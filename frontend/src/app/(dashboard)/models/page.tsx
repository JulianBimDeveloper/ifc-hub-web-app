"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  FolderOpen, RefreshCw, X, FileBox, FileText, Cpu, HardDrive, Calendar, User, Building2,
  Layers, Database, AlertTriangle, Tag, Type as TypeIcon, Palette, List, Link2, Copy, Info,
} from "lucide-react";
import { useProjectStore, IFCFileInfo, IFCSource } from "@/stores/projectStore";
import { getPB } from "@/lib/pb";
import { MIDP_ETAPA_ACTIVA } from "@/lib/constants";

const API = "http://127.0.0.1:8020";

// ── Etapa (MOI/MOM) lookup from PocketBase `midp_mapping` ──────────────────────
// A given IFC filename belongs to exactly one etapa — MOI and MOM are different
// project stages with their own file nomenclature (e.g. a "...-522110-..." code
// is MOI, its "...-523110-..." successor is MOM), never the same file. If the
// collection has more than one etapa row for the exact same ifc_name (bad/stale
// data), the currently active project stage (MIDP_ETAPA_ACTIVA) wins.
interface MidpMapping { id: string; ifc_name: string; native_name: string; etapa?: string; }

function useAllMidpMappings() {
  return useQuery<MidpMapping[]>({
    queryKey: ["midp_mapping", "all-etapas"],
    queryFn: () => getPB().collection("midp_mapping").getFullList<MidpMapping>({ requestKey: null }),
    staleTime: 60_000,
    retry: 2,
  });
}

function buildEtapaIndex(mappings: MidpMapping[] | undefined): Map<string, string> {
  const index = new Map<string, string>();
  for (const m of mappings ?? []) {
    if (!m.etapa) continue;
    const key = m.ifc_name.trim().toLowerCase();
    const existing = index.get(key);
    if (!existing || existing !== MIDP_ETAPA_ACTIVA) {
      if (!existing || m.etapa === MIDP_ETAPA_ACTIVA) index.set(key, m.etapa);
    }
  }
  return index;
}

const ETAPA_STYLE = { bg: "rgba(79,143,176,0.10)", text: "#cc66ff", border: "rgba(79,143,176,0.3)" };

// ── Origin detection (Civil3D / Revit) ─────────────────────────────────────────
// Mirrors detectOrigin() used in Sidebar.tsx / ifc-classify / ifc-project-default.
type Origin = "RVT" | "C3D" | null;

function detectOrigin(info?: { originating_system?: string; organization?: string; author?: string }): Origin {
  if (!info) return null;
  if (info.originating_system) {
    const s = info.originating_system.toUpperCase();
    if (s.includes("REVIT")) return "RVT";
    if (s.includes("CIVIL 3D") || s.includes("CIVIL3D")) return "C3D";
  }
  const combinedText = [info.organization, info.author].filter(Boolean).join(" ").toUpperCase();
  if (combinedText.includes("REVIT")) return "RVT";
  if (combinedText.includes("CIVIL") || combinedText.includes("C3D")) return "C3D";
  return null;
}

function originStyle(origin: Origin): { bg: string; text: string; border: string; label: string } | null {
  if (origin === "RVT") return { bg: "rgba(122,111,217,0.10)", text: "var(--magenta)", border: "rgba(122,111,217,0.3)", label: "REVIT" };
  if (origin === "C3D") return { bg: "rgba(217,164,65,0.10)", text: "#D9A441",        border: "rgba(217,164,65,0.3)", label: "CIVIL 3D" };
  return null;
}

// ── Tool shortcuts reachable from a model card ──────────────────────────────────
interface ToolLink { key: string; label: string; route: string; icon: React.ReactNode; }

const TOOL_LINKS: ToolLink[] = [
  { key: "project",      label: "Project Default",   route: "/ifc-project-default", icon: <Layers size={12} /> },
  { key: "classifier",   label: "Classifier",        route: "/ifc-classify",        icon: <Tag size={12} /> },
  { key: "nametype",     label: "Name Type+ID",      route: "/ifc-name-type-id",    icon: <TypeIcon size={12} /> },
  { key: "material",     label: "Material",          route: "/ifc-material",        icon: <Palette size={12} /> },
  { key: "nomenclature", label: "Nomenclature",      route: "/ifc-nomenclature",    icon: <List size={12} /> },
  { key: "relparams",    label: "Relation Params",   route: "/ifc-relation-params", icon: <Link2 size={12} /> },
];

// ── Schema badge colors ───────────────────────────────────────────────────────
const SCHEMA_COLOR: Record<string, { bg: string; text: string; border: string }> = {
  IFC4X3: { bg: "rgba(91,140,255,0.12)", text: "#5B8CFF",   border: "rgba(91,140,255,0.35)" },
  IFC4:   { bg: "rgba(63,190,138,0.10)", text: "#3FBE8A",   border: "rgba(63,190,138,0.30)" },
  IFC2X3: { bg: "rgba(217,164,65,0.10)", text: "#D9A441",   border: "rgba(217,164,65,0.30)" },
};
const SCHEMA_DEFAULT = { bg: "var(--border)", text: "var(--border-bright)", border: "var(--text-muted)" };

function schemaStyle(schema: string) {
  const key = schema?.toUpperCase().replace("IFC4X3AD", "IFC4X3");
  return SCHEMA_COLOR[key] ?? SCHEMA_DEFAULT;
}

// Cyberpunk Neon Palette (cycling through 16 vibrant colors)
const NEON_PALETTE = [
  "#5B8CFF",  // 0: Cyan brilliant
  "#7A6FD9",  // 1: Magenta
  "#3FBE8A",  // 2: Green lime
  "#D9A441",  // 3: Yellow neon
  "#ff1493",  // 4: Hot pink
  "#00ccff",  // 5: Sky cyan
  "#ff6600",  // 6: Orange neon
  "#00ff44",  // 7: Bright green
  "#4F8FB0",  // 8: Purple
  "#ff0080",  // 9: Magenta dark
  "#00dd66",  // 10: Green neon
  "#D9A441",  // 11: Orange gold
  "#cc00ff",  // 12: Purple bright
  "#5B6B8C",  // 13: Blue neon
  "#88ff00",  // 14: Lime
  "#dd00ff",  // 15: Violet bright
];

// Get color by type name or index (with cycling fallback)
function getTypeColor(typeName: string, index: number): string {
  // Use index to cycle through palette for variety
  return NEON_PALETTE[index % NEON_PALETTE.length];
}

