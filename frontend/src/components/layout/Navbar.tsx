"use client";

import { Circle, FolderOpen, Sun, Moon, Monitor, ChevronDown, Trash2, Loader2 } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { healthCheck, getSystemStats, clearSystemCache } from "@/lib/api";
import { useProjectStore } from "@/stores/projectStore";
import { useState, useEffect, useCallback, useRef } from "react";
import pkg from "../../../package.json";

// "2.0.18" -> version "2.0", build "18". package.json is the single source of
// truth (used to say "0.1.0" — boilerplate default, never touched — while this
// file hardcoded a completely different "v2.0" badge; they'd drifted apart).
// The build number is a total-updates-ever counter: it only ever goes up, never
// resets (unlike the "2.0" part, which can). Seeded 2026-09-15 at 18 — the best
// evidence-based estimate we have (git history here is only 3 commits deep),
// not an exact historical count. Bump the LAST segment on every significant
// change; bump the first two only for an intentional version milestone.
const [FRACTAL_VERSION, FRACTAL_BUILD] = (() => {
  const parts = pkg.version.split(".");
  return [parts.slice(0, 2).join("."), parts[2] ?? "0"];
})();

// ── Theme types ────────────────────────────────────────────────────────────
type ThemePref = "system" | "dark" | "light";

function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  root.classList.remove("dark", "light");
  if (pref === "system") {
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.classList.add(systemDark ? "dark" : "light");
  } else {
    root.classList.add(pref);
  }
}

function useTheme() {
  const [pref, setPref] = useState<ThemePref>("system");

  useEffect(() => {
    try {
      const stored = localStorage.getItem("fractal-theme") as ThemePref | null;
      if (stored) setPref(stored);
    } catch { /* ignore */ }
  }, []);

  const cycle = useCallback(() => {
    setPref(prev => {
      const next: ThemePref = prev === "system" ? "dark" : prev === "dark" ? "light" : "system";
      try { localStorage.setItem("fractal-theme", next); } catch { /* ignore */ }
      applyTheme(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme("system");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [pref]);

  return { pref, cycle };
}

// ── Fractal logo mark ──────────────────────────────────────────────────────
function FractalMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M12 2L20.66 7V17L12 22L3.34 17V7L12 2Z"
        stroke="var(--cyan)"
        strokeWidth="1.4"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M12 6L16.5 9V15L12 18L7.5 15V9L12 6Z"
        fill="var(--cyan)"
        fillOpacity="0.16"
        stroke="var(--cyan)"
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
      {/* Three branches from the nucleus — same mark as icon.svg and the sidebar tree core */}
      <path d="M12 12V6M12 12l4.5 3M12 12l-4.5 3" stroke="var(--cyan)" strokeWidth="0.9" strokeLinecap="round" />
      <circle cx="12" cy="12" r="1.8" fill="var(--cyan)" />
    </svg>
  );
}

// ── Theme toggle ───────────────────────────────────────────────────────────
function ThemeToggle({ pref, onCycle }: { pref: ThemePref; onCycle: () => void }) {
  const Icon = pref === "light" ? Sun : pref === "dark" ? Moon : Monitor;
  const label = pref === "light" ? "Tema: Claro" : pref === "dark" ? "Tema: Oscuro" : "Tema: Sistema";

  return (
    <button
      onClick={onCycle}
      title={label}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 32,
        height: 32,
        borderRadius: 8,
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        color: "var(--text-muted)",
        cursor: "pointer",
        transition: "all 0.15s ease",
        flexShrink: 0,
      }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLElement;
        el.style.color = "var(--text)";
        el.style.borderColor = "var(--border-bright)";
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLElement;
        el.style.color = "var(--text-muted)";
        el.style.borderColor = "var(--border)";
        el.style.background = "var(--surface-2)";
      }}
    >
      <Icon size={14} strokeWidth={1.8} />
    </button>
  );
}

