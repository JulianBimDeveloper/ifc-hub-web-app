"use client";

import type { FileScanResult, ReviewMode } from "../lib/reviewTypes";

interface Props {
  results: Record<string, FileScanResult>;
  mode: ReviewMode;
  tab: "file" | "project" | "element";
  scanning: boolean;
  progress: { done: number; total: number };
}

export function KpiHeader({ results, mode, tab, scanning, progress }: Props) {
  const files = Object.values(results).filter(r => !r.error);

  let totalRed = 0, totalOk = 0, totalFixed = 0, totalDiscrepancy = 0;
  const byDisciplina: Record<string, number> = {};

  for (const r of files) {
    if (tab === "element" && r.stats) {
      totalRed += r.stats.red_total ?? 0;
      if (r.stats.status_counts) {
        totalFixed      += r.stats.status_counts["client_red_fixed"] ?? 0;
        totalDiscrepancy += r.stats.status_counts["client_red_has_value"] ?? 0;
      }
      for (const [d, n] of Object.entries(r.stats.by_disciplina ?? {})) {
        byDisciplina[d] = (byDisciplina[d] ?? 0) + (n as number);
      }
    } else if (tab === "file" && r.file_row) {
      const reds = Object.values(r.file_row).filter(c => c.red || c.status === "client_red_still_empty").length;
      totalRed += reds;
    } else if (tab === "project" && r.project_row) {
      const reds = Object.values(r.project_row).filter(c => c.red || c.status === "client_red_still_empty").length;
      totalRed += reds;
    }
    totalOk++;
  }

  const topDisciplinas = Object.entries(byDisciplina)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
      {/* Progreso de escaneo */}
      {scanning && (
        <div style={{
          background: "var(--surface-2, #1a1a2e)", border: "1px solid var(--cyan)",
          borderRadius: 6, padding: "8px 14px", minWidth: 160,
        }}>
          <div style={{ fontSize: 10, color: "var(--cyan)", letterSpacing: "0.1em", marginBottom: 4 }}>ESCANEANDO</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#fff", fontFamily: "JetBrains Mono, monospace" }}>
            {progress.done}<span style={{ fontSize: 12, color: "#888" }}>/{progress.total}</span>
          </div>
          <div style={{ height: 3, background: "#333", borderRadius: 2, marginTop: 6 }}>
            <div style={{ height: 3, width: `${pct}%`, background: "var(--cyan)", borderRadius: 2, transition: "width 0.3s" }} />
          </div>
        </div>
      )}

      {/* Archivos procesados */}
      <KpiCard label="ARCHIVOS" value={progress.total} color="var(--cyan)" />

      {/* Rojas pendientes */}
      <KpiCard label={mode === "client" ? "PENDIENTES" : "ROJAS"} value={totalRed} color="#ff3355" />

      {mode === "client" && (
        <>
          <KpiCard label="CORREGIDAS" value={totalFixed} color="#3FBE8A" />
          <KpiCard label="DISCREPANCIAS" value={totalDiscrepancy} color="#D9A441" />
        </>
      )}

      {/* Top disciplinas (solo tab elemento) */}
      {tab === "element" && topDisciplinas.length > 0 && (
        <div style={{
          background: "var(--surface-2, #1a1a2e)", border: "1px solid var(--border)",
          borderRadius: 6, padding: "8px 14px", minWidth: 180,
        }}>
          <div style={{ fontSize: 10, color: "#888", letterSpacing: "0.1em", marginBottom: 6 }}>ROJAS POR DISCIPLINA</div>
          {topDisciplinas.map(([d, n]) => (
            <div key={d} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11, marginBottom: 2 }}>
              <span style={{ color: "#aaa" }}>{d}</span>
              <span style={{ color: "#ff3355", fontFamily: "JetBrains Mono, monospace" }}>{n}</span>
            </div>
          ))}
        </div>
      )}

      {/* Leyenda de estados (modo cliente) */}
      {mode === "client" && (
        <div style={{
          background: "var(--surface-2, #1a1a2e)", border: "1px solid var(--border)",
          borderRadius: 6, padding: "8px 14px", display: "flex", flexDirection: "column", gap: 3,
        }}>
          <div style={{ fontSize: 10, color: "#888", letterSpacing: "0.1em", marginBottom: 4 }}>LEYENDA</div>
          {[
            { color: "#ff3355", label: "Pendiente (rojo cliente, vacío)" },
            { color: "#3FBE8A", label: "Corregido" },
            { color: "#D9A441", label: "Discrepancia (rojo pero tenía valor)" },
            { color: "#ff6633", label: "Vacío nuevo (no marcado por cliente)" },
            { color: "#666688", label: "No estaba en revisión" },
          ].map(({ color, label }) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10 }}>
              <div style={{ width: 10, height: 10, background: color, borderRadius: 2, flexShrink: 0 }} />
              <span style={{ color: "#aaa" }}>{label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function KpiCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{
      background: "var(--surface-2, #1a1a2e)", border: `1px solid ${color}33`,
      borderRadius: 6, padding: "8px 14px", minWidth: 90,
    }}>
      <div style={{ fontSize: 10, color: "#888", letterSpacing: "0.1em", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color, fontFamily: "JetBrains Mono, monospace" }}>{value}</div>
    </div>
  );
}
