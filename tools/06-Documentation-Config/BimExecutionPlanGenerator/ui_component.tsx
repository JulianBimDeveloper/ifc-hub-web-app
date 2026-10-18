"use client";

import { useState, useCallback } from "react";
import {
  FileText, ChevronRight, ChevronLeft, Plus, Trash2,
  Download, CheckCircle, Loader2, Building2, Users,
  Calendar, Settings, Layers, MapPin, BookOpen,
} from "lucide-react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8020";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Persona { nombre: string; empresa: string; email: string; rol?: string }
interface Hito    { hito: string; fecha: string; descripcion: string }
interface Nivel   { codigo: string; elevacion: string; comentario: string }
interface UsoExcluido { codigo: string; uso: string; justificacion: string }
interface DocInput { documento: string; suministrador: string; formato: string }
interface Disciplina { code: string; nombre: string; software: string; activa: boolean }

const DISCIPLINAS_DEFAULT: Disciplina[] = [
  { code:"ARQ",  nombre:"Arquitectura",                 software:"REVIT",    activa:true },
  { code:"EST",  nombre:"Estructuras",                  software:"REVIT",    activa:true },
  { code:"SUV",  nombre:"Superestructura de Vía",        software:"CIVIL3D",  activa:true },
  { code:"ENE",  nombre:"Electrificación",              software:"REVIT",    activa:false },
  { code:"IAB",  nombre:"Instalaciones Abastecimiento",  software:"REVIT",    activa:false },
  { code:"IDR",  nombre:"Instalaciones Drenaje",         software:"AMBOS",    activa:false },
  { code:"IEL",  nombre:"Instalaciones Electricidad",    software:"REVIT",    activa:false },
  { code:"IGA",  nombre:"Instalaciones Gas",             software:"REVIT",    activa:false },
  { code:"INS",  nombre:"Instalaciones Generales",       software:"REVIT",    activa:false },
  { code:"ISA",  nombre:"Instalaciones Saneamiento",     software:"REVIT",    activa:false },
  { code:"ITE",  nombre:"Instalaciones Telecomunicación",software:"REVIT",    activa:false },
  { code:"ITF",  nombre:"Telecomunicación Ferroviaria",  software:"CIVIL3D",  activa:false },
  { code:"CMS",  nombre:"Sistemas CMS",                  software:"REVIT",    activa:false },
  { code:"CYT",  nombre:"Topografía",                   software:"CIVIL3D",  activa:false },
  { code:"INT",  nombre:"Gálibos Interoperabilidad",     software:"CIVIL3D",  activa:false },
];

const USOS_ALL = [
  { codigo:"GE013", nombre:"Autoría BIM 3D",                        req:true  },
  { codigo:"RE013", nombre:"Levantamiento digital activos existentes",req:true  },
  { codigo:"RE023", nombre:"Modelo construido (As-Built)",           req:false },
  { codigo:"GE023", nombre:"Seguimiento de obra con BIM",            req:false },
  { codigo:"CO011", nombre:"Gestión documental / CDE",               req:true  },
  { codigo:"CO022", nombre:"Documentación 2D / Planos",              req:true  },
  { codigo:"CO043", nombre:"Reuniones digitales",                    req:true  },
  { codigo:"CO053", nombre:"Visualización institucional",            req:true  },
  { codigo:"AN023", nombre:"Coordinación BIM 3D / Interferencias",   req:true  },
  { codigo:"AN034", nombre:"Simulación constructiva 4D",             req:true  },
  { codigo:"AN045", nombre:"Mediciones BIM 5D",                      req:false },
  { codigo:"AN089", nombre:"Interoperabilidad ferroviaria",          req:true  },
];

