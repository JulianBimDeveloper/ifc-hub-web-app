"use client";

import { useState, useMemo, memo } from "react";
import {
  CalendarClock, Check, Play, AlertCircle, Cpu, HardDrive,
} from "lucide-react";
import { useProjectStore, IFCFileInfo } from "@/stores/projectStore";
import { getPB } from "@/lib/pb";

const API = "http://127.0.0.1:8020";
const PSET_NAME = "ADIF_04_4D";
const PROP_NAME = "ADIF_04_Codigo_Actividad";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PlanningActivity {
  codigo_actividad: string;
  descripcion_actividad: string;
}

interface MatchedRow {
  codigo: string;
  descripcion: string;
  count: number;   // elements found across the selected models
  checked: boolean;
}

interface UnmatchedModelRow {
  codigo: string;
  count: number;
}

// ── Visual tokens (mirrors Sets) ────────────────────────────────────────────

const SCHEMA_COLOR: Record<string, { bg: string; text: string; border: string }> = {
  IFC4X3: { bg: "rgba(91,140,255,0.12)", text: "#5B8CFF", border: "rgba(91,140,255,0.35)" },
  IFC4:   { bg: "rgba(63,190,138,0.10)", text: "#3FBE8A", border: "rgba(63,190,138,0.30)" },
  IFC2X3: { bg: "rgba(217,164,65,0.10)", text: "#D9A441", border: "rgba(217,164,65,0.30)" },
};
const SCHEMA_DEFAULT = { bg: "var(--border)", text: "var(--border-bright)", border: "var(--text-muted)" };
function schemaStyle(schema?: string) {
  if (!schema) return SCHEMA_DEFAULT;
  const key = schema.toUpperCase().replace("IFC4X3AD", "IFC4X3");
  return SCHEMA_COLOR[key] ?? SCHEMA_DEFAULT;
}

// ── ModelCard ────────────────────────────────────────────────────────────────

const ModelCard = memo(function ModelCard({
  filename, info, checked, onCheckToggle,
}: {
  filename: string; info?: IFCFileInfo; checked: boolean; onCheckToggle: () => void;
}) {
  const schemaSc = schemaStyle(info?.schema);
  return (
    <div
      onClick={onCheckToggle}
      style={{
        position: "relative", background: checked ? "rgba(91,140,255,0.06)" : "var(--surface)",
        border: `1px solid ${checked ? "rgba(91,140,255,0.5)" : "var(--border)"}`,
        borderRadius: 6, cursor: "pointer", padding: "9px 10px",
        display: "flex", flexDirection: "column", gap: 7,
        boxShadow: checked ? "0 0 14px rgba(91,140,255,0.18)" : "none",
        transition: "box-shadow 0.2s, border-color 0.2s, background 0.2s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <span style={{
          fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 3,
          fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.06em",
          background: schemaSc.bg, color: schemaSc.text, border: `1px solid ${schemaSc.border}`,
        }}>
          {info?.schema || "IFC"}
        </span>
        <div style={{ flex: 1 }} />
        <div style={{
          width: 14, height: 14, borderRadius: 3, flexShrink: 0,
          border: `1px solid ${checked ? "rgba(91,140,255,0.7)" : "var(--border-bright)"}`,
          background: checked ? "rgba(91,140,255,0.12)" : "transparent",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {checked && <Check size={9} color="#5B8CFF" />}
        </div>
      </div>
      <div style={{
        fontSize: 11, fontWeight: 700, color: "var(--text-bright)",
        fontFamily: "JetBrains Mono, monospace",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }} title={filename}>
        {filename.replace(/\.ifc$/i, "")}
      </div>
      {info && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 8px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 9.5, color: "var(--border-bright)" }}>
            <Cpu size={10} /> {info.element_count.toLocaleString()}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 9.5, color: "var(--border-bright)" }}>
            <HardDrive size={10} /> {info.file_size_mb} MB
          </div>
        </div>
      )}
    </div>
  );
});

// ── Page ──────────────────────────────────────────────────────────────────────

