"use client";

import { useState } from "react";
import { useProjectStore } from "@/stores/projectStore";
import { IFCFileSelector } from "@/components/domain/IFCFileSelector";

interface DuplicateElement {
  ifc_file: string;
  name: string;
  ifc_class: string;
  [key: string]: unknown;
}

interface DuplicateGroup {
  group_id: string;
  group_size: number;
  name: string;
  ifc_class: string;
  elements?: DuplicateElement[];
  [key: string]: unknown;
}

interface DuplicatesData {
  total_elements: number;
  duplicate_groups: number;
  duplicate_elements: number;
  groups: DuplicateGroup[];
}

export default function IFCDuplicatesPage() {
  const { folderPath, files: storeFiles, selectedPaths, setSelectedPaths } = useProjectStore();
  const [tolerance, setTolerance] = useState("5");
  const [data, setData] = useState<DuplicatesData | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleScan() {
    if (!folderPath.trim()) return;
    if (selectedPaths.length === 0) {
      setError("Selecciona archivos en el árbol de selección antes de escanear");
      return;
    }
    setLoading(true);
    setError(null);
    setData(null);
    setExpandedGroups(new Set());
    try {
      const res = await fetch("http://127.0.0.1:8020/api/ifc/duplicates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folder: folderPath.trim(),
          tolerance_cm: parseFloat(tolerance) || 5,
          files: selectedPaths,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: DuplicatesData = await res.json();
      setData(json);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error desconocido");
    } finally {
      setLoading(false);
    }
  }

  function toggleGroup(id: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const uniqueGroups = data
    ? (() => {
        const map = new Map<string, DuplicateGroup & { elements: DuplicateElement[] }>();
        for (const g of data.groups) {
          if (!map.has(g.group_id)) {
            map.set(g.group_id, { ...g, elements: [] });
          }
          const entry = map.get(g.group_id)!;
          entry.elements.push({
            ifc_file: String(g.ifc_file ?? ""),
            name: String(g.name ?? ""),
            ifc_class: String(g.ifc_class ?? ""),
          });
          entry.group_size = entry.elements.length;
        }
        return Array.from(map.values());
      })()
    : [];

  return (
    <div style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{
          fontSize: 20, fontWeight: 700, color: "var(--cyan)", letterSpacing: "0.08em", margin: 0,
        }}>
          IFC DUPLICATES
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
          Detecta elementos duplicados por geometría en una carpeta de archivos IFC
        </p>
      </div>

      {selectedPaths.length === 0 && storeFiles.length > 0 && (
        <div style={{ padding: "8px 0 4px", fontSize: 11, color: "var(--yellow)" }}>
          Selecciona archivos en el árbol de selección para escanear
        </div>
      )}
      <IFCFileSelector mode="multi" selectedPaths={selectedPaths} onSelectionChange={setSelectedPaths} />

      <div className="card-cyber" style={{ padding: 16, marginBottom: 16, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>Tolerancia (cm):</span>
          <input
            value={tolerance}
            onChange={(e) => setTolerance(e.target.value)}
            type="number"
            min={0}
            step={0.1}
            style={{
              width: 70, background: "var(--surface)", border: "1px solid var(--border)",
              borderRadius: 6, padding: "8px 10px", color: "var(--cyan)",
              fontFamily: "inherit", fontSize: 12, outline: "none", textAlign: "right",
            }}
          />
        </div>
        <button
          className="btn"
          onClick={handleScan}
          disabled={loading}
          style={{
            background: loading ? "var(--surface-2)" : "var(--yellow)",
            color: "#0a0f1e", fontWeight: 700, fontFamily: "inherit",
            fontSize: 12, padding: "8px 20px", border: "none", borderRadius: 6,
            cursor: loading ? "not-allowed" : "pointer",
            letterSpacing: "0.04em",
          }}
        >
          {loading ? "ESCANEANDO…" : "ESCANEAR"}
        </button>
      </div>

      {error && (
        <div style={{
          background: "rgba(255,51,85,0.1)", border: "1px solid var(--red)",
          borderRadius: 6, padding: "10px 16px", marginBottom: 16,
          color: "var(--red)", fontSize: 12,
        }}>
          {error}
        </div>
      )}

      {data && (
        <>
          <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
            {[
              { label: "TOTAL ELEMENTOS", value: data.total_elements, color: "var(--cyan)" },
              { label: "GRUPOS DUP.", value: data.duplicate_groups, color: "var(--magenta)" },
              { label: "ELEM. DUPLICADOS", value: data.duplicate_elements, color: "var(--yellow)" },
            ].map((kpi) => (
              <div key={kpi.label} className="card-cyber" style={{
                padding: "12px 20px", display: "flex", flexDirection: "column", gap: 2, flex: 1,
              }}>
                <span style={{ fontSize: 22, fontWeight: 700, color: kpi.color }}>{kpi.value}</span>
                <span style={{ fontSize: 11, color: "var(--text-muted)", letterSpacing: "0.04em" }}>{kpi.label}</span>
              </div>
            ))}
          </div>

          {uniqueGroups.length === 0 ? (
            <div className="card-cyber" style={{
              padding: 48, textAlign: "center",
            }}>
              <div style={{
                fontSize: 14, fontWeight: 700, color: "var(--green)", marginBottom: 8,
              }}>
                Sin duplicados detectados
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                Todos los elementos son únicos con la tolerancia configurada
              </div>
            </div>
          ) : (
            <div className="card-cyber" style={{ padding: 0, overflow: "hidden" }}>
              {uniqueGroups.map((group, gi) => {
                const isExpanded = expandedGroups.has(group.group_id);
                return (
                  <div key={group.group_id}>
                    <div
                      onClick={() => toggleGroup(group.group_id)}
                      style={{
                        display: "flex", alignItems: "center", gap: 12,
                        padding: "12px 16px", cursor: "pointer",
                        borderBottom: "1px solid var(--border)",
                        background: isExpanded ? "rgba(122,111,217,0.06)" : "rgba(255,255,255,0.01)",
                        transition: "background 0.15s",
                        userSelect: "none",
                      }}
                    >
                      <span style={{
                        fontSize: 10, color: isExpanded ? "var(--magenta)" : "var(--text-muted)",
                        transition: "transform 0.15s",
                        display: "inline-block",
                        transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                      }}>
                        &#9654;
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
                        Grupo {gi + 1}
                      </span>
                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        — {group.group_size} elementos
                      </span>
                      <span style={{ fontSize: 11, color: "var(--cyan)", opacity: 0.7, marginLeft: "auto" }}>
                        {group.ifc_class}
                      </span>
                    </div>

                    {isExpanded && (
                      <div>
                        <div style={{
                          display: "grid",
                          gridTemplateColumns: "1fr 1fr 1fr",
                          padding: "6px 16px",
                          fontSize: 10, color: "var(--text-muted)", fontWeight: 700,
                          letterSpacing: "0.08em",
                          background: "rgba(255,255,255,0.015)",
                          borderBottom: "1px solid var(--border)",
                        }}>
                          <span>ARCHIVO IFC</span>
                          <span>NOMBRE ELEMENTO</span>
                          <span>IFC TYPE</span>
                        </div>
                        {group.elements.map((el, ei) => (
                          <div
                            key={ei}
                            style={{
                              display: "grid",
                              gridTemplateColumns: "1fr 1fr 1fr",
                              padding: "8px 16px",
                              fontSize: 12,
                              borderBottom: "1px solid rgba(30,45,74,0.4)",
                              background: ei % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)",
                            }}
                          >
                            <span style={{
                              color: "var(--yellow)", opacity: 0.85,
                              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                            }}>
                              {el.ifc_file || "(desconocido)"}
                            </span>
                            <span style={{
                              color: "var(--text)",
                              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                              paddingLeft: 8,
                            }}>
                              {el.name || "(sin nombre)"}
                            </span>
                            <span style={{
                              color: "var(--cyan)", opacity: 0.8,
                              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                              paddingLeft: 8,
                            }}>
                              {el.ifc_class}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