interface FormData {
  // Step 1 — Proyecto
  nombre_actuacion: string;
  expediente: string;
  expediente_num: string;
  codigo_actuacion: string;
  direccion: string;
  fecha_inicio: string;
  fecha_fin: string;
  descripcion_actuacion: string;
  fecha_peb: string;
  // Step 2 — Empresa
  empresa_am: string;
  codigo_am: string;
  // Step 3 — Equipo
  responsable_bim: Persona;
  coordinador_bim: Persona;
  modeladores: Persona[];
  // Step 4 — Fechas
  hitos: Hito[];
  // Step 5 — Disciplinas + coordenadas + niveles
  disciplinas: Disciplina[];
  coord_x: string;
  coord_y: string;
  coord_z: string;
  sistema_coordenadas: string;
  niveles: Nivel[];
  // Step 6 — Técnico + usos
  version_revit: string;
  usa_civil3d: boolean;
  version_civil3d: string;
  version_navisworks: string;
  nombre_cde: string;
  usos_activos: string[];
  usos_excluidos: UsoExcluido[];
  // Meta
  revision_actual: string;
  revision_estado: string;
}

const DEFAULT_FORM: FormData = {
  nombre_actuacion: "",
  expediente: "",
  expediente_num: "",
  codigo_actuacion: "",
  direccion: "",
  fecha_inicio: "",
  fecha_fin: "Fecha a confirmar",
  descripcion_actuacion: "",
  fecha_peb: "",
  empresa_am: "",
  codigo_am: "ACO",
  responsable_bim: { nombre:"", empresa:"", email:"", rol:"Responsable BIM AM" },
  coordinador_bim: { nombre:"", empresa:"", email:"", rol:"Coordinador BIM AM" },
  modeladores: [],
  hitos: [
    { hito:"PEB Rev.01", fecha:"", descripcion:"Primera entrega del Plan de Ejecución BIM" },
    { hito:"MEA",        fecha:"", descripcion:"Modelo de Estado Actual" },
    { hito:"MOI",        fecha:"", descripcion:"Modelo de Inicio de Obra" },
    { hito:"MOM Rev.01", fecha:"", descripcion:"Primer seguimiento mensual de obra" },
    { hito:"As-Built",   fecha:"3 meses tras fin de obra", descripcion:"Modelo construido final" },
  ],
  disciplinas: DISCIPLINAS_DEFAULT,
  coord_x: "", coord_y: "", coord_z: "",
  sistema_coordenadas: "ETRS89 UTM-30N",
  niveles: [],
  version_revit: "2025.2",
  usa_civil3d: false,
  version_civil3d: "2025",
  version_navisworks: "2026.2",
  nombre_cde: "Autodesk Construction Cloud (ACC)",
  usos_activos: USOS_ALL.filter(u => u.req).map(u => u.codigo),
  usos_excluidos: [],
  revision_actual: "01",
  revision_estado: "Borrador Primera Edición",
};

// ── Styles helpers ────────────────────────────────────────────────────────────
const S = {
  input: {
    width: "100%", padding: "7px 10px",
    background: "var(--bg)", border: "1px solid var(--border)",
    borderRadius: 5, color: "var(--text)", fontSize: 12,
    outline: "none",
  } as React.CSSProperties,
  label: { fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 3 } as React.CSSProperties,
  field: { marginBottom: 10 } as React.CSSProperties,
  row2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 } as React.CSSProperties,
  row3: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 } as React.CSSProperties,
  section: { marginBottom: 18 } as React.CSSProperties,
  sectionTitle: { fontSize: 11, fontWeight: 700, color: "var(--cyan)", marginBottom: 10, textTransform: "uppercase" as const, letterSpacing: "0.08em" },
  card: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, padding: 12, marginBottom: 8 } as React.CSSProperties,
  addBtn: {
    fontSize: 10, padding: "4px 10px", border: "1px dashed var(--cyan)",
    borderRadius: 4, color: "var(--cyan)", background: "transparent", cursor: "pointer",
    display: "flex", alignItems: "center", gap: 4,
  } as React.CSSProperties,
  delBtn: { background: "transparent", border: "none", cursor: "pointer", color: "var(--red)", padding: 2 } as React.CSSProperties,
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={S.field}><label style={S.label}>{label}</label>{children}</div>;
}

