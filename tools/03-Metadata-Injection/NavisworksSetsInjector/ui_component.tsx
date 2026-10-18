"use client";

import { useState, useEffect, useCallback, useMemo, memo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Boxes, RefreshCw, Trash2, Pencil, Check, X, Play,
  AlertCircle, Cpu, HardDrive, Layers,
} from "lucide-react";
import { useProjectStore, IFCFileInfo } from "@/stores/projectStore";
import { useToolStatusStore } from "@/stores/toolStatusStore";
import { getPB } from "@/lib/pb";

const API = "http://127.0.0.1:8020";

// ── Types ─────────────────────────────────────────────────────────────────────

interface IFCGroup {
  global_id: string;
  name: string;
  type: string;
  member_count: number;
}

interface GroupsSummary {
  groups: IFCGroup[];
  total: number;      // addressable elements in the model (excludes spatial containers)
  grouped: number;     // how many of those already belong to at least one set
  error?: string;
}

interface PsetInfo {
  name: string;
  prop_count: number;
  element_count: number;
  props: string[];
}

interface ValuePreviewRow { value: string; count: number; }

// ── ADIF/INGR parameter catalog (PocketBase `master_adif_parameters`) ────────
// The PSET/PROPERTY pickers used to be built by opening every selected IFC and
// enumerating every pset it actually contains — correct, but for heavy models
// (many thousands of elements) that scan alone could take a very long time,
// and it re-ran on every checkbox click. The catalog of ADIF/INGR parameters
// is fixed and already lives in PocketBase, so read it from there instead:
// instant, and independent of which/how many models are selected. Actual
// value search still hits the real IFCs, but only for the ONE property the
// user picked (see runPreview) — the backend matches by property name across
// every pset the element has (see _find_prop_value), never by this literal
// `pset_name`, since that field is a business category ("Construcción"), not
// necessarily the literal pset name embedded by every exporter.
interface AdifParamRow { property_name: string; pset_name: string; }

function useAdifParamCatalog() {
  return useQuery<AdifParamRow[]>({
    queryKey: ["master_adif_parameters", "all"],
    queryFn: () => getPB().collection("master_adif_parameters").getFullList<AdifParamRow>({ requestKey: null }),
    staleTime: 5 * 60_000,
    retry: 2,
  });
}

// ── Status semaphore (mirrors Classifier / Project Default) ───────────────────

type RowStatus = "match" | "diff" | "missing" | "none";

const STATUS_DOT_CFG: Record<RowStatus, { color: string; label: string }> = {
  match:   { color: "#3FBE8A", label: "Todos los elementos están en algún conjunto" },
  diff:    { color: "#D9A441", label: "Solo algunos elementos están en un conjunto" },
  missing: { color: "#ff4466", label: "Sin conjuntos todavía" },
  none:    { color: "var(--text-muted)", label: "Sin datos" },
};

function StatusDot({ status, size = 8 }: { status: RowStatus; size?: number }) {
  const cfg = STATUS_DOT_CFG[status];
  return (
    <span title={cfg.label} style={{
      width: size, height: size, borderRadius: "50%", display: "inline-block",
      background: cfg.color, boxShadow: status !== "none" ? `0 0 6px ${cfg.color}80` : undefined,
      flexShrink: 0,
    }} />
  );
}

function groupsMatchStatus(s?: GroupsSummary): RowStatus {
  if (!s) return "none";
  if (s.total === 0) return "none";
  if (s.grouped === 0) return "missing";
  if (s.grouped >= s.total) return "match";
  return "diff";
}

// ── Visual tokens (mirrors Classifier / Project Default) ──────────────────────

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
  const lastDash = full.lastIndexOf("-");
  if (lastDash > 0) {
    return { descriptor: full.substring(0, lastDash), code: full.substring(lastDash + 1), full };
  }
  return { descriptor: full, code: "", full };
}

// A distinct value like "N/A" is almost never something you actually want as
// its own set — it's rarely worth pre-selecting by default, though the user
// can still check it manually if they do want it.
function isPlaceholderValue(value: string): boolean {
  return ["N/A", "NA", "NULL", "NONE", "-"].includes(value.trim().toUpperCase());
}

// ── SetCard (Classifier-style: click activates, checkbox batch-selects) ───────

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

