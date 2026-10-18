// Tipos compartidos para la herramienta CLIENT REVIEW

export type CellStatus =
  | "client_red_still_empty"   // rojo cliente, sigue vacío
  | "client_red_fixed"         // rojo cliente, ya corregido
  | "client_red_has_value"     // rojo cliente pero había valor (discrepancia)
  | "ok"
  | "new_empty"                // vacío en disco, no marcado por cliente
  | "not_in_excel";            // elemento no estaba en la revisión del cliente

export interface ReviewCell {
  v: string;
  red?: boolean;               // modo en vivo: rojo por regla de validación
  reason?: string;
  status?: CellStatus;         // modo cliente: estado tras comparación
  client_value?: string;       // valor que tenía el cliente (para discrepancias)
}

export interface ElementRow {
  guid: string;
  filename: string;
  cells: Record<string, ReviewCell>;
}

export interface FileScanResult {
  path: string;
  filename: string;
  file_row?: Record<string, ReviewCell>;
  project_row?: Record<string, ReviewCell>;
  project_guid?: string;
  elements?: ElementRow[];
  stats?: {
    element_count: number;
    red_total: number;
    red_by_col: Record<string, number>;
    by_disciplina: Record<string, number>;
    by_ifc_class: Record<string, number>;
    status_counts?: Record<string, number>;
  };
  client_elements_matched?: number;
  error?: string;
  loading?: boolean;
}

export type ReviewMode = "live" | "client";

export type ReviewTab = "file" | "project" | "element";

export interface ReviewImport {
  review_id: string;
  source_filename: string;
  sheets: Record<string, { rows: number; red_cells: number; columns: string[] }>;
  files_in_excel: string[];
}

export interface BulkFillTarget {
  pset_name: string;
  prop_name: string;
  value: string;
  only_if_empty: boolean;
  create_if_missing: boolean;
}

// Agrupación para bulk-fill
export type FillScope =
  | "file"          // todos los elementos del archivo
  | "ifc_class"     // por clase IFC
  | "name_base"     // por nombre-tipo sin sufijo _123456
  | "empty"         // todos los vacíos del pset+prop
  | "manual";       // GUIDs seleccionados manualmente

export interface BulkFillRequest {
  targets_by_file: Record<string, string[]>;
  fills: BulkFillTarget[];
  ifc_class?: string;
  name_base?: string;
}

// Colores por estado de celda
export const STATUS_COLORS: Record<string, string> = {
  client_red_still_empty: "#ff3355",
  client_red_has_value:   "#D9A441",
  client_red_fixed:       "#3FBE8A",
  new_empty:              "#ff6633",
  not_in_excel:           "#666688",
  ok:                     "transparent",
};

export const LIVE_RED_COLOR = "#ff3355";
export const LIVE_OK_COLOR  = "transparent";

export function getCellBg(cell: ReviewCell, mode: ReviewMode): string {
  if (mode === "client" && cell.status) {
    return STATUS_COLORS[cell.status] ?? "transparent";
  }
  if (mode === "live" && cell.red) return LIVE_RED_COLOR;
  return LIVE_OK_COLOR;
}