function Input({ value, onChange, placeholder = "", type = "text" }: {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
}) {
  return <input style={S.input} type={type} value={value} placeholder={placeholder}
    onChange={e => onChange(e.target.value)} />;
}

function Textarea({ value, onChange, rows = 3, placeholder = "" }: {
  value: string; onChange: (v: string) => void; rows?: number; placeholder?: string;
}) {
  return <textarea style={{ ...S.input, resize: "vertical" as const, minHeight: rows * 20 }}
    value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} />;
}

// ── STEPS ─────────────────────────────────────────────────────────────────────

function Step1({ f, set }: { f: FormData; set: (patch: Partial<FormData>) => void }) {
  return (
    <div>
      <div style={S.section}>
        <p style={S.sectionTitle}><Building2 size={11} style={{ display: "inline", marginRight: 5 }} />Datos del Proyecto</p>
        <Field label="Nombre completo de la actuación *">
          <Textarea value={f.nombre_actuacion} onChange={v => set({ nombre_actuacion: v })} rows={2}
            placeholder="EJECUCIÓN DE LAS OBRAS DEL PROYECTO CONSTRUCTIVO PARA..." />
        </Field>
        <div style={S.row2}>
          <Field label="Expediente (formato 3.XX/XXXXX.XXXX) *">
            <Input value={f.expediente} onChange={v => set({ expediente: v })} placeholder="3.23/27507.0200" />
          </Field>
          <Field label="Número expediente corto (para códigos) *">
            <Input value={f.expediente_num} onChange={v => set({ expediente_num: v })} placeholder="323275070200" />
          </Field>
        </div>
        <div style={S.row2}>
          <Field label="Código de actuación">
            <Input value={f.codigo_actuacion} onChange={v => set({ codigo_actuacion: v })} placeholder="060-442" />
          </Field>
          <Field label="Mes y año del PEB">
            <Input value={f.fecha_peb} onChange={v => set({ fecha_peb: v })} placeholder="Junio 2026" />
          </Field>
        </div>
        <Field label="Dirección / Emplazamiento *">
          <Input value={f.direccion} onChange={v => set({ direccion: v })} placeholder="Plaza Emperador Carlos V, 28012 Madrid" />
        </Field>
        <div style={S.row2}>
          <Field label="Fecha de comienzo *">
            <Input value={f.fecha_inicio} onChange={v => set({ fecha_inicio: v })} placeholder="27/11/2025" />
          </Field>
          <Field label="Fecha de final">
            <Input value={f.fecha_fin} onChange={v => set({ fecha_fin: v })} placeholder="Fecha a confirmar" />
          </Field>
        </div>
        <Field label="Descripción de la actuación *">
          <Textarea value={f.descripcion_actuacion} onChange={v => set({ descripcion_actuacion: v })}
            placeholder="Breve descripción de los trabajos a realizar..." />
        </Field>
      </div>
      <div style={S.section}>
        <p style={S.sectionTitle}>Empresa Contratista (AM)</p>
        <div style={S.row2}>
          <Field label="Nombre empresa / UTE *">
            <Input value={f.empresa_am} onChange={v => set({ empresa_am: v })} placeholder="UTE GRUSAMAR - Asunto BIM" />
          </Field>
          <Field label="Código originador (3 letras) *">
            <Input value={f.codigo_am} onChange={v => set({ codigo_am: v.toUpperCase().slice(0,3) })} placeholder="ACO" />
          </Field>
        </div>
        <div style={S.row2}>
          <Field label="Revisión actual">
            <Input value={f.revision_actual} onChange={v => set({ revision_actual: v })} placeholder="01" />
          </Field>
          <Field label="Estado del PEB">
            <Input value={f.revision_estado} onChange={v => set({ revision_estado: v })} placeholder="Borrador Primera Edición" />
          </Field>
        </div>
      </div>
    </div>
  );
}

