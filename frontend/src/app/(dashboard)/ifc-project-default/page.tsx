"use client";

import { useState, useCallback, useEffect, useMemo, memo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getPB } from "@/lib/pb";
import {
  Pencil, Check, X, Play, RefreshCw,
  AlertCircle, Cpu, HardDrive, Settings, Lock,
} from "lucide-react";
import { useProjectStore, IFCFileInfo } from "@/stores/projectStore";
import { useToolStatusStore } from "@/stores/toolStatusStore";

const API = "http://127.0.0.1:8020";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ProjectDefaultParam {
  id: string; pset_name: string; property_name: string; property_value: string;
}
interface LogEntry { filename: string; ok: boolean; message: string; }

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

// ── Origin detection (same as Classifier / Sidebar) ───────────────────────────
function detectOrigin(info?: { originating_system?: string; organization?: string; author?: string }): "RVT" | "C3D" | null {
  if (!info) return null;
  if (info.originating_system) {
    const s = info.originating_system.toUpperCase();
    if (s.includes("CIVIL 3D") || s.includes("CIVIL3D") || s.includes("IFCINFRA")) return "C3D";
    if (s.includes("REVIT")) return "RVT";
    if (s.includes("CIVIL")) return "C3D";
  }
  const combined = [info.organization, info.author].filter(Boolean).join(" ").toUpperCase();
  if (combined.includes("CIVIL") || combined.includes("C3D")) return "C3D";
  if (combined.includes("REVIT")) return "RVT";
  return null;
}
function originBadgeStyle(o: "RVT" | "C3D" | null) {
  if (o === "C3D") return { color: "#D9A441", bg: "rgba(217,164,65,0.1)",  border: "rgba(217,164,65,0.28)",  label: "CIVIL 3D" };
  if (o === "RVT") return { color: "#7A6FD9", bg: "rgba(122,111,217,0.08)", border: "rgba(122,111,217,0.22)",  label: "REVIT"    };
  return null;
}

// ── PocketBase hook ───────────────────────────────────────────────────────────
function useProjectDefaults() {
  return useQuery<ProjectDefaultParam[]>({
    queryKey: ["ifc_project_defaults"],
    queryFn: () => getPB().collection("ifc_project_defaults").getFullList<ProjectDefaultParam>({ requestKey: null }),
    staleTime: 60_000, retry: 2,
  });
}

// ── Live value lookup (for the "valor en modelo" comparison column) ───────────
// `ifc_project_defaults.pset_name` uses the literal sentinel "IfcProject (Atributos)"
// for standard IfcProject attributes (Name, Description, ...); everything else is
// an ADIF pset name matching a key in the live /ifc-project-properties response.
const IFC_ATTRS_PSET = "IfcProject (Atributos)";

function getLiveValue(
  props: { attributes?: Record<string, unknown>; psets?: Record<string, Record<string, unknown>> } | undefined,
  psetName: string,
  propName: string
): string | undefined {
  if (!props) return undefined;
  if (psetName === IFC_ATTRS_PSET) {
    const v = props.attributes?.[propName];
    return v === undefined || v === null ? undefined : String(v);
  }
  let raw = props.psets?.[psetName]?.[propName];
  if (raw === undefined) {
    // Some Revit exports lump several ADIF/INGR properties into one
    // differently-named pset (e.g. "Propiedades de modelo") instead of the
    // per-group psets Civil3D uses — fall back to matching by property name
    // alone across every pset the model actually has.
    for (const bucket of Object.values(props.psets ?? {})) {
      if (bucket && propName in bucket) { raw = bucket[propName]; break; }
    }
  }
  return raw === undefined || raw === null ? undefined : String(raw);
}

// Default values like "{filename}" or "{currentmonth}" are computed dynamically
// when applied — comparing them literally against the live value is meaningless.
function isTemplatePlaceholder(value: string): boolean {
  return /\{[a-zA-Z_]+\}/.test(value || "");
}

interface DefaultRowInfo {
  d: ProjectDefaultParam;
  liveVal?: string;
  hasLive: boolean;
  template: boolean;
  matches: boolean;
  status: RowStatus;
  varies?: boolean;
}

