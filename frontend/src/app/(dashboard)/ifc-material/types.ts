// Tipos compartidos de la herramienta IFC Material
// Importados en page.tsx y usados en los componentes extraídos

export interface EntityRow {
  entity_type: string;
  element_count: number;
}

export interface ElementRow {
  uid: string;
  name: string;
  step_id: number;
  entity_type: string;
  material_name: string;
  mat_color: string;
  path: string;
  filename: string;
  material_source?: "ifc_rel" | "pset_fallback";
}

export interface MaterialRow {
  name: string;
  element_count: number;
  color: string;
  file_count: number;
  multi_file: boolean;
}

export interface ImportChange {
  uid: string;
  ifc_file: string;
  path: string;
  step_id: number;
  element_name: string;
  entity_type: string;
  old_material: string;
  new_material: string;
}

export interface RenameOp {
  path: string;
  old_material: string;
  new_material: string;
  step_ids: number[];
}

export interface ProgressState {
  label: string;
  phase: string;
  done?: number;
  total?: number;
}
