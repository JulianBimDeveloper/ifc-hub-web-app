"use client";
import { useState, useEffect } from "react";
import { IFCFileSelector } from "@/components/domain/IFCFileSelector";

const API = "http://127.0.0.1:8020";

const TYPE_COLORS: Record<string, string> = {
  IfcWall: "#5B8CFF", IfcSlab: "#3FBE8A", IfcColumn: "#ff9900",
  IfcBeam: "#7A6FD9", IfcDoor: "#D9A441", IfcWindow: "#4af",
  IfcStair: "#c084fc", IfcRoof: "#f87", IfcSpace: "#6af",
};
function typeColor(t: string) {
  return TYPE_COLORS[t] ?? "#6b7a99";
}

interface NomGroup { prefix: string; ifc_class: string; count: number; variant_count: number; }
interface NomData { elements: any[]; groups: NomGroup[]; total: number; }

export default function NomenclaturePage() {
  const [selectedPath, setSelectedPath] = useState("");
  const [data, setData] = useState<NomData | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (selectedPath) { load(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath]);

  async function load() {
    if (!selectedPath.trim()) return;
    setLoading(true); setError(""); setData(null);
    try {
      const res = await fetch(`${API}/api/ifc/nomenclature?path=${encodeURIComponent(selectedPath)}`);
      if (!res.ok) throw new Error(await res.text());
      setData(await res.json());
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }

  const selectedElements = selected && data
    ? data.elements.filter(e => e.prefix === selected)
    : [];

  return (
    <>
      <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--cyan)", letterSpacing: "0.04em" }}>
            NOMENCLATURE
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
            Agrupa elementos por prefijo de nombre y detecta variantes
          </p>
        </div>

        <IFCFileSelector mode="single" selectedPath={selectedPath} onSelectionChange={setSelectedPath} />

        {error && <div style={{ color: "var(--red)", fontSize: 12, marginBottom: 12 }}>{error}</div>}

        {data && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, height: "65vh" }}>
            {/* Groups panel */}
            <div className="card-cyber" style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}>
              <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)",
                fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase" }}>
                Prefijos — {data.groups.length} grupos · {data.total} elementos
              </div>
              <div style={{ overflowY: "auto", flex: 1 }}>
                {data.groups.map(g => (
                  <div key={g.prefix} onClick={() => setSelected(g.prefix)}
                    style={{
                      padding: "8px 14px", cursor: "pointer",
                      background: selected === g.prefix ? "rgba(91,140,255,0.06)" : "transparent",
                      borderLeft: selected === g.prefix ? "2px solid var(--cyan)" : "2px solid transparent",
                      display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--border)",
                    }}>
                    <span style={{ fontSize: 10, color: typeColor(g.ifc_class), background: `${typeColor(g.ifc_class)}18`,
                      border: `1px solid ${typeColor(g.ifc_class)}44`, borderRadius: 3,
                      padding: "1px 5px", minWidth: 60, textAlign: "center" }}>
                      {g.ifc_class.replace("Ifc", "")}
                    </span>
                    <span style={{ flex: 1, fontSize: 12, color: "var(--text)" }}>{g.prefix || "(sin prefijo)"}</span>
                    <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{g.count} elem</span>
                    {g.variant_count > 1 && (
                      <span style={{ fontSize: 10, color: "var(--yellow)", background: "rgba(217,164,65,0.1)",
                        border: "1px solid rgba(217,164,65,0.3)", borderRadius: 3, padding: "0 5px" }}>
                        {g.variant_count} var
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Elements panel */}
            <div className="card-cyber" style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}>
              <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)",
                fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase" }}>
                {selected ? `"${selected}" — ${selectedElements.length} elementos` : "Selecciona un prefijo"}
              </div>
              <div style={{ overflowY: "auto", flex: 1 }}>
                {selectedElements.map((e, i) => (
                  <div key={i} style={{ padding: "7px 14px", borderBottom: "1px solid var(--border)",
                    display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 10, color: typeColor(e.ifc_class), background: `${typeColor(e.ifc_class)}18`,
                      border: `1px solid ${typeColor(e.ifc_class)}44`, borderRadius: 3,
                      padding: "1px 5px", minWidth: 50, textAlign: "center" }}>
                      {e.ifc_class.replace("Ifc", "")}
                    </span>
                    <span style={{ fontSize: 12, color: "var(--text-bright)" }}>{e.name}</span>
                    <span style={{ fontSize: 10, color: "var(--dim)", marginLeft: "auto" }}>
                      {e.global_id?.slice(0, 10)}…
                    </span>
                  </div>
                ))}
                {selected && selectedElements.length === 0 && (
                  <div style={{ padding: 20, color: "var(--text-muted)", fontSize: 12, textAlign: "center" }}>
                    Sin elementos
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
    </>
  );
}