function computeDefaultRows(
  defaults: ProjectDefaultParam[],
  props: { attributes?: Record<string, unknown>; psets?: Record<string, Record<string, unknown>> } | undefined
): DefaultRowInfo[] {
  return defaults.map(d => {
    const liveVal  = getLiveValue(props, d.pset_name, d.property_name);
    const hasLive  = liveVal !== undefined && liveVal !== "" && liveVal !== "—";
    const template = isTemplatePlaceholder(d.property_value);
    const matches  = template || (hasLive && liveVal === d.property_value);
    const status: RowStatus = !hasLive ? "missing" : (matches ? "match" : "diff");
    return { d, liveVal, hasLive, template, matches, status };
  });
}

// Overall semaphore for one model: worst row wins (missing > diff > match).
function computeOverallStatus(rows: DefaultRowInfo[]): RowStatus {
  if (rows.some(r => r.status === "missing")) return "missing";
  if (rows.some(r => r.status === "diff")) return "diff";
  return "match";
}

// Same idea but across several models at once (multi-selection) — mirrors
// Navisworks: if every selected model agrees on a value, show it; if they
// don't, show "VARIOS" instead of picking one arbitrarily.
function computeAggregatedRows(
  defaults: ProjectDefaultParam[],
  propsList: Array<{ attributes?: Record<string, unknown>; psets?: Record<string, Record<string, unknown>> } | undefined>
): DefaultRowInfo[] {
  return defaults.map(d => {
    const vals = propsList
      .map(p => getLiveValue(p, d.pset_name, d.property_name))
      .filter((v): v is string => v !== undefined && v !== "" && v !== "—");
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

// ── DefaultsCard ─────────────────────────────────────────────────────────────

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

const DefaultsCard = memo(function DefaultsCard({ file, info, checked, isActive, origin, matchStatus, onToggle, onCheckToggle, onRefresh }: CardProps) {
  const schemaSc = schemaStyle(info?.schema);
  const { descriptor, code, full } = splitIFCName(file.filename);
  const originBadge = originBadgeStyle(origin);
  const isCivil = origin === "C3D";

  // Match/diff/missing tint (Civil 3D only, once its live properties are
  // loaded) is the card's whole personality now — Revit cards just stay
  // neutral since this tool never touches them.
  const tint = matchStatus !== "none" ? STATUS_DOT_CFG[matchStatus] : null;
  // The match/diff/missing tint shows as a faint background wash so the
  // semaphore reads at a glance; "active" (currently previewed) is a plain
  // accent border on top of it, not a second competing glow.
  const baseBg     = tint ? `${tint.color}0F` : "var(--surface)";
  const baseBorder = tint ? `${tint.color}40` : "var(--border)";
  const hoverBorder = tint ? tint.color : "var(--border-bright)";

  return (
    <div
      onClick={onToggle}
      style={{
        position: "relative",
        background: baseBg,
        border: `1px solid ${isActive ? "var(--cyan)" : baseBorder}`,
        borderRadius: 6, overflow: "hidden",
        cursor: "pointer",
        boxShadow: "var(--shadow-sm)",
        transition: "border-color 0.2s, background 0.2s",
        display: "flex", flexDirection: "column",
      }}
      onMouseEnter={e => {
        if (!isActive) (e.currentTarget as HTMLElement).style.borderColor = hoverBorder;
      }}
      onMouseLeave={e => {
        if (!isActive) (e.currentTarget as HTMLElement).style.borderColor = baseBorder;
      }}
    >

      {/* ── Header ── */}
      <div style={{
        padding: "9px 10px 8px", borderBottom: "1px solid var(--border)",
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

        {/* Origin badge */}
        {originBadge && (
          <span style={{
            fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 3,
            fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.06em",
            background: originBadge.bg, color: originBadge.color,
            border: `1px solid ${originBadge.border}`, flexShrink: 0,
          }}>
            {originBadge.label}
          </span>
        )}

        <div style={{ flex: 1 }} />

        {isCivil && (
          <button
            onClick={e => { e.stopPropagation(); onRefresh(); }}
            title="Volver a leer este modelo"
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
          title={checked ? "Quitar de la selección" : "Añadir a la selección para aplicar"}
          style={{
            width: 14, height: 14, borderRadius: 3, flexShrink: 0, cursor: "pointer",
            border: `1px solid ${checked ? "var(--cyan)" : "var(--border-bright)"}`,
            background: checked ? "color-mix(in srgb, var(--cyan) 12%, transparent)" : "transparent",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
          {checked && <Check size={9} color="var(--cyan)" />}
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ padding: "9px 10px 10px", display: "flex", flexDirection: "column", gap: 7, flex: 1 }}>

        {/* Filename — big: human label (code), small: technical code (descriptor) */}
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: 11, fontWeight: 700, color: "var(--text-bright)",
            fontFamily: "JetBrains Mono, monospace",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: 1.3,
          }} title={full}>
            {code || descriptor}
          </div>
          {code && (
            <div style={{
              fontSize: 8.5, color: "var(--text-muted)", fontFamily: "JetBrains Mono, monospace",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2,
            }} title={full}>
              {descriptor}
            </div>
          )}
        </div>

        {/* Stats grid */}
        {info && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 8px" }}>
            <MiniStat icon={<Cpu size={10} />}      label="Elementos" value={info.element_count.toLocaleString()} color={schemaSc.text} />
            <MiniStat icon={<HardDrive size={10} />} label="Tamaño"    value={`${info.file_size_mb} MB`}          color={schemaSc.text} />
          </div>
        )}

        {/* Match/diff/missing badge — the one status that matters now */}
        <div style={{ marginTop: "auto" }}>
          {isCivil ? (
            matchStatus === "none" ? (
              <span style={{ fontSize: 9.5, color: "var(--text-muted)",
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
                {matchStatus === "match" ? "OK" : matchStatus === "diff" ? "DIFERENCIAS" : "SIN VALORES"}
              </span>
            )
          ) : (
            <span style={{ fontSize: 9, color: "var(--text-muted)",
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
// ── Status semaphore (row-level and overall) ──────────────────────────────────
type RowStatus = "match" | "diff" | "missing" | "loading" | "none";

const STATUS_DOT_CFG: Record<RowStatus, { color: string; glow: boolean; label: string }> = {
  match:   { color: "#3FBE8A", glow: false, label: "Coincide con el default" },
  diff:    { color: "#D9A441", glow: false, label: "Tiene un valor distinto al default" },
  missing: { color: "#E2685C", glow: false, label: "Sin valor en el modelo" },
  loading: { color: "var(--text-muted)", glow: false, label: "Cargando…" },
  none:    { color: "var(--text-muted)", glow: false, label: "Sin modelo activo" },
};

function StatusDot({ status, size = 8 }: { status: RowStatus; size?: number }) {
  const cfg = STATUS_DOT_CFG[status];
  return (
    <span title={cfg.label} style={{
      width: size, height: size, borderRadius: "50%", display: "inline-block",
      background: cfg.color,
      flexShrink: 0,
    }} />
  );
}

function MiniStat({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--text-muted)" }}>
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
      <span style={{ fontSize: 22, fontWeight: 700, color, fontFamily: "JetBrains Mono, monospace",
        lineHeight: 1 }}>
        {value}
      </span>
      <span style={{ fontSize: 8, color: "var(--text-muted)",
        fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.08em" }}>
        {label}
      </span>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ProjectDefaultPage() {
  const qc = useQueryClient();
  const { files: storeFiles, fileInfos, selectedPaths, setSelectedPaths, toggleFileSelection } = useProjectStore();

  const { data: defaults = [], isLoading: loadingDef, error: defError } = useProjectDefaults();
  const [editId, setEditId]   = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");

  const [log, setLog]               = useState<LogEntry[]>([]);
  const [applying, setApplying]     = useState(false);
  const [progressFile, setProgressFile] = useState("");

  const [selectedFileIdx, setSelectedFileIdx] = useState<number | null>(null);
  const [ifcProperties, setIfcProperties] = useState<Record<string, any>>({});
  const [loadingProperties, setLoadingProperties] = useState(false);

  useEffect(() => {
    qc.refetchQueries({ queryKey: ["ifc_project_defaults"] });
  }, [qc]);

  // Track which model is "active" (its card was clicked, or it arrived here
  // pre-selected from the Models page) so the params panel can compare live
  // values against the defaults template even before the modal is opened.
  useEffect(() => {
    if (selectedFileIdx === null && selectedPaths.length === 1) {
      const idx = storeFiles.findIndex(f => f.path === selectedPaths[0]);
      if (idx !== -1) setSelectedFileIdx(idx);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPaths, storeFiles]);

  // Load IFC properties for the active model — decoupled from the modal so the
  // "valor en modelo" comparison column works as soon as a card is active.
  useEffect(() => {
    if (selectedFileIdx !== null && storeFiles[selectedFileIdx]) {
      const filePath = storeFiles[selectedFileIdx].path;
      if (ifcProperties[filePath]) return; // already cached
      setLoadingProperties(true);
      fetch(`${API}/api/ifc/ifc-project-properties?path=${encodeURIComponent(filePath)}`)
        .then(r => r.json())
        .then(data => {
          setIfcProperties(prev => ({ ...prev, [filePath]: data }));
          setLoadingProperties(false);
        })
        .catch(e => {
          console.error("Error loading properties:", e);
          setLoadingProperties(false);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFileIdx, storeFiles]);

  // Background-load live properties for every Civil 3D model (not just the
  // active one) so the card list can paint its own match/diff/missing
  // semaphore right away, without requiring a manual scan or click first.
  // Sequential and Civil-3D-only to avoid hammering the backend — Revit files
  // never need this since they're never colored.
  useEffect(() => {
    const paths = storeFiles
      .filter(f => fileOrigin(f.path) === "C3D" && !ifcProperties[f.path])
      .map(f => f.path);
    if (paths.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const p of paths) {
        if (cancelled) return;
        try {
          const res = await fetch(`${API}/api/ifc/ifc-project-properties?path=${encodeURIComponent(p)}`);
          if (res.ok) {
            const data = await res.json();
            if (!cancelled) setIfcProperties(prev => (prev[p] ? prev : { ...prev, [p]: data }));
          }
        } catch {
          // silent — card just stays uncolored
        }
      }
    })();
    return () => { cancelled = true; };
    // ifcProperties is a dep on purpose: refreshFileProps/refreshAll clear
    // entries from it to force a re-read, and this effect is what actually
    // does the re-fetch — without it as a dep, clearing the cache never
    // re-triggers this effect and the card is stuck on "Cargando…" forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeFiles, fileInfos, ifcProperties]);

  // ── Config editing ────────────────────────────────────────────────────────
  async function saveDefault(id: string) {
    await getPB().collection("ifc_project_defaults").update(id, { property_value: editVal });
    qc.invalidateQueries({ queryKey: ["ifc_project_defaults"] });
    setEditId(null);
  }

  // ── Refresh live properties ────────────────────────────────────────────────
  // Force-reread one model (drops its cache entry so the background loader —
  // now a dep on ifcProperties itself, see below — fetches it again).
  const refreshFileProps = useCallback((path: string) => {
    setIfcProperties(prev => {
      if (!(path in prev)) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    });
  }, []);

  function refreshAll() {
    setIfcProperties({});
  }

  // ── Apply defaults ────────────────────────────────────────────────────────
  // This tool only injects ADIF psets — Revit files never get them, so any
  // Revit file in the batch is skipped rather than applied to, even if it
  // slipped into the selection.
  function fileOrigin(path: string): "RVT" | "C3D" | null {
    const detected = detectOrigin(fileInfos[path]);
    if (detected) return detected;
    // Last resort before Models-page info is available: this project's naming
    // convention tags most files with a "_C3D" or "_RVT" suffix.
    const filename = storeFiles.find(f => f.path === path)?.filename.toUpperCase() ?? "";
    if (filename.includes("_C3D")) return "C3D";
    if (filename.includes("_RVT")) return "RVT";
    return null;
  }

  async function applyDefaults() {
    const candidates = selectedPaths.length > 0
      ? storeFiles.filter(f => selectedPaths.includes(f.path))
      : storeFiles;
    const selected = candidates.filter(f => fileOrigin(f.path) !== "RVT");
    const skipped = candidates.length - selected.length;
    if (!selected.length || !defaults.length) return;
    setApplying(true); setLog([]);
    if (skipped > 0) {
      setLog(prev => [...prev, {
        filename: `${skipped} archivo${skipped > 1 ? "s" : ""} Revit`,
        ok: false, message: "Omitido(s) — esta herramienta solo aplica ADIF sobre Civil 3D",
      }]);
    }
    const paramList = defaults.map(d => ({ pset_name: d.pset_name, prop_name: d.property_name, prop_value: d.property_value }));

    for (const f of selected) {
      setProgressFile(f.filename);
      try {
        const res = await fetch(`${API}/api/ifc/apply-defaults`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ifc_path: f.path, params: paramList }),
        });
        const d = await res.json();
        setLog(prev => [...prev, {
          filename: f.filename, ok: res.ok,
          message: res.ok ? `✓ ${d.modified ?? 0} props aplicadas` : (d.message ?? "Error"),
        }]);
        if (res.ok) refreshFileProps(f.path); // re-fetch so its semaphore updates
      } catch (e: unknown) {
        setLog(prev => [...prev, {
          filename: f.filename, ok: false,
          message: e instanceof Error ? e.message : "Error",
        }]);
      }
    }
    setProgressFile(""); setApplying(false); setSelectedPaths([]);
  }

  // ── Derived stats ─────────────────────────────────────────────────────────
  const civilCount   = storeFiles.filter(f => fileOrigin(f.path) === "C3D").length;
  const revitCount   = storeFiles.filter(f => fileOrigin(f.path) === "RVT").length;
  const selectedCount = selectedPaths.length;

  // Civil 3D first, Revit below — stable within each group.
  const sortedFiles = useMemo(() => {
    return [...storeFiles].sort((a, b) => {
      const aCivil = fileOrigin(a.path) === "C3D" ? 0 : 1;
      const bCivil = fileOrigin(b.path) === "C3D" ? 0 : 1;
      return aCivil - bCivil;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeFiles, fileInfos]);

  const civilPaths = storeFiles.filter(f => fileOrigin(f.path) === "C3D").map(f => f.path);
  const allCivilSelected = civilPaths.length > 0 && civilPaths.every(p => selectedPaths.includes(p));

  function toggleSelectAllCivil() {
    setSelectedPaths(allCivilSelected ? selectedPaths.filter(p => !civilPaths.includes(p)) : Array.from(new Set([...selectedPaths, ...civilPaths])));
  }

  // ── Active model (last card clicked, or arrived pre-selected from Models) ──
  const activeFile   = selectedFileIdx !== null ? storeFiles[selectedFileIdx] : null;
  const activeProps  = activeFile ? ifcProperties[activeFile.path] : undefined;
  const activeOrigin = activeFile ? fileOrigin(activeFile.path) : null;

  // Multi-selection (checkboxes): when more than one Civil 3D model is
  // checked, the panel compares across all of them at once instead of just
  // the last-clicked "active" one — same idea as Navisworks' multi-select
  // property view, showing "VARIOS" wherever they disagree.
  const selectedCivilPaths = selectedPaths.filter(p => fileOrigin(p) === "C3D");
  const multiMode = selectedCivilPaths.length > 1;

  // Read-only guard: this tool only injects ADIF psets into Civil 3D models —
  // a Revit model can be inspected/compared here but never edited or applied to.
  const readOnly = !multiMode && activeOrigin === "RVT";

  // Per-row live-vs-default comparison, computed once and reused by both the
  // table and the overall model semaphore.
  const propsLoading = multiMode
    ? selectedCivilPaths.some(p => !ifcProperties[p])
    : !!activeFile && loadingProperties && !activeProps;
  const rows = multiMode
    ? computeAggregatedRows(defaults, selectedCivilPaths.map(p => ifcProperties[p]))
    : computeDefaultRows(defaults, activeProps);

  const overallStatus: RowStatus =
    multiMode ? (propsLoading ? "loading" : computeOverallStatus(rows))
    : !activeFile ? "none"
    : propsLoading ? "loading"
    : computeOverallStatus(rows);

  // Publish this tool's aggregate health to the fractal status widget.
  useEffect(() => {
    useToolStatusStore.getState().setToolStatus("ifc-project-default", overallStatus);
  }, [overallStatus]);

  // Per-card semaphore (Civil 3D only — Revit never gets ADIF, so it stays
  // uncolored) used by the card list below and by the filter bar counts.
  const cardStatusByPath = useMemo(() => {
    const map: Record<string, RowStatus> = {};
    for (const f of storeFiles) {
      const isCivil = fileOrigin(f.path) === "C3D";
      const props = ifcProperties[f.path];
      map[f.path] = !isCivil ? "none" : !props ? "none" : computeOverallStatus(computeDefaultRows(defaults, props));
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeFiles, ifcProperties, defaults, fileInfos]);

  // Per-model breakdown for the fractal tree (one branch per model).
  useEffect(() => {
    useToolStatusStore.getState().setFileStatuses("ifc-project-default", cardStatusByPath);
  }, [cardStatusByPath]);

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
            IFC PROJECT DEFAULTS
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
            Aplica parámetros por defecto del proyecto desde PocketBase a los archivos IFC seleccionados.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={refreshAll} disabled={storeFiles.length === 0} title="Vuelve a leer todos los modelos Civil 3D" style={{
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
        <KpiChip label="MODELOS"    value={storeFiles.length} color="var(--cyan)"  />
        <div style={{ width: 1, height: 32, background: "var(--border)" }} />
        <KpiChip label="CIVIL 3D"   value={civilCount}        color="#D9A441"      />
        <KpiChip label="REVIT"      value={revitCount}        color="#7A6FD9"      />
      </div>

      {/* ── Main layout ── */}
      <div style={{
        display: "grid", gridTemplateColumns: "minmax(220px, 320px) minmax(0, 1fr)", gap: 16,
        flex: 1, minHeight: 0,
      }}>

        {/* ── LEFT: Filter bar + Cards (only the cards list scrolls) ── */}
        <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
          {storeFiles.length > 0 && (
            <div style={{
              display: "flex", gap: 6, marginBottom: 8, flexShrink: 0,
            }}>
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
              background: "rgba(91,140,255,0.015)",
            }}>
              <div style={{ fontSize: 32, marginBottom: 10, opacity: 0.15 }}>
                <Settings size={48} strokeWidth={1} />
              </div>
              <div style={{ fontSize: 14, color: "var(--text-muted)", fontWeight: 600, marginBottom: 6 }}>
                Sin modelos cargados
              </div>
              <div style={{ fontSize: 12, color: "var(--dim)" }}>
                Añade fuentes IFC en la página <strong style={{ color: "var(--cyan)" }}>Models</strong>.
              </div>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
              {sortedFiles.map(f => (
                <DefaultsCard
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
                  onRefresh={() => refreshFileProps(f.path)}
                />
              ))}
            </div>
          )}
          </div>
        </div>

        {/* ── RIGHT: Panel (params + apply btn + log) ── */}
        {/* Fixed in place — the page itself doesn't scroll, only the card
            list does, so this never has to be sticky/reposition. */}
        <div style={{
          display: "flex", flexDirection: "column", gap: 12,
          height: "100%", overflowY: "auto", paddingBottom: 4,
        }}>

          {/* Apply button */}
          <button
            className="btn btn-magenta"
            onClick={applyDefaults}
            disabled={applying || defaults.length === 0 || storeFiles.length === 0 || readOnly}
            title={readOnly ? "El modelo activo es Revit — esta herramienta solo aplica ADIF sobre Civil 3D" : undefined}
            style={{
              width: "100%", padding: "11px 0", fontSize: 13, fontWeight: 700,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            }}>
            <Play size={14} />
            {applying
              ? `Aplicando… ${progressFile ? progressFile.substring(0, 22) + "…" : ""}`
              : `APLICAR A SELECCIONADOS${selectedCount ? ` (${selectedCount})` : ""}`}
          </button>

          {/* Read-only notice: active model is Revit */}
          {readOnly && (
            <div style={{
              display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
              background: "rgba(122,111,217,0.06)", border: "1px solid rgba(122,111,217,0.22)",
              borderRadius: 6, fontSize: 10.5, color: "#7A6FD9", fontFamily: "JetBrains Mono, monospace",
            }}>
              <Lock size={12} style={{ flexShrink: 0 }} />
              Modelo Revit — solo lectura. Esta herramienta inyecta ADIF únicamente en Civil 3D.
            </div>
          )}

          {/* Params table */}
          <div className="card-cyber" style={{ overflow: "hidden" }}>
            <div style={{
              padding: "10px 14px", borderBottom: "1px solid var(--border)",
              display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8,
            }}>
              <span style={{
                fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase",
                letterSpacing: "0.1em", fontFamily: "JetBrains Mono, monospace", fontWeight: 600,
              }}>
                Parámetros por defecto
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {(multiMode || (activeFile && !readOnly)) && (
                  <span title={STATUS_DOT_CFG[overallStatus].label} style={{
                    display: "flex", alignItems: "center", gap: 5, padding: "2px 8px", borderRadius: 3,
                    fontSize: 8.5, fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.05em",
                    background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)", color: "var(--text-muted)",
                  }}>
                    <StatusDot status={overallStatus} />
                    {overallStatus === "match" ? "TODO OK" : overallStatus === "diff" ? "DIFERENCIAS" : overallStatus === "missing" ? "FALTAN VALORES" : "…"}
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
                    fontSize: 9, padding: "2px 8px", borderRadius: 3, maxWidth: 160,
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
                  background: loadingDef ? "var(--border)" : defaults.length ? "rgba(63,190,138,0.08)" : "rgba(255,68,102,0.08)",
                  color: loadingDef ? "var(--dim)" : defaults.length ? "var(--green)" : "var(--red)",
                  border: `1px solid ${loadingDef ? "var(--border)" : defaults.length ? "rgba(63,190,138,0.2)" : "rgba(255,68,102,0.2)"}`,
                }}>
                  {loadingDef ? "Cargando..." : `${defaults.length} registros`}
                </span>
              </div>
            </div>

            {defError && (
              <div style={{ padding: "10px 14px", color: "var(--red)", fontSize: 11,
                display: "flex", alignItems: "center", gap: 6 }}>
                <AlertCircle size={12} />
                No se pudo leer <code style={{ marginLeft: 4 }}>ifc_project_defaults</code>
              </div>
            )}

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
                {rows.map(({ d, liveVal, hasLive, template, matches, status, varies }) => {
                  // Read-only (Revit): the "default to apply" column is meaningless here
                  // (this tool never injects ADIF into Revit) — show only what the model
                  // actually has for each tracked property, same idea as Newton IFC.
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
                          ) : propsLoading ? (
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
                      ) : propsLoading ? (
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
                          title={template ? "Se calcula dinámicamente al aplicar" : (matches ? "Coincide con el default" : "Difiere del default")}
                          style={{
                            fontSize: 10.5, fontFamily: "JetBrains Mono, monospace",
                            color: matches ? "var(--green)" : "#ff8800", fontWeight: matches ? 400 : 700,
                          }}>
                          {liveVal}
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <StatusDot status={!hasSource ? "none" : propsLoading ? "loading" : status} />
                    </td>
                    <td style={wrap}>
                      {editId === d.id ? (
                        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                          <input value={editVal} onChange={e => setEditVal(e.target.value)}
                            style={{ flex: 1, fontSize: 11, padding: "2px 5px", minWidth: 0 }} autoFocus
                            onKeyDown={e => {
                              if (e.key === "Enter") saveDefault(d.id);
                              if (e.key === "Escape") setEditId(null);
                            }} />
                          <button onClick={() => saveDefault(d.id)}
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
                        <button onClick={() => { setEditId(d.id); setEditVal(d.property_value || ""); }}
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
                      <div style={{ color: "var(--text)", fontFamily: "JetBrains Mono, monospace",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10 }}>
                        {l.filename.replace(/\.ifc$/i, "")}
                      </div>
                      <div style={{ color: l.ok ? "var(--green)" : "var(--red)", fontSize: 9.5, marginTop: 1 }}>
                        {l.message}
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
        @keyframes dotBlink { 0%,100%{opacity:.5;transform:scale(1)} 50%{opacity:1;transform:scale(1.5)} }
        @keyframes spin { to{transform:rotate(360deg)} }
      `}</style>
    </div>
  );
}