function PersonaCard({ p, onChange, onDelete, showDel = false }: {
  p: Persona; onChange: (v: Persona) => void; onDelete?: () => void; showDel?: boolean;
}) {
  return (
    <div style={{ ...S.card, position: "relative" }}>
      {showDel && onDelete && (
        <button style={{ ...S.delBtn, position: "absolute", top: 6, right: 6 }} onClick={onDelete}>
          <Trash2 size={11} />
        </button>
      )}
      <div style={S.row3}>
        <Field label="Nombre y apellidos">
          <Input value={p.nombre} onChange={v => onChange({ ...p, nombre: v })} />
        </Field>
        <Field label="Empresa">
          <Input value={p.empresa} onChange={v => onChange({ ...p, empresa: v })} />
        </Field>
        <Field label="Email">
          <Input value={p.email} onChange={v => onChange({ ...p, email: v })} type="email" />
        </Field>
      </div>
    </div>
  );
}

function Step2({ f, set }: { f: FormData; set: (patch: Partial<FormData>) => void }) {
  return (
    <div>
      <div style={S.section}>
        <p style={S.sectionTitle}><Users size={11} style={{ display: "inline", marginRight: 5 }} />Responsable BIM AM</p>
        <PersonaCard p={f.responsable_bim} onChange={v => set({ responsable_bim: v })} />
      </div>
      <div style={S.section}>
        <p style={S.sectionTitle}>Coordinador BIM AM</p>
        <PersonaCard p={f.coordinador_bim} onChange={v => set({ coordinador_bim: v })} />
      </div>
      <div style={S.section}>
        <p style={S.sectionTitle}>Modeladores BIM</p>
        {f.modeladores.map((m, i) => (
          <PersonaCard key={i} p={m} showDel onDelete={() => set({ modeladores: f.modeladores.filter((_, j) => j !== i) })}
            onChange={v => { const arr = [...f.modeladores]; arr[i] = v; set({ modeladores: arr }); }} />
        ))}
        <button style={S.addBtn} onClick={() => set({ modeladores: [...f.modeladores, { nombre:"", empresa: f.empresa_am, email:"", rol:"Modelador BIM" }] })}>
          <Plus size={10} /> Añadir modelador
        </button>
      </div>
      <div style={{ padding: "8px 10px", background: "rgba(91,140,255,0.04)", borderRadius: 5, fontSize: 10, color: "var(--text-muted)", border: "1px solid rgba(91,140,255,0.1)" }}>
        Los datos de <strong>ADIF DACGP</strong> (Miguel Leor, David Ibáñez, Marta Díaz) y la <strong>ATC INECO</strong> (Fernando Gil, Adrián García, Samuel Triana, Victoria Fdez.) se incluyen automáticamente.
      </div>
    </div>
  );
}

function Step3({ f, set }: { f: FormData; set: (patch: Partial<FormData>) => void }) {
  return (
    <div>
      <div style={S.section}>
        <p style={S.sectionTitle}><Calendar size={11} style={{ display: "inline", marginRight: 5 }} />Hitos de entrega BIM</p>
        {f.hitos.map((h, i) => (
          <div key={i} style={{ ...S.card, position: "relative" }}>
            <button style={{ ...S.delBtn, position: "absolute", top: 6, right: 6 }} onClick={() => set({ hitos: f.hitos.filter((_, j) => j !== i) })}>
              <Trash2 size={11} />
            </button>
            <div style={S.row3}>
              <Field label="Hito">
                <Input value={h.hito} onChange={v => { const a=[...f.hitos]; a[i]={...h,hito:v}; set({hitos:a}); }} />
              </Field>
              <Field label="Fecha">
                <Input value={h.fecha} onChange={v => { const a=[...f.hitos]; a[i]={...h,fecha:v}; set({hitos:a}); }} placeholder="DD/MM/YYYY" />
              </Field>
              <Field label="Descripción">
                <Input value={h.descripcion} onChange={v => { const a=[...f.hitos]; a[i]={...h,descripcion:v}; set({hitos:a}); }} />
              </Field>
            </div>
          </div>
        ))}
        <button style={S.addBtn} onClick={() => set({ hitos: [...f.hitos, { hito:"", fecha:"", descripcion:"" }] })}>
          <Plus size={10} /> Añadir hito
        </button>
      </div>
    </div>
  );
}