// ── Split filename: extract descriptor and code parts ──────────────────────────
// Format: "442_MAM_TOPOGRAFIA 000000000001-ACO-MOP-ME-CYT-521110"
// Returns: { descriptor: "MAM_TOPOGRAFIA", code: "000000000001-ACO-MOP-ME-CYT-521110", full: "..." }
function splitIFCName(filename: string): { descriptor: string; code: string; full: string } {
  const full = filename.replace(/\.ifc$/i, "");

  // Try to split by space first
  const spaceParts = full.split(" ");
  if (spaceParts.length >= 2) {
    // Has space: "442_MAM_TOPOGRAFIA" "000000000001-ACO-MOP-ME-CYT-521110"
    const namePart = spaceParts[0];  // "442_MAM_TOPOGRAFIA"
    const codePart = spaceParts.slice(1).join(" ");  // Rest is code

    // Extract descriptor from name part (skip the number prefix like "442_")
    const underscoreParts = namePart.split("_");
    let descriptor = namePart;

    // If first part is all digits, skip it and take the rest
    if (underscoreParts.length > 1 && /^\d+$/.test(underscoreParts[0])) {
      descriptor = underscoreParts.slice(1).join("_");
    }

    return { descriptor, code: codePart, full };
  }

  // No space: try to split by dash
  const lastDashIdx = full.lastIndexOf("-");
  if (lastDashIdx > 0) {
    const descriptor = full.substring(0, lastDashIdx);
    const code = full.substring(lastDashIdx + 1);
    return { descriptor, code, full };
  }

  // Fallback
  return { descriptor: full, code: "", full };
}

// ── Card context/click menu ─────────────────────────────────────────────────────
// Anchored popup listing tool shortcuts (always) plus file-management actions
// (only when opened via right-click, mode === "full").

interface MenuState { x: number; y: number; mode: "tools" | "full"; }

function CardMenu({
  menu, file, onClose, onNavigate, onCopyPath, onRemoveSource,
}: {
  menu: MenuState;
  file: { filename: string; path: string };
  onClose: () => void;
  onNavigate: (route: string) => void;
  onCopyPath: () => void;
  onRemoveSource: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onEsc(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [onClose]);

  // Clamp so the menu never renders off-screen
  const width = 210;
  const left = Math.min(menu.x, (typeof window !== "undefined" ? window.innerWidth : 9999) - width - 8);
  const top  = Math.min(menu.y, (typeof window !== "undefined" ? window.innerHeight : 9999) - 360);

  const itemStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 7, width: "100%",
    padding: "6px 10px", fontSize: 11, fontFamily: "JetBrains Mono, monospace",
    background: "none", border: "none", cursor: "pointer", textAlign: "left",
    color: "var(--text-bright)", borderRadius: 3,
  };

  // Rendered via portal straight into <body> — a card can sit inside an
  // `overflow:hidden` + `backdrop-filter` box (card-cyber), and CSS makes that
  // box the containing/clipping block for both `position:fixed` and `absolute`
  // descendants, which silently clips popups to invisible. Escaping to <body>
  // sidesteps that entirely regardless of engine quirks.
  return createPortal(
    <div ref={ref} style={{
      position: "fixed", left, top, width, zIndex: 500,
      background: "var(--surface)", border: "1px solid var(--border-bright)", borderRadius: 6,
      boxShadow: "var(--shadow-lg)",
      overflow: "hidden", padding: 4,
    }}>
      <div style={{
        fontSize: 8.5, color: "var(--text-muted)", padding: "5px 8px 6px",
        borderBottom: "1px solid var(--border)", marginBottom: 4,
        fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.05em",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {file.filename}
      </div>

      <div style={{ fontSize: 7.5, color: "var(--dim)", padding: "2px 8px 3px",
        letterSpacing: "0.1em", fontFamily: "JetBrains Mono, monospace" }}>
        HERRAMIENTAS
      </div>
      {TOOL_LINKS.map(t => (
        <button key={t.key} style={itemStyle} onClick={() => onNavigate(t.route)}
          onMouseEnter={e => (e.currentTarget.style.background = "rgba(91,140,255,0.08)")}
          onMouseLeave={e => (e.currentTarget.style.background = "none")}
        >
          {t.icon} {t.label}
        </button>
      ))}

      {menu.mode === "full" && (
        <>
          <div style={{ height: 1, background: "var(--border)", margin: "4px 2px" }} />
          <div style={{ fontSize: 7.5, color: "var(--dim)", padding: "2px 8px 3px",
            letterSpacing: "0.1em", fontFamily: "JetBrains Mono, monospace" }}>
            ACCIONES
          </div>
          <button style={itemStyle} onClick={onCopyPath}
            onMouseEnter={e => (e.currentTarget.style.background = "rgba(91,140,255,0.08)")}
            onMouseLeave={e => (e.currentTarget.style.background = "none")}
          >
            <Copy size={12} /> Copiar ruta
          </button>
          <button style={{ ...itemStyle, color: "var(--red)" }} onClick={onRemoveSource}
            onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,68,102,0.08)")}
            onMouseLeave={e => (e.currentTarget.style.background = "none")}
          >
            <X size={12} /> Eliminar fuente del modelo
          </button>
        </>
      )}
    </div>,
    document.body
  );
}

// ── Hover tooltip: detailed IFC header info ─────────────────────────────────────

function CardTooltip({ info, origin, full, pos, etapa }: { info: IFCFileInfo; origin: Origin; full: string; pos: { x: number; y: number }; etapa?: string }) {
  const os = originStyle(origin);
  const rows: [string, string][] = [
    ["Archivo", full],
    ["Origen", os ? os.label : "Desconocido"],
    ...(etapa ? [["Etapa", etapa] as [string, string]] : []),
    ["Aplicación", info.originating_system || "—"],
    ["Proyecto", info.project_name || "—"],
    ["Descripción", info.project_description || "—"],
    ["Autor", info.author || "—"],
    ["Organización", info.organization || "—"],
    ["Schema", info.schema || "—"],
    ["Elementos", info.element_count?.toLocaleString() ?? "—"],
    ["Tamaño", `${info.file_size_mb} MB`],
  ];

  // Clamp so the tooltip never renders off-screen
  const width = 260;
  const left = Math.min(pos.x, (typeof window !== "undefined" ? window.innerWidth : 9999) - width - 8);
  const top  = Math.min(pos.y, (typeof window !== "undefined" ? window.innerHeight : 9999) - 260);

  // Portal straight into <body> — see CardMenu for why (card-cyber's
  // overflow:hidden + backdrop-filter otherwise clips this to invisible).
  return createPortal(
    <div style={{
      position: "fixed", left, top, width, zIndex: 400,
      background: "var(--surface)", border: "1px solid var(--border-bright)", borderRadius: 6,
      boxShadow: "var(--shadow-lg)",
      padding: "8px 10px", pointerEvents: "none",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 5,
        fontSize: 9, color: "var(--cyan)", fontFamily: "JetBrains Mono, monospace", fontWeight: 700 }}>
        <Info size={11} /> DETALLES IFC
      </div>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "flex", gap: 6, marginBottom: 2 }}>
          <span style={{ fontSize: 8.5, color: "var(--text-muted)", flexShrink: 0, width: 78,
            fontFamily: "JetBrains Mono, monospace" }}>{k}</span>
          <span style={{ fontSize: 8.5, color: "var(--text-bright)", overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "JetBrains Mono, monospace" }}>{v}</span>
        </div>
      ))}
    </div>,
    document.body
  );
}

