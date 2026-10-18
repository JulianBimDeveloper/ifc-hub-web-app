"use client";

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { getPB } from "@/lib/pb";
import { API_URL } from "@/lib/api";
import { MIDP_ETAPA_ACTIVA } from "@/lib/constants";
import { useProjectStore } from "@/stores/projectStore";
import { IFCFileSelector } from "@/components/domain/IFCFileSelector";

// ── Types ────────────────────────────────────────────────────────────────────

interface MidpMapping {
  id: string;
  ifc_name: string;
  native_name: string;
  etapa?: string;
}

interface RowResult {
  ifc_name: string;
  native_name: string | null;
  matched: boolean;
}

// ── PocketBase query ─────────────────────────────────────────────────────────

function useMidpMappings() {
  return useQuery<MidpMapping[]>({
    queryKey: ["midp_mapping", MIDP_ETAPA_ACTIVA],
    queryFn: () => getPB().collection("midp_mapping").getFullList<MidpMapping>({
      filter: `etapa="${MIDP_ETAPA_ACTIVA}"`, requestKey: null,
    }),
    staleTime: 60_000,
    retry: 2,
  });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({
  label,
  count,
  color,
}: {
  label: string;
  count: number;
  color: string;
}) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: `1px solid ${color}44`,
        borderRadius: 8,
        padding: "14px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minWidth: 120,
        boxShadow: `0 0 14px ${color}18`,
      }}
    >
      <span
        style={{
          fontSize: 28,
          fontWeight: 700,
          color,
          lineHeight: 1.1,
          textShadow: `0 0 10px ${color}66`,
        }}
      >
        {count}
      </span>
      <span
        style={{
          fontSize: 11,
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.07em",
        }}
      >
        {label}
      </span>
    </div>
  );
}

