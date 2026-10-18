"use client";

import { useState } from "react";
import { CheckCircle, XCircle, AlertCircle, ChevronDown, ChevronRight } from "lucide-react";
import { useProjectStore } from "@/stores/projectStore";
import { IFCFileSelector } from "@/components/domain/IFCFileSelector";

const API = "http://127.0.0.1:8020";

const STANDARDS = [
  { id: "ifc4x3", label: "IFC 4x3" },
  { id: "ifc4",   label: "IFC 4"   },
  { id: "ifc2x3", label: "IFC 2x3" },
];

interface FileReport {
  file: string;
  error?: string;
  summary?: { pass: number; fail: number; warn: number; total: number };
  results?: Array<{ rule_id: string; title: string; passed: boolean; severity: string; detail: string }>;
  [key: string]: unknown;
}

interface AuditResult {
  per_file: FileReport[];
  aggregate: Record<string, unknown>;
}

function StatusPill({ pass, fail, warn }: { pass: number; fail: number; warn: number }) {
  if (fail > 0) return (
    <span style={{ background: "rgba(255,51,85,0.12)", color: "var(--red)",
      border: "1px solid rgba(255,51,85,0.3)", borderRadius: 4, padding: "2px 8px", fontSize: 11 }}>
      {fail} error{fail !== 1 ? "s" : ""}
    </span>
  );
  if (warn > 0) return (
    <span style={{ background: "rgba(217,164,65,0.1)", color: "var(--yellow)",
      border: "1px solid rgba(217,164,65,0.3)", borderRadius: 4, padding: "2px 8px", fontSize: 11 }}>
      {warn} warn
    </span>
  );
  return (
    <span style={{ background: "rgba(63,190,138,0.1)", color: "var(--green)",
      border: "1px solid rgba(63,190,138,0.3)", borderRadius: 4, padding: "2px 8px", fontSize: 11 }}>
      OK
    </span>
  );
}

function FileRow({ report }: { report: FileReport }) {
  const [open, setOpen] = useState(false);

  const summary = report.summary ?? {
    pass: Array.isArray(report.results) ? report.results.filter(r => r.passed).length : 0,
    fail: Array.isArray(report.results) ? report.results.filter(r => !r.passed && r.severity === "error").length : 0,
    warn: Array.isArray(report.results) ? report.results.filter(r => !r.passed && r.severity === "warn").length : 0,
    total: Array.isArray(report.results) ? report.results.length : 0,
  };

  const hasDetails = Array.isArray(report.results) && report.results.length > 0;

  return (
    <>
      <tr
        onClick={() => hasDetails && setOpen(o => !o)}
        style={{ cursor: hasDetails ? "pointer" : "default",
          borderLeft: `3px solid ${report.error ? "var(--red)" : summary.fail > 0 ? "var(--red)" : summary.warn > 0 ? "var(--yellow)" : "var(--green)"}` }}>
        <td style={{ width: 28, paddingLeft: 8 }}>
          {hasDetails
            ? (open ? <ChevronDown size={13} color="var(--text-muted)" /> : <ChevronRight size={13} color="var(--text-muted)" />)
            : null}
        </td>
        <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "var(--text-bright)" }}>
          {report.file}
        </td>
        <td>
          {report.error
            ? <span style={{ color: "var(--red)", fontSize: 11 }}>✗ {report.error.slice(0, 60)}</span>
            : <StatusPill pass={summary.pass} fail={summary.fail} warn={summary.warn} />}
        </td>
        <td style={{ color: "var(--green)", fontSize: 12 }}>{summary.pass}</td>
        <td style={{ color: "var(--red)", fontSize: 12 }}>{summary.fail}</td>
        <td style={{ color: "var(--yellow)", fontSize: 12 }}>{summary.warn}</td>
        <td style={{ color: "var(--text-muted)", fontSize: 11 }}>{summary.total}</td>
      </tr>

      {open && hasDetails && report.results!.map((r, i) => (
        <tr key={i} style={{ background: "rgba(0,0,0,0.2)" }}>
          <td />
          <td style={{ paddingLeft: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {r.passed
                ? <CheckCircle size={12} color="var(--green)" />
                : r.severity === "error"
                  ? <XCircle size={12} color="var(--red)" />
                  : <AlertCircle size={12} color="var(--yellow)" />}
              <span style={{ fontSize: 11, color: "var(--text)" }}>{r.title}</span>
              {r.rule_id && <span style={{ fontSize: 10, color: "var(--dim)" }}>({r.rule_id})</span>}
            </div>
          </td>
          <td colSpan={5} style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>
            {r.detail}
          </td>
        </tr>
      ))}
    </>
  );
}

