"use client";

import { useState, useCallback, useEffect, useMemo, memo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getPB } from "@/lib/pb";
import {
  Pencil, Check, X, Play, RefreshCw,
  AlertCircle, Cpu, HardDrive, Tag, Lock,
} from "lucide-react";
import { useProjectStore, IFCFileInfo } from "@/stores/projectStore";
import { useToolStatusStore } from "@/stores/toolStatusStore";

const API = "http://127.0.0.1:8020";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ClassifyConfig { id: string; property_name: string; property_value: string; }
interface LogEntry { filename: string; ok: boolean; message: string; count: number; }

interface ClassifyModelInfo {
  attributes: Record<string, string>;
  found: boolean;
  error?: string;
}

interface ClassifyStatus {
  is_civil3d: boolean;
  originating_system: string;
  elements_with_code: number;
  already_classified: number;
  pending: number;
  // Detail breakdown — included in batch response (no second fetch needed)
  pending_by_type?:    { type: string; count: number }[];
  classified_by_ref?:  { ref: string;  count: number }[];
  error?: string;
}

// ── Status semaphore (mirrors ifc-project-default) ────────────────────────────
type RowStatus = "match" | "diff" | "missing" | "loading" | "none";

const STATUS_DOT_CFG: Record<RowStatus, { color: string; glow: boolean; label: string }> = {
  match:   { color: "#3FBE8A", glow: true,  label: "Completamente clasificado" },
  diff:    { color: "#D9A441", glow: true,  label: "Clasificación parcial" },
  missing: { color: "#ff4466", glow: true,  label: "Sin clasificar" },
  loading: { color: "var(--border-bright)", glow: false, label: "Cargando…" },
  none:    { color: "var(--text-muted)", glow: false, label: "Sin modelo activo" },
};

function StatusDot({ status, size = 8 }: { status: RowStatus; size?: number }) {
  const cfg = STATUS_DOT_CFG[status];
  return (
    <span title={cfg.label} style={{
      width: size, height: size, borderRadius: "50%", display: "inline-block",
      background: cfg.color, boxShadow: cfg.glow ? `0 0 6px ${cfg.color}80` : undefined,
      flexShrink: 0,
    }} />
  );
}

// A file's classify-status maps directly to the semaphore — no property
// diffing needed here since the backend already counts real elements.
function classifyMatchStatus(s?: ClassifyStatus): RowStatus {
  if (!s) return "none";
  if (s.elements_with_code === 0) return "missing";
  if (s.pending === 0) return "match";
  if (s.already_classified > 0) return "diff";
  return "missing";
}

// ── Config vs model comparison (mirrors ifc-project-default's live-value diff) ─
// classify-model-info returns attributes keyed exactly like ifc_classification_config's
// property_name (name/source/edition/edition_date/location/reference_location) —
// no pset indirection needed here.

function isTemplatePlaceholder(value: string): boolean {
  return /\{[a-zA-Z_]+\}/.test(value || "");
}

function getLiveClassifyValue(info: ClassifyModelInfo | undefined, propName: string): string | undefined {
  const v = info?.attributes?.[propName];
  return v === undefined || v === null || v === "" || v === "—" ? undefined : v;
}

interface ClassifyRowInfo {
  d: ClassifyConfig;
  liveVal?: string;
  hasLive: boolean;
  template: boolean;
  matches: boolean;
  status: RowStatus;
  varies?: boolean;
}

function computeClassifyRows(config: ClassifyConfig[], info: ClassifyModelInfo | undefined): ClassifyRowInfo[] {
  return config.map(d => {
    const liveVal  = getLiveClassifyValue(info, d.property_name);
    const hasLive  = liveVal !== undefined;
    const template = isTemplatePlaceholder(d.property_value);
    const matches  = template || (hasLive && liveVal === d.property_value);
    const status: RowStatus = !hasLive ? "missing" : (matches ? "match" : "diff");
    return { d, liveVal, hasLive, template, matches, status };
  });
}

function computeClassifyOverallStatus(rows: ClassifyRowInfo[]): RowStatus {
  if (rows.some(r => r.status === "missing")) return "missing";
  if (rows.some(r => r.status === "diff")) return "diff";
  return "match";
}

// Multi-select (checkboxes): "VARIOS" when selected models disagree, Navisworks-style.
function computeClassifyAggregatedRows(config: ClassifyConfig[], infoList: Array<ClassifyModelInfo | undefined>): ClassifyRowInfo[] {
  return config.map(d => {
    const vals = infoList
      .map(info => getLiveClassifyValue(info, d.property_name))
      .filter((v): v is string => v !== undefined);
    const template = isTemplatePlaceholder(d.property_value);
    const uniq = new Set(vals);
    const varies = uniq.size > 1;
    const hasLive = vals.length > 0;
    const liveVal = varies ? "VARIOS" : vals[0];
    const matches = !varies && (template || (hasLive && liveVal === d.property_value));
    const status: RowStatus = varies ? "diff" : (!hasLive ? "missing" : (matches ? "match" : "diff"));
    return { d, liveVal, hasLive, template, matches, status, varies };
  });
}

// ── Visual tokens ─────────────────────────────────────────────────────────────

const SCHEMA_COLOR: Record<string, { bg: string; text: string; border: string }> = {
  IFC4X3: { bg: "rgba(91,140,255,0.12)",  text: "#5B8CFF", border: "rgba(91,140,255,0.35)" },
  IFC4:   { bg: "rgba(63,190,138,0.10)",  text: "#3FBE8A", border: "rgba(63,190,138,0.30)" },
  IFC2X3: { bg: "rgba(217,164,65,0.10)",  text: "#D9A441", border: "rgba(217,164,65,0.30)" },
};
const SCHEMA_DEFAULT = { bg: "var(--border)", text: "var(--border-bright)", border: "var(--text-muted)" };
function schemaStyle(schema?: string) {
  if (!schema) return SCHEMA_DEFAULT;
  const key = schema.toUpperCase().replace("IFC4X3AD", "IFC4X3");
  return SCHEMA_COLOR[key] ?? SCHEMA_DEFAULT;
}

