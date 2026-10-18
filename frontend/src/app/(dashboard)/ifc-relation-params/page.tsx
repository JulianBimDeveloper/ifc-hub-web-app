"use client";
import { useEffect, useState, useCallback } from "react";
import { RefreshCw } from "lucide-react";
import { useProjectStore } from "@/stores/projectStore";

const API = "http://127.0.0.1:8020";

const MANDATORY = [
  { name: "ADIF_00_Codigo_Producto", desc: "Código único del producto en el catálogo ADIF. Requerido para MasterSync.", example: "ADI-001" },
  { name: "ADIF_02_Zonificacion",    desc: "Código de zonificación del proyecto. Lookup en master_zonificacion.", example: "ZON-A1" },
  { name: "ADIF_03_Codigo_Estado",   desc: "Estado del elemento (S1, S2, S3, S4). Lookup en master_estados.", example: "S1" },
  { name: "ADIF_03_Fuente_Definicion", desc: "Fuente que define el elemento (proyecto, contrato, etc.).", example: "PROYECTO" },
  { name: "ADIF_04_Codigo_Actividad", desc: "Código de actividad de planificación. Lo rellena el modelador; lo usa Auto Planning.", example: "ACT-014" },
  { name: "ADIF_05_Codigo_Partida",   desc: "Código de partida de presupuesto. Lo rellena el modelador; lo usa Auto Cost.", example: "01.02.03" },
];

const AUTOFILL = [
  { source: "master_productos",    target: "ADIF_01_Descripcion_Producto", key: "ADIF_00_Codigo_Producto", color: "#5B8CFF" },
  { source: "master_productos",    target: "ADIF_04_Unidad",               key: "ADIF_00_Codigo_Producto", color: "#5B8CFF" },
  { source: "master_productos",    target: "ADIF_05_Disciplina",           key: "ADIF_00_Codigo_Producto", color: "#5B8CFF" },
  { source: "master_zonificacion", target: "ADIF_02_Descripcion_Zona",     key: "ADIF_02_Zonificacion",    color: "#7A6FD9" },
  { source: "master_estados",      target: "ADIF_03_Descripcion_Estado",   key: "ADIF_03_Codigo_Estado",   color: "#3FBE8A" },
];

const SYNC_INFO = [
  { name: "INGR_Disciplina_Modelo", source: "filename", desc: "Último segmento del nombre de archivo. Ej: MEA_TELECO.rvt → TELECO" },
  { name: "INGR_Fecha_Emision",     source: "runtime",  desc: "DateTime.Now en el momento del Sync (siempre actualizado)" },
  { name: "INGR_IFC_GUID",          source: "revit",    desc: "GUID generado por Revit. Ignorado si vacío (IgnoreIfEmpty)" },
];

// Short labels for the summary table header — the full names don't fit in a column.
const SUMMARY_PARAMS = MANDATORY.map(p => p.name);
const SHORT_LABEL: Record<string, string> = {
  ADIF_00_Codigo_Producto:   "00 Producto",
  ADIF_02_Zonificacion:      "02 Zona",
  ADIF_03_Codigo_Estado:     "03 Estado",
  ADIF_03_Fuente_Definicion: "03 Fuente",
  ADIF_04_Codigo_Actividad:  "04 Actividad",
  ADIF_05_Codigo_Partida:    "05 Partida",
};

interface ParamCount { ok: number; bad: number }
interface ModelStatus {
  total_elements: number;
  params: Record<string, ParamCount>;
  error?: string;
}

function pct(ok: number, total: number): number {
  return total > 0 ? Math.round((ok / total) * 100) : 0;
}

function cellColor(p: number): string {
  if (p >= 95) return "var(--green)";
  if (p >= 60) return "var(--yellow)";
  return "var(--red)";
}

