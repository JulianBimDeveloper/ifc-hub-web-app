"use client";
import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getPB } from "@/lib/pb";
import { Pencil, Check, X } from "lucide-react";
import { useProjectStore } from "@/stores/projectStore";
import { IFCFileSelector } from "@/components/domain/IFCFileSelector";

const API = "http://127.0.0.1:8020";

interface PBParam { id: string; pset_name: string; prop_name: string; value: string; }

export default function IFCMetadataPage() {
  const qc = useQueryClient();
  const { folderPath, files: storeFiles, selectedPaths } = useProjectStore();
  const [selectedPath, setSelectedPath] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [syncLog, setSyncLog] = useState<{ file: string; ok: boolean; msg: string }[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [fileError, setFileError] = useState("");

  const { data: params = [] } = useQuery<PBParam[]>({
    queryKey: ["ifc_project_defaults"],
    queryFn: async () => {
      const r = await getPB().collection("ifc_project_defaults").getFullList<PBParam>();
      return r;
    },
    retry: 1,
  });

  useEffect(() => {
    if (selectedPath) { loadFiles(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath]);

  // Populate from selected files only
  useEffect(() => {
    const selectedFiles = storeFiles.filter(f => selectedPaths.includes(f.path));
    setFiles(selectedFiles.map(f => f.filename));
  }, [storeFiles, selectedPaths]);

  async function loadFiles() {
    if (!folderPath.trim()) return;
    setLoadingFiles(true); setFileError(""); setFiles([]);
    try {
      const res = await fetch(`${API}/api/ifc/files/list?folder=${encodeURIComponent(folderPath)}`);
      if (!res.ok) throw new Error(await res.text());
      const d = await res.json();
      setFiles(d.files || []);
    } catch (e: any) { setFileError(e.message); }
    finally { setLoadingFiles(false); }
  }

  async function saveParam(id: string) {
    await getPB().collection("ifc_project_defaults").update(id, { value: editVal });
    qc.invalidateQueries({ queryKey: ["ifc_project_defaults"] });
    setEditId(null);
  }

  async function syncAll() {
    const selectedFiles = storeFiles.filter(f => selectedPaths.includes(f.path));
    if (!selectedFiles.length || !params.length) return;
    setSyncing(true); setSyncLog([]);
    const paramList = params.map(p => ({ pset_name: p.pset_name, prop_name: p.prop_name, value: p.value }));
    for (const f of selectedFiles) {
      try {
        const res = await fetch(`${API}/api/ifc/apply-defaults`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ifc_path: f.path, params: paramList }),
        });
        const d = await res.json();
        setSyncLog(prev => [...prev, { file: f.filename, ok: true, msg: `${d.modified} params aplicados` }]);
      } catch (e: any) {
        setSyncLog(prev => [...prev, { file: f.filename, ok: false, msg: e.message }]);
      }
    }
    setSyncing(false);
  }

  return (
    <>
      <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--cyan)", letterSpacing: "0.04em" }}>
            IFC PROJECT DEFAULTS
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
            Aplica parámetros por defecto del proyecto (PocketBase) a archivos IFC
          </p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {/* Panel izquierdo: parámetros PB */}
          <div className="card-cyber" style={{ overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)",
              fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase" }}>
              Parámetros por defecto — PocketBase ({params.length})
            </div>
            <div style={{ overflowY: "auto", maxHeight: 400 }}>
              <table className="table-cyber">
                <thead><tr><th>PSet</th><th>Propiedad</th><th>Valor</th><th></th></tr></thead>
                <tbody>
                  {params.map(p => (
                    <tr key={p.id}>
                      <td style={{ color: "var(--text-muted)", fontSize: 11 }}>{p.pset_name}</td>
                      <td style={{ fontWeight: 600, fontSize: 11 }}>{p.prop_name}</td>
                      <td>
                        {editId === p.id ? (
                          <div style={{ display: "flex", gap: 4 }}>
                            <input value={editVal} onChange={e => setEditVal(e.target.value)}
                              style={{ width: 120, fontSize: 11, padding: "2px 6px" }} autoFocus
                              onKeyDown={e => { if (e.key === "Enter") saveParam(p.id); if (e.key === "Escape") setEditId(null); }} />
                            <button onClick={() => saveParam(p.id)}
                              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--green)" }}>
                              <Check size={12} />
                            </button>
                            <button onClick={() => setEditId(null)}
                              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--red)" }}>
                              <X size={12} />
                            </button>
                          </div>
                        ) : (
                          <span style={{ fontSize: 11, color: "var(--text-bright)" }}>{p.value || "—"}</span>
                        )}
                      </td>
                      <td>
                        {editId !== p.id && (
                          <button onClick={() => { setEditId(p.id); setEditVal(p.value || ""); }}
                            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)" }}>
                            <Pencil size={11} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {params.length === 0 && (
                    <tr><td colSpan={4} style={{ textAlign: "center", color: "var(--text-muted)", padding: 20 }}>
                      Sin parámetros en PocketBase (colección ifc_project_defaults)
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Panel derecho: archivos + sync */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <IFCFileSelector mode="single" selectedPath={selectedPath} onSelectionChange={setSelectedPath} />
            <div className="card-cyber" style={{ padding: 14 }}>
              {fileError && <div style={{ color: "var(--red)", fontSize: 11, marginBottom: 8 }}>{fileError}</div>}
              {storeFiles.length > 0 && selectedPaths.length === 0 && (
                <div style={{ color: "var(--yellow)", fontSize: 11, padding: "8px 0" }}>
                  Selecciona archivos en el árbol de selección para aplicar los parámetros
                </div>
              )}
              {files.length > 0 && (
                <>
                  <div style={{ maxHeight: 160, overflowY: "auto", marginBottom: 10 }}>
                    {files.map(f => (
                      <div key={f} style={{ fontSize: 11, color: "var(--text)", padding: "3px 6px",
                        borderBottom: "1px solid var(--border)" }}>
                        {f}
                      </div>
                    ))}
                  </div>
                  <button className="btn btn-magenta" onClick={syncAll}
                    disabled={syncing || !params.length} style={{ width: "100%" }}>
                    {syncing ? "Aplicando..." : `Aplicar a ${files.length} archivo(s)`}
                  </button>
                </>
              )}
            </div>

            {syncLog.length > 0 && (
              <div className="card-cyber" style={{ padding: 14, maxHeight: 200, overflowY: "auto" }}>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8, textTransform: "uppercase" }}>
                  Log
                </div>
                {syncLog.map((l, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, fontSize: 11, padding: "3px 0",
                    color: l.ok ? "var(--green)" : "var(--red)" }}>
                    <span>{l.ok ? "✓" : "✗"}</span>
                    <span style={{ flex: 1, color: "var(--text)" }}>{l.file}</span>
                    <span>{l.msg}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
    </>
  );
}