function StatusIcon({ matched }: { matched: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 22,
        height: 22,
        borderRadius: "50%",
        background: matched
          ? "rgba(63,190,138,0.15)"
          : "rgba(255,51,85,0.15)",
        color: matched ? "var(--green)" : "var(--red)",
        fontSize: 13,
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      {matched ? "✓" : "✗"}
    </span>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function NameValidatorPage() {
  const { folderPath, files: storeFiles, selectedPaths, setSelectedPaths } = useProjectStore();
  const [pendingScan, setPendingScan] = useState(false);
  const [scannedFiles, setScannedFiles] = useState<string[] | null>(null);
  const [backendOffline, setBackendOffline] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  // Auto-populate scannedFiles from selected store files
  useEffect(() => {
    if (selectedPaths.length > 0) {
      const selected = storeFiles.filter(f => selectedPaths.includes(f.path));
      setScannedFiles(selected.map(f => f.filename));
    } else {
      setScannedFiles(null);
    }
  }, [storeFiles, selectedPaths]);

  const { data: mappings, isLoading: loadingPB, error: pbError } = useMidpMappings();

  // Build a lookup map: lower-case ifc_name → mapping
  const mappingMap = new Map<string, MidpMapping>();
  if (mappings) {
    for (const m of mappings) {
      mappingMap.set(m.ifc_name.toLowerCase(), m);
    }
  }

  // Scan folder via FastAPI
  async function handleScan() {
    if (!folderPath.trim()) return;
    setPendingScan(true);
    setScanError(null);
    setBackendOffline(false);
    setScannedFiles(null);
    try {
      const res = await fetch(
        `${API_URL}/api/ifc/files/list?folder=${encodeURIComponent(folderPath)}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (!res.ok) {
        setScanError(`Backend respondió ${res.status}: ${res.statusText}`);
        setPendingScan(false);
        return;
      }
      const json = await res.json() as { files: string[] };
      setScannedFiles(json.files ?? []);
    } catch {
      setBackendOffline(true);
    } finally {
      setPendingScan(false);
    }
  }

  // Build results: union of scanned files + PB mappings
  const rows: RowResult[] = [];

  if (scannedFiles !== null && mappings) {
    // Scanned .ifc files
    const ifcFiles = scannedFiles.filter((f) => f.toLowerCase().endsWith(".ifc"));
    for (const file of ifcFiles) {
      const m = mappingMap.get(file.toLowerCase());
      rows.push({
        ifc_name: file,
        native_name: m?.native_name ?? null,
        matched: !!m,
      });
    }
    // PB mappings not found in folder (still show them as unmatched in folder)
    const scannedLower = new Set(ifcFiles.map((f) => f.toLowerCase()));
    for (const m of mappings) {
      if (!scannedLower.has(m.ifc_name.toLowerCase())) {
        rows.push({
          ifc_name: m.ifc_name,
          native_name: m.native_name,
          matched: false,
        });
      }
    }
    rows.sort((a, b) => {
      if (a.matched && !b.matched) return -1;
      if (!a.matched && b.matched) return 1;
      return a.ifc_name.localeCompare(b.ifc_name);
    });
  } else if (mappings && scannedFiles === null) {
    // No scan yet — just show PB mappings
    for (const m of mappings) {
      rows.push({ ifc_name: m.ifc_name, native_name: m.native_name, matched: false });
    }
    rows.sort((a, b) => a.ifc_name.localeCompare(b.ifc_name));
  }

  const countMapped = scannedFiles !== null
    ? rows.filter((r) => r.matched).length
    : 0;
  const countUnmapped = scannedFiles !== null
    ? rows.filter((r) => !r.matched).length
    : rows.length;

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: "var(--cyan)",
            letterSpacing: "0.06em",
          }}
        >
          NAME VALIDATOR
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
          Compara archivos .ifc en carpeta contra la tabla{" "}
          <code style={{ color: "var(--cyan)", fontSize: 11 }}>midp_mapping</code>{" "}
          de PocketBase
        </p>
      </div>

      {/* Folder picker */}
      <IFCFileSelector mode="multi" selectedPaths={selectedPaths} onSelectionChange={setSelectedPaths} />

      {/* Backend offline warning */}
      {backendOffline && (
        <div
          style={{
            background: "rgba(217,164,65,0.08)",
            border: "1px solid rgba(217,164,65,0.4)",
            borderRadius: 6,
            padding: "10px 14px",
            marginBottom: 16,
            fontSize: 12,
            color: "var(--yellow)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          ⚠ Backend offline — no se pudo escanear la carpeta. Mostrando sólo los mappings
          de PocketBase.
        </div>
      )}

      {/* Scan error */}
      {scanError && (
        <div
          style={{
            background: "rgba(255,51,85,0.08)",
            border: "1px solid rgba(255,51,85,0.4)",
            borderRadius: 6,
            padding: "10px 14px",
            marginBottom: 16,
            fontSize: 12,
            color: "var(--red)",
          }}
        >
          ✗ {scanError}
        </div>
      )}

      {/* PB loading / error */}
      {loadingPB && (
        <div
          style={{
            color: "var(--text-muted)",
            fontSize: 12,
            marginBottom: 16,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span
            style={{
              display: "inline-block",
              width: 10,
              height: 10,
              border: "2px solid var(--cyan)",
              borderTopColor: "transparent",
              borderRadius: "50%",
              animation: "spin 0.7s linear infinite",
            }}
          />
          Cargando mappings de PocketBase…
        </div>
      )}
      {pbError && (
        <div
          style={{
            background: "rgba(255,51,85,0.08)",
            border: "1px solid rgba(255,51,85,0.4)",
            borderRadius: 6,
            padding: "10px 14px",
            marginBottom: 16,
            fontSize: 12,
            color: "var(--red)",
          }}
        >
          ✗ No se pudo conectar con PocketBase
        </div>
      )}

      {/* Stats row */}
      {!loadingPB && mappings && (
        <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
          <StatCard
            label={scannedFiles !== null ? "Mapeados" : "Total mappings PB"}
            count={scannedFiles !== null ? countMapped : mappings.length}
            color="var(--green)"
          />
          <StatCard
            label={scannedFiles !== null ? "Sin mapping" : "Sin escanear"}
            count={scannedFiles !== null ? countUnmapped : 0}
            color="var(--red)"
          />
          {scannedFiles !== null && (
            <StatCard
              label="Archivos .ifc en carpeta"
              count={scannedFiles.filter((f) => f.toLowerCase().endsWith(".ifc")).length}
              color="var(--cyan)"
            />
          )}
        </div>
      )}

      {/* Results table */}
      {!loadingPB && rows.length > 0 && (
        <div className="card-cyber" style={{ overflow: "hidden" }}>
          <div
            style={{
              padding: "10px 16px",
              borderBottom: "1px solid var(--border)",
              fontSize: 11,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.07em",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>Resultados ({rows.length})</span>
            {scannedFiles === null && (
              <span style={{ color: "var(--yellow)", fontSize: 10 }}>
                Escanea una carpeta para ver el estado de exportación
              </span>
            )}
          </div>

          <div style={{ overflowX: "auto" }}>
            <table className="table-cyber" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ width: 40, textAlign: "center" }}></th>
                  <th>Archivo IFC</th>
                  <th style={{ width: 140 }}>Estado</th>
                  <th>Nombre Nativo</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i}>
                    <td style={{ textAlign: "center" }}>
                      <StatusIcon matched={row.matched} />
                    </td>
                    <td>
                      <span
                        style={{
                          color: row.matched
                            ? "var(--text-bright)"
                            : "var(--text-muted)",
                          fontFamily: "JetBrains Mono, monospace",
                          fontSize: 12,
                        }}
                      >
                        {row.ifc_name}
                      </span>
                    </td>
                    <td>
                      {row.matched ? (
                        <span className="badge badge-green">OK</span>
                      ) : (
                        <span className="badge badge-red">SIN MAPPING</span>
                      )}
                    </td>
                    <td>
                      <span
                        style={{
                          color: row.native_name
                            ? "var(--text-muted)"
                            : "var(--dim)",
                          fontSize: 12,
                          fontStyle: row.native_name ? "normal" : "italic",
                        }}
                      >
                        {row.native_name ?? "—"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loadingPB && !pbError && rows.length === 0 && (
        <div
          className="card-cyber"
          style={{
            padding: 40,
            textAlign: "center",
            color: "var(--text-muted)",
            fontSize: 13,
          }}
        >
          <div style={{ fontSize: 28, marginBottom: 8 }}>📭</div>
          No hay mappings en PocketBase todavía.
          <br />
          <span style={{ fontSize: 11, color: "var(--dim)" }}>
            Añade registros en la colección{" "}
            <code style={{ color: "var(--cyan)" }}>midp_mapping</code>.
          </span>
        </div>
      )}

      {/* Spin keyframe (injected inline) */}
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