export default function IfcPlanningSetsPage() {
  const { files: storeFiles, fileInfos, selectedPaths, setSelectedPaths, toggleFileSelection } = useProjectStore();

  const allSelected = storeFiles.length > 0 && storeFiles.every(f => selectedPaths.includes(f.path));
  function toggleSelectAll() {
    setSelectedPaths(allSelected ? [] : storeFiles.map(f => f.path));
  }
  const checkedFiles = storeFiles.filter(f => selectedPaths.includes(f.path));

  const [detecting, setDetecting] = useState(false);
  const [matched, setMatched] = useState<MatchedRow[] | null>(null);
  const [unmatchedInModel, setUnmatchedInModel] = useState<UnmatchedModelRow[]>([]);
  const [unmatchedInPB, setUnmatchedInPB] = useState<PlanningActivity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createLog, setCreateLog] = useState<{ filename: string; ok: boolean; message: string }[]>([]);

  async function detectAndMatch() {
    if (checkedFiles.length === 0) return;
    setDetecting(true);
    setError(null);
    setMatched(null);
    setUnmatchedInModel([]);
    setUnmatchedInPB([]);
    setCreateLog([]);
    try {
      const pathsQuery = checkedFiles.map(f => `paths=${encodeURIComponent(f.path)}`).join("&");
      const [valuesRes, activities] = await Promise.all([
        fetch(`${API}/api/ifc/property-values?${pathsQuery}&pset=${encodeURIComponent(PSET_NAME)}&prop=${encodeURIComponent(PROP_NAME)}`)
          .then(r => r.json()),
        getPB().collection("master_planning_activities").getFullList<PlanningActivity>(),
      ]);

      const values: { value: string; count: number }[] = valuesRes.values ?? [];
      const byCodigo = new Map(activities.map(a => [a.codigo_actividad, a.descripcion_actividad]));

      const matchedRows: MatchedRow[] = [];
      const unmatchedModel: UnmatchedModelRow[] = [];
      for (const v of values) {
        const desc = byCodigo.get(v.value);
        if (desc !== undefined) {
          matchedRows.push({ codigo: v.value, descripcion: desc, count: v.count, checked: true });
        } else {
          unmatchedModel.push({ codigo: v.value, count: v.count });
        }
      }
      matchedRows.sort((a, b) => a.codigo.localeCompare(b.codigo, undefined, { numeric: true }));
      unmatchedModel.sort((a, b) => a.codigo.localeCompare(b.codigo, undefined, { numeric: true }));

      const modelCodigos = new Set(values.map(v => v.value));
      const pbOnly = activities
        .filter(a => !modelCodigos.has(a.codigo_actividad))
        .sort((a, b) => a.codigo_actividad.localeCompare(b.codigo_actividad, undefined, { numeric: true }));

      setMatched(matchedRows);
      setUnmatchedInModel(unmatchedModel);
      setUnmatchedInPB(pbOnly);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error al detectar/cruzar valores");
    } finally {
      setDetecting(false);
    }
  }

  function toggleMatched(codigo: string) {
    setMatched(prev => prev ? prev.map(r => r.codigo === codigo ? { ...r, checked: !r.checked } : r) : prev);
  }

  const selectedCount = useMemo(() => (matched ?? []).filter(r => r.checked).length, [matched]);

  async function createSets() {
    if (!matched) return;
    const items = matched.filter(r => r.checked).map(r => ({ name: `${r.codigo} - ${r.descripcion}`, values: [r.codigo] }));
    if (items.length === 0 || checkedFiles.length === 0) return;

    setCreating(true);
    setCreateLog([]);
    for (const f of checkedFiles) {
      try {
        const res = await fetch(`${API}/api/ifc/groups/create-named`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: f.path, pset_name: PSET_NAME, prop_name: PROP_NAME, items }),
        });
        const d = await res.json();
        setCreateLog(prev => [...prev, {
          filename: f.filename, ok: res.ok && d.ok,
          message: res.ok
            ? (d.created > 0 ? `${d.created} conjuntos creados` : (d.message ?? "Sin elementos con esa propiedad"))
            : (d.detail ?? "Error al crear los conjuntos"),
        }]);
      } catch (e: unknown) {
        setCreateLog(prev => [...prev, { filename: f.filename, ok: false, message: e instanceof Error ? e.message : "Error" }]);
      }
    }
    setCreating(false);
  }

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      height: "calc(100vh - var(--navbar-h) - var(--toolbar-h) - 48px)",
      overflow: "hidden",
    }}>
      {/* ── Header ── */}
      <div style={{ marginBottom: 14, flexShrink: 0 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--cyan)", letterSpacing: "0.04em" }}>
          PLANNING SETS
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
          Selecciona modelos, detecta los valores de <code style={{ color: "var(--cyan)" }}>ADIF_04_Codigo_Actividad</code> presentes
          y crea un conjunto (<code style={{ color: "var(--cyan)" }}>IfcSystem</code>) por cada actividad, cruzando el
          nombre contra <code style={{ color: "var(--cyan)" }}>master_planning_activities</code> en PocketBase.
        </p>
      </div>

      {/* ── Main layout ── */}
      <div style={{
        display: "grid", gridTemplateColumns: "minmax(220px, 320px) minmax(0, 1fr)", gap: 16,
        flex: 1, minHeight: 0,
      }}>
        {/* ── LEFT: model selection ── */}
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
                <CalendarClock size={48} strokeWidth={1} style={{ opacity: 0.15, marginBottom: 10 }} />
                <div style={{ fontSize: 14, color: "var(--text-muted)", fontWeight: 600, marginBottom: 6 }}>
                  Sin modelos cargados
                </div>
                <div style={{ fontSize: 12, color: "var(--dim)" }}>
                  Añade fuentes IFC en la página <strong style={{ color: "var(--cyan)" }}>Models</strong>.
                </div>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
                {storeFiles.map(f => (
                  <ModelCard
                    key={f.path}
                    filename={f.filename}
                    info={fileInfos[f.path]}
                    checked={selectedPaths.includes(f.path)}
                    onCheckToggle={() => toggleFileSelection(f.path)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── RIGHT: detect + match + create ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", overflowY: "auto", paddingBottom: 4 }}>
          {checkedFiles.length === 0 ? (
            <div className="card-cyber" style={{ padding: 48, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
              <CalendarClock size={32} style={{ opacity: 0.3, marginBottom: 8 }} />
              <div>Marca uno o varios modelos a la izquierda para detectar sus actividades.</div>
            </div>
          ) : (
            <div className="card-cyber" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{
                fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase",
                letterSpacing: "0.1em", fontFamily: "JetBrains Mono, monospace", fontWeight: 600,
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
              }}>
                <span>Detectar actividades</span>
                <span style={{
                  fontSize: 9, padding: "2px 8px", borderRadius: 3, fontWeight: 400,
                  fontFamily: "JetBrains Mono, monospace", textTransform: "none", letterSpacing: 0,
                  background: "rgba(91,140,255,0.08)", color: "var(--cyan)", border: "1px solid rgba(91,140,255,0.25)",
                }}>
                  → {checkedFiles.length} modelo{checkedFiles.length > 1 ? "s" : ""}
                </span>
              </div>

              <button
                onClick={detectAndMatch}
                disabled={detecting}
                style={{
                  padding: "7px 0", fontSize: 10.5, fontWeight: 700,
                  background: "rgba(91,140,255,0.07)", border: "1px solid rgba(91,140,255,0.28)",
                  borderRadius: 4, color: "var(--cyan)", cursor: "pointer",
                  fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.03em",
                  opacity: detecting ? 0.6 : 1,
                }}
              >
                {detecting ? "Detectando y cruzando con PocketBase…" : "DETECTAR Y CRUZAR CON PB"}
              </button>

              {error && (
                <div style={{ fontSize: 11, color: "var(--red)", display: "flex", alignItems: "center", gap: 6 }}>
                  <AlertCircle size={12} /> {error}
                </div>
              )}

              {matched && (
                <>
                  {matched.length === 0 ? (
                    <div style={{ fontSize: 11, color: "rgba(217,164,65,0.8)", fontFamily: "JetBrains Mono, monospace" }}>
                      Ningún valor de {PROP_NAME} coincide con master_planning_activities.
                    </div>
                  ) : (
                    <div style={{ border: "1px solid var(--border)", borderRadius: 4, padding: "8px 10px", background: "rgba(255,255,255,0.02)" }}>
                      <div style={{ fontSize: 10.5, color: "var(--text-muted)", fontFamily: "JetBrains Mono, monospace", marginBottom: 6 }}>
                        {matched.length} actividades con coincidencia en PB — elige cuáles crear
                      </div>
                      <div style={{ maxHeight: 220, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
                        {matched.map(r => (
                          <div
                            key={r.codigo}
                            onClick={() => toggleMatched(r.codigo)}
                            style={{
                              display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between",
                              fontSize: 10.5, fontFamily: "JetBrains Mono, monospace", padding: "3px 4px",
                              cursor: "pointer", borderRadius: 3,
                              background: r.checked ? "rgba(91,140,255,0.05)" : "transparent",
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                              <span style={{
                                width: 13, height: 13, borderRadius: 3, flexShrink: 0,
                                border: `1px solid ${r.checked ? "rgba(91,140,255,0.7)" : "var(--border-bright)"}`,
                                background: r.checked ? "rgba(91,140,255,0.15)" : "transparent",
                                display: "flex", alignItems: "center", justifyContent: "center",
                              }}>
                                {r.checked && <Check size={9} color="#5B8CFF" />}
                              </span>
                              <span style={{
                                color: r.checked ? "var(--text)" : "var(--text-muted)",
                                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                              }} title={`${r.codigo} - ${r.descripcion}`}>
                                {r.codigo} - {r.descripcion}
                              </span>
                            </div>
                            <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>{r.count} elem.</span>
                          </div>
                        ))}
                      </div>
                      <button
                        onClick={createSets}
                        disabled={creating || selectedCount === 0}
                        className="btn btn-magenta"
                        style={{
                          marginTop: 10, width: "100%", padding: "9px 0", fontSize: 12, fontWeight: 700,
                          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                          opacity: selectedCount === 0 ? 0.5 : 1,
                        }}
                      >
                        <Play size={12} />
                        {creating
                          ? "Creando…"
                          : `CREAR ${selectedCount} CONJUNTO${selectedCount === 1 ? "" : "S"}${checkedFiles.length > 1 ? ` × ${checkedFiles.length} MODELOS` : ""}`}
                      </button>
                    </div>
                  )}

                  {(unmatchedInModel.length > 0 || unmatchedInPB.length > 0) && (
                    <div style={{ border: "1px solid rgba(217,164,65,0.25)", borderRadius: 4, padding: "8px 10px", background: "rgba(217,164,65,0.03)" }}>
                      <div style={{ fontSize: 10.5, color: "rgba(217,164,65,0.85)", fontFamily: "JetBrains Mono, monospace", marginBottom: 6 }}>
                        Sin coincidencia — revisar
                      </div>
                      {unmatchedInModel.length > 0 && (
                        <div style={{ marginBottom: unmatchedInPB.length > 0 ? 8 : 0 }}>
                          <div style={{ fontSize: 9, color: "var(--text-muted)", marginBottom: 3, fontFamily: "JetBrains Mono, monospace" }}>
                            En el modelo pero no en master_planning_activities:
                          </div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                            {unmatchedInModel.map(u => (
                              <span key={u.codigo} title={`${u.count} elem.`} style={{
                                fontSize: 9.5, padding: "2px 6px", borderRadius: 3,
                                fontFamily: "JetBrains Mono, monospace",
                                background: "rgba(217,164,65,0.08)", color: "rgba(217,164,65,0.9)",
                                border: "1px solid rgba(217,164,65,0.25)",
                              }}>
                                {u.codigo}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      {unmatchedInPB.length > 0 && (
                        <div>
                          <div style={{ fontSize: 9, color: "var(--text-muted)", marginBottom: 3, fontFamily: "JetBrains Mono, monospace" }}>
                            En master_planning_activities pero sin elementos en estos modelos:
                          </div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                            {unmatchedInPB.map(a => (
                              <span key={a.codigo_actividad} title={a.descripcion_actividad} style={{
                                fontSize: 9.5, padding: "2px 6px", borderRadius: 3,
                                fontFamily: "JetBrains Mono, monospace",
                                background: "var(--border)", color: "var(--text-muted)",
                                border: "1px solid var(--text-muted)",
                              }}>
                                {a.codigo_actividad}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </>
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