// ── Origin detection (same logic as Sidebar) ──────────────────────────────────
// Returns "RVT" | "C3D" | null — never defaults to REVIT if info is absent/empty
function detectOrigin(info?: { originating_system?: string; organization?: string; author?: string }): "RVT" | "C3D" | null {
  if (!info) return null;
  // Priority: originating_system field (most reliable — set by backend FILE_NAME parser)
  if (info.originating_system) {
    const s = info.originating_system.toUpperCase();
    if (s.includes("CIVIL 3D") || s.includes("CIVIL3D") || s.includes("CIVILINFRA") || s.includes("IFCINFRA")) return "C3D";
    if (s.includes("REVIT")) return "RVT";
    if (s.includes("CIVIL")) return "C3D";
  }
  // Fallback: organization / author text
  const combined = [info.organization, info.author].filter(Boolean).join(" ").toUpperCase();
  if (combined.includes("CIVIL") || combined.includes("C3D")) return "C3D";
  if (combined.includes("REVIT")) return "RVT";
  return null;
}

function originBadgeStyle(origin: "RVT" | "C3D" | null) {
  if (origin === "C3D") return { color: "#D9A441", bg: "rgba(217,164,65,0.1)",  border: "rgba(217,164,65,0.28)",  label: "CIVIL 3D" };
  if (origin === "RVT") return { color: "#7A6FD9", bg: "rgba(122,111,217,0.08)", border: "rgba(122,111,217,0.22)",  label: "REVIT"    };
  return null;
}

function splitIFCName(filename: string) {
  const full = filename.replace(/\.ifc$/i, "");
  const spaceParts = full.split(" ");
  if (spaceParts.length >= 2) {
    const namePart = spaceParts[0];
    const codePart = spaceParts.slice(1).join(" ");
    const parts = namePart.split("_");
    let descriptor = namePart;
    if (parts.length > 1 && /^\d+$/.test(parts[0])) descriptor = parts.slice(1).join("_");
    return { descriptor, code: codePart, full };
  }
  // ADIF format: "000000000001-ACO-MOP-ME-CYT-521110-442_MAM_TOPOGRAFIA" → split at last hyphen
  const lastDash = full.lastIndexOf("-");
  if (lastDash > 0) {
    return { descriptor: full.substring(0, lastDash), code: full.substring(lastDash + 1), full };
  }
  return { descriptor: full, code: "", full };
}

// ── PocketBase hook ───────────────────────────────────────────────────────────

function useClassifyConfig() {
  return useQuery<ClassifyConfig[]>({
    queryKey: ["ifc_classification_config"],
    queryFn: () => getPB().collection("ifc_classification_config").getFullList<ClassifyConfig>({ requestKey: null }),
    staleTime: 60_000,
    retry: 1,
  });
}

// ── TypeBar — mini bar row ────────────────────────────────────────────────────
function TypeBar({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((count / total) * 100)) : 0;
  return (
    <div style={{ marginBottom: 5 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 2 }}>
        <span style={{
          fontSize: 9, color: "rgba(190,210,230,0.7)", fontFamily: "JetBrains Mono, monospace",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "75%",
        }} title={label}>
          {label.replace(/^Ifc/, "")}
        </span>
        <span style={{ fontSize: 9, color, fontWeight: 700, fontFamily: "JetBrains Mono, monospace", flexShrink: 0 }}>
          {count}
        </span>
      </div>
      <div style={{ height: 3, background: "var(--border)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{
          height: "100%", width: `${pct}%`, background: color,
          borderRadius: 2, boxShadow: `0 0 4px ${color}60`,
          transition: "width 0.4s ease",
        }} />
      </div>
    </div>
  );
}

// ── DetailPanel — expandable breakdown (data comes from status, no separate fetch) ──
function DetailPanel({ status }: { status?: ClassifyStatus }) {
  if (!status) return null;

  const pendingRows = status.pending_by_type ?? [];
  const clsRows     = status.classified_by_ref ?? [];

  if (!pendingRows.length && !clsRows.length) return null;

  const totalPend = status.pending ?? 0;
  const totalClsf = status.already_classified ?? 0;

  // Use a temporary detail-like object for the rest of the render:
  const detail = { pending_by_type: pendingRows, classified_by_ref: clsRows, classified_by_type: [] as { type: string; count: number }[] };

  return (
    <div style={{
      borderTop: "1px solid var(--border)", paddingTop: 10, marginTop: 4,
      display: "flex", flexDirection: "column", gap: 10,
    }}>

      {/* ── Pending by type ── */}
      {detail.pending_by_type.length > 0 && (
        <div>
          <div style={{
            fontSize: 8, fontWeight: 700, letterSpacing: "0.1em",
            color: "#D9A441", fontFamily: "JetBrains Mono, monospace",
            marginBottom: 6, display: "flex", alignItems: "center", gap: 5,
          }}>
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#D9A441",
              boxShadow: "0 0 5px #D9A44180", display: "inline-block" }} />
            PENDIENTES · {totalPend}
          </div>
          {detail.pending_by_type.map(r => (
            <TypeBar key={r.type} label={r.type} count={r.count} total={totalPend} color="#D9A441" />
          ))}
        </div>
      )}

      {/* ── Classified by reference ── */}
      {detail.classified_by_ref.length > 0 && (
        <div>
          <div style={{
            fontSize: 8, fontWeight: 700, letterSpacing: "0.1em",
            color: "#3FBE8A", fontFamily: "JetBrains Mono, monospace",
            marginBottom: 6, display: "flex", alignItems: "center", gap: 5,
          }}>
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#3FBE8A",
              boxShadow: "0 0 5px #3FBE8A80", display: "inline-block" }} />
            CLASIFICADOS · {totalClsf}
          </div>
          {detail.classified_by_ref.map(r => (
            <TypeBar key={r.ref} label={r.ref} count={r.count} total={totalClsf} color="#3FBE8A" />
          ))}
        </div>
      )}

      {/* Classified by type (if no refs) */}
      {detail.classified_by_ref.length === 0 && detail.classified_by_type.length > 0 && (
        <div>
          <div style={{
            fontSize: 8, fontWeight: 700, letterSpacing: "0.1em",
            color: "#3FBE8A", fontFamily: "JetBrains Mono, monospace",
            marginBottom: 6, display: "flex", alignItems: "center", gap: 5,
          }}>
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#3FBE8A",
              boxShadow: "0 0 5px #3FBE8A80", display: "inline-block" }} />
            CLASIFICADOS · {totalClsf}
          </div>
          {detail.classified_by_type.map(r => (
            <TypeBar key={r.type} label={r.type} count={r.count} total={totalClsf} color="#3FBE8A" />
          ))}
        </div>
      )}

      {detail.pending_by_type.length === 0 && detail.classified_by_ref.length === 0 && (
        <div style={{ fontSize: 9.5, color: "var(--border-bright)", fontFamily: "JetBrains Mono, monospace" }}>
          Sin datos de detalle disponibles
        </div>
      )}
    </div>
  );
}

