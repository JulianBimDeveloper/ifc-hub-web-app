"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getPB } from "@/lib/pb";
import { API_URL } from "@/lib/api";
import { MIDP_ETAPA_ACTIVA } from "@/lib/constants";
import { Search, RefreshCw, X, CheckCircle2, FolderSearch, BookMarked, Trash2, Download, Pencil } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface MidpMapping {
  id: string;
  ifc_name: string;
  native_name: string;
  etapa?: string;
}

// Resultado del scan inteligente (backend /export-control/scan)
interface ScanWinner {
  folder_name: string;
  date: string | null;   // ISO "YYYY-MM-DD" de la copia más reciente
  tag: string | null;    // RVT / DWG / … (solo informativo)
  path: string;          // ruta absoluta del fichero a subir al ACC
  mtime: number;
  source: string;        // "dated" | "flat"
}
interface ScanFileEntry {
  ifc_name: string;
  winner: ScanWinner;
  older: { folder_name: string; date: string | null; path: string; mtime: number }[];
  copies: number;
}
interface ScanResult {
  files: Record<string, ScanFileEntry>;   // clave = ifc_name en minúsculas
  per_folder: { folder: string; mode: string; dated_count: number; ignored_subfolders: string[]; warning: string | null }[];
  ignored_folders: { folder: string; name: string }[];
  warnings: string[];
  total_unique: number;
  total_occurrences: number;
  scanned_at: string;
}

interface IFCDelivery {
  id: string;
  name: string;
  target_date: string;
  scope_prefixes: string[];
  manual_statuses: Record<string, ManualStatus>;
  total: number;
  listos: number;
  en_proceso: number;
  encontrados: number;
  faltan: number;
  pct: number;
  notes: string;
  folder_paths?: string[];
  created: string;
  updated: string;
}

type ManualStatus = "listo" | "en_proceso";
type DisplayStatus = "listo" | "en_proceso" | "encontrado" | "falta";
type FilterTab = "todos" | "listo" | "en_proceso" | "encontrado" | "falta";

// ── Status config ─────────────────────────────────────────────────────────────