function Step4({ f, set }: { f: FormData; set: (patch: Partial<FormData>) => void }) {
  const toggleDisciplina = (code: string) => {
    const arr = f.disciplinas.map(d => d.code === code ? { ...d, activa: !d.activa } : d);
    set({ disciplinas: arr });
  };
  const setSoftware = (code: string, sw: string) => {
    const arr = f.disciplinas.map(d => d.code === code ? { ...d, software: sw } : d);
    set({ disciplinas: arr });
  };
  const activasCount = f.disciplinas.filter(d => d.activa).length;

  return (
    <div>
      <div style={S.section}>
        <p style={S.sectionTitle}><Layers size={11} style={{ display: "inline", marginRight: 5 }} />Disciplinas BIM ({activasCount} activas)</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5 }}>
          {f.disciplinas.map(d => (
            <div key={d.code} style={{
              padding: "6px 8px", borderRadius: 5,
              border: `1px solid ${d.activa ? "rgba(91,140,255,0.4)" : "var(--border)"}`,
              background: d.activa ? "rgba(91,140,255,0.06)" : "transparent",
              display: "flex", flexDirection: "column", gap: 3,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <input type="checkbox" checked={d.activa} onChange={() => toggleDisciplina(d.code)}
                  style={{ accentColor: "var(--cyan)", cursor: "pointer" }} />
                <span style={{ fontSize: 10, fontWeight: 700, color: d.activa ? "var(--cyan)" : "var(--text-muted)" }}>{d.code}</span>
                <span style={{ fontSize: 9, color: "var(--text-muted)" }}>{d.nombre}</span>
              </div>
              {d.activa && (
                <select value={d.software} onChange={e => setSoftware(d.code, e.target.value)}
                  style={{ ...S.input, padding: "2px 6px", fontSize: 9 }}>
                  <option value="REVIT">Revit</option>
                  <option value="CIVIL3D">Civil 3D</option>
                  <option value="AMBOS">Ambos</option>
                </select>
              )}
            </div>
          ))}
        </div>
      </div>

      <div style={S.section}>
        <p style={S.sectionTitle}><MapPin size={11} style={{ display: "inline", marginRight: 5 }} />Sistema de coordenadas y punto base</p>
        <div style={S.row3}>
          <Field label="X (Este/Oeste) m">
            <Input value={f.coord_x} onChange={v => set({ coord_x: v })} placeholder="441.232,878" />
          </Field>
          <Field label="Y (Norte/Sur) m">
            <Input value={f.coord_y} onChange={v => set({ coord_y: v })} placeholder="4.473.159,541" />
          </Field>
          <Field label="Z (Altitud) m">
            <Input value={f.coord_z} onChange={v => set({ coord_z: v })} placeholder="622,497" />
          </Field>
        </div>
        <Field label="Sistema de coordenadas">
          <Input value={f.sistema_coordenadas} onChange={v => set({ sistema_coordenadas: v })} placeholder="ETRS89 UTM-30N" />
        </Field>
      </div>

      <div style={S.section}>
        <p style={S.sectionTitle}>Niveles de referencia</p>
        {f.niveles.map((n, i) => (
          <div key={i} style={{ ...S.card, position: "relative" }}>
            <button style={{ ...S.delBtn, position: "absolute", top: 6, right: 6 }} onClick={() => set({ niveles: f.niveles.filter((_,j) => j!==i) })}>
              <Trash2 size={11} />
            </button>
            <div style={S.row3}>
              <Field label="Código"><Input value={n.codigo} onChange={v => { const a=[...f.niveles]; a[i]={...n,codigo:v}; set({niveles:a}); }} placeholder="NSA_+611,00" /></Field>
              <Field label="Elevación"><Input value={n.elevacion} onChange={v => { const a=[...f.niveles]; a[i]={...n,elevacion:v}; set({niveles:a}); }} placeholder="+611,00" /></Field>
              <Field label="Comentario"><Input value={n.comentario} onChange={v => { const a=[...f.niveles]; a[i]={...n,comentario:v}; set({niveles:a}); }} /></Field>
            </div>
          </div>
        ))}
        <button style={S.addBtn} onClick={() => set({ niveles: [...f.niveles, { codigo:"", elevacion:"", comentario:"" }] })}>
          <Plus size={10} /> Añadir nivel
        </button>
      </div>
    </div>
  );
}

