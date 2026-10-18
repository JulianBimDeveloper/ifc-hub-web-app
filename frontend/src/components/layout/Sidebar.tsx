"use client";

/**
 * SelectionTree — Navisworks-style left panel.
 *
 * Shows all IFC sources (folders + individual files) from the global projectStore.
 * Each source is expandable to show its files and their metadata.
 *
 * v2 additions:
 * - Folder checkbox (tri-state): selects / deselects all IFC files in that folder
 * - Origin badge: RVT (Revit) or C3D (Civil 3D), detected from filename + fileInfo author
 */

import Link from "next/link";
import { useState, useEffect, useRef, useCallback } from "react";
import { FolderOpen, FileText, ChevronRight, FileBox, Box, RefreshCw, Check, Minus } from "lucide-react";
import { useProjectStore } from "@/stores/projectStore";
import { useBackgroundPreCache } from "@/hooks/useBackgroundPreCache";
import { useViewerGeomPreCache } from "@/hooks/useViewerGeomPreCache";
import { API_URL } from "@/lib/api";
import { FractalStatus } from "./FractalStatus";

// ── Resize constants ──────────────────────────────────────────────────────
const MIN_W     = 75;
const MAX_W     = 720;
const DEFAULT_W = 80;
const LS_KEY    = "ifc-hub-sidebar-w";

// ── Schema color helper ───────────────────────────────────────────────────

function schemaColor(schema: string | undefined): string {
  if (!schema) return "var(--border-bright)";
  const s = schema.toUpperCase();
  if (s.includes("4X3")) return "#5B8CFF";
  if (s.includes("IFC4")) return "#3FBE8A";
  if (s.includes("2X3"))  return "#D9A441";
  return "var(--border-bright)";
}

function schemaLabel(schema: string): string {
  const s = schema.toUpperCase();
  if (s.includes("4X3")) return "4X3";
  if (s.includes("IFC4")) return "4";
  if (s.includes("2X3")) return "2X3";
  return schema.slice(0, 5);
}

// ── Origin detection: Revit vs Civil 3D ──────────────────────────────────
// Returns "RVT" | "C3D" | null
// Detects from "Originating System" field in IFC FILE_NAME line
// Fallback: organization / author fields if originating_system not available
function detectOrigin(info?: { originating_system?: string; organization?: string; author?: string }): "RVT" | "C3D" | null {
  if (!info) return null;

  // Priority 1: originating_system field (most reliable)
  // Contains "Autodesk Revit 25.4.41.14..." or "Autodesk Civil 3D 2025..."
  if (info.originating_system) {
    const s = info.originating_system.toUpperCase();
    if (s.includes("REVIT")) return "RVT";
    if (s.includes("CIVIL 3D") || s.includes("CIVIL3D") || s.includes("CIVIL 3D")) return "C3D";
  }

  // Fallback: organization + author fields
  const combinedText = [info.organization, info.author]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();

  if (combinedText.includes("REVIT")) return "RVT";
  if (combinedText.includes("CIVIL") || combinedText.includes("C3D")) return "C3D";

  return null;
}

function originStyle(origin: "RVT" | "C3D" | null): { color: string; bg: string; border: string } {
  if (origin === "RVT") return {
    color:  "#7A6FD9",
    bg:     "rgba(122,111,217,0.12)",
    border: "rgba(122,111,217,0.35)",
  };
  if (origin === "C3D") return {
    color:  "#D9A441",
    bg:     "rgba(217,164,65,0.12)",
    border: "rgba(217,164,65,0.35)",
  };
  return { color: "var(--border-bright)", bg: "var(--border)", border: "var(--text-muted)" };
}

// ── Split filename: extract descriptor and code parts ──────────────────────
function splitIFCName(filename: string): { descriptor: string; code: string; full: string } {
  const full = filename.replace(/\.ifc$/i, "");

  const spaceParts = full.split(" ");
  if (spaceParts.length >= 2) {
    const namePart = spaceParts[0];
    const codePart = spaceParts.slice(1).join(" ");
    const underscoreParts = namePart.split("_");
    let descriptor = namePart;
    if (underscoreParts.length > 1 && /^\d+$/.test(underscoreParts[0])) {
      descriptor = underscoreParts.slice(1).join("_");
    }
    return { descriptor, code: codePart, full };
  }

  const lastDashIdx = full.lastIndexOf("-");
  if (lastDashIdx > 0) {
    return { descriptor: full.substring(0, lastDashIdx), code: full.substring(lastDashIdx + 1), full };
  }

  return { descriptor: full, code: "", full };
}

