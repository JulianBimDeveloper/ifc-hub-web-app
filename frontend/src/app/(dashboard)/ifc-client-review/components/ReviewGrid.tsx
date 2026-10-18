"use client";

import { useMemo } from "react";
import type { FileScanResult, ReviewCell, ReviewMode } from "../lib/reviewTypes";
import { getCellBg } from "../lib/reviewTypes";

interface Props {
  results: Record<string, FileScanResult>;
  tab: "file" | "project" | "element";
  mode: ReviewMode;
  filterRed: boolean;
  filterFile: string;
  filterDisciplina: string;
  filterText: string;
  selectedGuids: Set<string>;
  onSelectGuid: (guid: string, multi: boolean) => void;
  onCellClick: (guid: string, colKey: string, cell: ReviewCell, path: string, psetInfo: { pset: string; prop: string }) => void;
}

interface FlatRow {
  key: string;
  filename: string;
  path: string;
  guid?: string;
  cells: Record<string, ReviewCell>;
}

// Columns that are already shown in the sticky ARCHIVO column — hide from data grid
const HIDDEN_COLS = new Set(["Archivo"]);

const TAB_DESCRIPTIONS: Record<string, { label: string; detail: string }> = {
  file: {
    label: "Cabecera STEP del archivo IFC",
    detail: "Esquema IFC, timestamp de exportación, aplicación origen, organización y coordenadas geográficas del sitio.",
  },
  project: {
    label: "Entidad IfcProject + Psets de proyecto",
    detail: "GUID y atributos del IfcProject, tamaño de archivo y propiedades ADIF de nivel proyecto (ADIF_00_Codigo_Archivo, ADIF_02_*, ADIF_04_Inicio/Fin_Actuacion).",
  },
  element: {
    label: "Elementos IFC + Psets de elemento",
    detail: "Todos los elementos del modelo: GUID, nombre, clase IFC, material, clasificación SCF y propiedades ADIF de nivel elemento (ADIF_00_*, ADIF_02_Km, ADIF_03_*, ADIF_04_Actividad, ADIF_08_*).",
  },
};

