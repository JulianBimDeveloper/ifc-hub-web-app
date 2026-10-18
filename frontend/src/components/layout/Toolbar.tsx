"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, Box, FileSearch, CheckSquare, Tag, Layers3,
  Search, Droplets, SendHorizonal, GitBranch, TextCursor,
  BadgeCheck, ShieldCheck, Copy, BookOpen, Eye, Crosshair, Settings, FileCode,
  ClipboardList, FileText, Boxes, CalendarClock, Coins, Network,
} from "lucide-react";

// ── Tool groups (Navisworks ribbon style) ─────────────────────────────────────

export const GROUPS = [
  {
    id: "main",
    label: "MAIN",
    color: "#3B7DDB",
    items: [
      { label: "Dashboard", href: "/",                         icon: LayoutDashboard,
        desc: "Panel general — KPIs del proyecto y accesos rápidos a todas las herramientas" },
      { label: "Models",    href: "/models",                   icon: Box,
        desc: "Centro de mando de fuentes IFC — añade y organiza carpetas y archivos" },
    ],
  },
  {
    id: "explore",
    label: "EXPLORE",
    color: "#3FA88A",
    items: [
      { label: "Viewer",    href: "/viewer",              icon: Eye,
        desc: "Visor 3D rápido de los modelos IFC cargados" },
      { label: "Structure", href: "/ifc-structure",       icon: Layers3,
        desc: "Árbol espacial del IFC — jerarquía de proyecto, edificios y elementos" },
      { label: "Tree",      href: "/ifc-tree",            icon: Network,
        desc: "Árbol dinámico con carga perezosa — se expande nodo por nodo y agrupa ramas grandes por tipo" },
      { label: "Search",    href: "/ifc-value-search",    icon: Search,
        desc: "Busca elementos por valor de propiedad en los modelos cargados" },
    ],
  },
  {
    id: "inject",
    label: "INJECT",
    color: "#7A6FD9",
    items: [
      { label: "Project",    href: "/ifc-project-default",      icon: Settings,
        desc: "Aplica parámetros por defecto del proyecto (PocketBase) a los archivos IFC seleccionados" },
      { label: "Classifier", href: "/ifc-classify",            icon: Tag,
        desc: "Identifica y aplica clasificación IFC a elementos con ADIF_00_Codigo_Producto" },
      { label: "Sets",       href: "/ifc-sets",                icon: Boxes,
        desc: "Crea conjuntos (IfcSystem) que Navisworks reconoce como Colecciones de IFC" },
      { label: "Plan Sets",  href: "/ifc-planning-sets",       icon: CalendarClock,
        desc: "Agrupa elementos por ADIF_04_Codigo_Actividad y crea un conjunto por actividad, cruzando contra master_planning_activities" },
      { label: "Cost Sets",  href: "/ifc-cost-sets",           icon: Coins,
        desc: "Agrupa elementos por ADIF_05_Codigo_Partida y crea un conjunto por capítulo, cruzando contra master_presupuesto" },
      { label: "Name Type",  href: "/ifc-name-type-id",        icon: BadgeCheck,
        desc: "Renombra elementos como NombreActual_IdObjeto usando ADIF_00_Id_Objeto" },
      { label: "Metadata",   href: "/ifc-metadata",            icon: FileSearch,
        desc: "Aplica parámetros por defecto del proyecto (PocketBase) a archivos IFC" },
    ],
  },
  {
    id: "data",
    label: "DATA",
    color: "#B8862E",
    items: [
      { label: "Material",   href: "/ifc-material",     icon: Droplets,
        desc: "Análisis y edición de materiales por elemento" },
      { label: "Nomenclat.", href: "/ifc-nomenclature", icon: TextCursor,
        desc: "Agrupa elementos por prefijo de nombre y detecta variantes" },
      { label: "Rel.Params", href: "/ifc-relation-params", icon: GitBranch,
        desc: "Parámetros obligatorios ADIF y reglas de auto-relleno — resumen de cumplimiento por modelo" },
    ],
  },
  {
    id: "validate",
    label: "VALIDATE",
    color: "#4F8FB0",
    items: [
      { label: "Name Valid",  href: "/ifc-name-validator",  icon: CheckSquare,
        desc: "Compara archivos IFC de una carpeta contra la tabla midp_mapping de PocketBase" },
      { label: "Checker",     href: "/ifc-model-checker",   icon: ShieldCheck,
        desc: "Verifica reglas QA básicas sobre archivos IFC (plantilla Autodesk Model Checker)" },
      { label: "Export",      href: "/ifc-export-control",  icon: SendHorizonal,
        desc: "Plan de entrega de IFCs — verificación automática contra carpetas de exportación" },
      { label: "Duplicates",  href: "/ifc-duplicates",      icon: Copy,
        desc: "Detecta elementos duplicados por geometría en una carpeta de archivos IFC" },
      { label: "Standards",   href: "/ifc-standards-audit", icon: BookOpen,
        desc: "Audita archivos IFC contra estándares configurables (CEN, RailML, etc.)" },
      { label: "Client Rev.", href: "/ifc-client-review",   icon: ClipboardList,
        desc: "Revisión de cliente — comentarios y estado de aprobación por elemento" },
    ],
  },
  {
    id: "docs",
    label: "DOCS",
    color: "#9A7A3C",
    items: [
      { label: "PEB Gen", href: "/peb-generator", icon: FileText,
        desc: "Genera el PEB (Plan de Ejecución BIM) del proyecto" },
    ],
  },
  {
    id: "system",
    label: "SYSTEM",
    color: "#5B6B8C",
    items: [
      { label: "BIM Scope", href: "/bim-scope",        icon: Crosshair,
        desc: "Gestión del alcance BIM del proyecto — modelos, entregables y milestones" },
      { label: "C3D Setup", href: "/c3d-export-setup", icon: FileCode,
        desc: "Despliega la configuración de exportación IFC de Civil 3D (infraexportselect)" },
    ],
  },
];