// ── Folder selection state ────────────────────────────────────────────────
type FolderCheckState = "all" | "partial" | "none";

function folderCheckState(
  srcFiles: { path: string }[],
  selectedPaths: string[]
): FolderCheckState {
  if (srcFiles.length === 0) return "none";
  const selectedCount = srcFiles.filter(f => selectedPaths.includes(f.path)).length;
  if (selectedCount === 0)              return "none";
  if (selectedCount === srcFiles.length) return "all";
  return "partial";
}

// ── Tri-state folder checkbox ─────────────────────────────────────────────
function FolderCheckbox({ state, onClick }: { state: FolderCheckState; onClick: (e: React.MouseEvent) => void }) {
  const isAll     = state === "all";
  const isPartial = state === "partial";
  const active    = isAll || isPartial;

  return (
    <div
      onClick={onClick}
      title={isAll ? "Deseleccionar todos" : "Seleccionar todos"}
      style={{
        width: 11, height: 11, borderRadius: 2, flexShrink: 0,
        border: `1.5px solid ${active ? "var(--cyan)" : "var(--border-bright)"}`,
        background: isAll ? "var(--cyan)" : isPartial ? "rgba(91,140,255,0.25)" : "transparent",
        display: "flex", alignItems: "center", justifyContent: "center",
        cursor: "pointer", transition: "all 0.15s",
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "var(--cyan)"; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = active ? "var(--cyan)" : "var(--border-bright)"; }}
    >
      {isAll     && <Check  size={7} color="var(--background)" strokeWidth={3} />}
      {isPartial && <Minus  size={7} color="var(--cyan)"       strokeWidth={3} />}
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────

const API = "http://127.0.0.1:8020";

export function Sidebar() {
  const {
    sources, files, fileInfos, clearProject,
    selectedPaths, toggleFileSelection, removeBrokenSources,
  } = useProjectStore();

  // ── Startup: auto-remove sources where ALL files are inaccessible ─────────
  useEffect(() => {
    if (sources.length === 0) return;

    let cancelled = false;
    async function validateSources() {
      const brokenIds: string[] = [];
      for (const src of sources) {
        const srcFiles = files.filter(f => f.sourceId === src.id);
        if (srcFiles.length === 0) continue;
        // Sample up to 3 files per source; if all fail → source is broken
        const sample = srcFiles.slice(0, 3);
        const results = await Promise.all(
          sample.map(f =>
            fetch(`${API}/api/ifc/info?path=${encodeURIComponent(f.path)}`, { signal: AbortSignal.timeout(5000) })
              .then(r => r.ok)
              .catch(() => false)
          )
        );
        if (results.every(ok => !ok)) brokenIds.push(src.id);
      }
      if (!cancelled && brokenIds.length > 0) {
        removeBrokenSources(brokenIds);
      }
    }

    validateSources();
    return () => { cancelled = true; };
  // Run once on mount only
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Background pre-cache: runs automatically when selectedPaths changes ──
  const preCache = useBackgroundPreCache();
  // ── Pre-extracción de geometría 3D para el visor (carga instantánea) ──────
  const geomWarm = useViewerGeomPreCache();

  // ── Pre-warm IFC Material: carga modelos en pool LRU antes de navegar ─────
  // Cuando el usuario selecciona archivos en el sidebar, dispara silenciosamente
  // POST /material/warm para que ifcopenshell ya tenga los modelos abiertos en
  // memoria cuando el usuario llegue a la página IFC Material.
  useEffect(() => {
    const ifcPaths = selectedPaths.filter(p => p.toLowerCase().endsWith(".ifc"));
    if (ifcPaths.length === 0) return;
    const timer = setTimeout(() => {
      fetch(`${API_URL}/api/ifc/material/warm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: ifcPaths }),
      }).catch(() => { /* warm-up silencioso, los errores no importan */ });
    }, 600);
    return () => clearTimeout(timer);
  }, [selectedPaths]);

  // Derived: toggle all files of a source
  const toggleSourceSelection = useCallback((srcFiles: { path: string }[]) => {
    const state = folderCheckState(srcFiles, selectedPaths);
    // "all" → deselect all; anything else → select all
    if (state === "all") {
      useProjectStore.setState(s => ({
        selectedPaths: s.selectedPaths.filter(p => !srcFiles.some(f => f.path === p)),
      }));
    } else {
      // Dedup contra el estado FRESCO dentro del updater (no contra el cierre
      // obsoleto): así seleccionar la carpeta es idempotente y nunca apila
      // duplicados aunque el handler se dispare más de una vez.
      useProjectStore.setState(s => {
        const have = new Set(s.selectedPaths);
        const add  = srcFiles.map(f => f.path).filter(p => !have.has(p));
        return { selectedPaths: [...s.selectedPaths, ...add] };
      });
    }
  }, [selectedPaths]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    setExpanded(prev => {
      const next = new Set(prev);
      let changed = false;
      for (const src of sources) {
        const key = `src_${src.id}`;
        if (!next.has(key)) { next.add(key); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [sources]);

  const toggle = (key: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  // ── Resize logic ──────────────────────────────────────────────────────────
  const isDragging   = useRef(false);
  const dragStartX   = useRef(0);
  const dragStartW   = useRef(DEFAULT_W);

  const applyWidth = useCallback((w: number) => {
    const clamped = Math.min(MAX_W, Math.max(MIN_W, Math.round(w)));
    document.documentElement.style.setProperty("--sidebar-w", `${clamped}px`);
    try { localStorage.setItem(LS_KEY, String(clamped)); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (saved) applyWidth(Number(saved));
    } catch { /* ignore */ }
  }, [applyWidth]);

  const onHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current  = true;
    dragStartX.current  = e.clientX;
    dragStartW.current  = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w")
    ) || DEFAULT_W;

    const onMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      applyWidth(dragStartW.current + (ev.clientX - dragStartX.current));
    };
    const onUp = () => {
      isDragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);
      document.body.style.cursor     = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
    document.body.style.cursor     = "col-resize";
    document.body.style.userSelect = "none";
  }, [applyWidth]);

  // Group files by sourceId
  const filesBySource: Record<string, typeof files> = {};
  for (const f of files) {
    if (!filesBySource[f.sourceId]) filesBySource[f.sourceId] = [];
    filesBySource[f.sourceId].push(f);
  }

  const totalElements = Object.values(fileInfos).reduce((s, i) => s + (i?.element_count ?? 0), 0);

  return (
    <aside style={{
      position: "fixed",
      top: "calc(var(--navbar-h) + var(--toolbar-h))",
      left: 0,
      width: "var(--sidebar-w)",
      height: "calc(100vh - var(--navbar-h) - var(--toolbar-h))",
      background: "var(--surface)",
      borderRight: "1px solid var(--border)",
      overflow: "hidden",
      zIndex: 40,
      display: "flex",
      flexDirection: "column",
    }}>

      {/* ── Drag-resize handle ─────────────────────────────────────────────── */}
      <div
        onMouseDown={onHandleMouseDown}
        title="Arrastrar para redimensionar"
        style={{
          position: "absolute", top: 0, right: 0, bottom: 0,
          width: 5, cursor: "col-resize", zIndex: 10,
          background: "transparent", transition: "background 0.15s",
        }}
        onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "rgba(91,140,255,0.3)"}
        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"}
      />

      {/* ── Fractal status widget: live health of every tool, one glance ───── */}
      <FractalStatus />

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div style={{
        padding: "8px 12px 7px", borderBottom: "1px solid var(--border)",
        display: "flex", alignItems: "center", gap: 6, flexShrink: 0,
      }}>
        <Box size={11} color="var(--cyan)" style={{ flexShrink: 0 }} />
        <span style={{
          fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase",
          letterSpacing: "0.1em", fontFamily: "JetBrains Mono, monospace", flex: 1,
        }}>
          Árbol de Selección
        </span>
        {sources.length > 0 && (
          <button
            onClick={() => clearProject()}
            title="Limpiar proyecto"
            style={{
              background: "none", border: "none", cursor: "pointer",
              color: "var(--border-bright)", padding: 0, flexShrink: 0,
              display: "flex", alignItems: "center",
            }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = "var(--red)"}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = "var(--border-bright)"}
          >
            <RefreshCw size={10} />
          </button>
        )}
      </div>

      {/* ── Empty state ───────────────────────────────────────────────────── */}
      {sources.length === 0 ? (
        <div style={{ padding: "20px 14px", textAlign: "center", flex: 1 }}>
          <div style={{ fontSize: 22, opacity: 0.15, marginBottom: 10 }}>⬡</div>
          <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
            Sin fuentes cargadas
          </div>
          <Link href="/models" style={{
            fontSize: 10, color: "var(--cyan)", textDecoration: "none",
            border: "1px solid rgba(91,140,255,0.3)", borderRadius: 4,
            padding: "5px 12px", display: "inline-block",
          }}>
            → Abrir Models
          </Link>
        </div>

      ) : (
        <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>

          {/* ── KPI micro-strip ──────────────────────────────────────────── */}
          <div style={{
            padding: "4px 10px 5px", borderBottom: "1px solid rgba(30,45,74,0.6)",
            display: "flex", flexDirection: "column", gap: 3, flexShrink: 0,
          }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 9, color: "var(--text-muted)" }}>
                {sources.length} fuente{sources.length > 1 ? "s" : ""}
              </span>
              <span style={{ fontSize: 9, color: "var(--text-muted)" }}>
                {files.length} IFC
              </span>
              {totalElements > 0 && (
                <span style={{ fontSize: 9, color: "var(--text-muted)" }}>
                  {totalElements.toLocaleString()} elem.
                </span>
              )}
            </div>

            {/* ── Pre-cache status indicator ──────────────────────────── */}
            {preCache.status === "loading" && preCache.total > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  {/* Spinner */}
                  <span style={{
                    display: "inline-block", width: 6, height: 6, flexShrink: 0,
                    border: "1.5px solid rgba(91,140,255,0.4)",
                    borderTopColor: "var(--cyan)",
                    borderRadius: "50%",
                    animation: "spin 0.8s linear infinite",
                  }} />
                  <span style={{ fontSize: 8, color: "rgba(91,140,255,0.6)", fontFamily: "JetBrains Mono, monospace" }}>
                    Preparando herramientas… {preCache.done}/{preCache.total}
                  </span>
                </div>
                {/* Progress bar */}
                <div style={{ height: 2, background: "rgba(91,140,255,0.1)", borderRadius: 1, overflow: "hidden" }}>
                  <div style={{
                    height: "100%",
                    width: `${Math.round((preCache.done / preCache.total) * 100)}%`,
                    background: "var(--cyan)",
                    borderRadius: 1,
                    transition: "width 0.3s ease",
                  }} />
                </div>
              </div>
            )}
            {preCache.status === "done" && preCache.total > 0 && (
              <span style={{ fontSize: 8, color: "rgba(63,190,138,0.7)", fontFamily: "JetBrains Mono, monospace" }}>
                ✓ {preCache.total} psets en caché
              </span>
            )}

            {/* ── Geometría 3D: pre-extracción para el visor ─────────────── */}
            {geomWarm.status === "loading" && geomWarm.total > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{
                  display: "inline-block", width: 6, height: 6, flexShrink: 0,
                  border: "1.5px solid rgba(217,164,65,0.4)",
                  borderTopColor: "#D9A441",
                  borderRadius: "50%",
                  animation: "spin 0.8s linear infinite",
                }} />
                <span style={{ fontSize: 8, color: "rgba(217,164,65,0.7)", fontFamily: "JetBrains Mono, monospace" }}>
                  Preparando geometría… {geomWarm.done}/{geomWarm.total}
                </span>
              </div>
            )}
            {geomWarm.status === "done" && geomWarm.total > 0 && (
              <span style={{ fontSize: 8, color: "rgba(63,190,138,0.7)", fontFamily: "JetBrains Mono, monospace" }}>
                ✓ geometría lista ({geomWarm.total})
              </span>
            )}
          </div>

          {/* ── Source nodes ─────────────────────────────────────────────── */}
          <div style={{ flex: 1, overflowY: "auto" }}>
            {sources.map(src => {
              const srcFiles  = filesBySource[src.id] ?? [];
              const isFolder  = src.type === "folder";
              const srcKey    = `src_${src.id}`;
              const isExp     = expanded.has(srcKey);
              const c         = isFolder ? "var(--cyan)" : "var(--magenta)";
              const checkState = folderCheckState(srcFiles, selectedPaths);

              return (
                <div key={src.id}>
                  {/* ── Source root row ────────────────────────────────── */}
                  <div
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      padding: "5px 10px 5px 8px",
                      background: "rgba(0,0,0,0.12)",
                      borderBottom: "1px solid var(--border)",
                    }}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.03)"}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "rgba(0,0,0,0.12)"}
                  >
                    {/* Folder tri-state checkbox */}
                    {isFolder && srcFiles.length > 0 ? (
                      <FolderCheckbox
                        state={checkState}
                        onClick={(e) => { e.stopPropagation(); toggleSourceSelection(srcFiles); }}
                      />
                    ) : (
                      <span style={{ width: 11, flexShrink: 0 }} />
                    )}

                    {/* Expand chevron */}
                    <div
                      onClick={() => srcFiles.length > 0 && toggle(srcKey)}
                      style={{
                        display: "flex", alignItems: "center", gap: 5,
                        flex: 1, cursor: srcFiles.length > 0 ? "pointer" : "default",
                        minWidth: 0,
                      }}
                    >
                      {srcFiles.length > 0 ? (
                        <ChevronRight size={9} color="var(--border-bright)" style={{
                          transform: isExp ? "rotate(90deg)" : "none",
                          transition: "transform 0.15s", flexShrink: 0,
                        }} />
                      ) : <span style={{ width: 9, flexShrink: 0 }} />}

                      {isFolder
                        ? <FolderOpen size={12} color={c} style={{ flexShrink: 0 }} />
                        : <FileText  size={12} color={c} style={{ flexShrink: 0 }} />
                      }

                      <span style={{
                        fontSize: 10, color: c, fontWeight: 600,
                        flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        fontFamily: "JetBrains Mono, monospace",
                      }} title={src.type === "folder" ? src.path : undefined}>
                        {src.label}
                      </span>
                    </div>

                    {/* File count badge */}
                    <span style={{
                      fontSize: 9, color: isFolder ? "rgba(91,140,255,0.5)" : "rgba(122,111,217,0.5)",
                      background: isFolder ? "rgba(91,140,255,0.08)" : "rgba(122,111,217,0.08)",
                      borderRadius: 3, padding: "1px 5px", flexShrink: 0,
                      fontFamily: "JetBrains Mono, monospace",
                    }}>
                      {srcFiles.length}
                    </span>
                  </div>

                  {/* ── File nodes ─────────────────────────────────────── */}
                  {isExp && srcFiles.map(f => {
                    const info        = fileInfos[f.path];
                    const fileKey     = `file_${f.path}`;
                    const isFileExp   = expanded.has(fileKey);
                    const isSelected  = selectedPaths.includes(f.path);
                    const sc          = schemaColor(info?.schema);
                    const { descriptor, code, full } = splitIFCName(f.filename);
                    const origin      = detectOrigin(info);
                    const oStyle      = originStyle(origin);

                    return (
                      <div key={f.path}>
                        <div
                          onClick={(e) => {
                            if ((e.target as HTMLElement).closest('[data-no-select]')) {
                              if (info) toggle(fileKey);
                            } else {
                              toggleFileSelection(f.path);
                            }
                          }}
                          style={{
                            display: "flex", alignItems: "center", gap: 5,
                            padding: "3px 8px 3px 22px",
                            cursor: "pointer",
                            borderBottom: "1px solid rgba(30,45,74,0.3)",
                            background: isSelected ? "rgba(91,140,255,0.08)" : "transparent",
                            border: isSelected ? "1px solid rgba(91,140,255,0.2)" : "1px solid rgba(30,45,74,0.3)",
                            transition: "all 0.15s",
                          }}
                          onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = isSelected ? "rgba(91,140,255,0.12)" : "rgba(255,255,255,0.03)")}
                          onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = isSelected ? "rgba(91,140,255,0.08)" : ""}
                        >
                          {/* File checkbox */}
                          <div style={{
                            width: 8, height: 8, borderRadius: 1, flexShrink: 0,
                            border: `1px solid ${isSelected ? "var(--cyan)" : "var(--border-bright)"}`,
                            background: isSelected ? "var(--cyan)" : "transparent",
                            display: "flex", alignItems: "center", justifyContent: "center",
                          }}>
                            {isSelected && <Check size={6} color="var(--background)" strokeWidth={3} />}
                          </div>

                          <ChevronRight
                            size={8}
                            color="var(--border-bright)"
                            style={{
                              transform: isFileExp ? "rotate(90deg)" : "none",
                              transition: "transform 0.15s", flexShrink: 0,
                              opacity: info ? 1 : 0,
                              cursor: info ? "pointer" : "default",
                            }}
                            onClick={(e) => { e.stopPropagation(); if (info) toggle(fileKey); }}
                            data-no-select="true"
                          />

                          <FileBox size={10} color={isSelected ? "var(--cyan)" : sc} style={{ flexShrink: 0 }} />

                          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 0.5, minWidth: 0 }}>
                            <span style={{
                              fontSize: 9.5, color: isSelected ? "var(--cyan)" : "var(--text)",
                              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                              fontFamily: "JetBrains Mono, monospace", fontWeight: isSelected ? 600 : 400,
                            }} title={full}>
                              {code || descriptor || "sin-nombre"}
                            </span>
                            {descriptor && (
                              <span style={{
                                fontSize: 7.5, color: "rgba(91,140,255,0.5)",
                                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.02em",
                              }} title={full}>
                                {descriptor}
                              </span>
                            )}
                          </div>

                          {/* ── Badges: origin + schema ─────────────────── */}
                          <div style={{ display: "flex", gap: 3, alignItems: "center", flexShrink: 0 }}>
                            {/* Origin badge: RVT / C3D */}
                            {origin && (
                              <span style={{
                                fontSize: 7.5, fontWeight: 700,
                                color: oStyle.color,
                                background: oStyle.bg,
                                border: `1px solid ${oStyle.border}`,
                                borderRadius: 2, padding: "1px 3px",
                                fontFamily: "JetBrains Mono, monospace",
                              }}>
                                {origin}
                              </span>
                            )}
                            {/* Schema badge: 4X3 / 4 / 2X3 */}
                            {info && (
                              <span style={{
                                fontSize: 7.5,
                                color: isSelected ? "var(--cyan)" : sc,
                                background: isSelected ? "rgba(91,140,255,0.15)" : `color-mix(in srgb, ${sc} 15%, transparent)`,
                                border: isSelected ? "1px solid rgba(91,140,255,0.3)" : `1px solid color-mix(in srgb, ${sc} 30%, transparent)`,
                                borderRadius: 2, padding: "1px 3px",
                                fontFamily: "JetBrains Mono, monospace", fontWeight: 700,
                              }}>
                                {schemaLabel(info.schema)}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* File detail expand */}
                        {isFileExp && info && (
                          <div style={{
                            paddingLeft: 32, paddingRight: 8, paddingTop: 4, paddingBottom: 5,
                            background: "rgba(0,0,0,0.18)",
                            borderBottom: "1px solid var(--border)",
                          }}>
                            <div style={{
                              fontSize: 9, color: "var(--text-muted)",
                              display: "flex", flexDirection: "column", gap: 2,
                              fontFamily: "JetBrains Mono, monospace",
                            }}>
                              {info.project_name && (
                                <span style={{ color: "var(--text)", fontWeight: 600 }}>{info.project_name}</span>
                              )}
                              <div style={{ display: "flex", gap: 8 }}>
                                <span>{info.element_count.toLocaleString()} elem.</span>
                                <span>{info.file_size_mb} MB</span>
                              </div>
                              {info.author && <span>{info.author}</span>}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* ── Footer ───────────────────────────────────────────────── */}
          <div style={{ flexShrink: 0, padding: "7px 10px", borderTop: "1px solid var(--border)" }}>
            <Link href="/models" style={{
              display: "flex", alignItems: "center", gap: 6,
              fontSize: 10, color: "var(--text-muted)", textDecoration: "none",
              padding: "4px 6px", borderRadius: 4, transition: "color 0.15s",
            }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = "var(--cyan)"}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"}
            >
              <FolderOpen size={11} />
              <span>Gestionar fuentes</span>
            </Link>
          </div>
        </div>
      )}
    </aside>
  );
}