export function ReviewGrid({
  results, tab, mode, filterRed, filterFile, filterDisciplina, filterText,
  selectedGuids, onSelectGuid, onCellClick,
}: Props) {
  // Get columns from current tab, excluding columns already shown in the sticky ARCHIVO header
  const columns = useMemo<string[]>(() => {
    const files = Object.values(results).filter(r => !r.error);
    if (files.length === 0) return [];
    let raw: string[] = [];
    if (tab === "file") {
      const sample = files.find(f => f.file_row)?.file_row;
      raw = sample ? Object.keys(sample) : [];
    } else if (tab === "project") {
      const sample = files.find(f => f.project_row)?.project_row;
      raw = sample ? Object.keys(sample) : [];
    } else {
      const sample = files.find(f => f.elements && f.elements.length > 0)?.elements?.[0]?.cells;
      raw = sample ? Object.keys(sample) : [];
    }
    return raw.filter(c => !HIDDEN_COLS.has(c));
  }, [results, tab]);

  // Build flat rows
  const allRows = useMemo<FlatRow[]>(() => {
    const rows: FlatRow[] = [];
    for (const r of Object.values(results)) {
      if (r.error || r.loading) continue;
      if (tab === "file" && r.file_row) {
        rows.push({ key: r.path, filename: r.filename, path: r.path, cells: r.file_row });
      } else if (tab === "project" && r.project_row) {
        rows.push({ key: r.path + "_proj", filename: r.filename, path: r.path, guid: r.project_guid, cells: r.project_row });
      } else if (tab === "element" && r.elements) {
        for (const el of r.elements) {
          rows.push({ key: el.guid, filename: r.filename, path: r.path, guid: el.guid, cells: el.cells });
        }
      }
    }
    return rows;
  }, [results, tab]);

  // Filter rows
  const rows = useMemo<FlatRow[]>(() => {
    return allRows.filter(row => {
      if (filterFile && !row.filename.toLowerCase().includes(filterFile.toLowerCase())) return false;
      if (filterDisciplina) {
        const disc = (row.cells["ADIF_00_Disciplina"]?.v ?? "").toUpperCase();
        if (disc !== filterDisciplina.toUpperCase()) return false;
      }
      if (filterText) {
        const tl = filterText.toLowerCase();
        const hasText = Object.values(row.cells).some(c => c.v?.toLowerCase().includes(tl));
        const hasGuid = row.guid?.toLowerCase().includes(tl);
        const hasFile = row.filename?.toLowerCase().includes(tl);
        if (!hasText && !hasGuid && !hasFile) return false;
      }
      if (filterRed) {
        const hasRed = Object.values(row.cells).some(c =>
          c.red ||
          c.status === "client_red_still_empty" ||
          c.status === "client_red_has_value" ||
          c.status === "new_empty"
        );
        if (!hasRed) return false;
      }
      return true;
    });
  }, [allRows, filterRed, filterFile, filterDisciplina, filterText]);

  const tabDesc = TAB_DESCRIPTIONS[tab];

  if (columns.length === 0) {
    return (
      <div style={{ padding: 24, color: "#666", textAlign: "center", fontSize: 13 }}>
        Selecciona archivos en el sidebar y pulsa <strong>Escanear</strong>.
      </div>
    );
  }

  if (rows.length === 0 && allRows.length > 0) {
    return (
      <>
        {tabDesc && (
          <div style={{ padding: "6px 10px", background: "#0d0d1a", borderBottom: "1px solid #1a1a2a", marginBottom: 2 }}>
            <span style={{ color: "#4F8FB0", fontSize: 11, fontWeight: 700 }}>{tabDesc.label}</span>
            <span style={{ color: "#444", fontSize: 10, marginLeft: 10 }}>{tabDesc.detail}</span>
          </div>
        )}
        <div style={{ padding: 32, color: "#888", textAlign: "center", fontSize: 13 }}>
          <div style={{ fontSize: 28, marginBottom: 10 }}>✅</div>
          <div style={{ color: "#3FBE8A", fontWeight: 700, fontSize: 15, marginBottom: 6 }}>
            Sin filas rojas en este nivel
          </div>
          <div>
            {allRows.length} fila(s) escaneada(s), todas correctas.
            Desactiva <strong style={{ color: "#aaa" }}>Solo rojas</strong> para ver todos los datos.
          </div>
        </div>
      </>
    );
  }

  const COL_W_FILENAME = 320;
  const COL_W_DEFAULT = 160;

  const getColW = (col: string) => {
    if (col === "filename" || col === "Nombre") return COL_W_FILENAME;
    return COL_W_DEFAULT;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
      {/* Row count */}
      <div style={{ fontSize: 11, color: "#555", marginBottom: 6, fontFamily: "JetBrains Mono, monospace", padding: "0 8px" }}>
        {rows.length} filas {allRows.length !== rows.length ? `(de ${allRows.length})` : ""}
      </div>

      {/* Scrollable table container */}
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {/* Header row */}
        <div style={{ display: "flex", background: "#0d0d1a", borderBottom: "1px solid #333", position: "sticky", top: 0, zIndex: 10 }}>
          <div style={{ width: COL_W_FILENAME, flexShrink: 0, padding: "8px", borderRight: "1px solid #333", fontSize: 10, fontWeight: 600, color: "#4F8FB0", textTransform: "uppercase", letterSpacing: "0.06em", fontFamily: "JetBrains Mono, monospace" }}>
            Archivo
          </div>
          {columns.map(col => (
            <div key={col} style={{ width: getColW(col), flexShrink: 0, padding: "8px", borderRight: "1px solid #222", fontSize: 10, fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: "0.06em", fontFamily: "JetBrains Mono, monospace", whiteSpace: "normal", lineHeight: 1.3 }}>
              {col}
            </div>
          ))}
        </div>

        {/* Data rows */}
        {rows.map((row, idx) => {
          const isSelected = row.guid ? selectedGuids.has(row.guid) : false;
          const bg = isSelected ? "rgba(79,143,176,0.15)" : idx % 2 === 0 ? "#0a0a14" : "#0d0d1a";
          return (
            <div key={row.key} onClick={e => row.guid && onSelectGuid(row.guid, e.shiftKey || e.ctrlKey || e.metaKey)} style={{ display: "flex", background: bg, borderBottom: "1px solid #1a1a2a", cursor: "pointer", minHeight: "44px" }}>
              {/* Filename column */}
              <div style={{ width: COL_W_FILENAME, flexShrink: 0, padding: "8px", borderRight: "1px solid #222", fontSize: 11, color: "#4F8FB0", fontFamily: "JetBrains Mono, monospace", overflow: "hidden", whiteSpace: "normal", display: "flex", alignItems: "center", lineHeight: 1.3, wordBreak: "break-word", minHeight: "44px" }}>
                {row.filename}
              </div>

              {/* Data cells */}
              {columns.map(col => {
                const cell = row.cells[col] ?? { v: "" };
                const cellBg = getCellBg(cell, mode);
                const psetInfo = col.startsWith("ADIF_") || col.startsWith("SCFClass_")
                  ? { pset: col.includes("_00_") ? "ADIF_00_Generales" : col.includes("_02_") ? "ADIF_02_Localizacion" : col.includes("_03_") ? "ADIF_03_Coordinacion3D" : col.includes("_04_") ? "ADIF_04_4D" : col.includes("_08_") ? "ADIF_08_DocVinculada" : "SCFClass_Funciones", prop: col }
                  : { pset: "__attr__", prop: col };

                return (
                  <div key={col} onClick={e => { e.stopPropagation(); onCellClick(row.guid ?? row.key, col, cell, row.path, psetInfo); }} style={{ width: getColW(col), flexShrink: 0, padding: "8px", borderRight: "1px solid #222", fontSize: 11, fontFamily: "JetBrains Mono, monospace", background: cellBg !== "transparent" ? cellBg + "44" : "transparent", color: cellBg !== "transparent" ? "#fff" : "#bbb", cursor: "pointer", whiteSpace: "normal", lineHeight: 1.3, wordBreak: "break-word", overflow: "hidden", display: "flex", alignItems: "center", minHeight: "44px" }}>
                    {cell.v || <span style={{ color: "#444", fontStyle: "italic" }}>—</span>}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