export default function RelationParamsPage() {
  const { files: storeFiles } = useProjectStore();

  const [status, setStatus] = useState<Record<string, ModelStatus>>({});
  const [loading, setLoading] = useState(false);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  const loadSummary = useCallback(async () => {
    if (storeFiles.length === 0) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/ifc/mandatory-params-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: storeFiles.map(f => f.path) }),
      });
      const data = await res.json();
      setStatus(data);
      setLoadedAt(Date.now());
    } catch {
      // Silencioso — resumen informativo, no bloquea el resto de la página.
    } finally {
      setLoading(false);
    }
  }, [storeFiles]);

  // Auto-carga al entrar en la página — es un resumen rápido (caché de modelos),
  // no requiere que el usuario pulse nada para ver el estado.
  useEffect(() => { loadSummary(); }, [loadSummary]);

  return (
    <>
      <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--cyan)", letterSpacing: "0.04em" }}>
            RELATION PARAMS
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
            Parámetros obligatorios y reglas de auto-relleno para cumplimiento ADIF
          </p>
        </div>

        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, color: "var(--red)", textTransform: "uppercase",
            letterSpacing: "0.08em", marginBottom: 10, fontWeight: 700 }}>
            Parámetros obligatorios (MasterSync + Auto Planning/Auto Cost)
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {MANDATORY.map(p => (
              <div key={p.name} style={{ background: "var(--surface)", border: "1px solid rgba(255,51,85,0.4)",
                borderRadius: 6, padding: "12px 14px" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-bright)", marginBottom: 4 }}>
                  {p.name}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>{p.desc}</div>
                <span style={{ fontSize: 10, color: "var(--cyan)", background: "rgba(91,140,255,0.06)",
                  borderRadius: 3, padding: "2px 6px" }}>
                  Ej: {p.example}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Resumen gerencial por modelo ── */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: "var(--cyan)", textTransform: "uppercase",
              letterSpacing: "0.08em", fontWeight: 700 }}>
              Resumen por modelo — cumplimiento de códigos obligatorios
            </div>
            <button onClick={loadSummary} disabled={loading || storeFiles.length === 0} style={{
              display: "flex", alignItems: "center", gap: 5, padding: "4px 9px", fontSize: 9.5, fontWeight: 700,
              background: "rgba(91,140,255,0.06)", border: "1px solid rgba(91,140,255,0.25)",
              borderRadius: 4, color: "var(--cyan)", cursor: storeFiles.length === 0 ? "default" : "pointer",
              fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.03em",
              opacity: loading || storeFiles.length === 0 ? 0.5 : 1,
            }}>
              <RefreshCw size={11} className={loading ? "spin" : ""} />
              {loading ? "CALCULANDO…" : "ACTUALIZAR"}
            </button>
          </div>

          {storeFiles.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "16px 4px" }}>
              Sin modelos cargados — añade fuentes IFC en la página <strong style={{ color: "var(--cyan)" }}>Models</strong>.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="table-cyber">
                <thead>
                  <tr>
                    <th>Modelo</th>
                    <th style={{ textAlign: "right" }}>Elementos</th>
                    {SUMMARY_PARAMS.map(name => (
                      <th key={name} style={{ textAlign: "center" }} title={name}>{SHORT_LABEL[name]}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {storeFiles.map(f => {
                    const s = status[f.path];
                    return (
                      <tr key={f.path}>
                        <td style={{ color: "var(--text-bright)", fontWeight: 600, fontFamily: "JetBrains Mono, monospace",
                          fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220 }}
                          title={f.filename}>
                          {f.filename.replace(/\.ifc$/i, "")}
                        </td>
                        <td style={{ textAlign: "right", color: "var(--text-muted)", fontSize: 11 }}>
                          {s ? s.total_elements.toLocaleString() : (loading ? "…" : "—")}
                        </td>
                        {SUMMARY_PARAMS.map(name => {
                          const c = s?.params?.[name];
                          if (!s || !c) {
                            return <td key={name} style={{ textAlign: "center", color: "var(--dim)", fontSize: 11 }}>
                              {loading ? "…" : "—"}
                            </td>;
                          }
                          const p = pct(c.ok, s.total_elements);
                          const color = cellColor(p);
                          return (
                            <td key={name} style={{ textAlign: "center" }} title={`${c.ok} OK / ${c.bad} sin código`}>
                              <span style={{
                                fontSize: 11, fontWeight: 700, fontFamily: "JetBrains Mono, monospace",
                                color, background: `${color}18`, border: `1px solid ${color}44`,
                                borderRadius: 3, padding: "1px 7px",
                              }}>
                                {p}%
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {loadedAt && (
                <div style={{ fontSize: 9.5, color: "var(--dim)", marginTop: 6, fontFamily: "JetBrains Mono, monospace" }}>
                  % de elementos con el código bien rellenado (no vacío, no &quot;N/A&quot;) sobre el total de elementos del modelo.
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, color: "var(--green)", textTransform: "uppercase",
            letterSpacing: "0.08em", marginBottom: 10, fontWeight: 700 }}>
            Auto-relleno desde PocketBase
          </div>
          <table className="table-cyber">
            <thead><tr><th>Tabla origen</th><th>Clave lookup</th><th>Parámetro rellenado</th></tr></thead>
            <tbody>
              {AUTOFILL.map((r, i) => (
                <tr key={i}>
                  <td>
                    <span style={{ background: `${r.color}18`, color: r.color,
                      border: `1px solid ${r.color}44`, borderRadius: 3,
                      padding: "1px 7px", fontSize: 11, fontWeight: 600 }}>
                      {r.source}
                    </span>
                  </td>
                  <td style={{ color: "var(--text-muted)", fontSize: 11 }}>{r.key}</td>
                  <td style={{ color: "var(--text-bright)", fontWeight: 600 }}>{r.target}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <div style={{ fontSize: 11, color: "var(--yellow)", textTransform: "uppercase",
            letterSpacing: "0.08em", marginBottom: 10, fontWeight: 700 }}>
            Parámetros de sincronización (auto)
          </div>
          <table className="table-cyber">
            <thead><tr><th>Parámetro</th><th>Origen</th><th>Descripción</th></tr></thead>
            <tbody>
              {SYNC_INFO.map((r, i) => (
                <tr key={i}>
                  <td style={{ color: "var(--text-bright)", fontWeight: 600 }}>{r.name}</td>
                  <td><span className="badge badge-dim">{r.source}</span></td>
                  <td style={{ color: "var(--text-muted)", fontSize: 11 }}>{r.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
    </>
  );
}
