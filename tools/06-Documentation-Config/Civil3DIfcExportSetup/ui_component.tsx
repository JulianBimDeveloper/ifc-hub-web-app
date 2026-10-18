"use client";

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { getPB } from "@/lib/pb";
import {
  FolderSearch, X, Pencil, Check, FileCode,
  AlertTriangle, CheckCircle2, RefreshCw, Rocket,
} from "lucide-react";

const API = "http://127.0.0.1:8020";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ProjectDefaultParam {
  id: string;
  pset_name: string;
  property_name: string;
  property_value: string;
}

interface FolderPreview {
  folder: string;
  error: string | null;
  dwg_files: string[];
  dwg_count: number;
  conflicts: string[];
  has_conflicts: boolean;
  writable: boolean;
}

interface FolderResult {
  folder: string;
  deployed: string[];
  skipped: string[];
  errors: { file: string; error: string }[];
  ok: boolean;
}

// ── Override field definitions ────────────────────────────────────────────────

interface OverrideField {
  key: string;
  label: string;
  section: "AuthorAttributes" | "ProjectAttributes" | "FacilityAttributes";
  pbKey?: string; // property_name en ifc_project_defaults si existe
}

const OVERRIDE_FIELDS: OverrideField[] = [
  // ProjectAttributes — coinciden con ifc_project_defaults
  { key: "proj_Name",      label: "Project Name",      section: "ProjectAttributes",  pbKey: "Name"     },
  { key: "proj_LongName",  label: "Long Name",          section: "ProjectAttributes",  pbKey: "LongName" },
  { key: "proj_Phase",     label: "Phase",              section: "ProjectAttributes",  pbKey: "Phase"    },
  // FacilityAttributes
  { key: "fac_Name",       label: "Facility Name",      section: "FacilityAttributes", pbKey: undefined  },
  { key: "fac_Purpose",    label: "Facility Purpose",   section: "FacilityAttributes", pbKey: undefined  },
  // AuthorAttributes
  { key: "auth_Id",        label: "Author ID",          section: "AuthorAttributes",   pbKey: undefined  },
  { key: "auth_Family",    label: "Family Name",        section: "AuthorAttributes",   pbKey: undefined  },
  { key: "auth_Given",     label: "Given Name",         section: "AuthorAttributes",   pbKey: undefined  },
  { key: "auth_Org",       label: "Organization",       section: "AuthorAttributes",   pbKey: undefined  },
  { key: "auth_Email",     label: "Email",              section: "AuthorAttributes",   pbKey: undefined  },
  { key: "auth_Auth",      label: "Authorization",      section: "AuthorAttributes",   pbKey: undefined  },
];

// Map override key → path inside IfcInfraConfiguration.json
const OVERRIDE_TO_JSON: Record<string, { section: string; jsonKey: string }> = {
  proj_Name:     { section: "ProjectAttributes",  jsonKey: "Name"           },
  proj_LongName: { section: "ProjectAttributes",  jsonKey: "LongName"       },
  proj_Phase:    { section: "ProjectAttributes",  jsonKey: "Phase"          },
  fac_Name:      { section: "FacilityAttributes", jsonKey: "FacilityName"   },
  fac_Purpose:   { section: "FacilityAttributes", jsonKey: "FacilityPurpose"},
  auth_Id:       { section: "AuthorAttributes",   jsonKey: "Identification" },
  auth_Family:   { section: "AuthorAttributes",   jsonKey: "FamilyName"     },
  auth_Given:    { section: "AuthorAttributes",   jsonKey: "GivenName"      },
  auth_Org:      { section: "AuthorAttributes",   jsonKey: "OrganizationName"},
  auth_Email:    { section: "AuthorAttributes",   jsonKey: "OrganizationEmail"},
  auth_Auth:     { section: "AuthorAttributes",   jsonKey: "Authorization"  },
};

const TEMPLATE_FILES = [
  "IfcInfraConfiguration.json",
  "IfcInfraExportMapping.json",
  "IfcInfraExportPropertyMapping.json",
];

// ── Inline editable field ─────────────────────────────────────────────────────