const ST: Record<DisplayStatus, { label: string; color: string; bg: string; border: string; icon: string }> = {
  listo:      { label: "LISTO",      color: "#3FBE8A", bg: "rgba(63,190,138,0.08)",  border: "rgba(63,190,138,0.28)",  icon: "✓" },
  en_proceso: { label: "EN PROCESO", color: "#D9A441", bg: "rgba(217,164,65,0.08)",  border: "rgba(217,164,65,0.28)",  icon: "⟳" },
  encontrado: { label: "EN CARPETA", color: "#5B8CFF", bg: "rgba(91,140,255,0.08)",  border: "rgba(91,140,255,0.28)",  icon: "📁" },
  falta:      { label: "FALTA",      color: "#ff4466", bg: "rgba(255,68,102,0.05)", border: "rgba(255,68,102,0.22)", icon: "✗" },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function detectSoftware(nativeName: string): "revit" | "civil3d" | "other" {
  const lower = nativeName.toLowerCase();
  if (lower.endsWith(".rvt")) return "revit";
  if (lower.endsWith(".dwg")) return "civil3d";
  return "other";
}

// Extrae el prefijo de tipo (MAM / MAD / MNU / …) del nombre IFC
// Formato: "…-442_MAM_ARQUITECTURA" → "MAM"
function extractPrefix(ifcName: string): string | null {
  const m = ifcName.match(/_([A-Z]{3})_/);
  return m ? m[1] : null;
}

// Colores por prefijo conocido; los desconocidos usan amarillo
const PREFIX_COLOR: Record<string, string> = {
  MAM: "#5B8CFF",
  MAD: "#7A6FD9",
  MNU: "#3FBE8A",
};
function prefixColor(p: string) { return PREFIX_COLOR[p] ?? "#D9A441"; }

// localStorage scope
const LS_SCOPE_KEY = "ifc-export-scope";
function loadScope(): string[] | null {
  try { const r = localStorage.getItem(LS_SCOPE_KEY); return r ? JSON.parse(r) : null; }
  catch { return null; }
}
function saveScope(p: string[]) { localStorage.setItem(LS_SCOPE_KEY, JSON.stringify(p)); }

// Orden en el Plan de Entrega: lo que NO está en carpeta arriba; dentro de cada
// grupo, fecha más reciente arriba. "encontrado" (en carpeta) queda al final.
const STATUS_RANK: Record<DisplayStatus, number> = {
  falta: 0, en_proceso: 1, listo: 2, encontrado: 3,
};

function getDisplayStatus(manual: ManualStatus | undefined, found: boolean): DisplayStatus {
  if (manual === "listo") return "listo";
  if (manual === "en_proceso") return "en_proceso";
  if (found) return "encontrado";
  return "falta";
}

function nextManual(current: ManualStatus | undefined): ManualStatus | undefined {
  if (!current) return "en_proceso";
  if (current === "en_proceso") return "listo";
  return undefined;
}

// Llama al scan inteligente del backend (dedup por fecha de carpeta / mtime)
async function fetchScan(folders: string[]): Promise<ScanResult | null> {
  try {
    const res = await fetch(`${API_URL}/api/ifc/export-control/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folders }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return null;
    return await res.json() as ScanResult;
  } catch {
    return null;
  }
}

// "2026-06-12" → "12/06/26"  (compacto para la fila)
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y.slice(2)}`;
}

// ── localStorage ──────────────────────────────────────────────────────────────

const LS_KEY = "ifc-export-manual-status";

function loadManualStatuses(): Record<string, ManualStatus> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveManualStatuses(s: Record<string, ManualStatus>) {
  localStorage.setItem(LS_KEY, JSON.stringify(s));
}

// ── PocketBase ────────────────────────────────────────────────────────────────

function useMidpMappings() {
  return useQuery<MidpMapping[]>({
    queryKey: ["midp_mapping", MIDP_ETAPA_ACTIVA],
    queryFn: () => getPB().collection("midp_mapping").getFullList<MidpMapping>({
      filter: `etapa="${MIDP_ETAPA_ACTIVA}"`, requestKey: null,
    }),
    staleTime: 60_000,
    retry: 2,
  });
}

function useDeliveries() {
  return useQuery<IFCDelivery[]>({
    queryKey: ["ifc_deliveries"],
    queryFn: () => getPB().collection("ifc_deliveries").getFullList<IFCDelivery>({
      sort: "target_date,name", requestKey: null,
    }),
    staleTime: 30_000,
    retry: 1,
  });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatChip({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
      <span style={{ fontSize: 19, fontWeight: 700, color, lineHeight: 1,
        fontFamily: "JetBrains Mono, monospace", textShadow: `0 0 8px ${color}44` }}>
        {value}
      </span>
      <span style={{ fontSize: 8, color: "var(--border-bright)",
        fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.08em" }}>
        {label}
      </span>
    </div>
  );
}

function MiniKpi({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
      <span style={{ fontSize: 16, fontWeight: 700, color, fontFamily: "JetBrains Mono, monospace",
        textShadow: `0 0 6px ${color}44`, lineHeight: 1 }}>{value}</span>
      <span style={{ fontSize: 9, color: "var(--border-bright)", fontFamily: "JetBrains Mono, monospace" }}>
        {label}
      </span>
    </div>
  );
}

function ProgressRing({ pct, size = 90 }: { pct: number; size?: number }) {
  const color = pct >= 80 ? "#3FBE8A" : pct >= 40 ? "#D9A441" : "#ff4466";
  const inner = Math.round(size * 0.72);
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", flexShrink: 0,
      background: `conic-gradient(${color} ${pct}%, rgba(30,45,74,0.5) ${pct}%)`,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{
        width: inner, height: inner, borderRadius: "50%", background: "var(--surface)",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1,
      }}>
        <span style={{ fontSize: Math.round(size * 0.22), fontWeight: 700, color, lineHeight: 1,
          textShadow: `0 0 8px ${color}88` }}>{pct}%</span>
        <span style={{ fontSize: 7, color: "var(--border-bright)" }}>ENTREGADO</span>
      </div>
    </div>
  );
}

function CompactSection({ title, items, color, emptyLabel = "Sin datos" }:
  { title: string; items: string[]; color: string; emptyLabel?: string }) {
  return (
    <div style={{
      background: "var(--surface)", border: `1px solid ${color}33`, borderRadius: 6, overflow: "hidden",
    }}>
      <div style={{
        padding: "6px 12px", borderBottom: `1px solid ${color}22`,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, color, textTransform: "uppercase",
          letterSpacing: "0.07em" }}>{title}</span>
        <span style={{
          fontSize: 10, background: `${color}20`, color, borderRadius: 9999,
          padding: "1px 8px", fontWeight: 700,
        }}>{items.length}</span>
      </div>
      <div style={{ padding: "6px 12px", display: "flex", flexDirection: "column", gap: 3 }}>
        {items.length === 0 ? (
          <span style={{ color: "var(--dim)", fontSize: 11, fontStyle: "italic" }}>{emptyLabel}</span>
        ) : items.map(f => (
          <span key={f} style={{
            fontSize: 11, color: "var(--text)", fontFamily: "JetBrains Mono, monospace",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }} title={f}>{f.replace(/\.ifc$/i, "")}</span>
        ))}
      </div>
    </div>
  );
}

// ── Toggle control (3-state) ──────────────────────────────────────────────────

function StatusToggle({ status, onClick }: { status: DisplayStatus; onClick: () => void }) {
  const sc = ST[status];
  const hints: Record<DisplayStatus, string> = {
    listo: "Haz clic para quitar — vuelve a estado auto",
    en_proceso: "Haz clic para marcar como LISTO",
    encontrado: "Haz clic para marcar EN PROCESO",
    falta: "Haz clic para marcar EN PROCESO",
  };
  return (
    <button
      onClick={onClick}
      title={hints[status]}
      style={{
        fontSize: 7.5, fontWeight: 700, padding: "2px 6px", borderRadius: 3, cursor: "pointer",
        fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.05em",
        background: sc.bg, color: sc.color, border: `1px solid ${sc.border}`,
        flexShrink: 0, whiteSpace: "nowrap", transition: "all 0.15s",
        minWidth: 60, textAlign: "center",
      }}>
      {sc.icon} {sc.label}
    </button>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function ExportControlPage() {
  const [folderInput, setFolderInput] = useState("");
  const [folders, setFolders]         = useState<string[]>([]);
  const [scanning, setScanning]       = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [scan, setScan]               = useState<ScanResult | null>(null);
  const [scannedAt, setScannedAt]     = useState<string | null>(null);
  const [removedModels, setRemovedModels] = useState<string[]>([]);
  const autoRefreshRef = useRef<NodeJS.Timeout | null>(null);

  const [manualStatuses, setManualStatuses] = useState<Record<string, ManualStatus>>({});
  const [search, setSearch]       = useState("");
  const [filterTab, setFilterTab] = useState<FilterTab>("todos");
  const [selectedPrefixes, setSelectedPrefixes] = useState<Set<string>>(new Set());

  // Delivery save form
  const [saveOpen, setSaveOpen]           = useState(false);
  const [saveName, setSaveName]           = useState("");
  const [saveDate, setSaveDate]           = useState("");
  const [saveNotes, setSaveNotes]         = useState("");
  const [saving, setSaving]               = useState(false);
  const [loadedId, setLoadedId]           = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editingNameId, setEditingNameId]     = useState<string | null>(null);
  const [editingNameValue, setEditingNameValue] = useState("");

  const { data: mappings, isLoading: loadingPB, error: pbError } = useMidpMappings();
  const { data: deliveries = [], refetch: refetchDeliveries }     = useDeliveries();
  const qc = useQueryClient();

  useEffect(() => { setManualStatuses(loadManualStatuses()); }, []);

  // Cuando llegan los mappings: detectar todos los prefijos y restaurar scope guardado
  useEffect(() => {
    if (!mappings?.length) return;
    const all = Array.from(new Set(mappings.map(m => extractPrefix(m.ifc_name)).filter(Boolean) as string[])).sort();
    const saved = loadScope();
    // Si hay scope guardado y todos sus prefijos siguen existiendo, restaurarlo; si no, seleccionar todo
    const valid = saved?.filter(p => all.includes(p));
    setSelectedPrefixes(new Set(valid?.length ? valid : all));
  }, [mappings]);

  // ── Scan ─────────────────────────────────────────────────────────────────

  const runScan = useCallback(async (folderList: string[]) => {
    if (folderList.length === 0) return;
    setScanning(true);
    const result = await fetchScan(folderList);
    if (result) {
      setScan(result);
      setScannedAt(new Date().toLocaleTimeString("es-ES"));
    }
    setScanning(false);
  }, []);

  useEffect(() => {
    if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
    if (autoRefresh && folders.length > 0) {
      autoRefreshRef.current = setInterval(() => runScan(folders), 5000);
    }
    return () => { if (autoRefreshRef.current) clearInterval(autoRefreshRef.current); };
  }, [autoRefresh, folders, runScan]);

  function addFolder() {
    const val = folderInput.trim();
    if (!val || folders.includes(val)) return;
    setFolders(prev => [...prev, val]);
    setFolderInput("");
  }

  async function pickFolder() {
    try {
      const res = await fetch(`${API_URL}/api/ifc/folder-picker`);
      if (!res.ok) return;
      const { path } = await res.json() as { path: string };
      if (path && !folders.includes(path)) setFolders(prev => [...prev, path]);
    } catch { /* native dialog cancelled */ }
  }

  function removeFolder(folder: string) {
    setFolders(prev => prev.filter(f => f !== folder));
  }

  // ── Exports ───────────────────────────────────────────────────────────────

  function exportToCSV() {
    const scopeLabel = selectedPrefixes.size === allPrefixes.length
      ? "TODOS" : Array.from(selectedPrefixes).join("+");
    const date = new Date().toISOString().slice(0, 10);

    const header = ["PREFIJO", "SOFTWARE", "NOMBRE IFC", "ESTADO", "EN CARPETA"];
    const rows = inScope.map(m => [
      m.prefix ?? "",
      m.sw.toUpperCase(),
      m.ifc_name.replace(/\.ifc$/i, ""),
      { listo: "LISTO", en_proceso: "EN PROCESO", encontrado: "EN CARPETA", falta: "FALTA" }[m.status],
      m.found ? "SÍ" : "NO",
    ]);
    const summary = [
      [], ["RESUMEN", "", "", "", ""],
      ["Scope:", scopeLabel], ["Total IFCs:", total], ["Listos:", listoCount],
      ["En proceso:", enProcCount], ["En carpeta:", encontCount],
      ["Faltan:", faltaCount], ["% entregado:", `${pctGlobal}%`],
    ];

    const csv = [header, ...rows, ...summary]
      .map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(","))
      .join("\r\n");

    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement("a"), { href: url, download: `informe-entrega-${scopeLabel}-${date}.csv` });
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  // Lista lista-para-subir-al-ACC: modelos encontrados con su copia más reciente,
  // ordenados de la fecha más reciente hacia atrás.
  function exportACCList() {
    const scopeLabel = selectedPrefixes.size === allPrefixes.length
      ? "TODOS" : Array.from(selectedPrefixes).join("+");
    const date = new Date().toISOString().slice(0, 10);

    const rows = inScope
      .filter(m => m.found && m.winner)
      .sort((a, b) => (b.winner?.date ?? "").localeCompare(a.winner?.date ?? ""))
      .map(m => [
        m.winner?.date ?? "",
        m.ifc_name.replace(/\.ifc$/i, ""),
        m.sw === "revit" ? "RVT" : m.sw === "civil3d" ? "C3D" : "?",
        m.winner?.folder_name ?? "",
        String(m.copies),
        m.winner?.path ?? "",
        { listo: "LISTO", en_proceso: "EN PROCESO", encontrado: "EN CARPETA", falta: "FALTA" }[m.status],
      ]);

    const header = ["FECHA EXPORT", "MODELO IFC", "SW", "CARPETA ORIGEN", "VERSIONES", "RUTA FICHERO", "ESTADO"];
    const csv = [header, ...rows]
      .map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(","))
      .join("\r\n");

    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement("a"), { href: url, download: `lista-ACC-${scopeLabel}-${date}.csv` });
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  function exportToPDF() {
    const scopeLabel = selectedPrefixes.size === allPrefixes.length
      ? "TODOS" : Array.from(selectedPrefixes).join(", ");
    const date = new Date().toLocaleDateString("es-ES");

    const stColors: Record<DisplayStatus, string> = {
      listo: "#007744", en_proceso: "#cc8800", encontrado: "#0088cc", falta: "#cc2244"
    };
    const stLabels: Record<DisplayStatus, string> = {
      listo: "LISTO", en_proceso: "EN PROCESO", encontrado: "EN CARPETA", falta: "FALTA"
    };

    const rowsHtml = inScope.map(m => `
      <tr>
        <td style="color:${m.prefix === "MAM" ? "#005588" : m.prefix === "MAD" ? "#880055" : "#005533"};font-weight:bold">${m.prefix ?? "-"}</td>
        <td style="color:${m.sw === "revit" ? "#006688" : "#886600"};font-weight:bold">${m.sw === "revit" ? "RVT" : "C3D"}</td>
        <td style="font-size:9px;font-family:monospace">${m.ifc_name.replace(/\.ifc$/i, "")}</td>
        <td style="color:${stColors[m.status]};font-weight:bold">${stLabels[m.status]}</td>
        <td style="text-align:center">${m.found ? "✓" : "—"}</td>
      </tr>`).join("");

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Informe Entrega IFC — ${scopeLabel} — ${date}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 11px; color: #111; padding: 24px; }
  h1  { font-size: 18px; margin-bottom: 4px; }
  .sub { color: #555; margin-bottom: 16px; }
  .kpis { display: flex; gap: 12px; margin-bottom: 16px; }
  .kpi  { border: 1px solid #ccc; border-radius: 6px; padding: 10px 16px; text-align: center; flex: 1; }
  .kpi .val { font-size: 26px; font-weight: 700; line-height: 1; }
  .kpi .lbl { font-size: 9px; text-transform: uppercase; color: #666; margin-top: 3px; }
  .progress { background: #eee; border-radius: 4px; height: 8px; margin-bottom: 16px; }
  .progress-bar { background: ${pctGlobal >= 80 ? "#00aa55" : pctGlobal >= 40 ? "#cc8800" : "#cc2244"}; height: 8px; border-radius: 4px; width: ${pctGlobal}%; }
  .pct-label { text-align: right; font-size: 13px; font-weight: 700; color: ${pctGlobal >= 80 ? "#00aa55" : pctGlobal >= 40 ? "#cc8800" : "#cc2244"}; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #222; color: #fff; padding: 5px 8px; text-align: left; font-size: 10px; text-transform: uppercase; }
  td { padding: 3px 8px; border-bottom: 1px solid #eee; font-size: 10px; }
  tr:nth-child(even) { background: #f8f8f8; }
  .no-print { margin-bottom: 16px; }
  @media print { .no-print { display:none; } body { padding: 10px; } }
</style></head><body>
<div class="no-print">
  <button onclick="window.print()" style="padding:8px 20px;font-size:13px;cursor:pointer;background:#222;color:#fff;border:none;border-radius:4px">
    🖨 Imprimir / Guardar PDF
  </button>
</div>
<h1>Informe de Estado de Entrega IFC</h1>
<p class="sub">Fecha: <b>${date}</b> &nbsp;·&nbsp; Scope: <b>${scopeLabel}</b> &nbsp;·&nbsp; <b>${total}</b> IFCs en scope</p>
<div class="kpis">
  <div class="kpi"><div class="val" style="color:#007744">${listoCount}</div><div class="lbl">Listos</div></div>
  <div class="kpi"><div class="val" style="color:#cc8800">${enProcCount}</div><div class="lbl">En proceso</div></div>
  <div class="kpi"><div class="val" style="color:#0088cc">${encontCount}</div><div class="lbl">En carpeta</div></div>
  <div class="kpi"><div class="val" style="color:#cc2244">${faltaCount}</div><div class="lbl">Faltan</div></div>
</div>
<div class="progress"><div class="progress-bar"></div></div>
<div class="pct-label">${pctGlobal}% entregado (${listoCount + encontCount} / ${total})</div>
<table>
  <thead><tr><th>Prefijo</th><th>SW</th><th>Nombre IFC</th><th>Estado</th><th>En carpeta</th></tr></thead>
  <tbody>${rowsHtml}</tbody>
</table>
</body></html>`;

    const w = window.open("", "_blank", "width=1100,height=800");
    if (w) { w.document.write(html); w.document.close(); }
  }

  // ── Manual status ─────────────────────────────────────────────────────────

  function toggleManual(ifcName: string) {
    setManualStatuses(prev => {
      const next = { ...prev };
      const nxt = nextManual(prev[ifcName]);
      if (nxt === undefined) delete next[ifcName];
      else next[ifcName] = nxt;
      saveManualStatuses(next);
      return next;
    });
  }

  function bulkSetListo(names: string[]) {
    setManualStatuses(prev => {
      const next = { ...prev };
      for (const n of names) next[n] = "listo";
      saveManualStatuses(next);
      return next;
    });
  }

  function clearAllManual() {
    setManualStatuses({});
    saveManualStatuses({});
  }

  // ── Deliveries CRUD ───────────────────────────────────────────────────────

  async function saveDelivery() {
    if (!saveName.trim()) return;
    setSaving(true);
    try {
      const payload = {
        name:             saveName.trim(),
        target_date:      saveDate,
        scope_prefixes:   Array.from(selectedPrefixes),
        manual_statuses:  manualStatuses,
        total, listos: listoCount, en_proceso: enProcCount,
        encontrados: encontCount, faltan: faltaCount, pct: pctGlobal,
        notes: saveNotes.trim(),
        folder_paths:     folders,
      };
      // Update existing if loadedId matches name exactly; otherwise create new
      const existing = deliveries.find(d => d.id === loadedId);
      if (existing) {
        await getPB().collection("ifc_deliveries").update(existing.id, payload);
        setLoadedId(existing.id);
      } else {
        const rec = await getPB().collection("ifc_deliveries").create(payload);
        setLoadedId(rec.id);
      }
      qc.invalidateQueries({ queryKey: ["ifc_deliveries"] });
      setSaveOpen(false);
    } finally {
      setSaving(false);
    }
  }

  function loadDelivery(d: IFCDelivery) {
    const prefixes = Array.isArray(d.scope_prefixes) ? d.scope_prefixes : [];
    const statuses = d.manual_statuses && typeof d.manual_statuses === "object" ? d.manual_statuses : {};
    setSelectedPrefixes(new Set(prefixes));
    saveScope(prefixes);
    setManualStatuses(statuses as Record<string, ManualStatus>);
    saveManualStatuses(statuses as Record<string, ManualStatus>);
    setLoadedId(d.id);
    setSaveName(d.name);
    setSaveDate(d.target_date ?? "");
    setSaveNotes(d.notes ?? "");
    if (Array.isArray(d.folder_paths) && d.folder_paths.length > 0) {
      setFolders(d.folder_paths);
    }
    // Diff inteligente: modelos con estado manual que YA NO existen en midp_mapping
    const currentNames = new Set((mappings ?? []).map(m => m.ifc_name));
    const removed = Object.keys(statuses).filter(n => !currentNames.has(n));
    setRemovedModels(removed);
  }

  // Purga los modelos eliminados (ya no en midp_mapping) del estado manual
  function purgeRemovedModels() {
    setManualStatuses(prev => {
      const next = { ...prev };
      for (const n of removedModels) delete next[n];
      saveManualStatuses(next);
      return next;
    });
    setRemovedModels([]);
  }

  async function renameDelivery(id: string, newName: string) {
    if (!newName.trim()) { setEditingNameId(null); return; }
    try {
      await getPB().collection("ifc_deliveries").update(id, { name: newName.trim() });
      qc.invalidateQueries({ queryKey: ["ifc_deliveries"] });
      if (loadedId === id) setSaveName(newName.trim());
    } finally {
      setEditingNameId(null);
    }
  }

  async function deleteDelivery(id: string) {
    await getPB().collection("ifc_deliveries").delete(id);
    qc.invalidateQueries({ queryKey: ["ifc_deliveries"] });
    if (loadedId === id) { setLoadedId(null); setSaveName(""); setSaveDate(""); setSaveNotes(""); }
    setConfirmDeleteId(null);
  }

  function openSaveForm() {
    const current = deliveries.find(d => d.id === loadedId);
    setSaveName(current?.name ?? "");
    setSaveDate(current?.target_date ?? "");
    setSaveNotes(current?.notes ?? "");
    setSaveOpen(true);
  }

  // ── Derived data ──────────────────────────────────────────────────────────

  const hasScan = scannedAt !== null;

  // Todos los prefijos detectados en PB (para el selector)
  const allPrefixes = Array.from(
    new Set((mappings ?? []).map(m => extractPrefix(m.ifc_name)).filter(Boolean) as string[])
  ).sort();

  const scanFiles = scan?.files ?? {};
  const enriched = (mappings ?? []).map(m => {
    const nameNorm  = m.ifc_name.toLowerCase();
    const nameNoExt = nameNorm.replace(/\.ifc$/, "");
    const hit       = scanFiles[nameNorm] ?? scanFiles[nameNoExt + ".ifc"];
    const found     = !!hit;
    const manual    = manualStatuses[m.ifc_name];
    const prefix    = extractPrefix(m.ifc_name);
    return {
      ...m,
      sw:     detectSoftware(m.native_name ?? ""),
      found,
      manual,
      status: getDisplayStatus(manual, found),
      prefix,
      winner:    hit?.winner ?? null,
      copies:    hit?.copies ?? 0,
    };
  });

  // Orphans: ficheros encontrados que NO están en el plan (midp_mapping)
  const mappingNamesLower = new Set((mappings ?? []).map(m => m.ifc_name.toLowerCase()));
  const orphans = Object.values(scanFiles)
    .filter(f => !mappingNamesLower.has(f.ifc_name.toLowerCase()))
    .map(f => f.ifc_name)
    .sort();

  // Scope = enriched filtrado por prefijos seleccionados
  const inScope = enriched.filter(m =>
    !m.prefix || selectedPrefixes.size === 0 || selectedPrefixes.has(m.prefix)
  );

  const filtered = inScope.filter(m => {
    const matchSearch = !search || m.ifc_name.toLowerCase().includes(search.toLowerCase());
    const matchTab = filterTab === "todos" || m.status === filterTab;
    return matchSearch && matchTab;
  }).sort((a, b) => {
    // 1) por estado: faltas / en proceso / listos arriba; en carpeta al final
    const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (r !== 0) return r;
    // 2) dentro del mismo estado: fecha de la copia más reciente arriba
    const da = a.winner?.date ?? "";
    const db = b.winner?.date ?? "";
    if (da !== db) return db.localeCompare(da);
    // 3) desempate estable por nombre
    return a.ifc_name.localeCompare(b.ifc_name);
  });

  // KPIs sobre el scope activo
  const total         = inScope.length;
  const listoCount    = inScope.filter(m => m.status === "listo").length;
  const enProcCount   = inScope.filter(m => m.status === "en_proceso").length;
  const encontCount   = inScope.filter(m => m.status === "encontrado").length;
  const faltaCount    = inScope.filter(m => m.status === "falta").length;
  const pctGlobal     = total > 0 ? Math.round(((listoCount + encontCount) / total) * 100) : 0;

  // Listas de scan sobre el scope activo
  const rvtExported = inScope.filter(m => m.sw === "revit"   &&  m.found).map(m => m.ifc_name);
  const rvtPending  = inScope.filter(m => m.sw === "revit"   && !m.found && m.status !== "listo").map(m => m.ifc_name);
  const dwgExported = inScope.filter(m => m.sw === "civil3d" &&  m.found).map(m => m.ifc_name);
  const dwgPending  = inScope.filter(m => m.sw === "civil3d" && !m.found && m.status !== "listo").map(m => m.ifc_name);

  const tabCounts: Record<FilterTab, number> = {
    todos: total, listo: listoCount, en_proceso: enProcCount,
    encontrado: encontCount, falta: faltaCount,
  };
  const tabLabels: Record<FilterTab, string> = {
    todos: "TODOS", listo: "LISTO", en_proceso: "EN PROCESO",
    encontrado: "EN CARPETA", falta: "FALTA",
  };
  const tabColors: Record<FilterTab, string> = {
    todos: "rgba(150,175,200,0.65)", listo: "#3FBE8A", en_proceso: "#D9A441",
    encontrado: "#5B8CFF", falta: "#ff4466",
  };

  const encontradosNames = inScope.filter(m => m.status === "encontrado").map(m => m.ifc_name);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>

      {/* ── Header ── */}
      <div style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--cyan)", letterSpacing: "0.06em" }}>
          EXPORT CONTROL
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
          Plan de entrega de IFCs — verificación automática contra carpetas de exportación
        </p>
      </div>

      {pbError && (
        <div style={{ background: "rgba(255,51,85,0.08)", border: "1px solid rgba(255,51,85,0.35)",
          borderRadius: 6, padding: "8px 14px", marginBottom: 12, fontSize: 12, color: "var(--red)" }}>
          ✗ No se pudo conectar con PocketBase
        </div>
      )}

      {/* Aviso: modelos de la entrega cargada que ya NO están en midp_mapping */}
      {removedModels.length > 0 && (
        <div style={{ background: "rgba(217,164,65,0.07)", border: "1px solid rgba(217,164,65,0.35)",
          borderRadius: 6, padding: "8px 14px", marginBottom: 12, fontSize: 12,
          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ color: "#D9A441", fontWeight: 700 }}>
            ⚠ {removedModels.length} modelo{removedModels.length > 1 ? "s" : ""} de esta entrega ya no exist{removedModels.length > 1 ? "en" : "e"} en midp_mapping
          </span>
          <span title={removedModels.join("\n")} style={{ color: "rgba(150,175,200,0.6)",
            fontFamily: "JetBrains Mono, monospace", fontSize: 10, flex: 1,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {removedModels.map(n => n.replace(/\.ifc$/i, "")).join(", ")}
          </span>
          <button onClick={purgeRemovedModels}
            style={{ fontSize: 10, fontWeight: 700, padding: "3px 10px", borderRadius: 3, cursor: "pointer",
              background: "rgba(217,164,65,0.14)", border: "1px solid rgba(217,164,65,0.4)", color: "#D9A441",
              flexShrink: 0 }}>
            Limpiar obsoletos
          </button>
        </div>
      )}

      {/* ── KPI Bar ── */}
      <div className="card-cyber" style={{ padding: "9px 16px", marginBottom: 12,
        display: "flex", alignItems: "center", gap: 20 }}>
        <StatChip label="TOTAL"      value={total}       color="rgba(150,175,200,0.7)" />
        <div style={{ width: 1, height: 28, background: "var(--border)" }} />
        <StatChip label="LISTO"      value={listoCount}  color="#3FBE8A" />
        <StatChip label="EN PROCESO" value={enProcCount} color="#D9A441" />
        <StatChip label="EN CARPETA" value={encontCount} color="#5B8CFF" />
        <StatChip label="FALTA"      value={faltaCount}  color="#ff4466" />
        <div style={{ flex: 1 }} />
        {/* Progress bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 130, height: 5, borderRadius: 3, background: "var(--border)", overflow: "hidden" }}>
            <div style={{
              height: "100%", borderRadius: 3, width: `${pctGlobal}%`,
              background: pctGlobal >= 80 ? "#3FBE8A" : pctGlobal >= 40 ? "#D9A441" : "#ff4466",
              transition: "width 0.5s ease",
            }} />
          </div>
          <span style={{ fontSize: 13, fontWeight: 700, fontFamily: "JetBrains Mono, monospace",
            color: pctGlobal >= 80 ? "#3FBE8A" : pctGlobal >= 40 ? "#D9A441" : "#ff4466",
            textShadow: pctGlobal >= 80 ? "0 0 8px #3FBE8A55" : "none" }}>
            {pctGlobal}%
          </span>
        </div>
      </div>

      {/* ── Two-column main layout ── */}
      <div style={{ display: "grid", gridTemplateColumns: "460px 1fr", gap: 12 }}>

        {/* ══ LEFT: Plan de Entrega (vertical list) ══ */}
        <div className="card-cyber" style={{
          overflow: "hidden", display: "flex", flexDirection: "column",
          maxHeight: "calc(100vh - 220px)", minHeight: 400,
        }}>

          {/* Panel header */}
          <div style={{ padding: "10px 14px 8px", borderBottom: "1px solid var(--border)",
            display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)",
              textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Plan de Entrega
            </span>
            <span style={{ fontSize: 10, color: "var(--dim)", fontFamily: "JetBrains Mono" }}>
              {total} IFCs
            </span>
            <div style={{ flex: 1 }} />

            {/* Bulk: mark found-in-folder as listo */}
            {encontradosNames.length > 0 && (
              <button
                onClick={() => bulkSetListo(encontradosNames)}
                style={{
                  fontSize: 8.5, fontWeight: 700, padding: "2px 9px", borderRadius: 3, cursor: "pointer",
                  fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.05em",
                  background: "rgba(63,190,138,0.08)", border: "1px solid rgba(63,190,138,0.28)", color: "#3FBE8A",
                }}>
                <CheckCircle2 size={10} style={{ display: "inline", marginRight: 4 }} />
                CONFIRMAR EN CARPETA ({encontradosNames.length})
              </button>
            )}

            {/* Clear manual */}
            {Object.keys(manualStatuses).length > 0 && (
              <button
                onClick={clearAllManual}
                style={{
                  fontSize: 8.5, fontWeight: 700, padding: "2px 9px", borderRadius: 3, cursor: "pointer",
                  fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.05em",
                  background: "rgba(255,68,102,0.07)", border: "1px solid rgba(255,68,102,0.25)", color: "#ff4466",
                }}>
                ✕ Reset manual
              </button>
            )}
          </div>

          {/* ── Selector de scope (prefijos detectados en PB) ── */}
          {allPrefixes.length > 0 && (
            <div style={{
              padding: "7px 14px 6px", borderBottom: "1px solid var(--border)",
              display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
            }}>
              <span style={{ fontSize: 8.5, color: "var(--border-bright)",
                fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.08em", flexShrink: 0 }}>
                SCOPE
              </span>
              {allPrefixes.map(prefix => {
                const c = prefixColor(prefix);
                const active = selectedPrefixes.has(prefix);
                const cnt = enriched.filter(m => m.prefix === prefix).length;
                return (
                  <button
                    key={prefix}
                    onClick={() => {
                      setSelectedPrefixes(prev => {
                        const next = new Set(prev);
                        if (next.has(prefix)) { if (next.size > 1) next.delete(prefix); }
                        else next.add(prefix);
                        saveScope(Array.from(next));
                        return next;
                      });
                    }}
                    style={{
                      fontSize: 9, fontWeight: 700, padding: "2px 10px", borderRadius: 3, cursor: "pointer",
                      fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.06em",
                      background: active ? `color-mix(in srgb, ${c} 16%, transparent)` : "transparent",
                      border: `1px solid ${active ? c : "var(--text-muted)"}`,
                      color: active ? c : "var(--border-bright)",
                      boxShadow: active ? `0 0 8px ${c}30` : "none",
                      transition: "all 0.15s",
                    }}>
                    {prefix}
                    <span style={{ marginLeft: 5, fontSize: 8, opacity: 0.7 }}>{cnt}</span>
                  </button>
                );
              })}
              {/* Seleccionar todos */}
              {selectedPrefixes.size < allPrefixes.length && (
                <button
                  onClick={() => { const all = new Set(allPrefixes); setSelectedPrefixes(all); saveScope(allPrefixes); }}
                  style={{
                    fontSize: 8, padding: "2px 7px", borderRadius: 3, cursor: "pointer",
                    fontFamily: "JetBrains Mono, monospace",
                    background: "transparent", border: "1px solid var(--border)",
                    color: "var(--border-bright)",
                  }}>
                  TODOS
                </button>
              )}
            </div>
          )}

          {/* Search + filter tabs */}
          <div style={{ padding: "8px 14px 0", borderBottom: "1px solid var(--border)" }}>
            {/* Search */}
            <div style={{ position: "relative", marginBottom: 7 }}>
              <Search size={11} style={{
                position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)",
                color: "var(--border-bright)", pointerEvents: "none",
              }} />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Buscar IFC…"
                style={{ width: "100%", fontSize: 11, padding: "4px 8px 4px 26px" }}
              />
            </div>
            {/* Tabs */}
            <div style={{ display: "flex", gap: 4, paddingBottom: 8, flexWrap: "wrap" }}>
              {(Object.keys(tabLabels) as FilterTab[]).map(tab => {
                const active = filterTab === tab;
                const c = tabColors[tab];
                return (
                  <button
                    key={tab}
                    onClick={() => setFilterTab(tab)}
                    style={{
                      fontSize: 8.5, fontWeight: 700, padding: "2px 8px", borderRadius: 3, cursor: "pointer",
                      fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.05em",
                      background: active ? `color-mix(in srgb, ${c} 14%, transparent)` : "transparent",
                      border: `1px solid ${active ? c : "var(--border)"}`,
                      color: active ? c : "var(--border-bright)",
                      transition: "all 0.15s",
                    }}>
                    {tabLabels[tab]}{tabCounts[tab] > 0 ? ` (${tabCounts[tab]})` : ""}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Scrollable list */}
          <div style={{ flex: 1, overflowY: "auto" }}>
            {loadingPB ? (
              <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>
                Cargando mappings de PocketBase…
              </div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", color: "var(--dim)", fontSize: 11 }}>
                Sin resultados {search ? `para "${search}"` : `en filtro "${tabLabels[filterTab]}"`}
              </div>
            ) : filtered.map(m => {
              const sc = ST[m.status];
              return (
                <div
                  key={m.id}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "4px 10px",
                    borderBottom: "1px solid var(--border)",
                    transition: "background 0.12s",
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(91,140,255,0.02)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                >
                  {/* SW badge */}
                  <span style={{
                    fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 2, flexShrink: 0,
                    fontFamily: "JetBrains Mono, monospace",
                    background: m.sw === "revit"   ? "rgba(91,140,255,0.09)"  : "rgba(217,164,65,0.09)",
                    color:      m.sw === "revit"   ? "#5B8CFF"               : "#D9A441",
                    border:     `1px solid ${m.sw === "revit" ? "rgba(91,140,255,0.22)" : "rgba(217,164,65,0.22)"}`,
                  }}>
                    {m.sw === "revit" ? "RVT" : m.sw === "civil3d" ? "C3D" : "?"}
                  </span>

                  {/* Name — full ifc_name without extension */}
                  <span
                    title={m.ifc_name}
                    style={{
                      flex: 1, fontSize: 9.5, fontFamily: "JetBrains Mono, monospace",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      color: m.status === "listo"   ? "#3FBE8A"
                           : m.status === "falta"   ? "rgba(150,175,200,0.5)"
                           : "var(--text)",
                      textDecoration: m.status === "listo" ? "line-through" : "none",
                      opacity: m.status === "listo" ? 0.7 : 1,
                    }}>
                    {m.ifc_name.replace(/\.ifc$/i, "")}
                  </span>

                  {/* Fecha + carpeta de origen de la copia más reciente */}
                  {m.found && m.winner && (
                    <span
                      title={`${m.winner.path}\nCarpeta: ${m.winner.folder_name}${m.copies > 1 ? `\n${m.copies} versiones — se usa la más reciente` : ""}`}
                      style={{
                        display: "flex", alignItems: "center", gap: 4, flexShrink: 0,
                        fontFamily: "JetBrains Mono, monospace", fontSize: 8.5,
                        color: "rgba(91,140,255,0.7)",
                      }}>
                      <span style={{ color: "#5B8CFF" }}>{fmtDate(m.winner.date)}</span>
                      <span style={{ color: "var(--border-bright)", maxWidth: 90,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {m.winner.folder_name}
                      </span>
                      {m.copies > 1 && (
                        <span style={{ color: "#D9A441", background: "rgba(217,164,65,0.1)",
                          borderRadius: 2, padding: "0 4px", fontWeight: 700 }}
                          title={`${m.copies} versiones — se usa la más reciente`}>
                          ×{m.copies}
                        </span>
                      )}
                    </span>
                  )}

                  {/* Status toggle badge */}
                  <StatusToggle status={m.status} onClick={() => toggleManual(m.ifc_name)} />
                </div>
              );
            })}
          </div>

          {/* Footer: save + exports */}
          <div style={{
            padding: "7px 14px", borderTop: "1px solid var(--border)",
            display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap",
          }}>
            {/* Save delivery */}
            <button
              onClick={openSaveForm}
              title={loadedId ? "Actualizar entrega cargada" : "Guardar estado actual como entrega"}
              style={{
                fontSize: 9.5, fontWeight: 700, padding: "3px 10px", borderRadius: 3, cursor: "pointer",
                fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.05em",
                background: loadedId ? "rgba(79,143,176,0.1)" : "rgba(100,120,200,0.09)",
                border: `1px solid ${loadedId ? "rgba(79,143,176,0.35)" : "rgba(100,120,200,0.28)"}`,
                color: loadedId ? "#4F8FB0" : "rgba(150,175,210,0.8)",
                display: "flex", alignItems: "center", gap: 5,
              }}>
              <BookMarked size={11} />
              {loadedId ? "Actualizar entrega" : "💾 Guardar entrega"}
            </button>
            <button onClick={exportToCSV} disabled={inScope.length === 0} title="Exportar CSV (Excel)"
              style={{
                fontSize: 9.5, fontWeight: 700, padding: "3px 9px", borderRadius: 3, cursor: "pointer",
                fontFamily: "JetBrains Mono, monospace",
                background: "rgba(63,190,138,0.07)", border: "1px solid rgba(63,190,138,0.22)", color: "#3FBE8A",
                display: "flex", alignItems: "center", gap: 4, opacity: inScope.length ? 1 : 0.4,
              }}>
              ⬇ Excel
            </button>
            <button onClick={exportToPDF} disabled={inScope.length === 0} title="Imprimir / PDF"
              style={{
                fontSize: 9.5, fontWeight: 700, padding: "3px 9px", borderRadius: 3, cursor: "pointer",
                fontFamily: "JetBrains Mono, monospace",
                background: "rgba(91,140,255,0.06)", border: "1px solid rgba(91,140,255,0.2)", color: "var(--cyan)",
                display: "flex", alignItems: "center", gap: 4, opacity: inScope.length ? 1 : 0.4,
              }}>
              🖨 PDF
            </button>
            <button onClick={exportACCList} disabled={!hasScan}
              title="Lista para subir al ACC: modelo · fecha · ruta del fichero más reciente"
              style={{
                fontSize: 9.5, fontWeight: 700, padding: "3px 9px", borderRadius: 3, cursor: "pointer",
                fontFamily: "JetBrains Mono, monospace",
                background: "rgba(79,143,176,0.07)", border: "1px solid rgba(79,143,176,0.28)", color: "#4F8FB0",
                display: "flex", alignItems: "center", gap: 4, opacity: hasScan ? 1 : 0.4,
              }}>
              🚀 Lista ACC
            </button>
          </div>

          {/* Inline save form */}
          {saveOpen && (
            <div style={{
              padding: "12px 14px", borderTop: "1px solid rgba(79,143,176,0.3)",
              background: "rgba(79,143,176,0.04)",
            }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#4F8FB0",
                textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
                {loadedId ? "Actualizar entrega" : "Nueva entrega"}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <input
                  placeholder="Nombre del hito  ej: (MEA)-PARCIAL_01"
                  value={saveName}
                  onChange={e => setSaveName(e.target.value)}
                  style={{ fontSize: 11, padding: "5px 8px" }}
                  autoFocus
                />
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    type="date"
                    value={saveDate}
                    onChange={e => setSaveDate(e.target.value)}
                    title="Fecha objetivo de entrega"
                    style={{ fontSize: 11, padding: "4px 6px", flex: 1 }}
                  />
                  <input
                    placeholder="Notas opcionales"
                    value={saveNotes}
                    onChange={e => setSaveNotes(e.target.value)}
                    style={{ fontSize: 11, padding: "4px 6px", flex: 2 }}
                  />
                </div>
                <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                  <button onClick={() => setSaveOpen(false)}
                    style={{ fontSize: 10, padding: "3px 10px", cursor: "pointer",
                      background: "transparent", border: "1px solid var(--text-muted)",
                      borderRadius: 3, color: "var(--text-muted)" }}>
                    Cancelar
                  </button>
                  <button
                    onClick={saveDelivery}
                    disabled={!saveName.trim() || saving}
                    style={{
                      fontSize: 10, fontWeight: 700, padding: "3px 14px", cursor: "pointer",
                      background: "rgba(79,143,176,0.14)", border: "1px solid rgba(79,143,176,0.4)",
                      borderRadius: 3, color: "#4F8FB0", opacity: saveName.trim() ? 1 : 0.5,
                    }}>
                    {saving ? "Guardando…" : loadedId ? "Actualizar" : "Guardar"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ══ RIGHT: Scanner + results ══ */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

          {/* Folder manager */}
          <div className="card-cyber" style={{ padding: "12px 14px" }}>
            <div style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase",
              letterSpacing: "0.07em", marginBottom: 8 }}>
              Carpetas monitorizadas
            </div>

            {/* Botón selector nativo de Windows */}
            <button
              onClick={pickFolder}
              style={{
                width: "100%", marginBottom: 8, padding: "7px 12px", fontSize: 11,
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                background: "rgba(91,140,255,0.06)", border: "1px solid rgba(91,140,255,0.28)",
                borderRadius: 4, color: "var(--cyan)", cursor: "pointer",
                fontFamily: "JetBrains Mono, monospace", fontWeight: 600, letterSpacing: "0.04em",
                transition: "all 0.15s",
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(91,140,255,0.12)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "rgba(91,140,255,0.06)"; }}
            >
              <FolderSearch size={14} /> Seleccionar carpeta…
            </button>

            {/* Fallback: entrada manual */}
            <div style={{ display: "flex", gap: 7, marginBottom: 8 }}>
              <input
                type="text"
                placeholder="O escribe la ruta manualmente…"
                value={folderInput}
                onChange={e => setFolderInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addFolder()}
                style={{ flex: 1, fontSize: 10 }}
              />
              <button
                onClick={addFolder}
                disabled={!folderInput.trim()}
                style={{
                  fontSize: 10, padding: "4px 10px", whiteSpace: "nowrap", cursor: "pointer",
                  background: folderInput.trim() ? "rgba(91,140,255,0.08)" : "transparent",
                  border: `1px solid ${folderInput.trim() ? "rgba(91,140,255,0.28)" : "var(--text-muted)"}`,
                  borderRadius: 4, color: folderInput.trim() ? "var(--cyan)" : "var(--border-bright)",
                  transition: "all 0.15s",
                }}>
                + Añadir
              </button>
            </div>
            {folders.length === 0 ? (
              <span style={{ color: "var(--dim)", fontSize: 10, fontStyle: "italic" }}>
                Sin carpetas — añade al menos una
              </span>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {folders.map(f => (
                  <div key={f} style={{
                    display: "flex", alignItems: "center", gap: 6,
                    background: "rgba(91,140,255,0.04)", border: "1px solid rgba(91,140,255,0.18)",
                    borderRadius: 4, padding: "4px 8px",
                  }}>
                    <FolderSearch size={11} color="rgba(91,140,255,0.4)" style={{ flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: 10, color: "var(--cyan)",
                      fontFamily: "JetBrains Mono, monospace",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      title={f}>{f}</span>
                    <button onClick={() => removeFolder(f)}
                      style={{ background: "none", border: "none", cursor: "pointer",
                        color: "rgba(91,140,255,0.4)", padding: 0, display: "flex" }}>
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Scan controls */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              className="btn btn-cyan"
              onClick={() => runScan(folders)}
              disabled={scanning || folders.length === 0}
              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, padding: "6px 14px" }}>
              <RefreshCw size={12} style={{ animation: scanning ? "spin 0.7s linear infinite" : "none" }} />
              {scanning ? "Escaneando…" : "▶ Scan"}
            </button>
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", userSelect: "none" }}>
              <div
                onClick={() => setAutoRefresh(v => !v)}
                style={{
                  width: 32, height: 18, borderRadius: 9, flexShrink: 0, cursor: "pointer",
                  background: autoRefresh ? "var(--cyan)" : "var(--border)", position: "relative",
                  transition: "background 0.2s",
                }}>
                <div style={{
                  position: "absolute", top: 2, left: autoRefresh ? 16 : 2,
                  width: 14, height: 14, borderRadius: "50%", transition: "left 0.2s",
                  background: autoRefresh ? "var(--surface)" : "var(--text-muted)",
                }} />
              </div>
              <span style={{ fontSize: 10.5, color: autoRefresh ? "var(--cyan)" : "var(--text-muted)" }}>
                Auto (5 s)
              </span>
            </label>
            {scannedAt && (
              <span style={{ fontSize: 10, color: "var(--dim)", marginLeft: "auto" }}>
                Scan: {scannedAt}
              </span>
            )}
          </div>

          {/* Avisos del scan: modo flat / carpetas ignoradas */}
          {scan && (scan.warnings.length > 0 || scan.ignored_folders.length > 0) && (
            <div style={{ background: "rgba(217,164,65,0.05)", border: "1px solid rgba(217,164,65,0.25)",
              borderRadius: 6, padding: "8px 12px", display: "flex", flexDirection: "column", gap: 5 }}>
              {scan.warnings.map((w, i) => (
                <div key={i} style={{ fontSize: 10, color: "#D9A441",
                  fontFamily: "JetBrains Mono, monospace" }}>⚠ {w}</div>
              ))}
              {scan.ignored_folders.length > 0 && (
                <div style={{ fontSize: 9.5, color: "rgba(150,175,200,0.55)",
                  fontFamily: "JetBrains Mono, monospace" }}
                  title={scan.ignored_folders.map(f => f.name).join("\n")}>
                  Carpetas ignoradas (sin fecha AAMMDD): {scan.ignored_folders.map(f => f.name).join(", ")}
                </div>
              )}
            </div>
          )}

          {/* Progress ring + mini KPIs */}
          <div className="card-cyber" style={{ padding: "12px 14px",
            display: "flex", alignItems: "center", gap: 16 }}>
            <ProgressRing pct={pctGlobal} size={80} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 16px" }}>
              <MiniKpi label="Total"      value={total}                         color="rgba(150,175,200,0.7)" />
              <MiniKpi label="Confirmado" value={listoCount + encontCount}      color="#3FBE8A" />
              <MiniKpi label="RVT pend."  value={rvtPending.length}             color="var(--cyan)" />
              <MiniKpi label="C3D pend."  value={dwgPending.length}             color="var(--magenta)" />
            </div>
          </div>

          {/* Exported / Pending by tool */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <CompactSection title="RVT — En carpeta" items={rvtExported} color="var(--cyan)"
              emptyLabel={hasScan ? "Ninguno encontrado" : "Ejecuta scan"} />
            <CompactSection title="C3D — En carpeta" items={dwgExported} color="var(--magenta)"
              emptyLabel={hasScan ? "Ninguno encontrado" : "Ejecuta scan"} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <CompactSection title="RVT — Pendientes" items={rvtPending} color="var(--red)"
              emptyLabel={hasScan ? "✓ Todos encontrados" : "Ejecuta scan"} />
            <CompactSection title="C3D — Pendientes" items={dwgPending} color="var(--red)"
              emptyLabel={hasScan ? "✓ Todos encontrados" : "Ejecuta scan"} />
          </div>

          {/* Orphans: ficheros en carpeta fuera del plan */}
          {orphans.length > 0 && (
            <CompactSection title="⚠ En carpeta, fuera del plan" items={orphans} color="#D9A441"
              emptyLabel="Ninguno" />
          )}

          {/* ── Entregas registradas (PocketBase) ── */}
          <div className="card-cyber" style={{ overflow: "hidden" }}>
            <div style={{
              padding: "9px 14px", borderBottom: "1px solid var(--border)",
              display: "flex", alignItems: "center", gap: 8,
            }}>
              <BookMarked size={13} color="#4F8FB0" />
              <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-muted)",
                textTransform: "uppercase", letterSpacing: "0.08em", flex: 1 }}>
                Entregas registradas
              </span>
              <span style={{ fontSize: 9.5, color: "var(--border-bright)" }}>
                {deliveries.length} hitos
              </span>
            </div>

            {deliveries.length === 0 ? (
              <div style={{ padding: "14px", fontSize: 11, color: "var(--dim)", fontStyle: "italic" }}>
                Guarda tu primer estado con "💾 Guardar entrega"
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {deliveries.map(d => {
                  const isLoaded = loadedId === d.id;
                  const pctColor = d.pct >= 80 ? "#3FBE8A" : d.pct >= 40 ? "#D9A441" : "#ff4466";
                  const dateLabel = d.target_date
                    ? new Date(d.target_date + "T12:00:00").toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" })
                    : "Sin fecha";
                  return (
                    <div key={d.id} style={{
                      padding: "8px 14px",
                      borderBottom: "1px solid var(--border)",
                      background: isLoaded ? "rgba(79,143,176,0.05)" : "transparent",
                      borderLeft: isLoaded ? "2px solid #4F8FB0" : "2px solid transparent",
                      transition: "background 0.15s",
                    }}>
                      {/* Row header */}
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                        {editingNameId === d.id ? (
                          <input
                            autoFocus
                            value={editingNameValue}
                            onChange={e => setEditingNameValue(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === "Enter") renameDelivery(d.id, editingNameValue);
                              if (e.key === "Escape") setEditingNameId(null);
                            }}
                            onBlur={() => renameDelivery(d.id, editingNameValue)}
                            style={{
                              flex: 1, background: "rgba(91,140,255,0.05)",
                              border: "1px solid rgba(91,140,255,0.35)", borderRadius: 3,
                              color: "var(--text-bright)", fontSize: 11,
                              fontFamily: "JetBrains Mono, monospace",
                              padding: "1px 5px", height: 22, outline: "none",
                            }}
                          />
                        ) : (
                          <>
                            <span style={{ flex: 1, fontSize: 11, fontWeight: 700,
                              color: isLoaded ? "#4F8FB0" : "var(--text-bright)",
                              fontFamily: "JetBrains Mono, monospace",
                              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                              title={d.name}>
                              {d.name}
                            </span>
                            <button
                              onClick={() => { setEditingNameId(d.id); setEditingNameValue(d.name); }}
                              title="Renombrar"
                              style={{ background: "none", border: "none", cursor: "pointer",
                                color: "var(--border-bright)", padding: 2, display: "flex",
                                flexShrink: 0, lineHeight: 1 }}>
                              <Pencil size={10} />
                            </button>
                          </>
                        )}
                        {/* Load button */}
                        <button
                          onClick={() => isLoaded ? (setLoadedId(null)) : loadDelivery(d)}
                          title={isLoaded ? "Desvincular" : "Cargar este estado"}
                          style={{
                            fontSize: 8.5, fontWeight: 700, padding: "1px 7px", borderRadius: 3,
                            cursor: "pointer", fontFamily: "JetBrains Mono, monospace",
                            background: isLoaded ? "rgba(79,143,176,0.12)" : "rgba(91,140,255,0.07)",
                            border: `1px solid ${isLoaded ? "rgba(79,143,176,0.35)" : "rgba(91,140,255,0.22)"}`,
                            color: isLoaded ? "#4F8FB0" : "var(--cyan)",
                          }}>
                          {isLoaded ? "✓ CARGADO" : "CARGAR"}
                        </button>
                        {/* Delete */}
                        {confirmDeleteId === d.id ? (
                          <>
                            <button onClick={() => deleteDelivery(d.id)}
                              style={{ fontSize: 8, padding: "1px 6px", borderRadius: 3, cursor: "pointer",
                                background: "rgba(255,68,102,0.12)", border: "1px solid rgba(255,68,102,0.35)",
                                color: "#ff4466", fontWeight: 700 }}>
                              ¿Borrar?
                            </button>
                            <button onClick={() => setConfirmDeleteId(null)}
                              style={{ fontSize: 8, padding: "1px 5px", borderRadius: 3, cursor: "pointer",
                                background: "transparent", border: "1px solid var(--text-muted)",
                                color: "var(--text-muted)" }}>
                              No
                            </button>
                          </>
                        ) : (
                          <button onClick={() => setConfirmDeleteId(d.id)}
                            title="Eliminar entrega"
                            style={{ background: "none", border: "none", cursor: "pointer",
                              color: "var(--border-bright)", padding: 2, display: "flex" }}>
                            <Trash2 size={11} />
                          </button>
                        )}
                      </div>
                      {/* Meta row */}
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 9.5, color: "var(--text-muted)",
                          fontFamily: "JetBrains Mono, monospace" }}>
                          🗓 {dateLabel}
                        </span>
                        {(d.folder_paths ?? []).length > 0 && (
                          <span
                            title={(d.folder_paths ?? []).join("\n")}
                            style={{ fontSize: 8.5, color: "rgba(91,140,255,0.5)",
                              fontFamily: "JetBrains Mono, monospace", cursor: "default",
                              userSelect: "none" }}>
                            📁 {(d.folder_paths ?? []).length}
                          </span>
                        )}
                        {(d.scope_prefixes ?? []).map(p => (
                          <span key={p} style={{ fontSize: 8, fontWeight: 700, padding: "0 5px",
                            borderRadius: 2, fontFamily: "JetBrains Mono, monospace",
                            background: `color-mix(in srgb, ${prefixColor(p)} 12%, transparent)`,
                            border: `1px solid color-mix(in srgb, ${prefixColor(p)} 30%, transparent)`,
                            color: prefixColor(p) }}>{p}</span>
                        ))}
                        <div style={{ flex: 1 }} />
                        {/* Progress mini bar */}
                        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                          <div style={{ width: 50, height: 3, borderRadius: 2,
                            background: "var(--border)", overflow: "hidden" }}>
                            <div style={{ height: "100%", borderRadius: 2, width: `${d.pct}%`,
                              background: pctColor }} />
                          </div>
                          <span style={{ fontSize: 9.5, fontWeight: 700, color: pctColor,
                            fontFamily: "JetBrains Mono, monospace" }}>
                            {d.pct}%
                          </span>
                        </div>
                      </div>
                      {/* Counts */}
                      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                        {[
                          { v: d.listos,      c: "#3FBE8A", l: "listos" },
                          { v: d.en_proceso,  c: "#D9A441", l: "proc." },
                          { v: d.encontrados, c: "#5B8CFF", l: "carpeta" },
                          { v: d.faltan,      c: "#ff4466", l: "faltan" },
                        ].map(({ v, c, l }) => v > 0 ? (
                          <span key={l} style={{ fontSize: 9, color: "var(--text-muted)",
                            fontFamily: "JetBrains Mono, monospace" }}>
                            <span style={{ color: c, fontWeight: 700 }}>{v}</span> {l}
                          </span>
                        ) : null)}
                        {d.notes && (
                          <span style={{ fontSize: 9, color: "var(--border-bright)",
                            fontFamily: "JetBrains Mono, monospace", marginLeft: "auto",
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                            maxWidth: 120 }} title={d.notes}>
                            📝 {d.notes}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