// ── Component ─────────────────────────────────────────────────────────────────

interface HoverInfo { label: string; desc: string; rect: DOMRect }

export function Toolbar() {
  const pathname = usePathname();
  const [hover, setHover] = useState<HoverInfo | null>(null);

  return (
    <>
    <div
      className="toolbar-scroll"
      style={{
        position: "fixed",
        top: "var(--navbar-h)",
        left: 0, right: 0,
        height: "var(--toolbar-h)",
        background: "var(--surface)",
        borderBottom: "1px solid var(--border)",
        zIndex: 45,
        display: "flex",
        alignItems: "stretch",
        overflowX: "auto",
        // visible (not hidden) so the hover tooltip below each item isn't
        // clipped by the toolbar's own fixed height — horizontal scroll still
        // works fine with an independent overflowY.
        overflowY: "visible",
      }}
    >

      {GROUPS.map((group, gi) => {
        const isLast = gi === GROUPS.length - 1;

        return (
          <div
            key={group.id}
            style={{
              display: "flex",
              flexDirection: "column",
              borderRight: isLast ? "none" : "1px solid var(--border)",
              flexShrink: 0,
            }}
          >
            {/* ── Tool buttons ── */}
            <div style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              padding: "4px 4px 0",
              gap: 1,
            }}>
              {group.items.map(({ label, href, icon: Icon, desc }) => {
                const active = pathname === href || (href !== "/" && pathname.startsWith(href));
                const activeColor = "var(--cyan)";
                const activeBg    = "color-mix(in srgb, var(--cyan) 10%, transparent)";

                return (
                  <Link
                    key={href}
                    href={href}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 3,
                      padding: "5px 8px",
                      minWidth: 54,
                      borderRadius: 4,
                      textDecoration: "none",
                      color: active ? activeColor : "var(--text-muted)",
                      background: active ? activeBg : "transparent",
                      borderBottom: active ? `2px solid ${activeColor}` : "2px solid transparent",
                      transition: "all 0.15s",
                      position: "relative",
                    }}
                    onMouseEnter={e => {
                      const el = e.currentTarget as HTMLElement;
                      if (desc) setHover({ label, desc, rect: el.getBoundingClientRect() });
                      if (!active) {
                        el.style.color = "var(--text)";
                        el.style.background = "var(--surface-2)";
                      }
                    }}
                    onMouseLeave={e => {
                      setHover(null);
                      if (!active) {
                        const el = e.currentTarget as HTMLElement;
                        el.style.color = "var(--text-muted)";
                        el.style.background = "transparent";
                      }
                    }}
                  >
                    <Icon size={17} />
                    <span style={{
                      fontSize: 8,
                      fontWeight: active ? 700 : 500,
                      letterSpacing: "0.04em",
                      textTransform: "uppercase",
                      whiteSpace: "nowrap",
                      maxWidth: 58,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}>
                      {label}
                    </span>
                  </Link>
                );
              })}
            </div>

            {/* ── Group label strip ── */}
            <div style={{
              fontSize: 7,
              color: "var(--text-muted)",
              textAlign: "center",
              padding: "2px 8px 3px",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              fontFamily: "var(--font-plex-mono), monospace",
              fontWeight: 600,
              borderTop: "1px solid var(--border)",
            }}>
              {group.label}
            </div>
          </div>
        );
      })}
    </div>

    {/* ── Floating tooltip — portaled to <body> so it always renders above
         page content, instead of being trapped inside the toolbar's own
         z-index:45 stacking context (that was clipping it behind whatever
         page content painted next). Plain system-tooltip look, not themed. ── */}
    {hover && createPortal(
      <div style={{
        position: "fixed",
        top: hover.rect.bottom + 6,
        left: hover.rect.left + hover.rect.width / 2,
        transform: "translateX(-50%)",
        zIndex: 9999,
        maxWidth: 240,
        padding: "5px 9px",
        borderRadius: 3,
        background: "#ffffe1",
        border: "1px solid #767676",
        boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
        color: "#000",
        fontSize: 12,
        fontFamily: "Segoe UI, Tahoma, Arial, sans-serif",
        fontWeight: 400,
        lineHeight: 1.4,
        textTransform: "none",
        letterSpacing: "normal",
        whiteSpace: "normal",
        textAlign: "left",
        pointerEvents: "none",
      }}>
        {hover.desc}
      </div>,
      document.body
    )}
    </>
  );
}