const SetCard = memo(function SetCard({ file, info, checked, isActive, origin, matchStatus, onToggle, onCheckToggle, onRefresh }: CardProps) {
  const schemaSc = schemaStyle(info?.schema);
  const { descriptor, code, full } = splitIFCName(file.filename);
  const originBadge = originBadgeStyle(origin);

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
        borderRadius: 6, overflow: "hidden", cursor: "pointer",
        boxShadow: isActive ? `0 0 0 2px rgba(91,140,255,0.35), ${baseGlow}` : baseGlow,
        transition: "box-shadow 0.25s, border-color 0.2s, background 0.2s",
        display: "flex", flexDirection: "column",
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
      <div style={{
        padding: "9px 10px 8px", borderBottom: "1px solid var(--border)",
        display: "flex", alignItems: "center", gap: 5,
      }}>
        <span style={{
          fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 3,
          fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.06em",
          background: schemaSc.bg, color: schemaSc.text, border: `1px solid ${schemaSc.border}`,
          flexShrink: 0,
        }}>
          {info?.schema || "IFC"}
        </span>
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

        <button
          onClick={e => { e.stopPropagation(); onRefresh(); }}
          title="Volver a leer los conjuntos de este modelo"
          style={{
            background: "rgba(91,140,255,0.07)", border: "1px solid rgba(91,140,255,0.2)",
            borderRadius: 3, cursor: "pointer", color: "rgba(91,140,255,0.55)",
            padding: "3px 5px", display: "flex", alignItems: "center",
          }}>
          <RefreshCw size={11} />
        </button>

        <div
          onClick={e => { e.stopPropagation(); onCheckToggle(); }}
          title={checked ? "Quitar de la selección" : "Añadir a la selección para crear/ver en lote"}
          style={{
            width: 14, height: 14, borderRadius: 3, flexShrink: 0, cursor: "pointer",
            border: `1px solid ${checked ? "rgba(91,140,255,0.7)" : "var(--border-bright)"}`,
            background: checked ? "rgba(91,140,255,0.12)" : "transparent",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
          {checked && <Check size={9} color="#5B8CFF" />}
        </div>
      </div>

      <div style={{ padding: "9px 10px 10px", display: "flex", flexDirection: "column", gap: 7, flex: 1 }}>
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
              fontSize: 8.5, color: "rgba(91,140,255,0.5)", fontFamily: "JetBrains Mono, monospace",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2,
            }} title={full}>
              {descriptor}
            </div>
          )}
        </div>
        {info && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 8px" }}>
            <MiniStat icon={<Cpu size={10} />}       label="Elementos" value={info.element_count.toLocaleString()} color={schemaSc.text} />
            <MiniStat icon={<HardDrive size={10} />}  label="Tamaño"    value={`${info.file_size_mb} MB`}          color={schemaSc.text} />
          </div>
        )}

        <div style={{ marginTop: "auto" }}>
          {matchStatus === "none" ? (
            <span style={{ fontSize: 9.5, color: "var(--border-bright)", fontFamily: "JetBrains Mono, monospace" }}>
              {/* Beyond ~30 loaded models, only checked ones fetch their real status
                  (see the background-loader effect) — an unchecked card here isn't
                  "still loading", it just hasn't been asked for yet. */}
              {checked ? "Cargando…" : "Marca el modelo para ver su estado"}
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
              {matchStatus === "match" ? "TODO EN CONJUNTOS" : matchStatus === "diff" ? "PARCIAL" : "SIN CONJUNTOS"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

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

function KpiChip({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
      <span style={{ fontSize: 22, fontWeight: 700, color, fontFamily: "JetBrains Mono, monospace",
        textShadow: `0 0 12px ${color}55`, lineHeight: 1 }}>
        {value}
      </span>
      <span style={{ fontSize: 8, color: "var(--border-bright)", fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.08em" }}>
        {label}
      </span>
    </div>
  );
}

// ── GroupsTable — one model's existing conjuntos, with rename/delete ──────────

function GroupsTable({
  summary, editKey, editVal, setEditVal, busyKey,
  onStartEdit, onCancelEdit, onSaveRename, onDelete,
}: {
  summary?: GroupsSummary;
  editKey: string | null;
  editVal: string;
  setEditVal: (v: string) => void;
  busyKey: string | null;
  onStartEdit: (g: IFCGroup) => void;
  onCancelEdit: () => void;
  onSaveRename: (g: IFCGroup) => void;
  onDelete: (g: IFCGroup) => void;
}) {
  if (!summary) {
    return (
      <div style={{ padding: "10px 14px", fontSize: 11, color: "var(--text-muted)", fontFamily: "JetBrains Mono, monospace" }}>
        Cargando…
      </div>
    );
  }
  if (summary.error) {
    return (
      <div style={{ padding: "10px 14px", color: "var(--red)", fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
        <AlertCircle size={12} /> {summary.error}
      </div>
    );
  }
  if (summary.groups.length === 0) {
    return (
      <div style={{ padding: "10px 14px", fontSize: 11, color: "var(--text-muted)", fontFamily: "JetBrains Mono, monospace" }}>
        Este modelo no tiene conjuntos todavía.
      </div>
    );
  }
  return (
    <table className="table-cyber">
      <thead>
        <tr>
          <th style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase" }}>Nombre</th>
          <th style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase" }}>Tipo</th>
          <th style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase" }}>Elementos</th>
          <th style={{ width: 60 }}></th>
        </tr>
      </thead>
      <tbody>
        {summary.groups.map(g => {
          const key = g.global_id;
          const editing = editKey === key;
          const busy = busyKey === key;
          return (
            <tr key={key}>
              <td style={{ fontSize: 11, color: "var(--text-bright)", fontFamily: "JetBrains Mono, monospace" }}>
                {editing ? (
                  <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <input value={editVal} onChange={e => setEditVal(e.target.value)}
                      style={{ flex: 1, fontSize: 11, padding: "2px 5px", minWidth: 0 }} autoFocus
                      onKeyDown={e => {
                        if (e.key === "Enter") onSaveRename(g);
                        if (e.key === "Escape") onCancelEdit();
                      }} />
                    <button onClick={() => onSaveRename(g)} disabled={busy}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "var(--green)" }}>
                      <Check size={11} />
                    </button>
                    <button onClick={onCancelEdit}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "var(--red)" }}>
                      <X size={11} />
                    </button>
                  </div>
                ) : g.name}
              </td>
              <td style={{ fontSize: 9.5, color: "var(--text-muted)", fontFamily: "JetBrains Mono, monospace" }}>
                {g.type.replace(/^Ifc/, "")}
              </td>
              <td style={{ fontSize: 11, color: "var(--text)", fontFamily: "JetBrains Mono, monospace" }}>
                {g.member_count}
              </td>
              <td>
                {!editing && (
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <button onClick={() => onStartEdit(g)} title="Renombrar" disabled={busy}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)" }}>
                      <Pencil size={12} />
                    </button>
                    <button onClick={() => onDelete(g)} title="Eliminar" disabled={busy}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "var(--red, #ff3355)" }}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function IfcSetsPage() {
  const { files: storeFiles, fileInfos, selectedPaths, setSelectedPaths, toggleFileSelection } = useProjectStore();

  const [selectedFileIdx, setSelectedFileIdx] = useState<number | null>(null);
  const activeFile = selectedFileIdx !== null ? storeFiles[selectedFileIdx] : null;

  function fileOrigin(path: string): "RVT" | "C3D" | null {
    return detectOrigin(fileInfos[path]);
  }

  // ── Existing groups — one shared cache for every model, used by both the
  // card semaphore and the "conjuntos existentes" panel(s). ───────────────
  const [groupsByPath, setGroupsByPath] = useState<Record<string, GroupsSummary>>({});
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const loadGroupsFor = useCallback(async (path: string) => {
    try {
      const res = await fetch(`${API}/api/ifc/groups?path=${encodeURIComponent(path)}`);
      const d = await res.json();
      setGroupsByPath(prev => ({
        ...prev,
        [path]: {
          groups: d.groups ?? [],
          total: d.total_element_count ?? 0,
          grouped: d.grouped_element_count ?? 0,
          error: d.error,
        },
      }));
    } catch (e: unknown) {
      setGroupsByPath(prev => ({
        ...prev,
        [path]: { groups: [], total: 0, grouped: 0, error: e instanceof Error ? e.message : "Error" },
      }));
    }
  }, []);

  const refreshGroupsFor = useCallback((path: string) => {
    setGroupsByPath(prev => {
      if (!(path in prev)) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    });
  }, []);

  // Background-load models' groups so the card semaphore paints itself right
  // away — same pattern as Classifier's classify-status loader. Each fetch
  // opens the real IFC on the backend (ifcopenshell), so eagerly doing this
  // for the WHOLE store is fine for a handful of models but floods the
  // backend with a huge sequential queue once "Todos los proyectos" is
  // loaded (100+ files) — that queue is what made the API look "offline"
  // (health checks were just stuck behind it, not actually crashing; the
  // backend log showed a long run of plain 200 OKs, no errors). Past that
  // size, only eager-load status for the checked selection — still what
  // create/preview actually touches — and leave the rest "sin datos" until
  // the user checks them.
  useEffect(() => {
    const EAGER_LOAD_LIMIT = 30;
    const scopeFiles = storeFiles.length <= EAGER_LOAD_LIMIT
      ? storeFiles
      : storeFiles.filter(f => selectedPaths.includes(f.path));
    const paths = scopeFiles.filter(f => !groupsByPath[f.path]).map(f => f.path);
    if (paths.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const p of paths) {
        if (cancelled) return;
        await loadGroupsFor(p);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeFiles, selectedPaths, groupsByPath]);

  const cardStatusByPath = useMemo(() => {
    const map: Record<string, RowStatus> = {};
    for (const f of storeFiles) map[f.path] = groupsMatchStatus(groupsByPath[f.path]);
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeFiles, groupsByPath]);

  // Per-model breakdown for the fractal tree (one branch per model).
  useEffect(() => {
    useToolStatusStore.getState().setFileStatuses("ifc-sets", cardStatusByPath);
  }, [cardStatusByPath]);

  // Aggregate health across the active selection (worst case wins) —
  // published to the fractal status widget in the sidebar.
  const setsOverallStatus = useMemo(() => {
    const scope = selectedPaths.length > 0 ? selectedPaths : storeFiles.map(f => f.path);
    const vals = scope.map(p => cardStatusByPath[p]).filter((v): v is RowStatus => !!v);
    if (vals.length === 0) return "none" as RowStatus;
    if (vals.every(v => v === "none")) return "none" as RowStatus;
    if (vals.some(v => v === "missing")) return "missing" as RowStatus;
    if (vals.some(v => v === "diff")) return "diff" as RowStatus;
    return "match" as RowStatus;
  }, [selectedPaths, storeFiles, cardStatusByPath]);

  useEffect(() => {
    useToolStatusStore.getState().setToolStatus("ifc-sets", setsOverallStatus);
  }, [setsOverallStatus]);

  async function saveRename(path: string, g: IFCGroup) {
    setBusyKey(g.global_id);
    try {
      await fetch(`${API}/api/ifc/groups/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, global_id: g.global_id, name: editVal }),
      });
      setEditKey(null);
      await loadGroupsFor(path);
    } finally {
      setBusyKey(null);
    }
  }

  async function deleteGroup(path: string, g: IFCGroup) {
    if (!confirm(`¿Eliminar el conjunto "${g.name}"? Esta acción no se puede deshacer.`)) return;
    setBusyKey(g.global_id);
    try {
      await fetch(`${API}/api/ifc/groups/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, global_id: g.global_id }),
      });
      await loadGroupsFor(path);
    } finally {
      setBusyKey(null);
    }
  }

  // ── Batch selection (checkboxes) — shared with the left "Árbol de
  // Selección": checking a card here checks it there too, and vice versa. ──
  const allSelected = storeFiles.length > 0 && storeFiles.every(f => selectedPaths.includes(f.path));
  function toggleSelectAll() {
    setSelectedPaths(allSelected ? [] : storeFiles.map(f => f.path));
  }
  const checkedFiles = storeFiles.filter(f => selectedPaths.includes(f.path));
  const multiMode = checkedFiles.length > 1;

  // ── Create-new-groups panel — pset/prop/preview are read from the WHOLE
  // checked selection (union across every checked model), so ticking
  // "seleccionar todos" is enough on its own: no need to also click one
  // card just to populate the dropdowns. Falls back to the last-clicked
  // card only when nothing is checked yet. ────────────────────────────────
  const scopePaths = useMemo(() => {
    if (checkedFiles.length > 0) return checkedFiles.map(f => f.path);
    return activeFile ? [activeFile.path] : [];
  }, [checkedFiles, activeFile]);
  const scopeKey = scopePaths.join("|");

  const adifCatalog = useAdifParamCatalog();
  const psets = useMemo<PsetInfo[]>(() => {
    const rows = adifCatalog.data ?? [];
    const byPset = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!r.property_name) continue;
      const key = r.pset_name || "General";
      if (!byPset.has(key)) byPset.set(key, new Set());
      byPset.get(key)!.add(r.property_name);
    }
    return Array.from(byPset.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, props]) => ({
        name, prop_count: props.size, element_count: 0,
        props: Array.from(props).sort(),
      }));
  }, [adifCatalog.data]);
  const loadingPsets = adifCatalog.isLoading;
  const [selectedPset, setSelectedPset] = useState<string | null>(null);
  const [selectedProp, setSelectedProp] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ values: ValuePreviewRow[]; total: number } | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [selectedValues, setSelectedValues] = useState<Set<string>>(new Set());
  const [namePrefix, setNamePrefix] = useState("");
  const [nameSuffix, setNameSuffix] = useState("");
  const [creating, setCreating] = useState(false);
  const [createLog, setCreateLog] = useState<{ filename: string; ok: boolean; message: string }[]>([]);
  const [renamingTemplate, setRenamingTemplate] = useState("");
  const [showRenameDialog, setShowRenameDialog] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Reset the create-panel selections whenever the model scope changes. The
  // PSET/PROPERTY catalog itself no longer depends on scope at all (it comes
  // straight from PocketBase, see `psets` above) — only the value preview and
  // the actual creation touch the real IFCs, and only for the one property
  // the user picked.
  useEffect(() => {
    setEditKey(null);
    setSelectedPset(null);
    setSelectedProp(null);
    setPreview(null);
    setCreateLog([]);
    setNamePrefix("");
    setNameSuffix("");
  }, [scopeKey]);

  // Auto-fill namePrefix when pset/prop change
  useEffect(() => {
    if (selectedPset && selectedProp) {
      setNamePrefix(`${selectedPset} - ${selectedProp} - `);
    }
  }, [selectedPset, selectedProp]);

  const trackedProps = useMemo(
    () => psets.find(p => p.name === selectedPset)?.props ?? [],
    [psets, selectedPset]
  );

  async function runPreview() {
    if (scopePaths.length === 0 || !selectedPset || !selectedProp) return;
    setLoadingPreview(true);
    setPreview(null);
    setCreateLog([]);
    try {
      const pathsQs = scopePaths.map(p => `paths=${encodeURIComponent(p)}`).join("&");
      const res = await fetch(
        `${API}/api/ifc/property-values?${pathsQs}&pset=${encodeURIComponent(selectedPset)}&prop=${encodeURIComponent(selectedProp)}`
      );
      const d = await res.json();
      const values: ValuePreviewRow[] = d.values ?? [];
      setPreview({ values, total: d.total_elements ?? 0 });
      // Default: everything checked except placeholder-looking values like "N/A" —
      // the user can still check those in manually if they do want them.
      setSelectedValues(new Set(values.filter(v => !isPlaceholderValue(v.value)).map(v => v.value)));
    } catch {
      setPreview({ values: [], total: 0 });
    } finally {
      setLoadingPreview(false);
    }
  }

  function toggleValue(value: string) {
    setSelectedValues(prev => {
      const next = new Set(prev);
      next.has(value) ? next.delete(value) : next.add(value);
      return next;
    });
  }

  function selectAllValues() {
    setSelectedValues(new Set((preview?.values ?? []).map(v => v.value)));
  }

  function selectNoValues() {
    setSelectedValues(new Set());
  }

  async function deleteAllGroupsForModel(path: string) {
    if (!confirm("¿Eliminar TODOS los conjuntos de este modelo? Esta acción no se puede deshacer.")) return;
    setBusy(path);
    try {
      const res = await fetch(`${API}/api/ifc/groups/delete-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const d = await res.json();
      if (res.ok) {
        await loadGroupsFor(path);
      }
    } finally {
      setBusy(null);
    }
  }

  async function renameAllGroupsForModel(path: string) {
    if (!renamingTemplate.trim()) {
      alert("Introduce un nombre de plantilla (ej: Sanitario_{n})");
      return;
    }
    setBusy(path);
    try {
      const res = await fetch(`${API}/api/ifc/groups/rename-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, new_name_template: renamingTemplate }),
      });
      const d = await res.json();
      if (res.ok) {
        setRenamingTemplate("");
        setShowRenameDialog(null);
        await loadGroupsFor(path);
      }
    } finally {
      setBusy(null);
    }
  }

  async function createGroups() {
    if (!selectedPset || !selectedProp || selectedValues.size === 0) return;
    const targets = checkedFiles.length > 0 ? checkedFiles : (activeFile ? [activeFile] : []);
    if (targets.length === 0) return;

    setCreating(true);
    setCreateLog([]);
    const values = Array.from(selectedValues);

    for (const f of targets) {
      try {
        const res = await fetch(`${API}/api/ifc/groups/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: f.path, pset_name: selectedPset, prop_name: selectedProp, name_prefix: namePrefix, name_suffix: nameSuffix, values,
          }),
        });
        const d = await res.json();
        setCreateLog(prev => [...prev, {
          filename: f.filename, ok: res.ok && d.ok,
          message: res.ok
            ? (d.created > 0 ? `${d.created} conjuntos creados` : (d.message ?? "Sin elementos con esa propiedad"))
            : (d.detail ?? "Error al crear los conjuntos"),
        }]);
        if (res.ok) await loadGroupsFor(f.path);
      } catch (e: unknown) {
        setCreateLog(prev => [...prev, { filename: f.filename, ok: false, message: e instanceof Error ? e.message : "Error" }]);
      }
    }
    setCreating(false);
    setPreview(null);
    setNamePrefix("");
    setNameSuffix("");
  }

  const createTargetLabel = checkedFiles.length > 0
    ? `${checkedFiles.length} modelo${checkedFiles.length > 1 ? "s" : ""} seleccionado${checkedFiles.length > 1 ? "s" : ""}`
    : (activeFile ? activeFile.filename.replace(/\.ifc$/i, "") : "");

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
            IFC SETS
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
            Ve, edita o crea conjuntos (<code style={{ color: "var(--cyan)" }}>IfcSystem</code>) que Navisworks
            muestra listos al abrir el modelo — igual que los que Civil 3D ya inyecta.
          </p>
        </div>
      </div>

      {/* ── KPI bar ── */}
      <div className="card-cyber" style={{
        marginBottom: 16, padding: "10px 20px", flexShrink: 0,
        display: "flex", alignItems: "center", gap: 24,
      }}>
        <KpiChip label="MODELOS" value={storeFiles.length} color="var(--cyan)" />
      </div>

      {/* ── Main layout ── */}
      <div style={{
        display: "grid", gridTemplateColumns: "minmax(220px, 320px) minmax(0, 1fr)", gap: 16,
        flex: 1, minHeight: 0,
      }}>
        {/* ── LEFT: filter bar + Cards ── */}
        <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
          {storeFiles.length > 0 && (
            <div style={{ display: "flex", gap: 6, marginBottom: 8, flexShrink: 0 }}>
              <button onClick={toggleSelectAll} style={{
                flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                padding: "5px 8px", fontSize: 9.5, fontWeight: 700,
                background: "rgba(91,140,255,0.08)", border: "1px solid rgba(91,140,255,0.3)",
                borderRadius: 4, color: "var(--cyan)", cursor: "pointer",
                fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.03em",
              }}>
                {allSelected ? "QUITAR TODOS" : "SELECCIONAR TODOS"}
              </button>
              {checkedFiles.length > 0 && (
                <button onClick={() => setSelectedPaths([])} style={{
                  padding: "5px 10px", fontSize: 9.5, fontWeight: 700,
                  background: "var(--border)", border: "1px solid var(--text-muted)",
                  borderRadius: 4, color: "var(--text-muted)", cursor: "pointer",
                  fontFamily: "JetBrains Mono, monospace",
                }}>
                  ✕ {checkedFiles.length}
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
                  <Boxes size={48} strokeWidth={1} />
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
                {storeFiles.map((f, idx) => (
                  <SetCard
                    key={f.path}
                    file={f}
                    info={fileInfos[f.path]}
                    checked={selectedPaths.includes(f.path)}
                    isActive={selectedFileIdx === idx}
                    origin={fileOrigin(f.path)}
                    matchStatus={cardStatusByPath[f.path] ?? "none"}
                    onToggle={() => setSelectedFileIdx(idx)}
                    onCheckToggle={() => toggleFileSelection(f.path)}
                    onRefresh={() => refreshGroupsFor(f.path)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── RIGHT: existing groups (one or many) + create panel ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", overflowY: "auto", paddingBottom: 4 }}>
          {!activeFile && !multiMode ? (
            <div className="card-cyber" style={{ padding: 48, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
              <Boxes size={32} style={{ opacity: 0.3, marginBottom: 8 }} />
              <div>Selecciona uno o varios modelos para ver y crear sus conjuntos.</div>
            </div>
          ) : (
            <>
              {/* ── Existing groups ── */}
              {multiMode ? (
                // Several models checked: different models can have different
                // sets, so each gets its own mini-table instead of one merged view.
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {checkedFiles.map(f => (
                    <div key={f.path} className="card-cyber" style={{ overflow: "hidden" }}>
                      <div style={{
                        padding: "8px 14px", borderBottom: "1px solid var(--border)",
                        display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8,
                      }}>
                        <span style={{
                          fontSize: 10.5, color: "var(--text)", fontFamily: "JetBrains Mono, monospace", fontWeight: 600,
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }} title={f.filename}>
                          {f.filename.replace(/\.ifc$/i, "")}
                        </span>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                          <span style={{
                            fontSize: 9, padding: "2px 8px", borderRadius: 3,
                            fontFamily: "JetBrains Mono, monospace",
                            background: "rgba(91,140,255,0.08)", color: "var(--cyan)",
                            border: "1px solid rgba(91,140,255,0.25)",
                          }}>
                            {(groupsByPath[f.path]?.groups ?? []).length} conjuntos
                          </span>
                          {(groupsByPath[f.path]?.groups ?? []).length > 0 && (
                            <>
                              <button
                                onClick={() => setShowRenameDialog(f.path)}
                                title="Renombrar todos los conjuntos con una plantilla"
                                disabled={busy === f.path}
                                style={{
                                  background: "rgba(217,164,65,0.07)", border: "1px solid rgba(217,164,65,0.2)",
                                  borderRadius: 3, cursor: "pointer", color: "rgba(217,164,65,0.7)",
                                  padding: "3px 5px", display: "flex", alignItems: "center", fontSize: 9,
                                  fontWeight: 600, fontFamily: "JetBrains Mono, monospace",
                                  opacity: busy === f.path ? 0.5 : 1,
                                }}
                              >
                                RENOMBRAR
                              </button>
                              <button
                                onClick={() => deleteAllGroupsForModel(f.path)}
                                title="Eliminar todos los conjuntos"
                                disabled={busy === f.path}
                                style={{
                                  background: "rgba(255,51,85,0.07)", border: "1px solid rgba(255,51,85,0.2)",
                                  borderRadius: 3, cursor: "pointer", color: "rgba(255,51,85,0.8)",
                                  padding: "3px 5px", display: "flex", alignItems: "center",
                                  opacity: busy === f.path ? 0.5 : 1,
                                }}
                              >
                                <Trash2 size={11} />
                              </button>
                            </>
                          )}
                          <button onClick={() => loadGroupsFor(f.path)} title="Actualizar" disabled={busy === f.path} style={{
                            background: "rgba(91,140,255,0.07)", border: "1px solid rgba(91,140,255,0.2)",
                            borderRadius: 3, cursor: "pointer", color: "rgba(91,140,255,0.55)",
                            padding: "3px 5px", display: "flex", alignItems: "center",
                            opacity: busy === f.path ? 0.5 : 1,
                          }}>
                            <RefreshCw size={11} />
                          </button>
                        </div>
                      </div>
                      <GroupsTable
                        summary={groupsByPath[f.path]}
                        editKey={editKey} editVal={editVal} setEditVal={setEditVal} busyKey={busyKey}
                        onStartEdit={g => { setEditKey(g.global_id); setEditVal(g.name); }}
                        onCancelEdit={() => setEditKey(null)}
                        onSaveRename={g => saveRename(f.path, g)}
                        onDelete={g => deleteGroup(f.path, g)}
                      />
                    </div>
                  ))}
                </div>
              ) : activeFile && (
                <div className="card-cyber" style={{ overflow: "hidden" }}>
                  <div style={{
                    padding: "10px 14px", borderBottom: "1px solid var(--border)",
                    display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8,
                  }}>
                    <span style={{
                      fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase",
                      letterSpacing: "0.1em", fontFamily: "JetBrains Mono, monospace", fontWeight: 600,
                    }}>
                      Conjuntos existentes
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{
                        fontSize: 9, padding: "2px 8px", borderRadius: 3,
                        fontFamily: "JetBrains Mono, monospace",
                        background: "rgba(91,140,255,0.08)", color: "var(--cyan)",
                        border: "1px solid rgba(91,140,255,0.25)",
                      }}>
                        {(groupsByPath[activeFile.path]?.groups ?? []).length} conjuntos
                      </span>
                      <button onClick={() => loadGroupsFor(activeFile.path)} title="Actualizar" style={{
                        background: "rgba(91,140,255,0.07)", border: "1px solid rgba(91,140,255,0.2)",
                        borderRadius: 3, cursor: "pointer", color: "rgba(91,140,255,0.55)",
                        padding: "3px 5px", display: "flex", alignItems: "center",
                      }}>
                        <RefreshCw size={11} />
                      </button>
                    </div>
                  </div>
                  <GroupsTable
                    summary={groupsByPath[activeFile.path]}
                    editKey={editKey} editVal={editVal} setEditVal={setEditVal} busyKey={busyKey}
                    onStartEdit={g => { setEditKey(g.global_id); setEditVal(g.name); }}
                    onCancelEdit={() => setEditKey(null)}
                    onSaveRename={g => saveRename(activeFile.path, g)}
                    onDelete={g => deleteGroup(activeFile.path, g)}
                  />
                </div>
              )}

              {/* ── Rename All Dialog (Modal Overlay) ── */}
              {showRenameDialog && (
                <div style={{
                  position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
                  background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center",
                  zIndex: 1000,
                }}>
                  <div className="card-cyber" style={{ padding: 20, maxWidth: 450, width: "90%", display: "flex", flexDirection: "column", gap: 12 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-bright)" }}>
                      Renombrar todos los conjuntos
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      Usa <code style={{ color: "var(--cyan)", fontFamily: "JetBrains Mono" }}>{"{"} n {"}"}</code> como marcador para numerar: <br/>
                      <strong>Ejemplo:</strong> <code style={{ color: "var(--cyan)", fontFamily: "JetBrains Mono" }}>Sanitario_{"{"} n {"}"}</code> → Sanitario_1, Sanitario_2, ...
                    </div>
                    <input
                      type="text"
                      value={renamingTemplate}
                      onChange={e => setRenamingTemplate(e.target.value)}
                      placeholder="ej: Sanitario_{n}"
                      autoFocus
                      style={{
                        fontSize: 12, padding: "8px 10px", fontFamily: "JetBrains Mono, monospace",
                        borderRadius: 4, border: "1px solid var(--border)",
                      }}
                      onKeyDown={e => {
                        if (e.key === "Enter") renameAllGroupsForModel(showRenameDialog);
                        if (e.key === "Escape") { setShowRenameDialog(null); setRenamingTemplate(""); }
                      }}
                    />
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <button
                        onClick={() => { setShowRenameDialog(null); setRenamingTemplate(""); }}
                        style={{
                          padding: "6px 12px", fontSize: 11, borderRadius: 3, cursor: "pointer",
                          background: "var(--border)", border: "1px solid var(--text-muted)",
                          color: "var(--text-muted)", fontWeight: 600,
                        }}
                      >
                        CANCELAR
                      </button>
                      <button
                        onClick={() => renameAllGroupsForModel(showRenameDialog)}
                        disabled={busy !== null}
                        style={{
                          padding: "6px 12px", fontSize: 11, borderRadius: 3, cursor: "pointer",
                          background: "rgba(217,164,65,0.12)", border: "1px solid rgba(217,164,65,0.3)",
                          color: "rgba(217,164,65,0.9)", fontWeight: 600,
                          opacity: busy !== null ? 0.5 : 1,
                        }}
                      >
                        {busy !== null ? "RENOMBRANDO…" : "RENOMBRAR"}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Create new groups ── */}
              <div className="card-cyber" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{
                  fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase",
                  letterSpacing: "0.1em", fontFamily: "JetBrains Mono, monospace", fontWeight: 600,
                  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Layers size={12} /> Crear conjuntos a partir de una propiedad
                  </span>
                  {createTargetLabel && (
                    <span style={{
                      fontSize: 9, padding: "2px 8px", borderRadius: 3, maxWidth: 180, fontWeight: 400,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      fontFamily: "JetBrains Mono, monospace", textTransform: "none", letterSpacing: 0,
                      background: "rgba(91,140,255,0.08)", color: "var(--cyan)", border: "1px solid rgba(91,140,255,0.25)",
                    }}>
                      → {createTargetLabel}
                    </span>
                  )}
                </div>

                {scopePaths.length === 0 ? (
                  <div style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>
                    Marca uno o varios modelos (o pulsa &quot;SELECCIONAR TODOS&quot;) para ver qué propiedades
                    tienen en común — la búsqueda se hace sobre todos los modelos marcados a la vez.
                  </div>
                ) : loadingPsets ? (
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    Cargando catálogo de propiedades ADIF/INGR…
                  </div>
                ) : psets.length === 0 ? (
                  <div style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>
                    No se pudo leer el catálogo de propiedades ADIF/INGR de PocketBase.
                  </div>
                ) : (
                  <>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <span style={{ fontSize: 9.5, color: "var(--text-muted)", fontFamily: "JetBrains Mono, monospace" }}>PSET</span>
                        <select
                          value={selectedPset ?? ""}
                          onChange={e => { setSelectedPset(e.target.value || null); setSelectedProp(null); setPreview(null); setCreateLog([]); }}
                          style={{ fontSize: 11, padding: "5px 6px", fontFamily: "JetBrains Mono, monospace" }}
                        >
                          <option value="">— seleccionar —</option>
                          {psets.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                        </select>
                      </label>
                      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <span style={{ fontSize: 9.5, color: "var(--text-muted)", fontFamily: "JetBrains Mono, monospace" }}>PROPIEDAD</span>
                        <select
                          value={selectedProp ?? ""}
                          onChange={e => { setSelectedProp(e.target.value || null); setPreview(null); setCreateLog([]); }}
                          disabled={!selectedPset}
                          style={{ fontSize: 11, padding: "5px 6px", fontFamily: "JetBrains Mono, monospace" }}
                        >
                          <option value="">— seleccionar —</option>
                          {trackedProps.map(p => <option key={p} value={p}>{p}</option>)}
                        </select>
                      </label>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <span style={{ fontSize: 9.5, color: "var(--text-muted)", fontFamily: "JetBrains Mono, monospace" }}>
                          PREFIJO (opcional)
                        </span>
                        <input
                          value={namePrefix}
                          onChange={e => setNamePrefix(e.target.value)}
                          placeholder="p.ej. Actividad_"
                          style={{ fontSize: 11, padding: "5px 6px", fontFamily: "JetBrains Mono, monospace" }}
                        />
                      </label>
                      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <span style={{ fontSize: 9.5, color: "var(--text-muted)", fontFamily: "JetBrains Mono, monospace" }}>
                          SUFIJO (opcional)
                        </span>
                        <input
                          value={nameSuffix}
                          onChange={e => setNameSuffix(e.target.value)}
                          placeholder="p.ej. _completado"
                          style={{ fontSize: 11, padding: "5px 6px", fontFamily: "JetBrains Mono, monospace" }}
                        />
                      </label>
                    </div>

                    {(namePrefix || nameSuffix) && selectedProp && (
                      <div style={{
                        fontSize: 9.5, padding: "8px 10px", borderRadius: 3,
                        background: "rgba(91,140,255,0.08)", border: "1px solid rgba(91,140,255,0.2)",
                        color: "var(--cyan)", fontFamily: "JetBrains Mono, monospace",
                      }}>
                        <div style={{ color: "var(--text-muted)", fontSize: 9, marginBottom: 4 }}>VISTA PREVIA:</div>
                        <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {namePrefix}{selectedPset} - {selectedProp} - ejemplo_valor{nameSuffix}
                        </div>
                      </div>
                    )}

                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        onClick={runPreview}
                        disabled={!selectedPset || !selectedProp || loadingPreview}
                        style={{
                          flex: 1, padding: "7px 0", fontSize: 10.5, fontWeight: 700,
                          background: "rgba(91,140,255,0.07)", border: "1px solid rgba(91,140,255,0.28)",
                          borderRadius: 4, color: "var(--cyan)", cursor: "pointer",
                          fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.03em",
                          opacity: (!selectedPset || !selectedProp) ? 0.5 : 1,
                        }}
                      >
                        {loadingPreview ? "Calculando…" : "VISTA PREVIA"}
                      </button>
                    </div>

                    {preview && (
                      <div style={{ border: "1px solid var(--border)", borderRadius: 4, padding: "8px 10px", background: "rgba(255,255,255,0.02)" }}>
                        {preview.values.length === 0 ? (
                          <div style={{ fontSize: 11, color: "rgba(217,164,65,0.8)", fontFamily: "JetBrains Mono, monospace" }}>
                            Ningún elemento tiene esa propiedad con valor.
                          </div>
                        ) : (
                          <>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                              <span style={{ fontSize: 10.5, color: "var(--text-muted)", fontFamily: "JetBrains Mono, monospace" }}>
                                {preview.values.length} valores detectados (en {createTargetLabel || `${scopePaths.length} modelo(s)`}) — elige cuáles crear
                              </span>
                              <div style={{ display: "flex", gap: 6 }}>
                                <button onClick={selectAllValues} style={{
                                  fontSize: 9, padding: "2px 7px", borderRadius: 3, cursor: "pointer",
                                  background: "rgba(91,140,255,0.06)", border: "1px solid rgba(91,140,255,0.2)",
                                  color: "var(--cyan)", fontFamily: "JetBrains Mono, monospace",
                                }}>
                                  TODO
                                </button>
                                <button onClick={selectNoValues} style={{
                                  fontSize: 9, padding: "2px 7px", borderRadius: 3, cursor: "pointer",
                                  background: "var(--border)", border: "1px solid var(--text-muted)",
                                  color: "var(--text-muted)", fontFamily: "JetBrains Mono, monospace",
                                }}>
                                  NINGUNO
                                </button>
                              </div>
                            </div>
                            <div style={{ maxHeight: 160, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
                              {preview.values.map(v => {
                                const checked = selectedValues.has(v.value);
                                return (
                                  <div
                                    key={v.value}
                                    onClick={() => toggleValue(v.value)}
                                    style={{
                                      display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between",
                                      fontSize: 10.5, fontFamily: "JetBrains Mono, monospace", padding: "3px 4px",
                                      cursor: "pointer", borderRadius: 3,
                                      background: checked ? "rgba(91,140,255,0.05)" : "transparent",
                                    }}
                                  >
                                    <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                                      <span style={{
                                        width: 13, height: 13, borderRadius: 3, flexShrink: 0,
                                        border: `1px solid ${checked ? "rgba(91,140,255,0.7)" : "var(--border-bright)"}`,
                                        background: checked ? "rgba(91,140,255,0.15)" : "transparent",
                                        display: "flex", alignItems: "center", justifyContent: "center",
                                      }}>
                                        {checked && <Check size={9} color="#5B8CFF" />}
                                      </span>
                                      <span style={{
                                        color: checked ? "var(--text)" : "var(--text-muted)",
                                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                      }}>
                                        {namePrefix}{selectedPset} - {selectedProp} - {v.value}{nameSuffix}
                                      </span>
                                    </div>
                                    <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>{v.count} elem.</span>
                                  </div>
                                );
                              })}
                            </div>
                            <button
                              onClick={createGroups}
                              disabled={creating || selectedValues.size === 0}
                              className="btn btn-magenta"
                              style={{
                                marginTop: 10, width: "100%", padding: "9px 0", fontSize: 12, fontWeight: 700,
                                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                                opacity: selectedValues.size === 0 ? 0.5 : 1,
                              }}
                            >
                              <Play size={12} />
                              {creating
                                ? "Creando…"
                                : `CREAR ${selectedValues.size} CONJUNTO${selectedValues.size === 1 ? "" : "S"}${checkedFiles.length > 1 ? ` × ${checkedFiles.length} MODELOS` : ""}`}
                            </button>
                          </>
                        )}
                      </div>
                    )}

                    {createLog.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {createLog.map((l, i) => (
                          <div key={i} style={{
                            fontSize: 11, padding: "6px 10px", borderRadius: 4,
                            color: l.ok ? "var(--green)" : "var(--red)",
                            background: l.ok ? "rgba(63,190,138,0.06)" : "rgba(255,51,85,0.06)",
                            border: `1px solid ${l.ok ? "rgba(63,190,138,0.2)" : "rgba(255,51,85,0.2)"}`,
                            fontFamily: "JetBrains Mono, monospace",
                          }}>
                            {l.ok ? "✓" : "✗"} {l.filename.replace(/\.ifc$/i, "")}: {l.message}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