function EditableField({
  label, value, onChange,
}: { label: string; value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(value);

  useEffect(() => { setDraft(value); }, [value]);

  const commit = () => { onChange(draft); setEditing(false); };
  const cancel = () => { setDraft(value); setEditing(false); };

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "5px 10px", borderBottom: "1px solid var(--border)",
      minHeight: 32,
    }}>
      <span style={{ fontSize: 10, color: "var(--text-muted)", width: 130, flexShrink: 0,
        fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.04em" }}>
        {label}
      </span>

      {editing ? (
        <>
          <input
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") cancel(); }}
            style={{ flex: 1, fontSize: 11, padding: "3px 6px", background: "var(--surface-2)",
              border: "1px solid var(--cyan)", borderRadius: 3, color: "var(--text)",
              fontFamily: "JetBrains Mono, monospace" }}
          />
          <button onClick={commit} style={{ background: "none", border: "none", cursor: "pointer",
            color: "var(--green)", display: "flex", padding: 2 }}>
            <Check size={13} />
          </button>
          <button onClick={cancel} style={{ background: "none", border: "none", cursor: "pointer",
            color: "var(--red)", display: "flex", padding: 2 }}>
            <X size={13} />
          </button>
        </>
      ) : (
        <>
          <span style={{ flex: 1, fontSize: 11, color: value ? "var(--text)" : "var(--dim)",
            fontFamily: "JetBrains Mono, monospace", fontStyle: value ? "normal" : "italic" }}>
            {value || "—"}
          </span>
          <button onClick={() => setEditing(true)} style={{ background: "none", border: "none",
            cursor: "pointer", color: "var(--border-bright)", display: "flex", padding: 2,
            transition: "color 0.15s" }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = "var(--cyan)"}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = "var(--border-bright)"}>
            <Pencil size={11} />
          </button>
        </>
      )}
    </div>
  );
}

// ── Folder card ───────────────────────────────────────────────────────────────