// ── Expanded card: floating detail panel (opened on left-click) ────────────────

function BigStat({ icon, label, value, color, wrap, span }: {
  icon: React.ReactNode; label: string; value: string; color: string; wrap?: boolean; span?: number;
}) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 4, padding: "10px 12px",
      background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8,
      gridColumn: span ? `span ${span}` : undefined, minWidth: 0,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 5, color: "rgba(140,165,190,0.6)" }}>
        {icon}
        <span style={{ fontSize: 8.5, fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</span>
      </div>
      <div style={wrap ? {
        fontSize: 12, color, fontWeight: 700, fontFamily: "JetBrains Mono, monospace",
        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
        overflow: "hidden", lineHeight: 1.35, wordBreak: "break-word",
      } : {
        fontSize: 14, color, fontWeight: 700, fontFamily: "JetBrains Mono, monospace",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {value}
      </div>
    </div>
  );
}

function ExpandedCard({
  file, info, origin, descriptor, code, full, lastMod, etapa, onClose, onNavigate, onCopyPath, onRemoveSource,
}: {
  file: { filename: string; path: string; sourceId?: string };
  info: IFCFileInfo;
  origin: Origin;
  descriptor: string;
  code: string;
  full: string;
  lastMod: Date | null;
  etapa?: string;
  onClose: () => void;
  onNavigate: (route: string) => void;
  onCopyPath: () => void;
  onRemoveSource: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const sc = schemaStyle(info.schema);
  const os = originStyle(origin);

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    function onEsc(e: KeyboardEvent) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onEsc);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("keydown", onEsc);
      document.body.style.overflow = prevOverflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function close() {
    setVisible(false);
    setTimeout(onClose, 180);
  }

  const types = info.top_types ?? [];
  const totalCount = types.reduce((s, t) => s + t.count, 0);
  const glow = os ? os.text : sc.text;

  return createPortal(
    <div onClick={close} style={{
      position: "fixed", inset: 0, zIndex: 600, display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(3,8,14,0.72)",
      opacity: visible ? 1 : 0, transition: "opacity 0.2s ease", padding: 24,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: "min(620px, 100%)", maxHeight: "86vh", overflowY: "auto",
        background: "var(--surface)",
        border: `1px solid ${os ? os.border : sc.border}`,
        borderRadius: 14,
        boxShadow: `var(--shadow-lg), 0 0 50px ${glow}33`,
        transform: visible ? "scale(1) translateY(0)" : "scale(0.94) translateY(10px)",
        transition: "transform 0.25s cubic-bezier(.2,.9,.25,1.15), opacity 0.2s ease",
        opacity: visible ? 1 : 0,
        position: "relative",
      }}>
        {/* Header */}
        <div style={{
          padding: "18px 22px 16px", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "flex-start", gap: 12,
          background: `linear-gradient(135deg, ${glow}14, transparent 60%)`,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
              <span style={{
                fontSize: 9, fontWeight: 700, padding: "3px 8px", borderRadius: 4,
                fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.08em",
                background: sc.bg, color: sc.text, border: `1px solid ${sc.border}`,
              }}>
                {info.schema}
              </span>
              {os && (
                <span style={{
                  fontSize: 9, fontWeight: 700, padding: "3px 8px", borderRadius: 4,
                  fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.08em",
                  background: os.bg, color: os.text, border: `1px solid ${os.border}`,
                  boxShadow: `0 0 10px ${os.text}40`,
                }}>
                  {os.label}
                </span>
              )}
              {etapa && (
                <span style={{
                  fontSize: 9, fontWeight: 700, padding: "3px 8px", borderRadius: 4,
                  fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.08em",
                  background: ETAPA_STYLE.bg, color: ETAPA_STYLE.text, border: `1px solid ${ETAPA_STYLE.border}`,
                }}>
                  {etapa}
                </span>
              )}
            </div>
            <div style={{
              fontSize: 16, fontWeight: 700, color: "var(--text-bright)",
              fontFamily: "JetBrains Mono, monospace", textShadow: `0 0 14px ${glow}55`,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {code || descriptor || full}
            </div>
            {descriptor && (
              <div style={{ fontSize: 10, color: "rgba(91,140,255,0.6)", marginTop: 4,
                fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.04em" }}>
                {descriptor}
              </div>
            )}
          </div>
          <button onClick={close} title="Cerrar" style={{
            background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 6,
            width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", color: "var(--text-muted)", flexShrink: 0,
          }}>
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "18px 22px" }}>
          {info.project_description && (
            <div style={{
              fontSize: 11.5, color: "var(--text-bright)", lineHeight: 1.5, marginBottom: 16,
              padding: "10px 12px", background: "var(--surface-2)",
              borderLeft: `2px solid ${glow}`, borderRadius: 4,
            }}>
              {info.project_description}
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 8 }}>
            <BigStat icon={<Cpu size={11} />}       label="Elementos"  value={info.element_count.toLocaleString()} color={glow} />
            <BigStat icon={<HardDrive size={11} />} label="Tamaño"     value={`${info.file_size_mb} MB`} color={glow} />
            <BigStat icon={<Calendar size={11} />}  label="Modificado" value={lastMod ? lastMod.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "2-digit" }) : "—"} color="var(--text-bright)" />
            <BigStat icon={<User size={11} />}      label="Autor"      value={info.author || "—"} color="var(--text-bright)" span={1} />
            <BigStat icon={<Database size={11} />}  label="Proyecto"   value={info.project_name || "—"} color="var(--text-bright)" span={1} />
            {etapa && (
              <BigStat icon={<Tag size={11} />} label="Etapa" value={etapa} color={ETAPA_STYLE.text} span={1} />
            )}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8, marginBottom: 18 }}>
            <BigStat icon={<Building2 size={11} />} label="Organización" value={info.organization || "—"} color="var(--text-bright)" wrap />
          </div>

          <div style={{
            fontSize: 9, color: "rgba(140,165,190,0.6)", marginBottom: 6,
            fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.08em",
          }}>
            APLICACIÓN DE ORIGEN
          </div>
          <div style={{
            fontSize: 11, color: glow, fontFamily: "JetBrains Mono, monospace", marginBottom: 18,
            padding: "8px 10px", background: `${glow}0d`, border: `1px solid ${glow}30`, borderRadius: 6,
          }}>
            {info.originating_system || "Desconocida"}
          </div>

          {types.length > 0 && (
            <>
              <div style={{ fontSize: 9, color: "var(--cyan)", marginBottom: 8,
                fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.1em", fontWeight: 700 }}>
                ⚡ TIPOS DE ELEMENTOS ({types.length})
              </div>
              <div style={{
                display: "flex", height: 10, borderRadius: 5, overflow: "hidden", gap: 1.5, marginBottom: 10,
                boxShadow: "0 0 14px rgba(91,140,255,0.2), inset 0 0 8px rgba(91,140,255,0.05)",
              }}>
                {types.map((t, idx) => (
                  <div key={t.type} title={`${t.type}: ${t.count}`} style={{
                    flex: t.count, background: getTypeColor(t.type, idx),
                    boxShadow: `0 0 8px ${getTypeColor(t.type, idx)}80`,
                  }} />
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 14px", marginBottom: 18 }}>
                {types.map((t, idx) => {
                  const color = getTypeColor(t.type, idx);
                  const pct = totalCount ? ((t.count / totalCount) * 100).toFixed(1) : "0";
                  return (
                    <div key={t.type} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 7, height: 7, borderRadius: 2, flexShrink: 0, background: color, boxShadow: `0 0 4px ${color}80` }} />
                      <span style={{ fontSize: 10, color, fontFamily: "JetBrains Mono, monospace", flex: 1,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {t.type.replace("Ifc", "")}
                      </span>
                      <span style={{ fontSize: 9, color: "var(--text-muted)", fontFamily: "JetBrains Mono, monospace" }}>
                        {t.count.toLocaleString()} · {pct}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <div style={{ fontSize: 9, color: "rgba(140,165,190,0.6)", marginBottom: 8,
            fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.08em" }}>
            HERRAMIENTAS
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 16 }}>
            {TOOL_LINKS.map(t => (
              <button key={t.key} onClick={() => onNavigate(t.route)} style={{
                display: "flex", alignItems: "center", gap: 6, padding: "8px 10px",
                fontSize: 10.5, fontFamily: "JetBrains Mono, monospace", fontWeight: 600,
                background: "rgba(91,140,255,0.05)", border: "1px solid rgba(91,140,255,0.18)",
                borderRadius: 6, color: "var(--cyan)", cursor: "pointer",
              }}
                onMouseEnter={e => (e.currentTarget.style.background = "rgba(91,140,255,0.12)")}
                onMouseLeave={e => (e.currentTarget.style.background = "rgba(91,140,255,0.05)")}
              >
                {t.icon} {t.label}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", gap: 14, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
            <button onClick={onCopyPath} style={{
              display: "flex", alignItems: "center", gap: 5, background: "none", border: "none",
              color: "var(--text-muted)", fontSize: 10, fontFamily: "JetBrains Mono, monospace", cursor: "pointer",
            }}>
              <Copy size={11} /> Copiar ruta
            </button>
            <button onClick={onRemoveSource} style={{
              display: "flex", alignItems: "center", gap: 5, background: "none", border: "none",
              color: "var(--red)", fontSize: 10, fontFamily: "JetBrains Mono, monospace", cursor: "pointer",
            }}>
              <X size={11} /> Eliminar fuente
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── IFC File Card ─────────────────────────────────────────────────────────────

type CardStatus = "loading" | "done" | "error";

function IFCCard({ file, etapa }: { file: { filename: string; path: string; sourceId?: string }; etapa?: string }) {
  const { fileInfos, setFileInfo, setSelectedPaths, removeSource } = useProjectStore();
  const info: IFCFileInfo | undefined = fileInfos[file.path];
  const router = useRouter();

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Local fetch state — completely independent of Zustand loading flags
  const [status, setStatus] = useState<CardStatus>(info ? "done" : "loading");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    // Already cached — nothing to do
    if (fileInfos[file.path]) { setStatus("done"); return; }

    setStatus("loading");

    const ctrl  = new AbortController();
    // 45-second hard timeout — fast STEP reader finishes in < 10 s even for large files
    const timer = setTimeout(() => ctrl.abort(), 45_000);

    fetch(`${API}/api/ifc/info?path=${encodeURIComponent(file.path)}`, { signal: ctrl.signal })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: IFCFileInfo) => {
        setFileInfo(file.path, d);
        setStatus("done");
      })
      .catch((err: unknown) => {
        // AbortError = React StrictMode cleanup or component unmount — NOT a real error.
        // In dev/StrictMode React mounts twice: first mount's cleanup aborts the fetch,
        // then the second mount starts a fresh one. Ignore AbortError silently.
        const name = (err as { name?: string })?.name;
        if (name !== "AbortError") setStatus("error");
        // If AbortError: status stays "loading" and second-mount effect retries below.
      })
      .finally(() => clearTimeout(timer));

    return () => { ctrl.abort(); clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path, retryKey]);

  const sc          = info ? schemaStyle(info.schema) : SCHEMA_DEFAULT;
  const { descriptor, code, full } = splitIFCName(file.filename);
  const lastMod     = info ? new Date(info.last_modified * 1000) : null;
  const loading     = status === "loading";
  const origin      = info ? detectOrigin(info) : null;
  const os          = originStyle(origin);

  function openMenu(x: number, y: number, mode: MenuState["mode"]) {
    if (!info) return; // nothing to do until the file has loaded
    setTooltipPos(null);
    setMenu({ x, y, mode });
  }

  function navigateTo(route: string) {
    setSelectedPaths([file.path]);
    setMenu(null);
    setExpanded(false);
    router.push(route);
  }

  function copyPath() {
    navigator.clipboard?.writeText(file.path).catch(() => {});
    setMenu(null);
  }

  function removeThisSource() {
    if (file.sourceId) removeSource(file.sourceId);
    setMenu(null);
    setExpanded(false);
  }

  return (
    <div ref={cardRef} className="card-cyber" style={{
      display: "flex", flexDirection: "column", gap: 0,
      overflow: "hidden", position: "relative",
      cursor: info ? "pointer" : "default",
      transition: "box-shadow 0.3s ease, border-color 0.2s ease",
    }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLElement).style.boxShadow = "0 0 20px rgba(91,140,255,0.18)";
        (e.currentTarget as HTMLElement).style.borderColor = "rgba(91,140,255,0.3)";
        if (info) tooltipTimer.current = setTimeout(() => {
          const r = cardRef.current?.getBoundingClientRect();
          if (r) setTooltipPos({ x: r.left, y: r.bottom + 6 });
        }, 350);
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLElement).style.boxShadow = "";
        (e.currentTarget as HTMLElement).style.borderColor = "";
        if (tooltipTimer.current) clearTimeout(tooltipTimer.current);
        setTooltipPos(null);
      }}
      onClick={() => {
        if (!info) return; // nothing to show until the file has loaded
        setTooltipPos(null);
        setExpanded(true);
      }}
      onContextMenu={e => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, "full");
      }}
    >
      {tooltipPos && info && !menu && !expanded && <CardTooltip info={info} origin={origin} full={full} pos={tooltipPos} etapa={etapa} />}
      {menu && (
        <CardMenu
          menu={menu}
          file={file}
          onClose={() => setMenu(null)}
          onNavigate={navigateTo}
          onCopyPath={copyPath}
          onRemoveSource={removeThisSource}
        />
      )}
      {expanded && info && (
        <ExpandedCard
          file={file}
          info={info}
          origin={origin}
          descriptor={descriptor}
          code={code}
          full={full}
          lastMod={lastMod}
          etapa={etapa}
          onClose={() => setExpanded(false)}
          onNavigate={navigateTo}
          onCopyPath={copyPath}
          onRemoveSource={removeThisSource}
        />
      )}

      {/* Scan-line texture */}
      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        backgroundImage: "repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(91,140,255,0.008) 3px,rgba(91,140,255,0.008) 4px)",
      }} />

      {/* ── Header: schema badge + filename ── */}
      <div style={{
        padding: "10px 12px 8px", borderBottom: "1px solid var(--border)",
        display: "flex", alignItems: "flex-start", gap: 8,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Schema badge / origin badge / status badge */}
          <div style={{ marginBottom: 5, display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
            {info ? (
              <>
                <span style={{
                  fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 3,
                  fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.08em",
                  background: sc.bg, color: sc.text, border: `1px solid ${sc.border}`,
                }}>
                  {info.schema}
                </span>
                {os && (
                  <span title={info.originating_system} style={{
                    fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 3,
                    fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.08em",
                    background: os.bg, color: os.text, border: `1px solid ${os.border}`,
                  }}>
                    {os.label}
                  </span>
                )}
                {etapa && (
                  <span style={{
                    fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 3,
                    fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.08em",
                    background: ETAPA_STYLE.bg, color: ETAPA_STYLE.text, border: `1px solid ${ETAPA_STYLE.border}`,
                  }}>
                    {etapa}
                  </span>
                )}
              </>
            ) : status === "error" ? (
              <span style={{
                fontSize: 8, padding: "2px 6px", borderRadius: 3,
                background: "rgba(255,51,85,0.1)", color: "var(--red)",
                border: "1px solid rgba(255,51,85,0.3)",
                fontFamily: "JetBrains Mono, monospace",
              }}>
                ERROR
              </span>
            ) : (
              <span style={{
                fontSize: 8, padding: "2px 6px", borderRadius: 3,
                background: "var(--border)", color: "var(--border-bright)",
                border: "1px solid var(--border)",
                fontFamily: "JetBrains Mono, monospace",
                animation: loading ? "pulse 1.4s ease-in-out infinite" : undefined,
              }}>
                LEYENDO…
              </span>
            )}
          </div>
          {/* Filename — code (main) + descriptor (metadata) */}
          <div style={{
            fontSize: 11, fontWeight: 700, color: "var(--text-bright)",
            fontFamily: "JetBrains Mono, monospace",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            lineHeight: 1.3,
          }} title={full}>
            {code || descriptor || "sin-nombre"}
          </div>
          {/* Descriptor badge */}
          {descriptor && (
            <div style={{
              fontSize: 7.5, color: "rgba(91,140,255,0.6)", marginTop: 3,
              fontFamily: "JetBrains Mono, monospace",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              letterSpacing: "0.04em",
            }} title={full}>
              {descriptor}
            </div>
          )}
          {info?.project_name && (
            <div style={{
              fontSize: 9.5, color: "var(--text-muted)", marginTop: 2,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {info.project_name}
            </div>
          )}
        </div>

        {/* File icon */}
        <div style={{
          color: status === "error" ? "var(--red)" : info ? sc.text : "var(--text-muted)",
          flexShrink: 0, opacity: 0.7, marginTop: 2,
        }}>
          {status === "error" ? <AlertTriangle size={18} /> : <FileBox size={18} />}
        </div>
      </div>

      {/* ── Stats grid (when loaded) ── */}
      {info && (
        <div style={{ padding: "10px 12px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "7px 10px" }}>
          <Stat icon={<Cpu size={11} />}      label="Elementos" value={info.element_count.toLocaleString()} color={sc.text} />
          <Stat icon={<HardDrive size={11} />} label="Tamaño"    value={`${info.file_size_mb} MB`}          color={sc.text} />
          <Stat icon={<Calendar size={11} />}  label="Modificado"
            value={lastMod ? lastMod.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "2-digit" }) : "—"}
            color="var(--border-bright)"
          />
          <Stat icon={<User size={11} />} label="Autor"
            value={info.author || info.organization || "—"}
            color="var(--border-bright)"
          />
        </div>
      )}

      {/* ── Type breakdown bar (when loaded) ── */}
      {info?.top_types && info.top_types.length > 0 && (
        <div style={{ padding: "0 12px 10px" }}>
          <div style={{ fontSize: 8, color: "var(--cyan)", marginBottom: 5,
            fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.1em", fontWeight: 700 }}>
            ⚡ TIPOS DE ELEMENTOS
          </div>
          <div style={{
            display: "flex", height: 7, borderRadius: 4, overflow: "hidden", gap: 1.5,
            boxShadow: "0 0 12px rgba(91,140,255,0.2), inset 0 0 8px rgba(91,140,255,0.05)"
          }}>
            {info.top_types.map((t, idx) => {
              const color = getTypeColor(t.type, idx);
              return (
                <div key={t.type} title={`${t.type}: ${t.count}`}
                  style={{
                    flex: t.count,
                    background: color,
                    opacity: 1,
                    boxShadow: `0 0 8px ${color}80`,
                    transition: "flex 0.3s ease, box-shadow 0.3s ease"
                  }}
                />
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
            {info.top_types.slice(0, 3).map((t, idx) => {
              const color = getTypeColor(t.type, idx);
              return (
                <div key={t.type} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: 2, flexShrink: 0,
                    background: color,
                    boxShadow: `0 0 4px ${color}80`
                  }} />
                  <span style={{
                    fontSize: 8.5, color: color, fontWeight: 600,
                    fontFamily: "JetBrains Mono, monospace", maxWidth: 95,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    textShadow: `0 0 3px ${color}40`
                  }}>
                    {t.type.replace("Ifc", "")} ({t.count})
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Loading skeleton ── */}
      {loading && (
        <div style={{ padding: "10px 12px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
          {[80, 60, 40, 55].map((w, i) => (
            <div key={i} style={{
              height: 8, borderRadius: 4, background: "var(--border)",
              width: `${w}%`, animation: "shimmer 1.5s ease-in-out infinite",
              animationDelay: `${i * 0.15}s`,
            }} />
          ))}
        </div>
      )}

      {/* ── Error state ── */}
      {status === "error" && (
        <div style={{ padding: "10px 12px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 9.5, color: "rgba(255,51,85,0.7)",
            fontFamily: "JetBrains Mono, monospace", lineHeight: 1.5 }}>
            No se pudo leer el archivo.<br />
            Verifica que el backend esté activo.
          </div>
          <button
            onClick={e => { e.stopPropagation(); setStatus("loading"); setRetryKey(k => k + 1); }}
            style={{
              alignSelf: "flex-start", fontSize: 10, padding: "4px 10px", borderRadius: 3,
              background: "rgba(255,51,85,0.08)", border: "1px solid rgba(255,51,85,0.3)",
              color: "var(--red)", cursor: "pointer", fontFamily: "inherit",
              display: "flex", alignItems: "center", gap: 5,
            }}
          >
            <RefreshCw size={10} /> Reintentar
          </button>
        </div>
      )}
    </div>
  );
}

// ── Stat cell ─────────────────────────────────────────────────────────────────

function Stat({ icon, label, value, color }: {
  icon: React.ReactNode; label: string; value: string; color: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--border-bright)" }}>
        {icon}
        <span style={{ fontSize: 8, fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.07em" }}>{label}</span>
      </div>
      <div style={{
        fontSize: 11, color, fontWeight: 600,
        fontFamily: "JetBrains Mono, monospace",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        minHeight: 14,
      }}>
        {value}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ModelsPage() {
  const {
    sources, files, scanError,
    addFolderSource, addFileSource, removeSource,
    setScanError, clearProject, fileInfos,
  } = useProjectStore();

  const [scanningId, setScanningId] = useState<string | null>(null);
  const isScanning = scanningId !== null;
  const [batchScanning, setBatchScanning] = useState(false);
  const [batchStatus, setBatchStatus] = useState("");

  const { data: midpMappings } = useAllMidpMappings();
  const etapaIndex = useMemo(() => buildEtapaIndex(midpMappings), [midpMappings]);

  // ── Add folder source ─────────────────────────────────────────────────────
  async function handleAddFolder() {
    setScanError("");
    try {
      const res = await fetch(`${API}/api/ifc/folder-picker`);
      if (!res.ok) throw new Error(await res.text());
      const d = await res.json();
      if (!d.path) return;
      const id = `folder_${Date.now()}`;
      const label = d.path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? d.path;
      setScanningId(id);
      const scanRes = await fetch(`${API}/api/ifc/files/list-recursive?folder=${encodeURIComponent(d.path)}`);
      if (!scanRes.ok) throw new Error(await scanRes.text());
      const scanData = await scanRes.json();
      const newFiles = (scanData.files ?? []).map((f: { filename: string; path: string }) => ({
        filename: f.filename, path: f.path,
      }));
      addFolderSource(id, d.path, label, newFiles);
      if (!newFiles.length) setScanError("No se encontraron archivos IFC en esa carpeta.");
    } catch (e: unknown) {
      setScanError(e instanceof Error ? e.message : "Error al abrir selector");
    } finally {
      setScanningId(null);
    }
  }

  // ── Add individual files ──────────────────────────────────────────────────
  async function handleAddFiles() {
    setScanError("");
    try {
      const res = await fetch(`${API}/api/ifc/file-picker`);
      if (!res.ok) throw new Error(await res.text());
      const d = await res.json();
      if (d.cancelled || !d.files?.length) return;
      const id = `files_${Date.now()}`;
      const n = d.files.length;
      const label = `${n} archivo${n > 1 ? "s" : ""} suelto${n > 1 ? "s" : ""}`;
      addFileSource(id, label, d.files);
    } catch (e: unknown) {
      setScanError(e instanceof Error ? e.message : "Error al abrir selector");
    }
  }

  // ── Add every known project's LATEST export in one shot ───────────────────
  // Avoids the user having to open the native folder picker once per dated
  // "AAMMDD XXX" project subfolder. Reuses the backend's Export Control
  // "gana la fecha más reciente" resolution so this doesn't pull in stale
  // superseded copies of the same IFC from older export folders — just the
  // current one of each. Added as a single virtual source, same mechanism
  // as a manual folder add.
  async function handleAddAllProjects() {
    setScanError(""); setBatchStatus(""); setBatchScanning(true);
    try {
      const res = await fetch(`${API}/api/ifc/projects/list-all`);
      if (!res.ok) throw new Error(await res.text());
      const d = await res.json();
      const newFiles: { filename: string; path: string }[] = d.files ?? [];
      if (newFiles.length === 0) {
        setScanError("No se encontraron archivos IFC bajo la carpeta EXPORT configurada.");
        return;
      }
      addFolderSource("all_projects_latest", d.root ?? "EXPORT", "Todos los proyectos (vigentes)", newFiles);
      const skipped = (d.total_occurrences ?? newFiles.length) - newFiles.length;
      setBatchStatus(
        `${newFiles.length} modelos añadidos (el más reciente de cada uno)`
        + (skipped > 0 ? ` · ${skipped} copias antiguas omitidas.` : ".")
      );
    } catch (e: unknown) {
      setScanError(e instanceof Error ? e.message : "Error al listar proyectos");
    } finally {
      setBatchScanning(false);
    }
  }

  // ── Rescan folder source ──────────────────────────────────────────────────
  async function rescanSource(src: IFCSource) {
    if (src.type !== "folder") return;
    setScanError(""); setScanningId(src.id);
    try {
      const res = await fetch(`${API}/api/ifc/files/list-recursive?folder=${encodeURIComponent(src.path)}`);
      if (!res.ok) throw new Error(await res.text());
      const d = await res.json();
      const newFiles = (d.files ?? []).map((f: { filename: string; path: string }) => ({
        filename: f.filename, path: f.path,
      }));
      addFolderSource(src.id, src.path, src.label, newFiles);
    } catch (e: unknown) {
      setScanError(e instanceof Error ? e.message : "Error al reescanear");
    } finally {
      setScanningId(null);
    }
  }

  // ── Rescan all folder sources ───────────────────────────────────────────────
  async function rescanAllFolders() {
    setScanError("");
    const folderSources = sources.filter(s => s.type === "folder");
    if (folderSources.length === 0) return;

    for (const src of folderSources) {
      await rescanSource(src);
    }
  }

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const loadedInfos = files.map(f => fileInfos[f.path]).filter((i): i is IFCFileInfo => !!i);
  const totalElements = loadedInfos.reduce((s, i) => s + i.element_count, 0);
  const totalSizeMb   = loadedInfos.reduce((s, i) => s + i.file_size_mb, 0);
  const schemas       = Array.from(new Set(loadedInfos.map(i => i.schema)));

  // File count per source
  const filesBySource: Record<string, number> = {};
  for (const f of files) {
    filesBySource[f.sourceId] = (filesBySource[f.sourceId] ?? 0) + 1;
  }

  return (
    <>
      {/* Header */}
      <div style={{ marginBottom: 16, display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--cyan)", letterSpacing: "0.04em" }}>
            IFC MODELS
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
            Centro de mando de fuentes IFC — múltiples carpetas y archivos
          </p>
        </div>
        {sources.length > 0 && (
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={rescanAllFolders} disabled={isScanning} style={{
              display: "flex", alignItems: "center", gap: 6, fontSize: 11,
              background: "rgba(91,140,255,0.06)", border: "1px solid rgba(91,140,255,0.2)",
              color: "var(--cyan)", padding: "6px 12px", borderRadius: 4, cursor: isScanning ? "not-allowed" : "pointer",
              fontFamily: "inherit", opacity: isScanning ? 0.5 : 1,
            }}>
              <RefreshCw size={12} /> Rescannear
            </button>
            <button onClick={clearProject} style={{
              display: "flex", alignItems: "center", gap: 6, fontSize: 11,
              background: "rgba(255,68,102,0.06)", border: "1px solid rgba(255,68,102,0.2)",
              color: "var(--red)", padding: "6px 12px", borderRadius: 4, cursor: "pointer",
              fontFamily: "inherit",
            }}>
              <X size={12} /> Limpiar todo
            </button>
          </div>
        )}
      </div>

      {/* ── SOURCES PANEL ──────────────────────────────────────────────────── */}
      <div className="card-cyber" style={{ marginBottom: 14, overflow: "hidden" }}>
        {/* Card header */}
        <div style={{
          padding: "9px 14px", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Database size={12} color="var(--cyan)" />
            <span style={{ fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase",
              letterSpacing: "0.1em", fontFamily: "JetBrains Mono, monospace" }}>
              Fuentes de datos
            </span>
            {sources.length > 0 && (
              <span style={{ fontSize: 9, color: "rgba(91,140,255,0.5)",
                background: "rgba(91,140,255,0.08)", borderRadius: 3, padding: "1px 6px",
                fontFamily: "JetBrains Mono, monospace" }}>
                {sources.length} fuente{sources.length > 1 ? "s" : ""} · {files.length} IFC
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            <button onClick={handleAddFolder} disabled={isScanning || batchScanning} style={{
              display: "flex", alignItems: "center", gap: 5, padding: "5px 12px",
              borderRadius: 4, cursor: (isScanning || batchScanning) ? "not-allowed" : "pointer",
              background: "rgba(91,140,255,0.07)", border: "1px solid rgba(91,140,255,0.25)",
              color: "var(--cyan)", fontSize: 11, fontFamily: "inherit", fontWeight: 600,
              opacity: (isScanning || batchScanning) ? 0.5 : 1, whiteSpace: "nowrap",
            }}>
              <FolderOpen size={12} /> + Carpeta
            </button>
            <button onClick={handleAddFiles} disabled={isScanning || batchScanning} style={{
              display: "flex", alignItems: "center", gap: 5, padding: "5px 12px",
              borderRadius: 4, cursor: (isScanning || batchScanning) ? "not-allowed" : "pointer",
              background: "rgba(122,111,217,0.07)", border: "1px solid rgba(122,111,217,0.25)",
              color: "var(--magenta)", fontSize: 11, fontFamily: "inherit", fontWeight: 600,
              opacity: (isScanning || batchScanning) ? 0.5 : 1, whiteSpace: "nowrap",
            }}>
              <FileText size={12} /> + IFC sueltos
            </button>
            <button onClick={handleAddAllProjects} disabled={isScanning || batchScanning}
              title="Añade de golpe todas las carpetas de proyecto encontradas bajo la raíz EXPORT configurada, sin abrir el selector una por una"
              style={{
                display: "flex", alignItems: "center", gap: 5, padding: "5px 12px",
                borderRadius: 4, cursor: (isScanning || batchScanning) ? "not-allowed" : "pointer",
                background: "rgba(80,220,140,0.07)", border: "1px solid rgba(80,220,140,0.3)",
                color: "var(--green)", fontSize: 11, fontFamily: "inherit", fontWeight: 600,
                opacity: (isScanning || batchScanning) ? 0.5 : 1, whiteSpace: "nowrap",
              }}>
              {batchScanning
                ? <RefreshCw size={12} style={{ animation: "spin 0.8s linear infinite" }} />
                : <Layers size={12} />}
              + Todos los proyectos
            </button>
          </div>
        </div>

        {batchStatus && (
          <div style={{ padding: "0 14px 8px", fontSize: 10, color: "var(--green)",
            fontFamily: "JetBrains Mono, monospace" }}>
            {batchStatus}
          </div>
        )}

        {/* Source chips */}
        <div style={{
          padding: "10px 14px", minHeight: 52,
          display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center",
        }}>
          {sources.length === 0 && !isScanning ? (
            <span style={{ fontSize: 11, color: "var(--border-bright)", fontFamily: "JetBrains Mono, monospace" }}>
              Sin fuentes — añade carpetas o archivos IFC
            </span>
          ) : (
            <>
              {sources.map(src => {
                const isFolder  = src.type === "folder";
                const scanning  = scanningId === src.id;
                const count     = filesBySource[src.id] ?? 0;
                const c         = isFolder ? "var(--cyan)" : "var(--magenta)";
                const bgBase    = isFolder ? "rgba(91,140,255," : "rgba(122,111,217,";

                return (
                  <div key={src.id} title={src.type === "folder" ? src.path : undefined} style={{
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "4px 5px 4px 10px",
                    background: `${bgBase}0.08)`, border: `1px solid ${bgBase}0.25)`,
                    borderRadius: 5, maxWidth: 300,
                  }}>
                    {scanning
                      ? <RefreshCw size={12} color={c} style={{ animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                      : isFolder
                        ? <FolderOpen size={12} color={c} style={{ flexShrink: 0 }} />
                        : <FileText size={12} color={c} style={{ flexShrink: 0 }} />
                    }
                    <span style={{ fontSize: 11, color: c, fontFamily: "JetBrains Mono, monospace",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}>
                      {src.label}
                    </span>
                    {!scanning && count > 0 && (
                      <span style={{ fontSize: 9, color: c, background: `${bgBase}0.15)`,
                        borderRadius: 3, padding: "1px 5px", fontFamily: "JetBrains Mono, monospace",
                        fontWeight: 700, flexShrink: 0 }}>
                        {count}
                      </span>
                    )}
                    {!scanning && isFolder && (
                      <button onClick={() => rescanSource(src)} title="Reescanear" style={{
                        background: "none", border: "none", cursor: "pointer",
                        color: `${bgBase}0.5)`, padding: "1px 3px",
                        display: "flex", alignItems: "center", flexShrink: 0,
                      }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = c}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = `${bgBase}0.5)`}
                      >
                        <RefreshCw size={10} />
                      </button>
                    )}
                    {!scanning && (
                      <button onClick={() => removeSource(src.id)} title="Eliminar fuente" style={{
                        background: "none", border: "none", cursor: "pointer",
                        color: `${bgBase}0.45)`, padding: "1px 5px",
                        display: "flex", alignItems: "center", flexShrink: 0,
                      }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = "var(--red)"}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = `${bgBase}0.45)`}
                      >
                        <X size={11} />
                      </button>
                    )}
                  </div>
                );
              })}
              {/* Scanning placeholder (before source is added) */}
              {isScanning && !sources.find(s => s.id === scanningId) && (
                <div style={{
                  display: "flex", alignItems: "center", gap: 6, padding: "4px 12px",
                  background: "rgba(91,140,255,0.05)", border: "1px dashed rgba(91,140,255,0.2)", borderRadius: 5,
                }}>
                  <RefreshCw size={12} color="var(--cyan)" style={{ animation: "spin 0.8s linear infinite" }} />
                  <span style={{ fontSize: 11, color: "rgba(91,140,255,0.6)", fontFamily: "JetBrains Mono, monospace" }}>
                    Escaneando…
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Error bar */}
      {scanError && (
        <div style={{ color: "var(--red)", fontSize: 11, marginBottom: 12, padding: "8px 12px",
          background: "rgba(255,68,102,0.05)", border: "1px solid rgba(255,68,102,0.2)", borderRadius: 6,
          display: "flex", alignItems: "center", gap: 8 }}>
          <X size={12} /> {scanError}
          <button onClick={() => setScanError("")} style={{ marginLeft: "auto", background: "none",
            border: "none", color: "rgba(255,68,102,0.6)", cursor: "pointer", fontSize: 10,
            fontFamily: "inherit" }}>
            Cerrar
          </button>
        </div>
      )}

      {/* ── KPI strip ────────────────────────────────────────────────────── */}
      {files.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 16 }}>
          {[
            { label: "MODELOS",   value: files.length.toString(),                              icon: <Layers size={14} />,   color: "var(--cyan)" },
            { label: "ELEMENTOS", value: totalElements ? totalElements.toLocaleString() : "—", icon: <Cpu size={14} />,      color: "var(--cyan)" },
            { label: "TAMAÑO",    value: totalSizeMb ? `${totalSizeMb.toFixed(1)} MB` : "—",   icon: <HardDrive size={14} />,color: "var(--green)" },
            { label: "SCHEMAS",   value: schemas.length ? schemas.join(" · ") : "—",           icon: <Building2 size={14} />,color: "var(--magenta)" },
          ].map(({ label, value, icon, color }) => (
            <div key={label} className="card-cyber" style={{ padding: "12px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, color, marginBottom: 6 }}>
                {icon}
                <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em",
                  fontFamily: "JetBrains Mono, monospace" }}>{label}</span>
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, color, textShadow: `0 0 10px ${color}66`,
                fontFamily: "JetBrains Mono, monospace",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {value}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── File grid ────────────────────────────────────────────────────── */}
      {files.length > 0 ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
          {files.map((f) => (
            <IFCCard key={f.path} file={f} etapa={etapaIndex.get(f.filename.trim().toLowerCase())} />
          ))}
        </div>
      ) : sources.length === 0 ? (
        /* Empty state */
        <div style={{
          padding: "60px 20px", textAlign: "center",
          border: "1px dashed rgba(91,140,255,0.12)", borderRadius: 8,
          background: "rgba(91,140,255,0.015)", position: "relative", overflow: "hidden",
        }}>
          <div style={{ position: "absolute", inset: 0, pointerEvents: "none",
            backgroundImage: "repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(91,140,255,0.01) 3px,rgba(91,140,255,0.01) 4px)" }} />
          {(["tl","tr","bl","br"] as const).map(pos => (
            <div key={pos} style={{
              position: "absolute",
              ...(pos.includes("t") ? { top: 16 } : { bottom: 16 }),
              ...(pos.includes("l") ? { left: 20 } : { right: 20 }),
              width: 16, height: 16,
              borderTop:    pos.includes("t") ? "1px solid rgba(91,140,255,0.25)" : "none",
              borderBottom: pos.includes("b") ? "1px solid rgba(91,140,255,0.25)" : "none",
              borderLeft:   pos.includes("l") ? "1px solid rgba(91,140,255,0.25)" : "none",
              borderRight:  pos.includes("r") ? "1px solid rgba(91,140,255,0.25)" : "none",
            }} />
          ))}
          <div style={{ fontSize: 36, marginBottom: 12, opacity: 0.15 }}>⬡</div>
          <div style={{ fontSize: 14, color: "var(--text-muted)", marginBottom: 6, fontWeight: 600 }}>
            Sin fuentes configuradas
          </div>
          <div style={{ fontSize: 12, color: "var(--dim)", marginBottom: 24 }}>
            Añade carpetas o archivos IFC individuales para comenzar
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <button className="btn btn-cyan" onClick={handleAddFolder} style={{ gap: 6 }}>
              <FolderOpen size={13} /> + Añadir carpeta
            </button>
            <button className="btn btn-magenta" onClick={handleAddFiles} style={{ gap: 6 }}>
              <FileText size={13} /> + IFC sueltos
            </button>
          </div>
        </div>
      ) : null}

      <style>{`
        @keyframes shimmer { 0%,100%{opacity:.4} 50%{opacity:.9} }
        @keyframes spin    { to{transform:rotate(360deg)} }
        @keyframes pulse   { 0%,100%{opacity:.5} 50%{opacity:1} }
      `}</style>
    </>
  );
}