export default function StandardsAuditPage() {
  const { folderPath, files: storeFiles, selectedPaths, setSelectedPaths } = useProjectStore();
  const [selectedStds, setSelectedStds] = useState<string[]>(["ifc4x3"]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AuditResult | null>(null);

  function toggleStd(id: string) {
    setSelectedStds(prev =>
      prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id]
    );
  }

  async function runAudit() {
    if (!folderPath.trim() || !selectedStds.length || selectedPaths.length === 0) return;
    setLoading(true); setError(""); setResult(null);
    try {
      const res = await fetch(`${API}/api/ifc/standards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder: folderPath.trim(), standards: selectedStds, files: selectedPaths.length > 0 ? selectedPaths : null }),
      });
      if (!res.ok) throw new Error(await res.text());
      setResult(await res.json());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error desconocido");
    } finally {
      setLoading(false);
    }
  }

  const totalFiles = result?.per_file.length ?? 0;
  const totalErrors = result?.per_file.reduce((acc, r) => {
    const s = r.summary ?? { fail: Array.isArray(r.results) ? r.results.filter(x => !x.passed && x.severity === "error").length : 0 };
    return acc + (s.fail ?? 0);
  }, 0) ?? 0;
  const cleanFiles = result?.per_file.filter(r => !r.error && (r.summary?.fail ?? 0) === 0).length ?? 0;

  return (
    <>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--cyan)", letterSpacing: "0.04em" }}>
          STANDARDS AUDIT
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
          Audita archivos IFC en una carpeta contra estándares configurables
        </p>
      </div>

      {selectedPaths.length === 0 && storeFiles.length > 0 && (
        <div style={{ padding: "8px 0 4px", fontSize: 11, color: "var(--yellow)" }}>
          Selecciona archivos en el árbol de selección para auditar
        </div>
      )}
      <IFCFileSelector mode="multi" selectedPaths={selectedPaths} onSelectionChange={setSelectedPaths} />

      {/* Controls */}
      <div className="card-cyber" style={{ padding: "14px 16px", marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
          <button className="btn btn-cyan" onClick={runAudit}
            disabled={loading || !folderPath.trim() || !selectedStds.length || selectedPaths.length === 0}>
            {loading ? "Auditando..." : "Auditar"}
          </button>
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase",
            letterSpacing: "0.06em" }}>Estándares:</span>
          {STANDARDS.map(s => (
            <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 5,
              cursor: "pointer", fontSize: 12,
              color: selectedStds.includes(s.id) ? "var(--cyan)" : "var(--text-muted)" }}>
              <input type="checkbox" checked={selectedStds.includes(s.id)}
                onChange={() => toggleStd(s.id)}
                style={{ accentColor: "var(--cyan)" }} />
              {s.label}
            </label>
          ))}
        </div>
      </div>

      {error && (
        <div style={{ background: "rgba(255,51,85,0.08)", border: "1px solid rgba(255,51,85,0.3)",
          borderRadius: 6, padding: "10px 14px", marginBottom: 16, fontSize: 12, color: "var(--red)" }}>
          ✗ {error}
        </div>
      )}

      {result && (
        <>
          {/* KPIs */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 16 }}>
            {[
              { label: "Archivos auditados", val: totalFiles, color: "var(--cyan)" },
              { label: "Sin errores", val: cleanFiles, color: "var(--green)" },
              { label: "Total errores", val: totalErrors, color: "var(--red)" },
            ].map(k => (
              <div key={k.label} style={{ background: "var(--surface)", border: `1px solid ${k.color}33`,
                borderRadius: 6, padding: "10px 16px", textAlign: "center" }}>
                <div style={{ fontSize: 28, fontWeight: 700, color: k.color }}>{k.val}</div>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{k.label}</div>
              </div>
            ))}
          </div>

          {/* Per-file table */}
          <div className="card-cyber" style={{ overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)",
              fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase" }}>
              Resultados por archivo — {totalFiles} archivo{totalFiles !== 1 ? "s" : ""}
            </div>
            <table className="table-cyber">
              <thead>
                <tr>
                  <th style={{ width: 28 }}></th>
                  <th>Archivo</th>
                  <th>Estado</th>
                  <th style={{ color: "var(--green)" }}>✓</th>
                  <th style={{ color: "var(--red)" }}>✗</th>
                  <th style={{ color: "var(--yellow)" }}>⚠</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {result.per_file.map((r, i) => <FileRow key={i} report={r} />)}
              </tbody>
            </table>
          </div>

          {/* Aggregate (if available) */}
          {result.aggregate && Object.keys(result.aggregate).length > 0 && (
            <div className="card-cyber" style={{ padding: 14, marginTop: 16 }}>
              <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase",
                marginBottom: 8 }}>Resumen agregado</div>
              <pre style={{ fontSize: 11, color: "var(--text)", margin: 0,
                fontFamily: "JetBrains Mono, monospace", whiteSpace: "pre-wrap" }}>
                {JSON.stringify(result.aggregate, null, 2)}
              </pre>
            </div>
          )}
        </>
      )}
    </>
  );
}