// ── ClassifierCard (Models-style) ─────────────────────────────────────────────

interface CardProps {
  file: { filename: string; path: string };
  info?: IFCFileInfo;
  checked: boolean;
  isActive: boolean;
  origin: "RVT" | "C3D" | null;
  matchStatus: RowStatus;
  onToggle: () => void;
  onCheckToggle: () => void;
  onRefresh: () => void;
}

const ClassifierCard = memo(function ClassifierCard({ file, info, checked, isActive, origin, matchStatus, onToggle, onCheckToggle, onRefresh }: CardProps) {
  const schemaSc = schemaStyle(info?.schema);
  const { descriptor, code, full } = splitIFCName(file.filename);
  const originBadge = originBadgeStyle(origin);
  const isCivil = origin === "C3D";

  // Match/diff/missing tint (Civil 3D only) is the card's whole personality —
  // Revit cards stay neutral since classification only targets Civil 3D here.
  const tint = matchStatus !== "none" ? STATUS_DOT_CFG[matchStatus] : null;
  const baseBg     = tint ? `${tint.color}12` : "var(--surface)";
  const baseBorder = tint ? `${tint.color}59` : "var(--border)";
  const baseGlow   = tint ? `0 0 14px ${tint.color}33` : "none";
  const accentColor = tint ? tint.color : "var(--border-bright)";

  return (
    <div
      onClick={onToggle}
      style={{
        position: "relative",
        background: baseBg,
        border: `1px solid ${isActive ? "rgba(91,140,255,0.65)" : baseBorder}`,
        borderRadius: 6,
        overflow: "hidden",
        cursor: "pointer",
        boxShadow: isActive ? `0 0 0 2px rgba(91,140,255,0.35), ${baseGlow}` : baseGlow,
        transition: "box-shadow 0.25s, border-color 0.2s, background 0.2s",
        display: "flex",
        flexDirection: "column",
      }}
      onMouseEnter={e => {
        if (!isActive) {
          (e.currentTarget as HTMLElement).style.boxShadow = `0 0 20px ${accentColor}55`;
          (e.currentTarget as HTMLElement).style.borderColor = accentColor;
        }
      }}
      onMouseLeave={e => {
        if (!isActive) {
          (e.currentTarget as HTMLElement).style.boxShadow = baseGlow;
          (e.currentTarget as HTMLElement).style.borderColor = baseBorder;
        }
      }}
    >
      {/* Scan-line texture */}
      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        backgroundImage: "repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(91,140,255,0.008) 3px,rgba(91,140,255,0.008) 4px)",
      }} />

      {/* ── Header: badges + refresh/check icons ── */}
      <div style={{
        padding: "9px 10px 8px",
        borderBottom: "1px solid var(--border)",
        display: "flex", alignItems: "center", gap: 5,
      }}>
        {/* Schema badge */}
        <span style={{
          fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 3,
          fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.06em",
          background: schemaSc.bg, color: schemaSc.text, border: `1px solid ${schemaSc.border}`,
          flexShrink: 0,
        }}>
          {info?.schema || "IFC"}
        </span>

        {/* Civil3D / Revit badge — only shown when origin is known */}
        {originBadge && (
          <span style={{
            fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 3,
            fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.06em",
            background: originBadge.bg,
            color:      originBadge.color,
            border:     `1px solid ${originBadge.border}`,
            flexShrink: 0,
          }}>
            {originBadge.label}
          </span>
        )}

        <div style={{ flex: 1 }} />

        {isCivil && (
          <button
            onClick={e => { e.stopPropagation(); onRefresh(); }}
            title="Volver a analizar este modelo"
            style={{
              background: "rgba(91,140,255,0.07)", border: "1px solid rgba(91,140,255,0.2)",
              borderRadius: 3, cursor: "pointer", color: "rgba(91,140,255,0.55)",
              padding: "3px 5px", display: "flex", alignItems: "center",
            }}>
            <RefreshCw size={11} />
          </button>
        )}

        <div
          onClick={e => { e.stopPropagation(); onCheckToggle(); }}
          title={checked ? "Quitar de la selección" : "Añadir a la selección para clasificar"}
          style={{
            width: 14, height: 14, borderRadius: 3, flexShrink: 0, cursor: "pointer",
            border: `1px solid ${checked ? "rgba(91,140,255,0.7)" : "var(--border-bright)"}`,
            background: checked ? "rgba(91,140,255,0.12)" : "transparent",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
          {checked && <Check size={9} color="#5B8CFF" />}
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ padding: "9px 10px 10px", display: "flex", flexDirection: "column", gap: 7, flex: 1 }}>

        {/* Filename — big: human label (code), small: technical code (descriptor) */}
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: 11, fontWeight: 700, color: "var(--text-bright)",
            fontFamily: "JetBrains Mono, monospace",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            lineHeight: 1.3,
          }} title={full}>
            {code || descriptor}
          </div>
          {code && (
            <div style={{
              fontSize: 8.5, color: "rgba(91,140,255,0.5)",
              fontFamily: "JetBrains Mono, monospace",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              marginTop: 2, letterSpacing: "0.03em",
            }} title={full}>
              {descriptor}
            </div>
          )}
        </div>

        {/* ── Stats grid (when info loaded) ── */}
        {info && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 8px" }}>
            <MiniStat icon={<Cpu size={10} />}       label="Elementos" value={info.element_count.toLocaleString()} color={schemaSc.text} />
            <MiniStat icon={<HardDrive size={10} />}  label="Tamaño"    value={`${info.file_size_mb} MB`}          color={schemaSc.text} />
          </div>
        )}

        {/* Match/diff/missing badge — the one status that matters now */}
        <div style={{ marginTop: "auto" }}>
          {isCivil ? (
            matchStatus === "none" ? (
              <span style={{ fontSize: 9.5, color: "var(--border-bright)",
                fontFamily: "JetBrains Mono, monospace" }}>
                Cargando…
              </span>
            ) : (
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                fontSize: 7.5, fontWeight: 700, padding: "2px 7px", borderRadius: 3,
                fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.1em",
                background: `${STATUS_DOT_CFG[matchStatus].color}14`,
                color: STATUS_DOT_CFG[matchStatus].color,
                border: `1px solid ${STATUS_DOT_CFG[matchStatus].color}45`,
              }}>
                <StatusDot status={matchStatus} size={6} />
                {matchStatus === "match" ? "CLASIFICADO" : matchStatus === "diff" ? "PARCIAL" : "SIN CLASIFICAR"}
              </span>
            )
          ) : (
            <span style={{ fontSize: 9, color: "var(--border-bright)",
              fontFamily: "JetBrains Mono, monospace" }}>
              Solo lectura
            </span>
          )}
        </div>
      </div>
    </div>
  );
}); // React.memo

