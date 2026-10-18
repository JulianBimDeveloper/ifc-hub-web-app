"use client";

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useProjectStore } from "@/stores/projectStore";
import { KpiHeader }          from "./components/KpiHeader";
import { ReviewGrid }         from "./components/ReviewGrid";
import { CellEditPanel }      from "./components/CellEditPanel";
import { BulkFillBar }        from "./components/BulkFillBar";
import { ImportExcelDialog }  from "./components/ImportExcelDialog";
import { useReviewScan }      from "./lib/useReviewScan";
import type { ReviewTab, ReviewMode, ReviewCell, BulkFillRequest } from "./lib/reviewTypes";

export default function ClientReviewPage() {
  const { selectedPaths } = useProjectStore();

  const {
    results, scanning, progress,
    reviewId, setReviewId,
    mode, setMode,
    scanPaths, rescanPaths,
    importExcel, bulkFill, updateProperty,
    stop, clearCache,
    exportExcel, importEdits,
  } = useReviewScan();

  // Tabs
  const [tab, setTab] = useState<ReviewTab>("element");

  // Filtros
  const [filterRed,        setFilterRed]        = useState(false);
  const [filterFile,       setFilterFile]        = useState("");
  const [filterDisciplina, setFilterDisciplina]  = useState("");
  const [filterText,       setFilterText]        = useState("");

  // Selección de filas
  const [selectedGuids, setSelectedGuids] = useState<Set<string>>(new Set());

  // Panel de edición
  const [editSel, setEditSel] = useState<{
    guid: string; colKey: string; cell: ReviewCell;
    path: string; psetInfo: { pset: string; prop: string };
  } | null>(null);

  // BulkFill bar
  const [bulkFillOpen, setBulkFillOpen] = useState(false);
  const [bulkFillCol,  setBulkFillCol]  = useState<{
    colKey: string; psetInfo: { pset: string; prop: string }; initialValue: string;
  } | null>(null);

  // Import dialog
  const [showImport, setShowImport] = useState(false);

  // Export dropdown
  const [exportOpen,   setExportOpen]   = useState(false);
  const [exportBusy,   setExportBusy]   = useState(false);
  const exportBtnRef = useRef<HTMLDivElement>(null);

  // Cerrar dropdown al hacer click fuera
  useEffect(() => {
    if (!exportOpen) return;
    const handler = (e: MouseEvent) => {
      if (exportBtnRef.current && !exportBtnRef.current.contains(e.target as Node)) {
        setExportOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [exportOpen]);

  // Import-edits (write-back)
  const importEditsRef = useRef<HTMLInputElement>(null);
  const [importEditsMsg, setImportEditsMsg] = useState<string | null>(null);

  // ── Actions ───────────────────────────────────────────────────────────────

  const handleExportExcel = async (tabs: Array<"file" | "project" | "element">) => {
    setExportOpen(false);
    setExportBusy(true);
    try {
      const { missingFiles, erroredFiles } = await exportExcel(tabs, "client_review.xlsx");
      if (missingFiles.length > 0 || erroredFiles.length > 0) {
        const parts: string[] = [];
        if (missingFiles.length > 0) parts.push(`${missingFiles.length} archivo(s) aún escaneando (no incluidos): ${missingFiles.join(", ")}`);
        if (erroredFiles.length > 0) parts.push(`${erroredFiles.length} archivo(s) con error (no incluidos): ${erroredFiles.join(", ")}`);
        window.alert(`El Excel exportado NO incluye todos los archivos seleccionados.\n\n${parts.join("\n")}\n\nEspera a que termine el escaneo (o reintenta los que fallaron) y vuelve a exportar.`);
      }
    } finally {
      setExportBusy(false);
    }
  };

  const handleExportPdf = () => {
    setExportOpen(false);
    window.print();
  };

  const handleImportEditsFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setImportEditsMsg("Aplicando cambios…");
    const res = await importEdits(file);
    if (!res) {
      setImportEditsMsg("Error al importar. Revisa la consola.");
    } else {
      const total = Object.values(res).reduce((s, v) => s + v.updated, 0);
      const errs  = Object.values(res).flatMap(v => v.errors).length;
      setImportEditsMsg(`✔ ${total} valores actualizados${errs ? ` · ${errs} errores` : ""}`);
    }
    setTimeout(() => setImportEditsMsg(null), 5000);
  };

  const handleScan = () => {
    setSelectedGuids(new Set());
    scanPaths(selectedPaths, reviewId, mode);
  };

  const handleModeChange = (m: ReviewMode) => {
    setMode(m);
    if (Object.keys(results).length > 0) {
      scanPaths(selectedPaths, reviewId, m);
    }
  };

  const handleImportDone = async (file: File) => {
    const id = await importExcel(file);
    if (id) setMode("client");
    return id;
  };

  const handleSelectGuid = useCallback((guid: string, multi: boolean) => {
    setSelectedGuids(prev => {
      const next = new Set(prev);
      if (multi) {
        if (next.has(guid)) next.delete(guid);
        else next.add(guid);
      } else {
        if (next.has(guid) && next.size === 1) next.clear();
        else { next.clear(); next.add(guid); }
      }
      return next;
    });
  }, []);

  const handleCellClick = useCallback((
    guid: string, colKey: string, cell: ReviewCell,
    path: string, psetInfo: { pset: string; prop: string },
  ) => {
    setEditSel({ guid, colKey, cell, path, psetInfo });
    setBulkFillOpen(false);
  }, []);

  const handleOpenBulkFill = useCallback((colKey: string, psetInfo: { pset: string; prop: string }, initialValue: string) => {
    setBulkFillCol({ colKey, psetInfo, initialValue });
    setBulkFillOpen(true);
  }, []);

  const handleBulkApply = async (req: BulkFillRequest) => {
    const res = await bulkFill(req);
    if (res.ok) {
      // Re-escanear solo los archivos afectados
      const paths = Object.keys(req.targets_by_file);
      await scanPaths(paths, reviewId, mode);
    }
    return res;
  };

  const handleUpdateSingle = async (path: string, guid: string, pset: string, prop: string, value: string) => {
    return updateProperty(path, guid, pset, prop, value);
  };

  // Disciplinas únicas para filtro
  const disciplinas = useMemo(() => {
    const set = new Set<string>();
    for (const r of Object.values(results)) {
      for (const d of Object.keys(r.stats?.by_disciplina ?? {})) {
        if (d) set.add(d);
      }
    }
    return Array.from(set).sort();
  }, [results]);

  const hasResults = Object.keys(results).length > 0;
  const errorFiles = Object.values(results).filter(r => r.error);

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100%",
      padding: "16px 20px", gap: 12, overflow: "hidden", boxSizing: "border-box",
    }}>
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          .print-area, .print-area * { visibility: visible !important; }
          .print-area { position: fixed !important; top: 0 !important; left: 0 !important; width: 100% !important; overflow: visible !important; }
          .no-print { display: none !important; }
        }
      `}</style>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 18, color: "#4F8FB0", fontWeight: 800, letterSpacing: "0.04em" }}>
            CLIENT REVIEW
          </h1>
          <p style={{ margin: "2px 0 0", fontSize: 11, color: "#555" }}>
            Revisión de entregables IFC según la matriz del cliente · {selectedPaths.length} archivos seleccionados
          </p>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", marginLeft: "auto", flexWrap: "wrap" }}>
          {/* Modo toggle */}
          <div style={{ display: "flex", background: "#111", border: "1px solid #333", borderRadius: 4, overflow: "hidden" }}>
            {(["live", "client"] as ReviewMode[]).map(m => (
              <button
                key={m}
                onClick={() => handleModeChange(m)}
                disabled={m === "client" && !reviewId}
                style={{
                  background: mode === m ? "#4F8FB033" : "none",
                  border: "none", color: mode === m ? "#4F8FB0" : "#666",
                  padding: "6px 14px", cursor: m === "client" && !reviewId ? "not-allowed" : "pointer",
                  fontSize: 11, fontWeight: mode === m ? 700 : 400,
                  textTransform: "uppercase", letterSpacing: "0.06em",
                }}
              >
                {m === "live" ? "En Vivo" : "Cliente"}
              </button>
            ))}
          </div>

          <button
            onClick={async () => { await clearCache(); if (Object.keys(results).length > 0) handleScan(); }}
            title="Borrar caché y re-escanear (útil si los datos del tab IfcFile aparecen incorrectos)"
            style={{
              background: "#ff663311", border: "1px solid #ff663355",
              color: "#ff9966", borderRadius: 4, padding: "6px 10px",
              cursor: "pointer", fontSize: 11,
            }}
          >
            ♻ Limpiar caché
          </button>

          <button
            onClick={() => setShowImport(true)}
            style={{
              background: "#4F8FB022", border: "1px solid #4F8FB055",
              color: "#4F8FB0", borderRadius: 4, padding: "6px 14px",
              cursor: "pointer", fontSize: 11,
            }}
          >
            {reviewId ? "📊 Reimportar revisión" : "📊 Importar revisión cliente"}
          </button>

          {/* ── Export dropdown ── */}
          {hasResults && (
            <div ref={exportBtnRef} style={{ position: "relative" }}>
              <button
                onClick={() => setExportOpen(o => !o)}
                disabled={exportBusy}
                style={{
                  background: "#1a1a2a", border: "1px solid #444",
                  color: exportBusy ? "#555" : "#ccc",
                  borderRadius: 4, padding: "6px 12px",
                  cursor: exportBusy ? "not-allowed" : "pointer", fontSize: 11,
                  display: "flex", alignItems: "center", gap: 4,
                }}
              >
                {exportBusy ? "⏳ Exportando…" : "⬇ Exportar ▾"}
              </button>
              {exportOpen && (
                <div
                  style={{
                    position: "absolute", right: 0, top: "100%", marginTop: 4,
                    background: "#1a1a2a", border: "1px solid #444", borderRadius: 6,
                    zIndex: 100, minWidth: 220, boxShadow: "0 4px 20px #0008",
                  }}
                >
                  <div style={{ padding: "6px 0", borderBottom: "1px solid #333", color: "#555", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", paddingLeft: 12 }}>
                    Excel — {tab === "element" ? "IfcElement" : tab === "project" ? "IfcProject" : "IfcFile"}
                  </div>
                  <button
                    onClick={() => handleExportExcel([tab as "file" | "project" | "element"])}
                    style={{ display: "block", width: "100%", background: "none", border: "none", color: "#ccc", textAlign: "left", padding: "9px 14px", cursor: "pointer", fontSize: 12 }}
                    onMouseEnter={e => (e.currentTarget.style.background = "#4F8FB022")}
                    onMouseLeave={e => (e.currentTarget.style.background = "none")}
                  >
                    Solo esta hoja ({tab === "element" ? "IfcElement" : tab === "project" ? "IfcProject" : "IfcFile"})
                  </button>
                  <button
                    onClick={() => handleExportExcel(["file", "project", "element"])}
                    style={{ display: "block", width: "100%", background: "none", border: "none", color: "#ccc", textAlign: "left", padding: "9px 14px", cursor: "pointer", fontSize: 12 }}
                    onMouseEnter={e => (e.currentTarget.style.background = "#4F8FB022")}
                    onMouseLeave={e => (e.currentTarget.style.background = "none")}
                  >
                    Las 3 hojas (IfcFile + IfcProject + IfcElement)
                  </button>
                  <div style={{ height: 1, background: "#333", margin: "2px 0" }} />
                  <button
                    onClick={handleExportPdf}
                    style={{ display: "block", width: "100%", background: "none", border: "none", color: "#ccc", textAlign: "left", padding: "9px 14px", cursor: "pointer", fontSize: 12 }}
                    onMouseEnter={e => (e.currentTarget.style.background = "#4F8FB022")}
                    onMouseLeave={e => (e.currentTarget.style.background = "none")}
                  >
                    🖨 Imprimir / Exportar PDF
                  </button>
                  <div style={{ height: 1, background: "#333", margin: "2px 0" }} />
                  <button
                    onClick={() => { setExportOpen(false); importEditsRef.current?.click(); }}
                    style={{ display: "block", width: "100%", background: "none", border: "none", color: "#aaffaa", textAlign: "left", padding: "9px 14px", cursor: "pointer", fontSize: 12 }}
                    onMouseEnter={e => (e.currentTarget.style.background = "#3FBE8A22")}
                    onMouseLeave={e => (e.currentTarget.style.background = "none")}
                  >
                    ⬆ Importar ediciones (.xlsx)
                  </button>
                </div>
              )}
            </div>
          )}

          <button
            onClick={scanning ? stop : handleScan}
            disabled={selectedPaths.length === 0}
            style={{
              background: scanning ? "#ff335533" : "#4F8FB0",
              border: scanning ? "1px solid #ff3355" : "none",
              color: "#fff", borderRadius: 4, padding: "7px 18px",
              cursor: selectedPaths.length === 0 ? "not-allowed" : "pointer",
              fontWeight: 700, fontSize: 13,
            }}
          >
            {scanning ? `⏹ Detener (${progress.done}/${progress.total})` : "▶ Escanear"}
          </button>
        </div>
      </div>

      {/* ── KPIs ───────────────────────────────────────────────────────────── */}
      {(hasResults || scanning) && (
        <KpiHeader results={results} mode={mode} tab={tab} scanning={scanning} progress={progress} />
      )}

      {/* ── Tabs ───────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #333" }}>
        {(["element", "project", "file"] as ReviewTab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              background: tab === t ? "#4F8FB022" : "none",
              border: "none", borderBottom: tab === t ? "2px solid #4F8FB0" : "2px solid transparent",
              color: tab === t ? "#4F8FB0" : "#666",
              padding: "7px 18px", cursor: "pointer", fontSize: 12,
              fontWeight: tab === t ? 700 : 400, textTransform: "uppercase", letterSpacing: "0.06em",
            }}
          >
            {t === "element" ? "IfcElement" : t === "project" ? "IfcProject" : "IfcFile"}
            {tab === t && hasResults && (
              <span style={{ marginLeft: 6, fontSize: 10, color: "#888" }}>
                ({Object.values(results).reduce((acc, r) => {
                  if (t === "element") return acc + (r.elements?.length ?? 0);
                  return acc + (r.file_row || r.project_row ? 1 : 0);
                }, 0)})
              </span>
            )}
          </button>
        ))}

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, paddingBottom: 4 }}>
          {/* Filtros */}
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#888", cursor: "pointer" }}>
            <input
              type="checkbox" checked={filterRed}
              onChange={e => setFilterRed(e.target.checked)}
            />
            Solo rojas
          </label>

          {tab === "element" && disciplinas.length > 0 && (
            <select
              value={filterDisciplina}
              onChange={e => setFilterDisciplina(e.target.value)}
              style={{ background: "#111", border: "1px solid #333", color: "#888", borderRadius: 4, padding: "4px 8px", fontSize: 11 }}
            >
              <option value="">Todas las disciplinas</option>
              {disciplinas.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          )}

          <input
            value={filterFile}
            onChange={e => setFilterFile(e.target.value)}
            placeholder="Filtrar por archivo..."
            style={{
              background: "#111", border: "1px solid #333", color: "#aaa",
              borderRadius: 4, padding: "4px 8px", fontSize: 11, width: 160, outline: "none",
            }}
          />

          <input
            value={filterText}
            onChange={e => setFilterText(e.target.value)}
            placeholder="Buscar texto..."
            style={{
              background: "#111", border: "1px solid #333", color: "#aaa",
              borderRadius: 4, padding: "4px 8px", fontSize: 11, width: 140, outline: "none",
            }}
          />

          {selectedGuids.size > 0 && (
            <button
              onClick={() => setSelectedGuids(new Set())}
              style={{
                background: "#4F8FB022", border: "1px solid #4F8FB055",
                color: "#4F8FB0", borderRadius: 4, padding: "4px 10px",
                cursor: "pointer", fontSize: 11,
              }}
            >
              {selectedGuids.size} sel. × limpiar
            </button>
          )}
        </div>
      </div>

      {/* ── Sin archivos seleccionados ──────────────────────────────────────── */}
      {selectedPaths.length === 0 && (
        <div style={{
          flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
          flexDirection: "column", gap: 10, color: "#444",
        }}>
          <div style={{ fontSize: 40 }}>📋</div>
          <div style={{ fontSize: 14 }}>Selecciona archivos IFC en el sidebar y pulsa <strong style={{ color: "#4F8FB0" }}>Escanear</strong></div>
          <div style={{ fontSize: 11, color: "#333" }}>
            Puedes importar la revisión del cliente (.xlsx) para comparar en modo "Cliente"
          </div>
        </div>
      )}

      {/* ── Errores ─────────────────────────────────────────────────────────── */}
      {errorFiles.length > 0 && (
        <div style={{ fontSize: 11, color: "#ff6633", background: "#ff663311", borderRadius: 4, padding: "6px 10px" }}>
          {errorFiles.length} archivo(s) con error: {errorFiles.map(r => r.filename).join(", ")}
        </div>
      )}

      {/* ── Grid + Panel (flex row) ─────────────────────────────────────────── */}
      <div className="print-area" style={{ display: "flex", flex: 1, minHeight: 0, gap: 0 }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <ReviewGrid
            results={results}
            tab={tab}
            mode={mode}
            filterRed={filterRed}
            filterFile={filterFile}
            filterDisciplina={filterDisciplina}
            filterText={filterText}
            selectedGuids={selectedGuids}
            onSelectGuid={handleSelectGuid}
            onCellClick={handleCellClick}
          />
        </div>

        {editSel && (
          <CellEditPanel
            selection={editSel}
            multiGuids={selectedGuids}
            mode={mode}
            onUpdateSingle={handleUpdateSingle}
            onOpenBulkFill={handleOpenBulkFill}
            onClose={() => setEditSel(null)}
          />
        )}
      </div>

      {/* ── Bulk fill bar ───────────────────────────────────────────────────── */}
      {bulkFillOpen && bulkFillCol && (
        <BulkFillBar
          colKey={bulkFillCol.colKey}
          psetInfo={bulkFillCol.psetInfo}
          initialValue={bulkFillCol.initialValue}
          selectedGuids={selectedGuids}
          selectedPaths={selectedPaths}
          onApply={handleBulkApply}
          onClose={() => setBulkFillOpen(false)}
        />
      )}

      {/* ── Import dialog ───────────────────────────────────────────────────── */}
      {showImport && (
        <ImportExcelDialog
          onImport={handleImportDone}
          onClose={() => setShowImport(false)}
          reviewId={reviewId}
        />
      )}

      {/* ── Hidden file input for import-edits ─────────────────────────────── */}
      <input
        ref={importEditsRef}
        type="file"
        accept=".xlsx"
        style={{ display: "none" }}
        onChange={handleImportEditsFile}
      />

      {/* ── Toast para import-edits ─────────────────────────────────────────── */}
      {importEditsMsg && (
        <div style={{
          position: "fixed", bottom: 24, right: 24, zIndex: 999,
          background: importEditsMsg.startsWith("✔") ? "#3FBE8A22" : "#ff335522",
          border: `1px solid ${importEditsMsg.startsWith("✔") ? "#3FBE8A" : "#ff3355"}`,
          color: importEditsMsg.startsWith("✔") ? "#3FBE8A" : "#ff9977",
          borderRadius: 8, padding: "12px 18px", fontSize: 13, fontWeight: 600,
          boxShadow: "0 4px 20px #0008",
        }}>
          {importEditsMsg}
        </div>
      )}
    </div>
  );
}
