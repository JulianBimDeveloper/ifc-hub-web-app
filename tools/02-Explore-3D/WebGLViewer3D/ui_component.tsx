"use client";

/**
 * Viewer page — IFC 3D viewer (That Open Platform: web-ifc/@thatopen/fragments
 * convertidos server-side, @thatopen/components para render/selección).
 *
 * Flujo:
 *   1. El usuario selecciona IFCs en el Sidebar (selectedPaths en projectStore).
 *   2. Pulsa "Cargar en visor" → se construyen URLs /api/viewer-frag?path=…
 *      (el backend convierte a Fragments con un subproceso Node y cachea en disco).
 *   3. Se envía postMessage { type:'load', files:[...urls] } al iframe.
 *   4. El iframe (That Open) descarga el .frag y renderiza.
 *
 * El iframe también escucha highlight/isolate/show_all/fit/clear desde el padre,
 * y emite select/deselect (con globalId) cuando el usuario clica un elemento —
 * se usan aquí para pedir propiedades al pipeline Python existente.
 */

import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import type { CSSProperties } from "react";
import { Navbar } from "@/components/layout/Navbar";
import { Toolbar } from "@/components/layout/Toolbar";
import { Sidebar } from "@/components/layout/Sidebar";
import { useProjectStore } from "@/stores/projectStore";
import { API_URL } from "@/lib/api";
import { Eye, RefreshCw, Maximize2, Layers, Crosshair, X, MousePointerClick, BoxSelect } from "lucide-react";

// Forma real de GET /api/ifc/element-properties (routers/ifc.py:1442) — los
// atributos van anidados bajo "attributes", no en el nivel superior.
type ElementProperties = {
  attributes: {
    GlobalId?: string | null;
    Name?: string | null;
    Description?: string | null;
    ObjectType?: string | null;
    Tag?: string | null;
  };
  psets: Record<string, Record<string, unknown>>;
};

