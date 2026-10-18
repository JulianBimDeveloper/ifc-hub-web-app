"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getPB } from "@/lib/pb";

interface BimScopeProject {
  id: string;
  project_name: string;
  start_date: string;
  target_date: string;
  notes: string;
}

interface BimScopeItem {
  id: string;
  project_id: string;
  section: string;
  discipline: string;
  item_type: "model" | "deliverable" | "milestone";
  progress: number;
  sort_order: number;
  notes: string;
}

const TYPE_COLOR: Record<string, string> = {
  model: "var(--cyan)",
  deliverable: "var(--magenta)",
  milestone: "var(--yellow)",
};

function ProgressRing({ pct }: { pct: number }) {
  return (
    <div style={{ position: "relative", width: 80, height: 80, flexShrink: 0 }}>
      <div style={{
        width: 80,
        height: 80,
        borderRadius: "50%",
        background: `conic-gradient(var(--cyan) ${pct}%, var(--border) 0)`,
      }} />
      <div style={{
        position: "absolute",
        top: 8,
        left: 8,
        width: 64,
        height: 64,
        borderRadius: "50%",
        background: "var(--surface-2)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
      }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--cyan)", lineHeight: 1 }}>
          {pct}%
        </span>
        <span style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 2 }}>done</span>
      </div>
    </div>
  );
}

function KpiCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{
      background: "var(--surface)",
      border: `1px solid ${color}33`,
      borderRadius: 8,
      padding: "14px 18px",
      boxShadow: `0 0 14px ${color}14`,
      minWidth: 0,
    }}>
      <div style={{ fontSize: 26, fontWeight: 700, color, lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>{label}</div>
    </div>
  );
}