function Step5({ f, set }: { f: FormData; set: (patch: Partial<FormData>) => void }) {
  const toggleUso = (codigo: string) => {
    const active = f.usos_activos.includes(codigo);
    set({ usos_activos: active ? f.usos_activos.filter(u => u !== codigo) : [...f.usos_activos, codigo] });
  };

  return (
    <div>
      <div style={S.section}>
        <p style={S.sectionTitle}><BookOpen size={11} style={{ display: "inline", marginRight: 5 }} />Usos de modelo BIM activos</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
          {USOS_ALL.map(u => {
            const active = f.usos_activos.includes(u.codigo);
            return (
              <div key={u.codigo} onClick={() => toggleUso(u.codigo)} style={{
                padding: "7px 10px", borderRadius: 5, cursor: "pointer",
                border: `1px solid ${active ? "rgba(91,140,255,0.4)" : "var(--border)"}`,
                background: active ? "rgba(91,140,255,0.06)" : "transparent",
                display: "flex", alignItems: "center", gap: 8,
              }}>
                <div style={{ width: 12, height: 12, borderRadius: 3,
                  border: `2px solid ${active ? "var(--cyan)" : "var(--border)"}`,
                  background: active ? "var(--cyan)" : "transparent", flexShrink: 0 }} />
                <div>
                  <span style={{ fontSize: 9, fontWeight: 700, color: "var(--text-muted)", marginRight: 5 }}>{u.codigo}</span>
                  <span style={{ fontSize: 10, color: active ? "var(--text)" : "var(--text-muted)" }}>{u.nombre}</span>
                  {u.req && <span style={{ marginLeft: 5, fontSize: 8, color: "var(--cyan)", border: "1px solid rgba(91,140,255,0.3)", borderRadius: 2, padding: "0 3px" }}>ATC*</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Step6({ f, set }: { f: FormData; set: (patch: Partial<FormData>) => void }) {
  return (
    <div>
      <div style={S.section}>
        <p style={S.sectionTitle}><Settings size={11} style={{ display: "inline", marginRight: 5 }} />Software y versiones</p>
        <div style={S.row3}>
          <Field label="Versión Revit">
            <Input value={f.version_revit} onChange={v => set({ version_revit: v })} placeholder="2025.2" />
          </Field>
          <Field label="Versión Navisworks">
            <Input value={f.version_navisworks} onChange={v => set({ version_navisworks: v })} placeholder="2026.2" />
          </Field>
          <Field label="Plataforma CDE">
            <Input value={f.nombre_cde} onChange={v => set({ nombre_cde: v })} placeholder="Autodesk Construction Cloud (ACC)" />
          </Field>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 5 }}>
          <input type="checkbox" id="civil3d" checked={f.usa_civil3d} onChange={e => set({ usa_civil3d: e.target.checked })}
            style={{ accentColor: "var(--cyan)", cursor: "pointer" }} />
          <label htmlFor="civil3d" style={{ fontSize: 11, cursor: "pointer", color: "var(--text)" }}>
            Usar Civil 3D (infraestructura lineal, vía, obra civil)
          </label>
          {f.usa_civil3d && (
            <div style={{ marginLeft: "auto" }}>
              <Input value={f.version_civil3d} onChange={v => set({ version_civil3d: v })} placeholder="2025" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── RESULT PANEL ──────────────────────────────────────────────────────────────

function ResultPanel({ result, onReset }: {
  result: { job_id: string; doc_code: string; tables: number; figures: number; docx_url: string | null; pdf_url: string | null };
  onReset: () => void;
}) {
  const download = (url: string, label: string) => {
    const a = document.createElement("a");
    a.href = `${API}${url}`;
    a.download = label;
    a.click();
  };

  return (
    <div style={{ textAlign: "center", padding: "40px 20px" }}>
      <CheckCircle size={48} color="var(--green)" style={{ margin: "0 auto 16px" }} />
      <h2 style={{ color: "var(--green)", fontSize: 18, fontWeight: 700, marginBottom: 6 }}>PEB generado correctamente</h2>
      <p style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>{result.doc_code}</p>
      <p style={{ color: "var(--text-muted)", fontSize: 10, marginBottom: 24 }}>
        {result.tables} tablas · {result.figures} diagramas
      </p>

      <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
        {result.docx_url && (
          <button onClick={() => download(result.docx_url!, `${result.doc_code}.docx`)}
            style={{ display: "flex", alignItems: "center", gap: 7, padding: "10px 20px",
              background: "rgba(91,140,255,0.1)", border: "1px solid var(--cyan)",
              borderRadius: 6, color: "var(--cyan)", cursor: "pointer", fontSize: 12 }}>
            <Download size={14} /> Descargar DOCX
          </button>
        )}
        {result.pdf_url && (
          <button onClick={() => download(result.pdf_url!, `${result.doc_code}.pdf`)}
            style={{ display: "flex", alignItems: "center", gap: 7, padding: "10px 20px",
              background: "rgba(63,190,138,0.1)", border: "1px solid var(--green)",
              borderRadius: 6, color: "var(--green)", cursor: "pointer", fontSize: 12 }}>
            <Download size={14} /> Descargar PDF
          </button>
        )}
      </div>

      {!result.pdf_url && (
        <p style={{ marginTop: 16, fontSize: 10, color: "var(--text-muted)" }}>
          PDF no disponible (abre el DOCX en Word y guarda como PDF)
        </p>
      )}

      <button onClick={onReset}
        style={{ marginTop: 24, fontSize: 10, color: "var(--text-muted)", background: "transparent",
          border: "1px solid var(--border)", borderRadius: 4, padding: "5px 14px", cursor: "pointer" }}>
        Generar otro PEB
      </button>
    </div>
  );
}

// ── MAIN COMPONENT ────────────────────────────────────────────────────────────

const STEPS = [
  { label: "Proyecto",    icon: Building2 },
  { label: "Equipo",      icon: Users      },
  { label: "Hitos",       icon: Calendar   },
  { label: "Disciplinas", icon: Layers     },
  { label: "Usos BIM",    icon: BookOpen   },
  { label: "Técnico",     icon: Settings   },
];

export default function PEBGeneratorPage() {
  const [step, setStep]       = useState(0);
  const [form, setForm]       = useState<FormData>(DEFAULT_FORM);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [result, setResult]   = useState<any>(null);

  const set = useCallback((patch: Partial<FormData>) => setForm(f => ({ ...f, ...patch })), []);

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/peb/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail ?? "Error desconocido");
      }
      setResult(await res.json());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const stepComponents = [
    <Step1 key={0} f={form} set={set} />,
    <Step2 key={1} f={form} set={set} />,
    <Step3 key={2} f={form} set={set} />,
    <Step4 key={3} f={form} set={set} />,
    <Step5 key={4} f={form} set={set} />,
    <Step6 key={5} f={form} set={set} />,
  ];

  const isLast = step === STEPS.length - 1;

  return (
    <div style={{ padding: "24px 28px", maxWidth: 900, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24 }}>
        <FileText size={20} color="var(--cyan)" />
        <div>
          <h1 style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", margin: 0 }}>
            Generador de PEB — Plan de Ejecución BIM
          </h1>
          <p style={{ fontSize: 10, color: "var(--text-muted)", margin: 0 }}>
            Rellena los campos mínimos y genera un PEB completo listo para entregar a ADIF
          </p>
        </div>
      </div>

      {result ? (
        <ResultPanel result={result} onReset={() => { setResult(null); setStep(0); }} />
      ) : (
        <>
          {/* Step indicator */}
          <div style={{ display: "flex", gap: 0, marginBottom: 20, borderRadius: 6, overflow: "hidden", border: "1px solid var(--border)" }}>
            {STEPS.map((s, i) => {
              const Icon = s.icon;
              const active = i === step;
              const done = i < step;
              return (
                <button key={i} onClick={() => setStep(i)}
                  style={{
                    flex: 1, padding: "8px 4px", display: "flex", flexDirection: "column",
                    alignItems: "center", gap: 3, cursor: "pointer",
                    background: active ? "rgba(91,140,255,0.1)" : done ? "rgba(91,140,255,0.04)" : "var(--surface)",
                    border: "none", borderRight: i < STEPS.length - 1 ? "1px solid var(--border)" : "none",
                    borderBottom: active ? "2px solid var(--cyan)" : "2px solid transparent",
                  }}>
                  <Icon size={13} color={active ? "var(--cyan)" : done ? "rgba(91,140,255,0.5)" : "var(--text-muted)"} />
                  <span style={{ fontSize: 8, color: active ? "var(--cyan)" : "var(--text-muted)",
                    fontWeight: active ? 700 : 400, letterSpacing: "0.05em", textTransform: "uppercase" as const }}>
                    {s.label}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Step content */}
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: 20, marginBottom: 16 }}>
            {stepComponents[step]}
          </div>

          {/* Error */}
          {error && (
            <div style={{ padding: "8px 12px", background: "rgba(255,50,50,0.1)", border: "1px solid var(--red)",
              borderRadius: 5, fontSize: 11, color: "var(--red)", marginBottom: 12 }}>
              {error}
            </div>
          )}

          {/* Navigation */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <button onClick={() => setStep(s => Math.max(0, s - 1))} disabled={step === 0}
              style={{ display: "flex", alignItems: "center", gap: 5, padding: "8px 16px",
                background: "transparent", border: "1px solid var(--border)", borderRadius: 5,
                color: step === 0 ? "var(--text-muted)" : "var(--text)", cursor: step === 0 ? "not-allowed" : "pointer",
                fontSize: 11, opacity: step === 0 ? 0.4 : 1 }}>
              <ChevronLeft size={13} /> Anterior
            </button>

            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{step + 1} / {STEPS.length}</span>

            {isLast ? (
              <button onClick={generate} disabled={loading}
                style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 20px",
                  background: loading ? "rgba(91,140,255,0.05)" : "rgba(91,140,255,0.15)",
                  border: "1px solid var(--cyan)", borderRadius: 5, color: "var(--cyan)",
                  cursor: loading ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 700 }}>
                {loading ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
                {loading ? "Generando PEB…" : "Generar PEB"}
              </button>
            ) : (
              <button onClick={() => setStep(s => Math.min(STEPS.length - 1, s + 1))}
                style={{ display: "flex", alignItems: "center", gap: 5, padding: "8px 16px",
                  background: "rgba(91,140,255,0.08)", border: "1px solid rgba(91,140,255,0.3)",
                  borderRadius: 5, color: "var(--cyan)", cursor: "pointer", fontSize: 11 }}>
                Siguiente <ChevronRight size={13} />
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