function FolderCard({
  preview, onRemove,
}: { preview: FolderPreview; onRemove: () => void }) {
  const [expanded, setExpanded] = useState(true);
  const hasError    = !!preview.error;
  const hasConflict = preview.has_conflicts;
  const statusColor = hasError    ? "var(--red)"
                    : !preview.writable ? "#D9A441"
                    : hasConflict ? "#D9A441"
                    : "var(--green)";
  const statusLabel = hasError    ? "ERROR"
                    : !preview.writable ? "SIN PERMISO"
                    : hasConflict ? "CONFLICTO"
                    : "OK";

  return (
    <div style={{
      background: "var(--surface)", border: `1px solid ${statusColor}33`,
      borderRadius: 6, overflow: "hidden", marginBottom: 8,
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "8px 12px", borderBottom: `1px solid ${statusColor}22`,
        cursor: "pointer",
      }} onClick={() => setExpanded(v => !v)}>
        <FolderSearch size={13} color={statusColor} style={{ flexShrink: 0 }} />
        <span style={{ flex: 1, fontSize: 10, color: "var(--text)", fontFamily: "JetBrains Mono, monospace",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={preview.folder}>
          {preview.folder}
        </span>
        <span style={{ fontSize: 8, fontWeight: 700, padding: "1px 6px", borderRadius: 2,
          background: `${statusColor}18`, color: statusColor, flexShrink: 0,
          fontFamily: "JetBrains Mono, monospace" }}>
          {statusLabel}
        </span>
        {preview.dwg_count > 0 && (
          <span style={{ fontSize: 8, padding: "1px 6px", borderRadius: 2,
            background: "rgba(217,164,65,0.12)", color: "#D9A441",
            fontFamily: "JetBrains Mono, monospace", flexShrink: 0 }}>
            {preview.dwg_count} DWG
          </span>
        )}
        <button
          onClick={e => { e.stopPropagation(); onRemove(); }}
          style={{ background: "none", border: "none", cursor: "pointer",
            color: "var(--border-bright)", display: "flex", padding: 2, flexShrink: 0 }}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = "var(--red)"}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = "var(--border-bright)"}>
          <X size={12} />
        </button>
      </div>

      {/* Body */}
      {expanded && (
        <div style={{ padding: "8px 12px" }}>
          {hasError && (
            <p style={{ fontSize: 10, color: "var(--red)", fontStyle: "italic" }}>{preview.error}</p>
          )}

          {/* DWG files */}
          {preview.dwg_files.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {preview.dwg_files.map(f => (
                <div key={f} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ fontSize: 8, padding: "1px 5px", borderRadius: 2,
                    background: "rgba(217,164,65,0.1)", color: "#D9A441",
                    fontFamily: "JetBrains Mono, monospace", fontWeight: 700 }}>
                    DWG
                  </span>
                  <span style={{ fontSize: 10, color: "var(--text-muted)",
                    fontFamily: "JetBrains Mono, monospace",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {f}
                  </span>
                </div>
              ))}
            </div>
          ) : !hasError && (
            <p style={{ fontSize: 10, color: "var(--dim)", fontStyle: "italic" }}>
              Sin archivos .dwg en esta carpeta
            </p>
          )}

          {/* Conflicts */}
          {hasConflict && (
            <div style={{ marginTop: 8, padding: "6px 10px",
              background: "rgba(217,164,65,0.07)", border: "1px solid rgba(217,164,65,0.25)",
              borderRadius: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4 }}>
                <AlertTriangle size={11} color="#D9A441" />
                <span style={{ fontSize: 9.5, fontWeight: 700, color: "#D9A441" }}>
                  JSON ya existentes — se saltarán si no activas "Sobrescribir"
                </span>
              </div>
              {preview.conflicts.map(f => (
                <div key={f} style={{ fontSize: 9, color: "rgba(217,164,65,0.7)",
                  fontFamily: "JetBrains Mono, monospace" }}>
                  • {f}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function C3DExportSetupPage() {
  const [folders, setFolders]       = useState<string[]>([]);
  const [previews, setPreviews]     = useState<FolderPreview[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [overwrite, setOverwrite]   = useState(false);
  const [deploying, setDeploying]   = useState(false);
  const [results, setResults]       = useState<FolderResult[] | null>(null);
  const [overrides, setOverrides]   = useState<Record<string, string>>({});

  // ── Load project defaults from PocketBase ─────────────────────────────────

  const { data: pbDefaults = [] } = useQuery<ProjectDefaultParam[]>({
    queryKey: ["ifc_project_defaults"],
    queryFn: () => getPB().collection("ifc_project_defaults").getFullList<ProjectDefaultParam>({
      requestKey: null,
    }),
    staleTime: 60_000,
  });

  // Pre-populate overrides from PocketBase on first load
  useEffect(() => {
    if (!pbDefaults.length) return;
    const init: Record<string, string> = {};
    OVERRIDE_FIELDS.forEach(f => {
      if (f.pbKey) {
        const row = pbDefaults.find(r => r.property_name === f.pbKey);
        if (row?.property_value) init[f.key] = row.property_value;
      }
    });
    setOverrides(prev => ({ ...init, ...prev })); // don't overwrite user edits
  }, [pbDefaults]);

  // ── Build project_overrides payload from overrides state ──────────────────

  function buildPayload() {
    const auth: Record<string, string> = {};
    const proj: Record<string, string> = {};
    const fac:  Record<string, string> = {};

    Object.entries(overrides).forEach(([key, val]) => {
      const mapping = OVERRIDE_TO_JSON[key];
      if (!mapping || !val) return;
      if (mapping.section === "AuthorAttributes")   auth[mapping.jsonKey] = val;
      if (mapping.section === "ProjectAttributes")  proj[mapping.jsonKey] = val;
      if (mapping.section === "FacilityAttributes") fac[mapping.jsonKey]  = val;
    });

    return {
      AuthorAttributes:   Object.keys(auth).length ? auth : undefined,
      ProjectAttributes:  Object.keys(proj).length ? proj : undefined,
      FacilityAttributes: Object.keys(fac).length  ? fac  : undefined,
    };
  }

  // ── Folder management ─────────────────────────────────────────────────────

  async function pickFolder() {
    try {
      const res = await fetch(`${API}/api/ifc/folder-picker`);
      if (!res.ok) return;
      const { path } = await res.json() as { path: string };
      if (!path || folders.includes(path)) return;
      const newFolders = [...folders, path];
      setFolders(newFolders);
      await runPreview(newFolders);
    } catch { /* dialog cancelled */ }
  }

  function removeFolder(folder: string) {
    const newFolders = folders.filter(f => f !== folder);
    setFolders(newFolders);
    setPreviews(prev => prev.filter(p => p.folder !== folder));
    if (newFolders.length === 0) setResults(null);
  }

  // ── Preview ───────────────────────────────────────────────────────────────

  async function runPreview(foldersToPreview: string[]) {
    if (!foldersToPreview.length) return;
    setPreviewing(true);
    try {
      const res = await fetch(`${API}/api/ifc/c3d-export/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folders: foldersToPreview }),
      });
      if (!res.ok) return;
      const data = await res.json() as { folders: FolderPreview[] };
      setPreviews(data.folders);
    } catch { /* ignore */ } finally {
      setPreviewing(false);
    }
  }

  // ── Deploy ────────────────────────────────────────────────────────────────

  async function deploy() {
    if (!folders.length) return;
    setDeploying(true);
    setResults(null);
    try {
      const res = await fetch(`${API}/api/ifc/c3d-export/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folders,
          project_overrides:   buildPayload(),
          overwrite_conflicts: overwrite,
        }),
      });
      if (!res.ok) return;
      const data = await res.json() as { ok: boolean; results: FolderResult[] };
      setResults(data.results);
      // Refresh preview to show new conflicts
      await runPreview(folders);
    } catch { /* ignore */ } finally {
      setDeploying(false);
    }
  }

  // ── Derived state ─────────────────────────────────────────────────────────

  const anyWritable   = previews.some(p => p.writable && !p.error);
  const anyConflict   = previews.some(p => p.has_conflicts);
  const canDeploy     = folders.length > 0 && anyWritable && !deploying && !previewing;

  const sectionLabels: Record<string, string> = {
    ProjectAttributes:  "Proyecto",
    FacilityAttributes: "Instalación",
    AuthorAttributes:   "Autor",
  };

  const fieldsBySection: Record<string, OverrideField[]> = {};
  OVERRIDE_FIELDS.forEach(f => {
    if (!fieldsBySection[f.section]) fieldsBySection[f.section] = [];
    fieldsBySection[f.section].push(f);
  });

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>

      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--cyan)", letterSpacing: "0.06em" }}>
          C3D EXPORT SETUP
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
          Deploya los 3 JSON de <code style={{ color: "var(--cyan)", fontSize: 11 }}>infraexportselect</code> junto a los nativos Civil 3D
        </p>
      </div>

      {/* Template files info */}
      <div className="card-cyber" style={{ padding: "8px 14px", marginBottom: 14,
        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 9.5, color: "var(--dim)", textTransform: "uppercase",
          letterSpacing: "0.08em" }}>Plantillas:</span>
        {TEMPLATE_FILES.map(f => (
          <div key={f} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <FileCode size={11} color="var(--cyan)" />
            <span style={{ fontSize: 9.5, color: "var(--text-muted)",
              fontFamily: "JetBrains Mono, monospace" }}>{f}</span>
          </div>
        ))}
      </div>

      {/* Main two-column grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 14, alignItems: "start" }}>

        {/* ══ LEFT: Carpetas de destino ══ */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

          {/* Add folder button */}
          <button
            onClick={pickFolder}
            disabled={previewing}
            style={{
              width: "100%", padding: "10px 16px", fontSize: 12,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              background: "rgba(91,140,255,0.06)", border: "1px solid rgba(91,140,255,0.28)",
              borderRadius: 6, color: previewing ? "var(--dim)" : "var(--cyan)",
              cursor: previewing ? "not-allowed" : "pointer",
              fontFamily: "JetBrains Mono, monospace", fontWeight: 600,
              transition: "all 0.15s",
            }}
            onMouseEnter={e => { if (!previewing) (e.currentTarget as HTMLElement).style.background = "rgba(91,140,255,0.12)"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "rgba(91,140,255,0.06)"; }}
          >
            {previewing
              ? <><RefreshCw size={14} style={{ animation: "spin 0.7s linear infinite" }} /> Analizando…</>
              : <><FolderSearch size={14} /> Añadir carpeta de destino…</>
            }
          </button>

          {/* Empty state */}
          {folders.length === 0 && (
            <div style={{
              border: "1px dashed rgba(91,140,255,0.18)", borderRadius: 6,
              padding: "32px 20px", textAlign: "center", color: "var(--dim)",
            }}>
              <FolderSearch size={28} style={{ marginBottom: 8, opacity: 0.4 }} />
              <p style={{ fontSize: 11, marginBottom: 4 }}>Sin carpetas de destino</p>
              <p style={{ fontSize: 10, color: "var(--border-bright)" }}>
                Selecciona la carpeta donde están los archivos .dwg nativos
              </p>
            </div>
          )}

          {/* Folder cards */}
          {previews.map(p => (
            <FolderCard
              key={p.folder}
              preview={p}
              onRemove={() => removeFolder(p.folder)}
            />
          ))}

          {/* Folders added but not yet previewed */}
          {folders.filter(f => !previews.find(p => p.folder === f)).map(f => (
            <div key={f} className="card-cyber" style={{ padding: "8px 12px",
              display: "flex", alignItems: "center", gap: 8 }}>
              <RefreshCw size={12} color="var(--dim)" style={{ animation: "spin 0.7s linear infinite" }} />
              <span style={{ fontSize: 10, color: "var(--dim)", fontFamily: "JetBrains Mono, monospace",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {f}
              </span>
            </div>
          ))}

          {/* Overwrite toggle — shown only when conflicts exist */}
          {anyConflict && (
            <div style={{
              padding: "10px 14px",
              background: "rgba(217,164,65,0.06)", border: "1px solid rgba(217,164,65,0.28)",
              borderRadius: 6, display: "flex", alignItems: "center", gap: 10,
            }}>
              <AlertTriangle size={14} color="#D9A441" style={{ flexShrink: 0 }} />
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
                flex: 1, fontSize: 11, color: "#D9A441" }}>
                <div
                  onClick={() => setOverwrite(v => !v)}
                  style={{
                    width: 32, height: 18, borderRadius: 9, cursor: "pointer", flexShrink: 0,
                    background: overwrite ? "#D9A441" : "var(--border)", position: "relative",
                    transition: "background 0.2s",
                  }}>
                  <div style={{
                    position: "absolute", top: 2, left: overwrite ? 16 : 2,
                    width: 14, height: 14, borderRadius: "50%", transition: "left 0.2s",
                    background: overwrite ? "var(--surface)" : "var(--text-muted)",
                  }} />
                </div>
                Sobrescribir archivos JSON existentes
              </label>
            </div>
          )}

          {/* Deploy log */}
          {results && (
            <div className="card-cyber" style={{ overflow: "hidden" }}>
              <div style={{ padding: "8px 14px", borderBottom: "1px solid var(--border)",
                fontSize: 10, fontWeight: 700, color: "var(--text-muted)",
                textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Resultado del deploy
              </div>
              <div style={{ padding: "8px 0" }}>
                {results.map(r => (
                  <div key={r.folder} style={{ marginBottom: 8 }}>
                    <div style={{ padding: "4px 14px", fontSize: 9,
                      color: "var(--border-bright)", fontFamily: "JetBrains Mono, monospace",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      borderBottom: "1px solid var(--border)" }}>
                      📁 {r.folder}
                    </div>
                    {TEMPLATE_FILES.map(f => {
                      const deployed = r.deployed.includes(f);
                      const skipped  = r.skipped.includes(f);
                      const errEntry = r.errors.find(e => e.file === f);
                      const color  = errEntry ? "var(--red)" : skipped ? "#D9A441" : "var(--green)";
                      const icon   = errEntry ? "✗" : skipped ? "⟳" : "✓";
                      const status = errEntry ? errEntry.error : skipped ? "SALTADO" : "CREADO";
                      return (
                        <div key={f} style={{
                          display: "flex", alignItems: "center", gap: 8,
                          padding: "3px 14px",
                        }}>
                          <span style={{ fontSize: 11, color, fontWeight: 700, flexShrink: 0 }}>{icon}</span>
                          <span style={{ fontSize: 10, color: "var(--text-muted)",
                            fontFamily: "JetBrains Mono, monospace", flex: 1,
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {f}
                          </span>
                          <span style={{ fontSize: 8.5, color, fontFamily: "JetBrains Mono, monospace",
                            flexShrink: 0 }}>
                            {status}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ══ RIGHT: Config + Deploy ══ */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10, position: "sticky", top: 0 }}>

          {/* Deploy button */}
          <button
            onClick={deploy}
            disabled={!canDeploy}
            style={{
              width: "100%", padding: "12px 16px", fontSize: 13, fontWeight: 700,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              background: canDeploy ? "rgba(122,111,217,0.12)" : "var(--border)",
              border: `1px solid ${canDeploy ? "var(--magenta)" : "var(--text-muted)"}`,
              borderRadius: 6, color: canDeploy ? "var(--magenta)" : "var(--dim)",
              cursor: canDeploy ? "pointer" : "not-allowed",
              fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.05em",
              boxShadow: canDeploy ? "0 0 12px rgba(122,111,217,0.2)" : "none",
              transition: "all 0.2s",
            }}
          >
            {deploying
              ? <><RefreshCw size={14} style={{ animation: "spin 0.7s linear infinite" }} /> Deployando…</>
              : <><Rocket size={14} /> DEPLOY JSON ({folders.length > 0 ? `${folders.length} carpeta${folders.length > 1 ? "s" : ""}` : "sin carpetas"})</>
            }
          </button>

          {/* Summary chips */}
          {previews.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <div style={{ fontSize: 9, padding: "2px 8px", borderRadius: 3,
                background: "rgba(91,140,255,0.08)", color: "var(--cyan)",
                fontFamily: "JetBrains Mono, monospace" }}>
                {previews.reduce((s, p) => s + p.dwg_count, 0)} DWG total
              </div>
              {anyConflict && (
                <div style={{ fontSize: 9, padding: "2px 8px", borderRadius: 3,
                  background: "rgba(217,164,65,0.08)", color: "#D9A441",
                  fontFamily: "JetBrains Mono, monospace" }}>
                  {previews.filter(p => p.has_conflicts).length} con conflictos
                </div>
              )}
              {previews.filter(p => !p.writable && !p.error).length > 0 && (
                <div style={{ fontSize: 9, padding: "2px 8px", borderRadius: 3,
                  background: "rgba(255,68,102,0.08)", color: "var(--red)",
                  fontFamily: "JetBrains Mono, monospace" }}>
                  {previews.filter(p => !p.writable).length} sin permiso
                </div>
              )}
            </div>
          )}

          {/* Project overrides editor */}
          {Object.entries(fieldsBySection).map(([section, fields]) => (
            <div key={section} className="card-cyber" style={{ overflow: "hidden" }}>
              <div style={{ padding: "7px 12px", borderBottom: "1px solid var(--border)",
                fontSize: 9.5, fontWeight: 700, color: "var(--text-muted)",
                textTransform: "uppercase", letterSpacing: "0.08em" }}>
                {sectionLabels[section] ?? section}
              </div>
              {fields.map(f => (
                <EditableField
                  key={f.key}
                  label={f.label}
                  value={overrides[f.key] ?? ""}
                  onChange={val => setOverrides(prev => ({ ...prev, [f.key]: val }))}
                />
              ))}
            </div>
          ))}

          {/* Help card */}
          <div className="card-cyber" style={{ padding: "10px 14px" }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, color: "var(--cyan)",
              textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
              ¿Cómo funciona?
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {[
                "1. Añade la carpeta donde tienes el .dwg nativo",
                "2. Verifica que aparecen los archivos DWG",
                "3. Edita los campos si necesitas ajustar autor o proyecto",
                "4. Pulsa DEPLOY — se crean los 3 JSON junto al nativo",
                "5. Exporta IFC desde Civil 3D con infraexportselect",
              ].map((step, i) => (
                <div key={i} style={{ fontSize: 10, color: "var(--text-muted)",
                  fontFamily: "JetBrains Mono, monospace" }}>
                  {step}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