function ProgressCell({
  item,
  onSaved,
}: {
  item: BimScopeItem;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(item.progress));
  const [saving, setSaving] = useState(false);

  async function save() {
    const n = Math.max(0, Math.min(100, parseInt(val, 10) || 0));
    setSaving(true);
    try {
      await getPB().collection("bim_scope_items").update(item.id, { progress: n });
      onSaved();
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setVal(String(item.progress));
    setEditing(false);
  }

  const pct = item.progress;
  const barColor =
    pct === 100 ? "var(--green)" : pct === 0 ? "var(--red)" : "var(--cyan)";

  if (editing) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          type="number"
          min={0}
          max={100}
          value={val}
          onChange={e => setVal(e.target.value)}
          autoFocus
          onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") cancel(); }}
          style={{
            width: 56,
            background: "var(--surface)",
            border: "1px solid var(--cyan)",
            borderRadius: 4,
            color: "var(--text)",
            fontSize: 12,
            padding: "2px 6px",
            fontFamily: "inherit",
            outline: "none",
          }}
        />
        <button
          onClick={save}
          disabled={saving}
          style={{
            background: "var(--cyan)",
            border: "none",
            borderRadius: 4,
            color: "var(--surface)",
            fontSize: 11,
            padding: "3px 8px",
            cursor: "pointer",
            fontFamily: "inherit",
            fontWeight: 700,
          }}
        >
          {saving ? "…" : "OK"}
        </button>
        <button
          onClick={cancel}
          style={{
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: "var(--text-muted)",
            fontSize: 11,
            padding: "3px 8px",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div
      onClick={() => setEditing(true)}
      title="Click to edit progress"
      style={{
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 8,
        minWidth: 120,
      }}
    >
      <div style={{
        flex: 1,
        height: 6,
        background: "var(--border)",
        borderRadius: 3,
        overflow: "hidden",
        minWidth: 60,
      }}>
        <div style={{
          width: `${pct}%`,
          height: "100%",
          background: barColor,
          borderRadius: 3,
          transition: "width 0.3s",
          boxShadow: pct > 0 ? `0 0 6px ${barColor}88` : "none",
        }} />
      </div>
      <span style={{ fontSize: 11, color: barColor, fontWeight: 600, minWidth: 32, textAlign: "right" }}>
        {pct}%
      </span>
    </div>
  );
}

function TypeBadge({ type }: { type: string }) {
  const color = TYPE_COLOR[type] ?? "var(--text-muted)";
  return (
    <span style={{
      fontSize: 9,
      fontWeight: 700,
      textTransform: "uppercase",
      letterSpacing: "0.06em",
      color,
      border: `1px solid ${color}55`,
      borderRadius: 4,
      padding: "2px 6px",
      background: `${color}11`,
      whiteSpace: "nowrap",
    }}>
      {type}
    </span>
  );
}

export default function BimScopePage() {
  const qc = useQueryClient();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newStart, setNewStart] = useState("");
  const [newTarget, setNewTarget] = useState("");
  const [creating, setCreating] = useState(false);

  const { data: projects = [], isLoading: loadingProjects } = useQuery<BimScopeProject[]>({
    queryKey: ["bim_scope_projects"],
    queryFn: () =>
      getPB().collection("bim_scope_projects").getFullList({ sort: "project_name" }) as Promise<BimScopeProject[]>,
    staleTime: 15_000,
  });

  const { data: items = [], isLoading: loadingItems } = useQuery<BimScopeItem[]>({
    queryKey: ["bim_scope_items", selectedId],
    queryFn: () =>
      getPB()
        .collection("bim_scope_items")
        .getFullList({
          filter: `project_id = "${selectedId}"`,
          sort: "sort_order,section,discipline",
        }) as Promise<BimScopeItem[]>,
    enabled: !!selectedId,
    staleTime: 10_000,
  });

  const selectedProject = projects.find(p => p.id === selectedId);

  const total = items.length;
  const done = items.filter(i => i.progress === 100).length;
  const inProgress = items.filter(i => i.progress > 0 && i.progress < 100).length;
  const pending = items.filter(i => i.progress === 0).length;
  const avgPct = total === 0 ? 0 : Math.round(items.reduce((s, i) => s + i.progress, 0) / total);

  const grouped = items.reduce<Record<string, BimScopeItem[]>>((acc, item) => {
    if (!acc[item.section]) acc[item.section] = [];
    acc[item.section].push(item);
    return acc;
  }, {});

  async function createProject() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const rec = await getPB().collection("bim_scope_projects").create({
        project_name: newName.trim(),
        start_date: newStart || null,
        target_date: newTarget || null,
        notes: "",
      });
      await qc.invalidateQueries({ queryKey: ["bim_scope_projects"] });
      setSelectedId((rec as unknown as BimScopeProject).id);
      setShowNewForm(false);
      setNewName("");
      setNewStart("");
      setNewTarget("");
    } finally {
      setCreating(false);
    }
  }

  async function deleteProject(id: string, name: string) {
    if (!window.confirm(`Delete project "${name}"? This cannot be undone.`)) return;
    await getPB().collection("bim_scope_projects").delete(id);
    await qc.invalidateQueries({ queryKey: ["bim_scope_projects"] });
    if (selectedId === id) setSelectedId(null);
  }

  const inputStyle: React.CSSProperties = {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 5,
    color: "var(--text)",
    fontSize: 12,
    padding: "5px 10px",
    fontFamily: "inherit",
    outline: "none",
  };

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{
          fontSize: 22,
          fontWeight: 700,
          background: "linear-gradient(90deg, var(--cyan), var(--magenta))",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
          letterSpacing: "0.06em",
          display: "inline-block",
        }}>
          BIM SCOPE
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
          Gestión del alcance BIM del proyecto — modelos, entregables y milestones
        </p>
      </div>

      {/* Project Selector */}
      <div className="card-cyber" style={{ padding: "14px 16px", marginBottom: 20 }}>
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}>
          <span style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase",
            letterSpacing: "0.08em", marginRight: 4, whiteSpace: "nowrap" }}>
            PROYECTO
          </span>

          {loadingProjects ? (
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Cargando…</span>
          ) : (
            projects.map(p => (
              <div
                key={p.id}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  background: selectedId === p.id ? "var(--cyan)22" : "var(--surface)",
                  border: `1px solid ${selectedId === p.id ? "var(--cyan)" : "var(--border)"}`,
                  borderRadius: 20,
                  padding: "4px 10px 4px 12px",
                  cursor: "pointer",
                  transition: "all 0.15s",
                  fontSize: 12,
                  color: selectedId === p.id ? "var(--cyan)" : "var(--text)",
                  fontWeight: selectedId === p.id ? 700 : 400,
                  boxShadow: selectedId === p.id ? "0 0 8px rgba(91,140,255,0.2)" : "none",
                }}
                onClick={() => setSelectedId(p.id === selectedId ? null : p.id)}
              >
                {p.project_name}
                <button
                  onClick={e => { e.stopPropagation(); deleteProject(p.id, p.project_name); }}
                  title="Delete project"
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "var(--red)",
                    cursor: "pointer",
                    fontSize: 12,
                    lineHeight: 1,
                    padding: "0 0 0 4px",
                    opacity: 0.6,
                    display: "inline-flex",
                    alignItems: "center",
                  }}
                  onMouseEnter={e => (e.currentTarget.style.opacity = "1")}
                  onMouseLeave={e => (e.currentTarget.style.opacity = "0.6")}
                >
                  ✕
                </button>
              </div>
            ))
          )}

          {!showNewForm && (
            <button
              onClick={() => setShowNewForm(true)}
              style={{
                background: "transparent",
                border: "1px dashed var(--border)",
                borderRadius: 20,
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 12,
                padding: "4px 12px",
                fontFamily: "inherit",
                transition: "all 0.15s",
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLElement).style.borderColor = "var(--cyan)";
                (e.currentTarget as HTMLElement).style.color = "var(--cyan)";
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLElement).style.borderColor = "var(--border)";
                (e.currentTarget as HTMLElement).style.color = "var(--text-muted)";
              }}
            >
              + Nuevo proyecto
            </button>
          )}
        </div>

        {/* New project inline form */}
        {showNewForm && (
          <div style={{
            marginTop: 12,
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            paddingTop: 12,
            borderTop: "1px solid var(--border)",
          }}>
            <input
              placeholder="Nombre del proyecto"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              autoFocus
              onKeyDown={e => { if (e.key === "Enter") createProject(); if (e.key === "Escape") setShowNewForm(false); }}
              style={{ ...inputStyle, minWidth: 180 }}
            />
            <input
              type="date"
              value={newStart}
              onChange={e => setNewStart(e.target.value)}
              title="Fecha inicio"
              style={{ ...inputStyle, colorScheme: "dark" }}
            />
            <input
              type="date"
              value={newTarget}
              onChange={e => setNewTarget(e.target.value)}
              title="Fecha objetivo"
              style={{ ...inputStyle, colorScheme: "dark" }}
            />
            <button
              onClick={createProject}
              disabled={creating || !newName.trim()}
              style={{
                background: "var(--cyan)",
                border: "none",
                borderRadius: 5,
                color: "var(--surface)",
                fontSize: 12,
                fontWeight: 700,
                padding: "6px 14px",
                cursor: creating || !newName.trim() ? "not-allowed" : "pointer",
                fontFamily: "inherit",
                opacity: creating || !newName.trim() ? 0.5 : 1,
              }}
            >
              {creating ? "Creando…" : "Crear"}
            </button>
            <button
              onClick={() => { setShowNewForm(false); setNewName(""); setNewStart(""); setNewTarget(""); }}
              style={{
                background: "transparent",
                border: "1px solid var(--border)",
                borderRadius: 5,
                color: "var(--text-muted)",
                fontSize: 12,
                padding: "6px 12px",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Cancelar
            </button>
          </div>
        )}
      </div>

      {/* KPI Row */}
      {selectedProject && (
        <>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginBottom: 20,
            flexWrap: "wrap",
          }}>
            <ProgressRing pct={avgPct} />
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
              gap: 10,
              flex: 1,
              minWidth: 0,
            }}>
              <KpiCard label="Total items" value={total} color="var(--yellow)" />
              <KpiCard label="Completados" value={done} color="var(--green)" />
              <KpiCard label="En progreso" value={inProgress} color="var(--cyan)" />
              <KpiCard label="Pendientes" value={pending} color="var(--red)" />
            </div>
          </div>

          {/* Project meta */}
          <div style={{
            display: "flex",
            gap: 16,
            marginBottom: 20,
            flexWrap: "wrap",
          }}>
            {selectedProject.start_date && (
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                Inicio:{" "}
                <span style={{ color: "var(--text)" }}>{selectedProject.start_date.slice(0, 10)}</span>
              </span>
            )}
            {selectedProject.target_date && (
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                Objetivo:{" "}
                <span style={{ color: "var(--yellow)" }}>{selectedProject.target_date.slice(0, 10)}</span>
              </span>
            )}
          </div>

          {/* Items Table */}
          {loadingItems ? (
            <div className="card-cyber" style={{ padding: 24, textAlign: "center" }}>
              <span style={{ color: "var(--text-muted)", fontSize: 13 }}>Cargando items…</span>
            </div>
          ) : items.length === 0 ? (
            <div className="card-cyber" style={{ padding: 24, textAlign: "center" }}>
              <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
                No hay items para este proyecto en PocketBase
              </span>
            </div>
          ) : (
            <div className="card-cyber" style={{ padding: 0, overflow: "hidden" }}>
              <table style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12,
              }}>
                <thead>
                  <tr style={{ background: "var(--surface)" }}>
                    <th style={thStyle}>DISCIPLINA</th>
                    <th style={thStyle}>TIPO</th>
                    <th style={{ ...thStyle, minWidth: 160 }}>PROGRESO</th>
                    <th style={thStyle}>NOTAS</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.keys(grouped).sort().map(section => {
                    const sectionItems = grouped[section];
                    const sectionType = sectionItems[0]?.item_type;
                    const sectionColor = TYPE_COLOR[sectionType] ?? "var(--text-muted)";
                    return [
                      <tr key={`section-${section}`}>
                        <td
                          colSpan={4}
                          style={{
                            padding: "10px 16px",
                            background: `${sectionColor}0d`,
                            borderTop: `1px solid ${sectionColor}44`,
                            borderBottom: `1px solid ${sectionColor}22`,
                            color: sectionColor,
                            fontWeight: 700,
                            fontSize: 11,
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                          }}
                        >
                          {section}
                        </td>
                      </tr>,
                      ...sectionItems.map((item, idx) => (
                        <tr
                          key={item.id}
                          style={{
                            background: idx % 2 === 0 ? "var(--surface-2)" : "var(--surface)",
                            borderBottom: "1px solid var(--border)",
                            transition: "background 0.1s",
                          }}
                          onMouseEnter={e => (e.currentTarget.style.background = "rgba(91,140,255,0.04)")}
                          onMouseLeave={e => (e.currentTarget.style.background = idx % 2 === 0 ? "var(--surface-2)" : "var(--surface)")}
                        >
                          <td style={tdStyle}>{item.discipline}</td>
                          <td style={tdStyle}>
                            <TypeBadge type={item.item_type} />
                          </td>
                          <td style={tdStyle}>
                            <ProgressCell
                              item={item}
                              onSaved={() => qc.invalidateQueries({ queryKey: ["bim_scope_items", selectedId] })}
                            />
                          </td>
                          <td style={{ ...tdStyle, color: "var(--text-muted)", maxWidth: 220, overflow: "hidden",
                            textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {item.notes || "—"}
                          </td>
                        </tr>
                      )),
                    ];
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {!selectedProject && !loadingProjects && (
        <div style={{
          marginTop: 40,
          textAlign: "center",
          color: "var(--text-muted)",
          fontSize: 13,
        }}>
          Selecciona o crea un proyecto para ver su alcance BIM
        </div>
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: "10px 16px",
  textAlign: "left",
  fontSize: 10,
  fontWeight: 700,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  borderBottom: "1px solid var(--border)",
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "9px 16px",
  color: "var(--text)",
  verticalAlign: "middle",
};