// ── Memory indicator ──────────────────────────────────────────────────────
// El backend puede acumular varias cachés de IFC sin límite mientras el
// usuario pasa de una herramienta a otra (ver core/system_stats.py) — este
// desplegable muestra qué está ocupando RAM ahora mismo y deja liberarla sin
// reiniciar el backend. Mismo espíritu que el gauge de caché del dashboard
// legacy (BIM_HUB/ifc-hub), llevado a Fractal IFC.
function MemoryIndicator() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  const { data: stats, isError } = useQuery({
    queryKey: ["system-stats"],
    queryFn: getSystemStats,
    retry: false,
    refetchInterval: 15_000,
  });

  const [clearing, setClearing] = useState(false);
  const handleClear = useCallback(async () => {
    setClearing(true);
    try {
      const fresh = await clearSystemCache();
      qc.setQueryData(["system-stats"], fresh);
    } catch { /* silencioso: es un panel de diagnóstico, no bloquea la app */ }
    setClearing(false);
  }, [qc]);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  if (isError || !stats) return null;

  const pct = stats.process.system_percent;
  const level = pct > 85 ? "var(--red)" : pct > 60 ? "var(--yellow)" : "var(--green)";
  const derived = stats.derived_caches;
  const derivedTotal =
    derived.pset_index_cache + derived.pset_mat_cache + derived.entity_type_rows_cache +
    derived.elements_cache + derived.geom_json_cache + derived.geom_bin_cache;

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(v => !v)}
        title="Memoria del backend — clic para ver el desglose"
        style={{
          display: "flex", alignItems: "center", gap: 5,
          background: "transparent", border: "none", cursor: "pointer",
          padding: "4px 2px", fontSize: 11, color: "var(--text-muted)",
          fontFamily: "var(--font-plex-mono), monospace",
        }}
      >
        <Circle size={6} fill={level} color={level} />
        <span>{stats.process.rss_mb.toLocaleString("es-ES", { maximumFractionDigits: 0 })} MB</span>
        <ChevronDown size={11} style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 8px)", right: 0,
          width: 300, background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: 8, boxShadow: "var(--shadow-lg)", zIndex: 100,
          padding: 14, fontSize: 12,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
            <span style={{ fontWeight: 700, color: "var(--text-bright)" }}>Memoria del backend</span>
            <span style={{ fontFamily: "var(--font-plex-mono), monospace", color: level, fontWeight: 600 }}>
              {stats.process.rss_mb.toLocaleString("es-ES")} MB
            </span>
          </div>

          <div style={{ fontSize: 10.5, color: "var(--text-muted)", marginBottom: 12 }}>
            {stats.process.system_percent.toFixed(0)}% de la RAM del sistema en uso
            ({(stats.process.system_total_mb / 1000).toFixed(1)} GB totales)
          </div>

          <div style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", color: "var(--text-muted)", fontSize: 10.5, marginBottom: 4 }}>
              <span>MODELOS IFC CACHEADOS</span>
              <span>{stats.model_pool.size} / {stats.model_pool.max_size}</span>
            </div>
            {stats.model_pool.models.length === 0 ? (
              <div style={{ color: "var(--text-muted)", fontSize: 11 }}>Ninguno cargado ahora mismo.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {stats.model_pool.models.map(m => (
                  <div key={m.path} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span style={{
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      fontFamily: "var(--font-plex-mono), monospace", fontSize: 10.5, color: "var(--text)",
                    }} title={m.path}>
                      {m.name}
                    </span>
                    <span style={{ fontFamily: "var(--font-plex-mono), monospace", fontSize: 10.5, color: "var(--text-muted)", flexShrink: 0 }}>
                      {m.size_mb != null ? `${m.size_mb} MB` : "—"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", color: "var(--text-muted)", fontSize: 10.5, marginBottom: 4 }}>
              <span>CACHÉS DERIVADAS (sin límite)</span>
              <span>{derivedTotal} entradas</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "3px 10px", fontSize: 10.5 }}>
              <span style={{ color: "var(--text-muted)" }}>Índices de psets</span>
              <span style={{ textAlign: "right", fontFamily: "var(--font-plex-mono), monospace" }}>{derived.pset_index_cache}</span>
              <span style={{ color: "var(--text-muted)" }}>Materiales</span>
              <span style={{ textAlign: "right", fontFamily: "var(--font-plex-mono), monospace" }}>{derived.pset_mat_cache}</span>
              <span style={{ color: "var(--text-muted)" }}>Tipos de entidad</span>
              <span style={{ textAlign: "right", fontFamily: "var(--font-plex-mono), monospace" }}>{derived.entity_type_rows_cache}</span>
              <span style={{ color: "var(--text-muted)" }}>Elementos</span>
              <span style={{ textAlign: "right", fontFamily: "var(--font-plex-mono), monospace" }}>{derived.elements_cache}</span>
              <span style={{ color: "var(--text-muted)" }}>Geometría (JSON)</span>
              <span style={{ textAlign: "right", fontFamily: "var(--font-plex-mono), monospace" }}>{derived.geom_json_cache}</span>
              <span style={{ color: "var(--text-muted)" }}>Geometría (binaria)</span>
              <span style={{ textAlign: "right", fontFamily: "var(--font-plex-mono), monospace" }}>{derived.geom_bin_cache}</span>
            </div>
          </div>

          <button
            onClick={handleClear}
            disabled={clearing}
            style={{
              width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              padding: "7px 10px", borderRadius: 5, fontSize: 11.5, fontWeight: 600,
              background: "transparent", color: clearing ? "var(--text-muted)" : "var(--red)",
              border: `1px solid ${clearing ? "var(--border)" : "var(--red)"}`,
              cursor: clearing ? "default" : "pointer",
            }}
          >
            {clearing ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
            {clearing ? "Liberando…" : "Liberar toda la caché"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Navbar ─────────────────────────────────────────────────────────────────
export function Navbar() {
  const { data: health, isError } = useQuery({
    queryKey: ["health"],
    queryFn: healthCheck,
    retry: false,
    refetchInterval: 10_000,
  });

  const { sources, files } = useProjectStore();
  const { pref, cycle } = useTheme();
  const apiOk = !isError && health?.status === "ok";

  const sourceLabel = sources.length === 0 ? null
    : sources.length === 1 ? sources[0].label
    : `${sources.length} fuentes`;

  return (
    <header style={{
      position: "fixed",
      top: 0, left: 0, right: 0,
      height: "var(--navbar-h)",
      background: "var(--surface)",
      borderBottom: "1px solid var(--border)",
      boxShadow: "var(--shadow-sm)",
      display: "flex",
      alignItems: "center",
      padding: "0 16px",
      zIndex: 50,
      justifyContent: "space-between",
    }}>

      {/* ── Left: brand + project ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <FractalMark size={22} />

        <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
          <span style={{
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: "-0.01em",
            color: "var(--text-bright)",
          }}>
            Fractal
          </span>
          <span style={{
            fontSize: 14,
            fontWeight: 400,
            letterSpacing: "-0.01em",
            color: "var(--text-muted)",
          }}>
            IFC
          </span>
        </div>

        <span title={`Build ${FRACTAL_BUILD} — total de actualizaciones desde el 2026-09-15`} style={{
          fontSize: 10,
          fontWeight: 600,
          color: "var(--text-muted)",
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          borderRadius: 4,
          padding: "1px 6px",
        }}>
          v{FRACTAL_VERSION} · build {FRACTAL_BUILD}
        </span>

        {sourceLabel && (
          <>
            <div style={{ width: 1, height: 14, background: "var(--border-bright)" }} />
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <FolderOpen size={11} color="var(--text-muted)" />
              <span style={{
                fontSize: 11,
                color: "var(--text-muted)",
                maxWidth: 220,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>
                {sourceLabel}
              </span>
              {files.length > 0 && (
                <span style={{
                  fontSize: 10,
                  color: "var(--cyan)",
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  padding: "0px 6px",
                  fontWeight: 600,
                }}>
                  {files.length} IFC
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Right: status + theme toggle ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11 }}>
          <Circle
            size={6}
            fill={apiOk ? "var(--green)" : "var(--red)"}
            color={apiOk ? "var(--green)" : "var(--red)"}
          />
          <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-plex-mono), monospace" }}>
            API {apiOk ? "online" : "offline"}
          </span>
        </div>

        {apiOk && (
          <>
            <div style={{ height: 16, width: 1, background: "var(--border-bright)" }} />
            <MemoryIndicator />
          </>
        )}

        <div style={{ height: 16, width: 1, background: "var(--border-bright)" }} />

        <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-plex-mono), monospace" }}>
          PB :8090
        </span>

        <div style={{ height: 16, width: 1, background: "var(--border-bright)" }} />

        <ThemeToggle pref={pref} onCycle={cycle} />
      </div>
    </header>
  );
}
