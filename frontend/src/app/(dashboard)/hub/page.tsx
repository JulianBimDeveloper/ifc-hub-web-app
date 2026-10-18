"use client";

import { useEffect, useState } from "react";
import { RefreshCw, ExternalLink, Layers } from "lucide-react";

const API = "http://127.0.0.1:8020";

interface HubModel {
  disciplina: string;
  nombre: string;
  speckle_model_id: string;
  speckle_version_id: string;
  pushed_by: string;
  pushed_at: string;
  viewer_url: string;
}

interface HubProject {
  proyecto: string;
  speckle_project_id: string;
  federated_url: string;
  modelos: HubModel[];
}

/**
 * BIMRail Hub — visor unificado de lo que Revit/Civil3D han enviado al
 * servidor Speckle propio (DEPLOYMENT/speckle-server/). Los datos de qué
 * proyecto/disciplina existe salen de PocketBase (colección speckle_links,
 * escrita por ADDINS/shared/BIMRail.Core/SpeckleService.cs en cada push);
 * el visor en sí es el visor propio de Speckle, embebido — no se reconstruye
 * uno nuevo aquí.
 */
export default function HubPage() {
  const [proyectos, setProyectos] = useState<HubProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [selectedLabel, setSelectedLabel] = useState<string>("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/hub/projects`);
      if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
      const data = await res.json();
      setProyectos(data.proyectos ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error desconocido");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <div style={{ display: "flex", height: "100%", width: "100%" }}>
      <div style={{ width: 360, minWidth: 360, borderRight: "1px solid rgba(255,255,255,0.08)", overflowY: "auto", padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
            <Layers size={18} /> BIMRail Hub
          </h2>
          <button onClick={load} title="Recargar" style={{ background: "none", border: "none", cursor: "pointer", opacity: 0.7 }}>
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        {error && (
          <div style={{ padding: 12, borderRadius: 8, background: "rgba(255,80,80,0.1)", color: "#ff8080", fontSize: 13, marginBottom: 12 }}>
            ⚠ {error}. ¿Está corriendo el servidor Speckle (DEPLOYMENT/speckle-server) y el backend de Fractal IFC?
          </div>
        )}

        {!loading && !error && proyectos.length === 0 && (
          <div style={{ fontSize: 13, opacity: 0.6, padding: 12 }}>
            Todavía no se ha enviado nada al Hub. Usa el botón &quot;Enviar a Hub&quot; en Revit o Civil3D.
          </div>
        )}

        {proyectos.map((p) => (
          <div key={p.proyecto} style={{ marginBottom: 16, border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ padding: "10px 12px", fontWeight: 600, fontSize: 13, background: "rgba(255,255,255,0.04)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>{p.proyecto}</span>
              <button
                onClick={() => { setSelectedUrl(p.federated_url); setSelectedLabel(`${p.proyecto} — todas las disciplinas`); }}
                title="Ver todas las disciplinas juntas"
                style={{ fontSize: 11, opacity: 0.7, background: "none", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, padding: "2px 8px", cursor: "pointer", color: "inherit" }}
              >
                Ver juntas
              </button>
            </div>
            {p.modelos.map((m) => (
              <button
                key={m.speckle_model_id}
                onClick={() => { setSelectedUrl(m.viewer_url); setSelectedLabel(`${p.proyecto} — ${m.nombre}`); }}
                style={{
                  width: "100%", textAlign: "left", padding: "8px 12px", background: selectedUrl === m.viewer_url ? "rgba(100,150,255,0.12)" : "transparent",
                  border: "none", borderTop: "1px solid rgba(255,255,255,0.05)", cursor: "pointer", color: "inherit",
                }}
              >
                <div style={{ fontSize: 13 }}>{m.nombre}</div>
                <div style={{ fontSize: 11, opacity: 0.55 }}>{m.pushed_by} · {new Date(m.pushed_at).toLocaleString("es-ES")}</div>
              </button>
            ))}
          </div>
        ))}
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        {selectedUrl ? (
          <>
            <div style={{ padding: "8px 16px", fontSize: 12, opacity: 0.7, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>{selectedLabel}</span>
              <a href={selectedUrl} target="_blank" rel="noreferrer" style={{ color: "inherit", display: "flex", alignItems: "center", gap: 4 }}>
                Abrir en pestaña nueva <ExternalLink size={12} />
              </a>
            </div>
            <iframe src={selectedUrl} style={{ flex: 1, border: "none", width: "100%" }} />
          </>
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.5, fontSize: 14 }}>
            Elige un proyecto y disciplina a la izquierda para ver su modelo.
          </div>
        )}
      </div>
    </div>
  );
}