export default function ViewerPage() {
  const iframeRef   = useRef<HTMLIFrameElement>(null);
  const [ready,     setReady]     = useState(false);   // iframe posted 'ready'
  const [loaded,    setLoaded]    = useState(false);   // at least one mesh loaded
  const [loading,   setLoading]   = useState(false);
  const [lastCount, setLastCount] = useState(0);       // triangles of last load

  const [selectedProps,  setSelectedProps]  = useState<ElementProperties | null>(null);
  const [propsLoading,   setPropsLoading]   = useState(false);
  // Modo de selección: "click" (un elemento) o "box" (arrastrar rectángulo,
  // varios elementos — como Civil3D: derecha=ventana, izquierda=cruce).
  const [selectionMode,  setSelectionMode]  = useState<"click" | "box">("click");
  // modelId (la URL que se le pasó al iframe) → path original del IFC, para
  // poder pedir propiedades por (path, globalId) cuando llega un 'select'.
  const modelPathByUrl = useRef<Map<string, string>>(new Map());

  const { selectedPaths } = useProjectStore();

  const src = `${API_URL}/api/viewer-html`;

  // ── Escuchar mensajes del iframe ──────────────────────────────────────────────
  const readyRef = useRef(false);
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const msg = e.data;
      if (!msg || msg.source !== "ifc-viewer") return;
      if (msg.event === "ready")  { readyRef.current = true; setReady(true); }
      if (msg.event === "loaded") { setLoaded(true); setLoading(false); setLastCount(msg.elements ?? 0); }
      if (msg.event === "error")  { setLoading(false); }
      if (msg.event === "select") {
        const path = modelPathByUrl.current.get(msg.modelId);
        if (path && msg.globalId) {
          setPropsLoading(true);
          setSelectedProps(null);
          fetch(`${API_URL}/api/ifc/element-properties?path=${encodeURIComponent(path)}&global_id=${encodeURIComponent(msg.globalId)}`)
            .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
            .then(data => setSelectedProps(data))
            .catch(() => setSelectedProps(null))
            .finally(() => setPropsLoading(false));
        }
      }
      if (msg.event === "deselect") { setSelectedProps(null); setPropsLoading(false); }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // ── Ping al iframe hasta que responda (resuelve carrera onLoad/useEffect) ─────
  // El iframe (HTML estático, se carga en el acto) suele mandar 'ready' antes
  // de que React monte su listener de 'message' — sobre todo en dev, donde el
  // árbol React tarda más en montar que el propio iframe en cargar. onLoad por
  // sí solo no basta (puede dispararse igual de rápido), así que reintentamos
  // el ping varias veces con backoff hasta confirmar 'ready'.
  const pingIframe = useCallback(() => {
    let tries = 0;
    const attempt = () => {
      if (readyRef.current || tries >= 8) return;
      tries++;
      iframeRef.current?.contentWindow?.postMessage({ type: "ping" }, "*");
      setTimeout(attempt, Math.min(150 * tries, 1000));
    };
    attempt();
  }, []);

  useEffect(() => { pingIframe(); }, [pingIframe]);
  const handleIframeLoad = pingIframe;

  // ── Enviar comando al iframe ──────────────────────────────────────────────────
  const send = useCallback((msg: object) => {
    iframeRef.current?.contentWindow?.postMessage(msg, "*");
  }, []);

  // ── Reenviar el modo de selección al iframe cuando cambie o esté listo ────────
  useEffect(() => {
    if (ready) send({ type: "set-selection-mode", mode: selectionMode });
  }, [ready, selectionMode, send]);

  // ── Paths únicos (cinturón y tirantes: el store ya deduplica) ─────────────────
  const uniquePaths = useMemo(() => Array.from(new Set(selectedPaths)), [selectedPaths]);

  // ── Cargar archivos seleccionados ─────────────────────────────────────────────
  const loadSelected = useCallback(() => {
    if (!ready || !uniquePaths.length) return;
    setLoading(true);
    setSelectedProps(null);
    const urls = uniquePaths.map(p => {
      const url = `${API_URL}/api/viewer-frag?path=${encodeURIComponent(p)}`;
      modelPathByUrl.current.set(url, p);
      return url;
    });
    send({ type: "load", files: urls });
  }, [ready, uniquePaths, send]);

  // ── Número de archivos seleccionados ──────────────────────────────────────────
  const selCount = uniquePaths.length;

  return (
    <>
      <Navbar />
      <Toolbar />
      <Sidebar />
      <main style={{
        marginLeft: "var(--sidebar-w)",
        marginTop:  "calc(var(--navbar-h) + var(--toolbar-h))",
        height:     "calc(100vh - var(--navbar-h) - var(--toolbar-h))",
        overflow:   "hidden",
        display:    "flex",
        flexDirection: "column",
      }}>

        {/* ── Barra superior del visor ───────────────────────────────────────── */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "5px 12px",
          background: "var(--surface)",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}>

          {/* Botón cargar */}
          <button
            onClick={loadSelected}
            disabled={!ready || !selCount || loading}
            title={!selCount ? "Selecciona IFCs en el árbol de la izquierda" : `Cargar ${selCount} IFC${selCount !== 1 ? "s" : ""} en el visor`}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "5px 14px",
              background: (!ready || !selCount) ? "rgba(91,140,255,0.04)" : "rgba(91,140,255,0.12)",
              border: `1px solid ${(!ready || !selCount) ? "rgba(91,140,255,0.15)" : "rgba(91,140,255,0.5)"}`,
              borderRadius: 5,
              color: (!ready || !selCount) ? "rgba(91,140,255,0.4)" : "var(--cyan)",
              fontSize: 12, fontFamily: "JetBrains Mono, monospace",
              cursor: (!ready || !selCount) ? "not-allowed" : "pointer",
              transition: "all 0.15s",
            }}
          >
            {loading
              ? <><RefreshCw size={12} style={{ animation: "spin 0.8s linear infinite" }} /> Cargando…</>
              : <><Eye size={12} /> Cargar en visor {selCount > 0 && `(${selCount})`}</>
            }
          </button>

          {/* Modo de selección: clic único o arrastrar rectángulo (varios) */}
          {loaded && (
            <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
              <button
                onClick={() => setSelectionMode("click")}
                title="Seleccionar con un clic"
                style={{ ...ctrlStyle, border: "none", borderRadius: 0,
                  background: selectionMode === "click" ? "rgba(91,140,255,0.18)" : "transparent",
                  color: selectionMode === "click" ? "var(--cyan)" : "var(--text-muted)" }}
              >
                <MousePointerClick size={11} /> Clic
              </button>
              <button
                onClick={() => setSelectionMode("box")}
                title="Arrastrar para seleccionar varios (como Civil3D: derecha=ventana, izquierda=cruce)"
                style={{ ...ctrlStyle, border: "none", borderRadius: 0,
                  background: selectionMode === "box" ? "rgba(91,140,255,0.18)" : "transparent",
                  color: selectionMode === "box" ? "var(--cyan)" : "var(--text-muted)" }}
              >
                <BoxSelect size={11} /> Arrastrar
              </button>
            </div>
          )}

          {/* Controles post-carga */}
          {loaded && (
            <>
              <button onClick={() => send({ type: "fit" })}      title="Encuadrar todo"   style={ctrlStyle}><Maximize2 size={11} /> Fit</button>
              <button onClick={() => send({ type: "show_all" })} title="Mostrar todo"     style={ctrlStyle}><Layers    size={11} /> Todo</button>
              <button onClick={() => send({ type: "isolate" })}  title="Aislar elemento"  style={ctrlStyle}><Crosshair size={11} /> Aislar</button>
              <button onClick={() => send({ type: "clear" })}    title="Limpiar escena"   style={{ ...ctrlStyle, color: "rgba(255,80,80,0.7)" }}>
                <RefreshCw size={11} /> Limpiar
              </button>
            </>
          )}

          {/* Info triangles */}
          {loaded && lastCount > 0 && (
            <span style={{
              marginLeft: "auto",
              fontSize: 10, color: "var(--text-muted)",
              fontFamily: "JetBrains Mono, monospace",
            }}>
              {lastCount.toLocaleString("es")} triáng.
            </span>
          )}

          {/* Estado del iframe */}
          {!ready && (
            <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--border-bright)" }}>
              Cargando visor…
            </span>
          )}
        </div>

        {/* ── iframe visor + panel de propiedades ───────────────────────────── */}
        <div style={{ flex: 1, display: "flex", overflow: "hidden", position: "relative" }}>
          <iframe
            ref={iframeRef}
            src={src}
            onLoad={handleIframeLoad}
            style={{ flex: 1, width: "100%", border: "none" }}
            allow="fullscreen"
            title="IFC 3D Viewer"
          />

          {(propsLoading || selectedProps) && (
            <div style={{
              position: "absolute", top: 8, right: 8, bottom: 8, width: 280,
              background: "var(--surface)", border: "1px solid var(--border)",
              borderRadius: 6, overflow: "auto", padding: "10px 12px",
              fontFamily: "JetBrains Mono, monospace", fontSize: 11,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ color: "var(--cyan)", fontWeight: 600 }}>Propiedades</span>
                <button
                  onClick={() => setSelectedProps(null)}
                  style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 2 }}
                  title="Cerrar"
                >
                  <X size={12} />
                </button>
              </div>
              {propsLoading && <div style={{ color: "var(--text-muted)" }}>Cargando…</div>}
              {!propsLoading && selectedProps && (
                <div>
                  {(["Name", "GlobalId", "ObjectType", "Description", "Tag"] as const)
                    .filter(k => selectedProps.attributes[k] != null && selectedProps.attributes[k] !== "")
                    .map(k => (
                      <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "2px 0", borderBottom: "1px solid var(--border)" }}>
                        <span style={{ color: "var(--text-muted)" }}>{k}</span>
                        <span style={{ color: "var(--fg)", textAlign: "right", wordBreak: "break-all" }}>{String(selectedProps.attributes[k])}</span>
                      </div>
                    ))}

                  {Object.entries(selectedProps.psets ?? {}).map(([psetName, props]) => (
                    <div key={psetName} style={{ marginTop: 10 }}>
                      <div style={{ color: "var(--cyan)", fontSize: 10, marginBottom: 3 }}>{psetName}</div>
                      {Object.entries(props ?? {})
                        .filter(([, v]) => v != null && v !== "")
                        .map(([k, v]) => (
                          <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "2px 0", borderBottom: "1px solid var(--border)" }}>
                            <span style={{ color: "var(--text-muted)" }}>{k}</span>
                            <span style={{ color: "var(--fg)", textAlign: "right", wordBreak: "break-all" }}>{String(v)}</span>
                          </div>
                        ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </>
  );
}

// ── Estilos botones de control ─────────────────────────────────────────────────
const ctrlStyle: CSSProperties = {
  display: "flex", alignItems: "center", gap: 4,
  padding: "4px 10px",
  background: "rgba(255,255,255,0.03)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  color: "var(--text-muted)",
  fontSize: 11, fontFamily: "JetBrains Mono, monospace",
  cursor: "pointer", transition: "all 0.12s",
};