// ── MiniStat ──────────────────────────────────────────────────────────────────

function MiniStat({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--border-bright)" }}>
        {icon}
        <span style={{ fontSize: 7.5, fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.06em" }}>{label}</span>
      </div>
      <div style={{ fontSize: 11, color, fontWeight: 600, fontFamily: "JetBrains Mono, monospace",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {value}
      </div>
    </div>
  );
}

// ── KPI chip ──────────────────────────────────────────────────────────────────

function KpiChip({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
      <span style={{
        fontSize: 22, fontWeight: 700, color, fontFamily: "JetBrains Mono, monospace",
        textShadow: `0 0 12px ${color}55`, lineHeight: 1,
      }}>
        {value}
      </span>
      <span style={{
        fontSize: 8, color: "var(--border-bright)",
        fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.08em",
      }}>
        {label}
      </span>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ClassifyPage() {
  const qc = useQueryClient();
  const { files: storeFiles, fileInfos, selectedPaths, setSelectedPaths, toggleFileSelection } = useProjectStore();

  const { data: config = [], isLoading: loadingCfg, error: cfgError } = useClassifyConfig();
  // The classification name the config actually wants applied — files can carry
  // several classification systems at once (e.g. Revit's own "Uniformat" export
  // next to the ADIF one), so every model-info lookup must target this one by
  // name rather than guessing "whichever is referenced" or "the first in file".
  const configClassificationName = config.find(c => c.property_name === "name")?.property_value ?? "";
  const [editId, setEditId]   = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");

  const [statuses, setStatuses]         = useState<Record<string, ClassifyStatus>>({});
  const [log, setLog]                   = useState<LogEntry[]>([]);
  const [classifying, setClassifying]   = useState(false);
  const [progressFile, setProgressFile] = useState("");

  // Live IfcClassification attributes already present in each model — for the
  // "En modelo vs Aplicar" comparison table (mirrors ifc-project-default).
  const [classInfo, setClassInfo] = useState<Record<string, ClassifyModelInfo>>({});
  const [loadingClassInfo, setLoadingClassInfo] = useState(false);

  // Which model's detail breakdown shows in the fixed right panel — set by
  // clicking a card (separate from the checkbox, which is for batch classify).
  const [selectedFileIdx, setSelectedFileIdx] = useState<number | null>(null);

  // ── Config editing ────────────────────────────────────────────────────────

  async function saveConfig(id: string) {
    await getPB().collection("ifc_classification_config").update(id, { property_value: editVal });
    qc.invalidateQueries({ queryKey: ["ifc_classification_config"] });
    setEditId(null);
  }

  // ── Refresh classify-status ────────────────────────────────────────────────
  const refreshFile = useCallback((path: string) => {
    setStatuses(prev => {
      if (!(path in prev)) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    });
    setClassInfo(prev => {
      if (!(path in prev)) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    });
  }, []);

  function refreshAll() {
    setStatuses({});
    setClassInfo({});
  }

  // This tool only classifies Civil 3D elements — Revit files are skipped
  // rather than classified, even if one slips into the selection.
  function fileOrigin(path: string): "RVT" | "C3D" | null {
    if (statuses[path]) return statuses[path].is_civil3d ? "C3D" : "RVT";
    const detected = detectOrigin(fileInfos[path]);
    if (detected) return detected;
    const filename = storeFiles.find(f => f.path === path)?.filename.toUpperCase() ?? "";
    if (filename.includes("_C3D")) return "C3D";
    if (filename.includes("_RVT")) return "RVT";
    return null;
  }

  // Background-load classify-status for every Civil 3D model so the card
  // list paints its own match/diff/missing semaphore right away, without
  // requiring a manual scan or click first. Sequential to avoid hammering
  // the backend.
  useEffect(() => {
    const paths = storeFiles
      .filter(f => fileOrigin(f.path) === "C3D" && !statuses[f.path])
      .map(f => f.path);
    if (paths.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const p of paths) {
        if (cancelled) return;
        try {
          const res = await fetch(`${API}/api/ifc/classify-status?path=${encodeURIComponent(p)}`);
          if (res.ok) {
            const data: ClassifyStatus = await res.json();
            if (!cancelled) setStatuses(prev => (prev[p] ? prev : { ...prev, [p]: data }));
          }
        } catch {
          // silent — card just stays uncolored
        }
      }
    })();
    return () => { cancelled = true; };
    // statuses is a dep on purpose: refreshFile/refreshAll clear entries from
    // it to force a re-read, and this effect is what does the re-fetch —
    // without it as a dep, clearing the cache never re-triggers this effect
    // and the card is stuck on "Cargando…" forever (same bug fixed in
    // ifc-project-default/page.tsx).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeFiles, fileInfos, statuses]);

  // Load classify-model-info for the active model — decoupled so the "En
  // modelo" column works as soon as a card is active, not just after a click.
  // Runs for ANY origin (Revit included): a Revit model never gets classified
  // by this tool, but its existing classification data is still worth
  // consulting — same "look, don't touch" idea as Project Default's read-only view.
  useEffect(() => {
    if (selectedFileIdx !== null && storeFiles[selectedFileIdx]) {
      const filePath = storeFiles[selectedFileIdx].path;
      if (classInfo[filePath]) return;
      setLoadingClassInfo(true);
      const qs = configClassificationName ? `&name=${encodeURIComponent(configClassificationName)}` : "";
      fetch(`${API}/api/ifc/classify-model-info?path=${encodeURIComponent(filePath)}${qs}`)
        .then(r => r.json())
        .then(data => {
          setClassInfo(prev => ({ ...prev, [filePath]: data }));
          setLoadingClassInfo(false);
        })
        .catch(() => setLoadingClassInfo(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFileIdx, storeFiles, configClassificationName]);

  // Background-load classify-model-info for every Civil 3D model so multi-select
  // aggregation ("VARIOS") works without requiring each card to be clicked first.
  useEffect(() => {
    const paths = storeFiles
      .filter(f => fileOrigin(f.path) === "C3D" && !classInfo[f.path])
      .map(f => f.path);
    if (paths.length === 0) return;
    let cancelled = false;
    const qs = configClassificationName ? `&name=${encodeURIComponent(configClassificationName)}` : "";
    (async () => {
      for (const p of paths) {
        if (cancelled) return;
        try {
          const res = await fetch(`${API}/api/ifc/classify-model-info?path=${encodeURIComponent(p)}${qs}`);
          if (res.ok) {
            const data: ClassifyModelInfo = await res.json();
            if (!cancelled) setClassInfo(prev => (prev[p] ? prev : { ...prev, [p]: data }));
          }
        } catch {
          // silent — table just stays uncolored for this model
        }
      }
    })();
    return () => { cancelled = true; };
    // classInfo is a dep on purpose — same reasoning as the statuses effect
    // above: without it, refreshFile/refreshAll clearing an entry never
    // re-triggers this effect to actually re-fetch it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeFiles, fileInfos, configClassificationName, classInfo]);

  // ── Classify ─────────────────────────────────────────────────────────────

  async function classifySelected() {
    const candidates = storeFiles.filter(f => selectedPaths.includes(f.path));
    const selected = candidates.filter(f => fileOrigin(f.path) !== "RVT");
    const skipped = candidates.length - selected.length;
    if (!selected.length || !config.length) return;
    setClassifying(true); setLog([]);
    if (skipped > 0) {
      setLog(prev => [...prev, {
        filename: `${skipped} archivo${skipped > 1 ? "s" : ""} Revit`,
        ok: false, message: "Omitido(s) — esta herramienta solo clasifica Civil 3D", count: 0,
      }]);
    }
    const cfgList = config.map(r => ({ property_name: r.property_name, property_value: r.property_value }));

    for (const f of selected) {
      setProgressFile(f.filename);
      try {
        const res = await fetch(`${API}/api/ifc/classify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ifc_path: f.path, config: cfgList }),
        });
        const d = await res.json();
        setLog(prev => [...prev, { filename: f.filename, ok: res.ok, message: d.message ?? "", count: d.modified ?? 0 }]);
        if (res.ok) refreshFile(f.path);
      } catch (e: unknown) {
        setLog(prev => [...prev, { filename: f.filename, ok: false,
          message: e instanceof Error ? e.message : "Error", count: 0 }]);
      }
    }
    setProgressFile(""); setClassifying(false);
    setSelectedPaths([]);
  }

  // ── Derived stats ─────────────────────────────────────────────────────────

  const civilCount    = storeFiles.filter(f => fileOrigin(f.path) === "C3D").length;
  const revitCount    = storeFiles.filter(f => fileOrigin(f.path) === "RVT").length;
  const selectedCount = selectedPaths.length;

  // Civil 3D first, Revit below — stable within each group.
  const sortedFiles = useMemo(() => {
    return [...storeFiles].sort((a, b) => {
      const aCivil = fileOrigin(a.path) === "C3D" ? 0 : 1;
      const bCivil = fileOrigin(b.path) === "C3D" ? 0 : 1;
      return aCivil - bCivil;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeFiles, statuses, fileInfos]);

  const civilPaths = storeFiles.filter(f => fileOrigin(f.path) === "C3D").map(f => f.path);
  const allCivilSelected = civilPaths.length > 0 && civilPaths.every(p => selectedPaths.includes(p));

  function toggleSelectAllCivil() {
    setSelectedPaths(allCivilSelected ? selectedPaths.filter(p => !civilPaths.includes(p)) : Array.from(new Set([...selectedPaths, ...civilPaths])));
  }

  // Per-card semaphore, straight from the real classify-status (no property
  // diffing needed here — the backend already counts real elements).
  const cardStatusByPath = useMemo(() => {
    const map: Record<string, RowStatus> = {};
    for (const f of storeFiles) map[f.path] = fileOrigin(f.path) === "C3D" ? classifyMatchStatus(statuses[f.path]) : "none";
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeFiles, statuses, fileInfos]);

  // Per-model breakdown for the fractal tree (one branch per model).
  useEffect(() => {
    useToolStatusStore.getState().setFileStatuses("ifc-classify", cardStatusByPath);
  }, [cardStatusByPath]);

  // ── Active model (last card clicked) ──────────────────────────────────────
  const activeFile   = selectedFileIdx !== null ? storeFiles[selectedFileIdx] : null;
  const activeStatus = activeFile ? statuses[activeFile.path] : undefined;
  const activeOrigin = activeFile ? fileOrigin(activeFile.path) : null;

  // Multi-selection (checkboxes): when more than one Civil 3D model is
  // checked, the config table compares across all of them at once — same
  // "VARIOS" idea as Project Default's Navisworks-style aggregation.
  const selectedCivilPaths = selectedPaths.filter(p => fileOrigin(p) === "C3D");
  const multiMode = selectedCivilPaths.length > 1;

  const readOnly = !multiMode && activeOrigin === "RVT";

  // Per-row live-vs-config comparison for the "Configuración de clasificación" table.
  const classInfoLoading = multiMode
    ? selectedCivilPaths.some(p => !classInfo[p])
    : !!activeFile && loadingClassInfo && !classInfo[activeFile.path];
  const classifyRows = multiMode
    ? computeClassifyAggregatedRows(config, selectedCivilPaths.map(p => classInfo[p]))
    : computeClassifyRows(config, activeFile ? classInfo[activeFile.path] : undefined);
  const classifyOverallStatus: RowStatus =
    multiMode ? (classInfoLoading ? "loading" : computeClassifyOverallStatus(classifyRows))
    : !activeFile ? "none"
    : classInfoLoading ? "loading"
    : computeClassifyOverallStatus(classifyRows);

  // Publish this tool's aggregate health to the fractal status widget.
  useEffect(() => {
    useToolStatusStore.getState().setToolStatus("ifc-classify", classifyOverallStatus);
  }, [classifyOverallStatus]);

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      height: "calc(100vh - var(--navbar-h) - var(--toolbar-h) - 48px)",
      overflow: "hidden",
    }}>
      {/* ── Header ── */}
      <div style={{ marginBottom: 14, display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexShrink: 0 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--cyan)", letterSpacing: "0.04em" }}>
            IFC CLASSIFIER
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
            Identifica y aplica clasificación IFC a elementos con{" "}
            <code style={{ color: "var(--cyan)" }}>ADIF_00_Codigo_Producto</code>
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={refreshAll} disabled={storeFiles.length === 0} title="Vuelve a analizar todos los modelos Civil 3D" style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "6px 14px", fontSize: 10.5, fontWeight: 700,
            background: "rgba(91,140,255,0.07)", border: "1px solid rgba(91,140,255,0.28)",
            borderRadius: 4, color: "var(--cyan)", cursor: "pointer",
            fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.05em",
            opacity: storeFiles.length === 0 ? 0.5 : 1,
          }}>
            <RefreshCw size={11} />
            ACTUALIZAR
          </button>
        </div>
      </div>

      {/* ── KPI bar ── */}
      <div className="card-cyber" style={{
        marginBottom: 16, padding: "10px 20px", flexShrink: 0,
        display: "flex", alignItems: "center", gap: 24,
      }}>
        <KpiChip label="MODELOS"  value={storeFiles.length} color="var(--cyan)" />
        <div style={{ width: 1, height: 32, background: "var(--border)" }} />
        <KpiChip label="CIVIL 3D" value={civilCount}        color="#D9A441"     />
        <KpiChip label="REVIT"    value={revitCount}        color="#7A6FD9"     />
      </div>

      {/* ── Main layout ── */}
      <div style={{
        display: "grid", gridTemplateColumns: "minmax(220px, 320px) minmax(0, 1fr)", gap: 16,
        flex: 1, minHeight: 0,
      }}>

        {/* ── LEFT: Filter bar + Cards (only the cards list scrolls) ── */}
        <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
          {storeFiles.length > 0 && (
            <div style={{ display: "flex", gap: 6, marginBottom: 8, flexShrink: 0 }}>
              <button onClick={toggleSelectAllCivil} disabled={civilPaths.length === 0} style={{
                flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                padding: "5px 8px", fontSize: 9.5, fontWeight: 700,
                background: "rgba(217,164,65,0.08)", border: "1px solid rgba(217,164,65,0.3)",
                borderRadius: 4, color: "#D9A441", cursor: civilPaths.length === 0 ? "not-allowed" : "pointer",
                fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.03em",
                opacity: civilPaths.length === 0 ? 0.5 : 1,
              }}>
                {allCivilSelected ? "QUITAR CIVIL 3D" : "TODO CIVIL 3D"}
              </button>
              {selectedCount > 0 && (
                <button onClick={() => setSelectedPaths([])} style={{
                  padding: "5px 10px", fontSize: 9.5, fontWeight: 700,
                  background: "var(--border)", border: "1px solid var(--text-muted)",
                  borderRadius: 4, color: "var(--text-muted)", cursor: "pointer",
                  fontFamily: "JetBrains Mono, monospace",
                }}>
                  ✕ {selectedCount}
                </button>
              )}
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingRight: 4 }}>
          {storeFiles.length === 0 ? (
            <div style={{
              padding: 56, textAlign: "center",
              border: "1px dashed rgba(91,140,255,0.12)", borderRadius: 8,
              background: "rgba(91,140,255,0.015)", position: "relative", overflow: "hidden",
            }}>
              <div style={{ position: "absolute", inset: 0, pointerEvents: "none",
                backgroundImage: "repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(91,140,255,0.01) 3px,rgba(91,140,255,0.01) 4px)" }} />
              <div style={{ fontSize: 32, marginBottom: 10, opacity: 0.15 }}>
                <Tag size={48} strokeWidth={1} />
              </div>
              <div style={{ fontSize: 14, color: "var(--text-muted)", fontWeight: 600, marginBottom: 6 }}>
                Sin modelos cargados
              </div>
              <div style={{ fontSize: 12, color: "var(--dim)" }}>
                Añade fuentes IFC en la página{" "}
                <strong style={{ color: "var(--cyan)" }}>Models</strong> para comenzar.
              </div>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
              {sortedFiles.map(f => (
                <ClassifierCard
                  key={f.path}
                  file={f}
                  info={fileInfos[f.path]}
                  checked={selectedPaths.includes(f.path)}
                  isActive={activeFile?.path === f.path}
                  origin={fileOrigin(f.path)}
                  matchStatus={cardStatusByPath[f.path] ?? "none"}
                  onToggle={() => {
                    const idx = storeFiles.findIndex(x => x.path === f.path);
                    setSelectedFileIdx(idx);
                  }}
                  onCheckToggle={() => toggleFileSelection(f.path)}
                  onRefresh={() => refreshFile(f.path)}
                />
              ))}
            </div>
          )}
          </div>
        </div>

        {/* ── RIGHT: Panel (classify btn + config + detail + log) ── */}
        {/* Fixed in place — the page itself doesn't scroll, only the card
            list does, so this never has to be sticky/reposition. */}
        <div style={{
          display: "flex", flexDirection: "column", gap: 12,
          height: "100%", overflowY: "auto", paddingBottom: 4,
        }}>

          {/* Classify button */}
          <button
            className="btn btn-magenta"
            onClick={classifySelected}
            disabled={classifying || selectedCount === 0 || config.length === 0}
            style={{
              width: "100%", padding: "11px 0", fontSize: 13, fontWeight: 700,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            }}>
            <Play size={14} />
            {classifying
              ? `Clasificando… ${progressFile ? progressFile.substring(0, 22) + "…" : ""}`
              : `CLASIFICAR SELECCIONADOS${selectedCount ? ` (${selectedCount})` : ""}`}
          </button>

          {/* Read-only notice: active model is Revit */}
          {readOnly && (
            <div style={{
              display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
              background: "rgba(122,111,217,0.06)", border: "1px solid rgba(122,111,217,0.22)",
              borderRadius: 6, fontSize: 10.5, color: "#7A6FD9", fontFamily: "JetBrains Mono, monospace",
            }}>
              <Lock size={12} style={{ flexShrink: 0 }} />
              Modelo Revit — solo lectura. Esta herramienta clasifica únicamente Civil 3D.
            </div>
          )}

          {/* ── Detail breakdown for the active model (fixed, not per-card) ── */}
          <div className="card-cyber" style={{ padding: "10px 14px" }}>
            <div style={{
              fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase",
              letterSpacing: "0.1em", fontFamily: "JetBrains Mono, monospace", fontWeight: 600,
              marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
            }}>
              <span>Detalle del modelo</span>
              {activeFile && (
                <span title={activeFile.filename} style={{
                  fontSize: 9, padding: "2px 8px", borderRadius: 3, maxWidth: 160, fontWeight: 400,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  fontFamily: "JetBrains Mono, monospace", textTransform: "none", letterSpacing: 0,
                  background: readOnly ? "rgba(122,111,217,0.08)" : "rgba(91,140,255,0.08)",
                  color: readOnly ? "#7A6FD9" : "var(--cyan)",
                  border: `1px solid ${readOnly ? "rgba(122,111,217,0.25)" : "rgba(91,140,255,0.25)"}`,
                }}>
                  {activeFile.filename.replace(/\.ifc$/i, "")}
                </span>
              )}
            </div>
            {!activeFile ? (
              <div style={{ fontSize: 10.5, color: "var(--border-bright)", fontFamily: "JetBrains Mono, monospace" }}>
                Selecciona un modelo para ver su desglose.
              </div>
            ) : !activeStatus ? (
              <div style={{ fontSize: 10.5, color: "var(--border-bright)", fontFamily: "JetBrains Mono, monospace" }}>
                Cargando…
              </div>
            ) : (
              <DetailPanel status={activeStatus} />
            )}
          </div>

          {/* ── Config table card ── */}
          <div className="card-cyber" style={{ overflow: "hidden" }}>
            {/* Header */}
            <div style={{
              padding: "10px 14px",
              borderBottom: "1px solid var(--border)",
              display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8,
            }}>
              <span style={{
                fontSize: 10, color: "var(--text-muted)",
                textTransform: "uppercase", letterSpacing: "0.1em",
                fontFamily: "JetBrains Mono, monospace", fontWeight: 600,
              }}>
                Configuración de clasificación
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {(multiMode || (activeFile && !readOnly)) && (
                  <span title={STATUS_DOT_CFG[classifyOverallStatus].label} style={{
                    display: "flex", alignItems: "center", gap: 5, padding: "2px 8px", borderRadius: 3,
                    fontSize: 8.5, fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.05em",
                    background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)", color: "var(--text-muted)",
                  }}>
                    <StatusDot status={classifyOverallStatus} />
                    {classifyOverallStatus === "match" ? "TODO OK" : classifyOverallStatus === "diff" ? "DIFERENCIAS" : classifyOverallStatus === "missing" ? "FALTAN VALORES" : "…"}
                  </span>
                )}
                {multiMode ? (
                  <span style={{
                    fontSize: 9, padding: "2px 8px", borderRadius: 3,
                    fontFamily: "JetBrains Mono, monospace",
                    background: "rgba(91,140,255,0.08)", color: "var(--cyan)",
                    border: "1px solid rgba(91,140,255,0.25)",
                  }}>
                    {selectedCivilPaths.length} SELECCIONADOS
                  </span>
                ) : activeFile && (
                  <span title={activeFile.filename} style={{
                    fontSize: 9, padding: "2px 8px", borderRadius: 3, maxWidth: 140,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    fontFamily: "JetBrains Mono, monospace",
                    background: readOnly ? "rgba(122,111,217,0.08)" : "rgba(91,140,255,0.08)",
                    color: readOnly ? "#7A6FD9" : "var(--cyan)",
                    border: `1px solid ${readOnly ? "rgba(122,111,217,0.25)" : "rgba(91,140,255,0.25)"}`,
                  }}>
                    {activeFile.filename.replace(/\.ifc$/i, "")}
                  </span>
                )}
                <span style={{
                  fontSize: 9, padding: "2px 8px", borderRadius: 3,
                  fontFamily: "JetBrains Mono, monospace",
                  background: loadingCfg
                    ? "var(--border)"
                    : config.length
                      ? "rgba(63,190,138,0.08)"
                      : "rgba(255,68,102,0.08)",
                  color: loadingCfg ? "var(--dim)" : config.length ? "var(--green)" : "var(--red)",
                  border: `1px solid ${loadingCfg ? "var(--border)" : config.length ? "rgba(63,190,138,0.2)" : "rgba(255,68,102,0.2)"}`,
                }}>
                  {loadingCfg ? "Cargando..." : `${config.length} registros`}
                </span>
              </div>
            </div>

            {cfgError && (
              <div style={{ padding: "10px 14px", color: "var(--red)", fontSize: 11,
                display: "flex", alignItems: "center", gap: 6 }}>
                <AlertCircle size={12} />
                No se pudo leer <code style={{ marginLeft: 4 }}>ifc_classification_config</code>
              </div>
            )}

            {/* Table */}
            <div>
            <table className="table-cyber" style={{ tableLayout: "fixed" }}>
              {readOnly ? (
                <colgroup>
                  <col style={{ width: "30%" }} />
                  <col style={{ width: "70%" }} />
                </colgroup>
              ) : (
                <colgroup>
                  <col style={{ width: "18%" }} />
                  <col style={{ width: "39%" }} />
                  <col style={{ width: 32 }} />
                  <col style={{ width: "39%" }} />
                  <col style={{ width: 28 }} />
                </colgroup>
              )}
              <thead>
                {readOnly ? (
                  <tr>
                    <th style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase" }}>Propiedad</th>
                    <th style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase" }}>Valor en el modelo</th>
                  </tr>
                ) : (
                  <tr>
                    <th style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase" }}>Propiedad</th>
                    <th style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase" }}>En modelo</th>
                    <th></th>
                    <th style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase" }}>Aplicar</th>
                    <th></th>
                  </tr>
                )}
              </thead>
              <tbody>
                {classifyRows.map(({ d, liveVal, hasLive, template, matches, status, varies }) => {
                  const wrap: React.CSSProperties = { wordBreak: "break-word", overflowWrap: "anywhere" };
                  const hasSource = !!activeFile || multiMode;

                  if (readOnly) {
                    return (
                      <tr key={d.id}>
                        <td style={{ color: "var(--text-muted)", fontSize: 10.5,
                          fontFamily: "JetBrains Mono, monospace", ...wrap }}>
                          {d.property_name}
                        </td>
                        <td style={wrap}>
                          {!hasSource ? (
                            <span style={{ fontSize: 10, color: "var(--border-bright)" }}>—</span>
                          ) : classInfoLoading ? (
                            <span style={{ fontSize: 10, color: "var(--border-bright)" }}>…</span>
                          ) : !hasLive ? (
                            <span style={{ fontSize: 10, color: "var(--border-bright)", fontFamily: "JetBrains Mono, monospace" }}>
                              sin valor
                            </span>
                          ) : (
                            <span style={{ fontSize: 11, color: "var(--text-bright)", fontFamily: "JetBrains Mono, monospace" }}>
                              {liveVal}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  }

                  return (
                  <tr key={d.id}>
                    <td style={{ color: "var(--text-muted)", fontSize: 10.5,
                      fontFamily: "JetBrains Mono, monospace", ...wrap }}>
                      {d.property_name}
                    </td>
                    <td style={wrap}>
                      {!hasSource ? (
                        <span style={{ fontSize: 10, color: "var(--border-bright)" }}>—</span>
                      ) : classInfoLoading ? (
                        <span style={{ fontSize: 10, color: "var(--border-bright)" }}>…</span>
                      ) : !hasLive ? (
                        <span style={{ fontSize: 10, color: "rgba(217,164,65,0.65)", fontFamily: "JetBrains Mono, monospace" }}>
                          sin valor
                        </span>
                      ) : varies ? (
                        <span
                          title="Los modelos seleccionados tienen valores distintos"
                          style={{
                            fontSize: 10.5, fontFamily: "JetBrains Mono, monospace",
                            color: "#cc66ff", fontWeight: 700, fontStyle: "italic",
                          }}>
                          VARIOS
                        </span>
                      ) : (
                        <span
                          title={template ? "Se calcula dinámicamente al aplicar" : (matches ? "Coincide con la configuración" : "Difiere de la configuración")}
                          style={{
                            fontSize: 10.5, fontFamily: "JetBrains Mono, monospace",
                            color: matches ? "var(--green)" : "#ff8800", fontWeight: matches ? 400 : 700,
                          }}>
                          {liveVal}
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <StatusDot status={!hasSource ? "none" : classInfoLoading ? "loading" : status} />
                    </td>
                    <td style={wrap}>
                      {editId === d.id ? (
                        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                          <input
                            value={editVal}
                            onChange={e => setEditVal(e.target.value)}
                            style={{ flex: 1, fontSize: 11, padding: "2px 5px", minWidth: 0 }}
                            autoFocus
                            onKeyDown={e => {
                              if (e.key === "Enter") saveConfig(d.id);
                              if (e.key === "Escape") setEditId(null);
                            }}
                          />
                          <button onClick={() => saveConfig(d.id)}
                            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--green)" }}>
                            <Check size={11} />
                          </button>
                          <button onClick={() => setEditId(null)}
                            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--red)" }}>
                            <X size={11} />
                          </button>
                        </div>
                      ) : (
                        <span style={{ fontSize: 11, color: "var(--text-bright)" }}>
                          {d.property_value || "—"}
                        </span>
                      )}
                    </td>
                    <td>
                      {editId !== d.id && (
                        <button
                          onClick={() => { setEditId(d.id); setEditVal(d.property_value || ""); }}
                          style={{ background: "none", border: "none", cursor: "pointer",
                            color: "var(--text-muted)", display: "flex", alignItems: "center" }}>
                          <Pencil size={11} />
                        </button>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>

          {/* Log */}
          {log.length > 0 && (
            <div className="card-cyber" style={{ overflow: "hidden" }}>
              <div style={{
                padding: "9px 14px", borderBottom: "1px solid var(--border)",
                fontSize: 9.5, color: "var(--text-muted)", textTransform: "uppercase",
                letterSpacing: "0.08em", fontFamily: "JetBrains Mono, monospace",
              }}>
                Log de ejecución
              </div>
              <div style={{ padding: "6px 0" }}>
                {log.map((l, i) => (
                  <div key={i} style={{
                    display: "flex", gap: 7, fontSize: 10.5, padding: "5px 14px",
                    borderBottom: i < log.length - 1 ? "1px solid var(--border)" : "none",
                    alignItems: "flex-start",
                  }}>
                    <span style={{ color: l.ok ? "var(--green)" : "var(--red)", flexShrink: 0, marginTop: 1 }}>
                      {l.ok ? "✓" : "✗"}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        color: "var(--text)", fontFamily: "JetBrains Mono, monospace",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10,
                      }}>
                        {l.filename.replace(/\.ifc$/i, "")}
                      </div>
                      <div style={{ color: l.ok ? "var(--green)" : "var(--red)", fontSize: 9.5, marginTop: 1 }}>
                        {l.message || `${l.count} elem. modificados`}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes dotBlink {
          0%, 100% { opacity: 0.5; transform: scale(1); }
          50%       { opacity: 1;   transform: scale(1.5); }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
