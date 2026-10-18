"use client";

/**
 * IFC Name + ID Objeto
 *
 * Lee el parámetro ADIF_00_Id_Objeto de cada elemento IFC y propone renombrarlo
 * como NombreActual_IdObjeto. Aplica de forma masiva o grupo a grupo.
 *
 * Los archivos a procesar se toman del árbol de selección (projectStore.selectedPaths).
 * No re-lista los modelos — para eso está el árbol lateral.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { Search, RefreshCw, Zap, Check, Loader2 } from "lucide-react";
import { useProjectStore } from "@/stores/projectStore";
import { API_URL } from "@/lib/api";

// ── Types ─────────────────────────────────────────────────────────────────
interface ElementRow {
  step_id: number;
  entity_type: string;
  current_name: string;
  id_objeto: string;
  new_name: string;
  has_change: boolean;
  applied: boolean;
  path: string;
  filename: string;
}

interface GroupRow {
  current_name: string;
  id_objeto: string;
  new_name: string;
  has_change: boolean;
  applied: boolean;
  entity_type: string;
  count: number;
  file_count: number;
  paths_items: Record<string, { step_id: number }[]>;  // path → step_ids for apply
}

type FilterStatus = "all" | "pending" | "done" | "no_id";

// ── Component ───────────────────────────────────────────────────────────────
export default function IFCNameTypeIdPage() {
  const { files: storeFiles, selectedPaths } = useProjectStore();

  const [rows, setRows] = useState<ElementRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");
  const [filterStatus, setFilterStatus] = useState<FilterStatus>("all");
  const [applying, setApplying] = useState(false);
  const [applyMsg, setApplyMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // Only operate on files checked in the selection tree
  const targetPaths = useMemo(() => selectedPaths, [selectedPaths]);

  // ── Load elements ─────────────────────────────────────────────────────────
  const loadElements = useCallback(async () => {
    if (targetPaths.length === 0) { setRows([]); return; }
    setLoading(true);
    setError(null);
    setApplyMsg(null);
    try {
      const res = await fetch(`${API_URL}/api/ifc/name-id-elements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: targetPaths }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: { rows: ElementRow[]; errors: string[] } = await res.json();
      setRows(json.rows);
      if (json.errors?.length) setError(json.errors.join(" · "));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error desconocido");
    } finally {
      setLoading(false);
    }
  }, [targetPaths]);

  useEffect(() => { loadElements(); }, [loadElements]);

  // ── Group by (current_name, id_objeto) ──────────────────────────────────────
  const groups = useMemo<GroupRow[]>(() => {
    const map = new Map<string, GroupRow>();
    for (const r of rows) {
      const key = `${r.current_name}||${r.id_objeto}`;
      let g = map.get(key);
      if (!g) {
        g = {
          current_name: r.current_name,
          id_objeto: r.id_objeto,
          new_name: r.new_name,
          has_change: r.has_change,
          applied: r.applied,
          entity_type: r.entity_type,
          count: 0,
          file_count: 0,
          paths_items: {},
        };
        map.set(key, g);
      }
      g.count += 1;
      if (r.applied) g.applied = true;
      if (r.has_change && !r.applied) {
        if (!g.paths_items[r.path]) g.paths_items[r.path] = [];
        g.paths_items[r.path].push({ step_id: r.step_id });
      }
    }
    // file_count = distinct files per group
    for (const [key, g] of Array.from(map.entries())) {
      const files = new Set(rows.filter(r => `${r.current_name}||${r.id_objeto}` === key).map(r => r.filename));
      g.file_count = files.size;
    }
    return Array.from(map.values()).sort((a, b) => a.current_name.toLowerCase().localeCompare(b.current_name.toLowerCase()));
  }, [rows]);

  // ── Counts ───────────────────────────────────────────────────────────────
  const pendingCount = groups.filter(g => g.has_change && !g.applied).length;
  const doneCount    = groups.filter(g => g.applied).length;
  const noIdCount    = groups.filter(g => !g.id_objeto).length;

  // ── Filtered ─────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let r = groups;
    if (filterText) {
      const ft = filterText.toLowerCase();
      r = r.filter(g =>
        g.current_name.toLowerCase().includes(ft) ||
        g.id_objeto.toLowerCase().includes(ft) ||
        g.new_name.toLowerCase().includes(ft)
      );
    }
    if (filterStatus === "pending") r = r.filter(g => g.has_change && !g.applied);
    else if (filterStatus === "done") r = r.filter(g => g.applied);
    else if (filterStatus === "no_id") r = r.filter(g => !g.id_objeto);
    return r;
  }, [groups, filterText, filterStatus]);

  // ── Apply helpers ─────────────────────────────────────────────────────────
  const buildChanges = useCallback((targetRows: ElementRow[]) => {
    const changes: Record<string, { step_id: number; new_name: string }[]> = {};
    for (const r of targetRows) {
      if (!r.has_change || r.applied) continue;
      if (!changes[r.path]) changes[r.path] = [];
      changes[r.path].push({ step_id: r.step_id, new_name: r.new_name });
    }
    return changes;
  }, []);

  const applyChanges = useCallback(async (changes: Record<string, { step_id: number; new_name: string }[]>, label: string) => {
    const totalItems = Object.values(changes).reduce((s, a) => s + a.length, 0);
    if (totalItems === 0) {
      setApplyMsg({ text: "No hay elementos pendientes de aplicar", ok: false });
      return;
    }
    setApplying(true);
    setApplyMsg(null);
    try {
      const res = await fetch(`${API_URL}/api/ifc/name-id-apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: { total_changed: number } = await res.json();
      // Mark applied rows locally
      const appliedKeys = new Set<string>();
      for (const [path, items] of Object.entries(changes)) {
        for (const it of items) appliedKeys.add(`${path}||${it.step_id}`);
      }
      setRows(prev => prev.map(r =>
        appliedKeys.has(`${r.path}||${r.step_id}`)
          ? { ...r, current_name: r.new_name, applied: true, has_change: false }
          : r
      ));
      setApplyMsg({ text: `${json.total_changed} elemento(s) renombrados · ${label}`, ok: true });
    } catch (e) {
      setApplyMsg({ text: e instanceof Error ? e.message : "Error al aplicar", ok: false });
    } finally {
      setApplying(false);
    }
  }, []);

  const applyAll = useCallback(() => {
    applyChanges(buildChanges(rows), "todos");
  }, [rows, buildChanges, applyChanges]);

  const applyGroup = useCallback((g: GroupRow) => {
    const changes: Record<string, { step_id: number; new_name: string }[]> = {};
    for (const [path, items] of Object.entries(g.paths_items)) {
      changes[path] = items.map(it => ({ step_id: it.step_id, new_name: g.new_name }));
    }
    applyChanges(changes, `'${g.current_name}'`);
  }, [applyChanges]);

  // ── Render ──────────────────────────────────────────────────────────────
  const fileLabel = selectedPaths.length > 0
    ? `${selectedPaths.length} archivo${selectedPaths.length > 1 ? "s" : ""} seleccionado${selectedPaths.length > 1 ? "s" : ""}`
    : "ningún archivo seleccionado — usa el árbol";

  return (
    <div style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      {/* ── Header ── */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{
          fontSize: 20, fontWeight: 700, color: "var(--cyan)", letterSpacing: "0.08em", margin: 0,
          display: "flex", alignItems: "center", gap: 8,
        }}>
          IFC Name + ID
          <span style={{
            fontSize: 10, fontWeight: 400, color: "var(--text-muted)",
            background: "rgba(91,140,255,0.08)", border: "1px solid rgba(91,140,255,0.2)",
            borderRadius: 4, padding: "2px 8px",
          }}>
            NombreActual + _ + ADIF_00_Id_Objeto
          </span>
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
          Lee el parámetro ADIF_00_Id_Objeto de cada elemento IFC y propone renombrarlo como NombreActual_IdObjeto. Aplica de forma masiva o grupo a grupo.
        </p>
      </div>

      {/* ── Source bar ── */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        background: "var(--surface)", border: "1px solid var(--border)",
        borderRadius: 8, padding: "8px 14px", marginBottom: 14,
      }}>
        <span style={{ fontSize: 12, color: "var(--text)" }}>
          <strong style={{ color: "var(--cyan)" }}>{fileLabel}</strong>
          <span style={{ color: "var(--text-muted)", marginLeft: 8 }}>
            · usa el árbol de selección para elegir archivos
          </span>
        </span>
        <button
          onClick={loadElements}
          disabled={loading}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            background: "rgba(91,140,255,0.08)", border: "1px solid var(--cyan)",
            color: "var(--cyan)", borderRadius: 6, padding: "6px 14px",
            fontSize: 11, fontWeight: 700, fontFamily: "inherit", cursor: "pointer",
          }}
        >
          {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
          Recargar
        </button>
      </div>

      {error && (
        <div style={{
          background: "rgba(255,51,85,0.1)", border: "1px solid var(--red)",
          borderRadius: 6, padding: "8px 14px", marginBottom: 14,
          color: "var(--red)", fontSize: 11,
        }}>
          {error}
        </div>
      )}

      {/* ── KPIs + search + filters ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 16, marginBottom: 14, flexWrap: "wrap",
      }}>
        <span style={{ fontSize: 12, color: "var(--cyan)", fontWeight: 700 }}>
          {rows.length} elem
        </span>
        <span style={{ fontSize: 12, color: "var(--yellow)" }}>
          {pendingCount} pendientes
        </span>
        <span style={{ fontSize: 12, color: "var(--green)" }}>
          {doneCount} aplicados
        </span>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {noIdCount} sin ID
        </span>
      </div>

      {/* ── Search bar ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        background: "var(--surface)", border: "1px solid var(--border)",
        borderRadius: 8, padding: "8px 14px", marginBottom: 12,
      }}>
        <Search size={15} color="var(--text-muted)" />
        <input
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder="Buscar nombre, ID o nuevo nombre..."
          style={{
            flex: 1, background: "transparent", border: "none", outline: "none",
            color: "var(--text)", fontSize: 12, fontFamily: "inherit",
          }}
        />
      </div>

      {/* ── Filter chips + apply all ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {([
          { id: "all",     label: `Todos` },
          { id: "pending", label: `Pendientes ${pendingCount}` },
          { id: "done",    label: `Aplicados ${doneCount}` },
          { id: "no_id",   label: `Sin ID ${noIdCount}` },
        ] as { id: FilterStatus; label: string }[]).map(f => {
          const active = filterStatus === f.id;
          return (
            <button
              key={f.id}
              onClick={() => setFilterStatus(f.id)}
              style={{
                padding: "6px 14px", borderRadius: 20, fontSize: 11,
                fontFamily: "inherit", fontWeight: 700, cursor: "pointer",
                background: active ? "rgba(91,140,255,0.12)" : "transparent",
                border: active ? "1px solid var(--cyan)" : "1px solid var(--border)",
                color: active ? "var(--cyan)" : "var(--text-muted)",
                transition: "all 0.15s",
              }}
            >
              {f.label}
            </button>
          );
        })}

        <div style={{ flex: 1 }} />

        <button
          onClick={applyAll}
          disabled={applying || pendingCount === 0}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "8px 18px", borderRadius: 6, fontSize: 12, fontWeight: 700,
            fontFamily: "inherit", cursor: pendingCount === 0 ? "not-allowed" : "pointer",
            background: pendingCount === 0 ? "var(--border)" : "rgba(122,111,217,0.12)",
            border: `1px solid ${pendingCount === 0 ? "var(--border)" : "var(--magenta)"}`,
            color: pendingCount === 0 ? "var(--text-muted)" : "var(--magenta)",
            opacity: applying ? 0.6 : 1,
          }}
        >
          {applying ? <Loader2 size={14} className="spin" /> : <Zap size={14} />}
          Aplicar todos ({pendingCount})
        </button>
      </div>

      {applyMsg && (
        <div style={{
          background: applyMsg.ok ? "rgba(63,190,138,0.1)" : "rgba(255,51,85,0.1)",
          border: `1px solid ${applyMsg.ok ? "var(--green)" : "var(--red)"}`,
          borderRadius: 6, padding: "8px 14px", marginBottom: 14,
          color: applyMsg.ok ? "var(--green)" : "var(--red)", fontSize: 12,
        }}>
          {applyMsg.ok ? "✅ " : ""}{applyMsg.text}
        </div>
      )}

      {/* ── Table ── */}
      <div className="card-cyber" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: "rgba(255,255,255,0.02)" }}>
                {["TIPO", "NOMBRE ACTUAL", "ID_OBJETO", "→ NOMBRE NUEVO", "ELEM", ""].map((col) => (
                  <th key={col} style={{
                    padding: "10px 14px", textAlign: "left",
                    fontSize: 10, color: "var(--text-muted)", fontWeight: 700,
                    letterSpacing: "0.08em", borderBottom: "1px solid var(--border)",
                    whiteSpace: "nowrap",
                  }}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((g, i) => {
                const isApplied = g.applied;
                const isPending = g.has_change && !g.applied;
                const noId      = !g.id_objeto;
                return (
                  <tr key={i} style={{
                    borderBottom: "1px solid rgba(30,45,74,0.5)",
                    borderLeft: isApplied ? "3px solid rgba(63,190,138,0.5)"
                      : isPending ? "3px solid rgba(217,164,65,0.5)"
                      : "3px solid var(--border-bright)",
                  }}>
                    {/* TIPO */}
                    <td style={{ padding: "8px 14px" }}>
                      <span style={{
                        fontSize: 9, fontWeight: 700, color: "var(--cyan)",
                        background: "rgba(91,140,255,0.08)", border: "1px solid rgba(91,140,255,0.2)",
                        borderRadius: 3, padding: "2px 6px",
                      }}>
                        {g.entity_type.replace(/^Ifc/, "")}
                      </span>
                    </td>
                    {/* NOMBRE ACTUAL */}
                    <td style={{ padding: "8px 14px", color: "var(--text)", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        title={g.current_name}>
                      {g.current_name || <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>(vacío)</span>}
                    </td>
                    {/* ID_OBJETO */}
                    <td style={{ padding: "8px 14px" }}>
                      {g.id_objeto ? (
                        <span style={{
                          fontSize: 11, fontWeight: 700, color: "var(--green)",
                          background: "rgba(63,190,138,0.1)", border: "1px solid rgba(63,190,138,0.3)",
                          borderRadius: 4, padding: "2px 8px",
                        }}>
                          {g.id_objeto}
                        </span>
                      ) : (
                        <span style={{ color: "var(--text-muted)", fontStyle: "italic", fontSize: 11 }}>sin ID</span>
                      )}
                    </td>
                    {/* NOMBRE NUEVO */}
                    <td style={{ padding: "8px 14px", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        title={g.new_name}>
                      {noId ? (
                        <span style={{ color: "var(--text-muted)" }}>—</span>
                      ) : isApplied ? (
                        <span style={{ color: "var(--green)", display: "flex", alignItems: "center", gap: 4 }}>
                          <Check size={12} /> {g.current_name}
                        </span>
                      ) : (
                        <span style={{ color: "var(--magenta)" }}>{g.new_name}</span>
                      )}
                    </td>
                    {/* ELEM */}
                    <td style={{ padding: "8px 14px", color: "var(--text-muted)", fontSize: 11, whiteSpace: "nowrap" }}>
                      {g.count} elem
                      {g.file_count > 1 && <span style={{ opacity: 0.6 }}> · {g.file_count} arch</span>}
                    </td>
                    {/* ACTION */}
                    <td style={{ padding: "8px 14px", textAlign: "right", whiteSpace: "nowrap" }}>
                      {isPending && (
                        <button
                          onClick={() => applyGroup(g)}
                          disabled={applying}
                          style={{
                            display: "inline-flex", alignItems: "center", gap: 4,
                            fontSize: 10, fontWeight: 700, fontFamily: "inherit",
                            background: "rgba(122,111,217,0.1)", border: "1px solid var(--magenta)",
                            color: "var(--magenta)", borderRadius: 4, padding: "3px 10px",
                            cursor: "pointer",
                          }}
                        >
                          <Zap size={11} /> Aplicar
                        </button>
                      )}
                      {isApplied && (
                        <span style={{ fontSize: 10, color: "var(--green)", display: "inline-flex", alignItems: "center", gap: 3 }}>
                          <Check size={12} /> Aplicado
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 && !loading && (
            <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>
              {rows.length === 0
                ? "Selecciona archivos en el árbol y pulsa Recargar"
                : "Sin resultados para el filtro seleccionado"}
            </div>
          )}
          {loading && (
            <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <Loader2 size={16} className="spin" /> Leyendo elementos...
            </div>
          )}
        </div>
      </div>

      <style jsx>{`
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
