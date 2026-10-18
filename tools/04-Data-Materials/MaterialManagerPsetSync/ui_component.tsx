"use client";

/**
 * IFC Material — cascada de 3 paneles
 *
 *   Tipos de elemento  →  Elementos  →  Materiales
 *
 * Los archivos a procesar se toman del árbol de selección (projectStore.selectedPaths).
 * No re-lista los modelos — para eso está el árbol lateral.
 *
 * Funciones:
 *  - Selección de tipos de entidad (con conteo)
 *  - Elementos filtrados por tipos, con material y color
 *  - Materiales agregados, búsqueda, renombrado global / inline / masivo
 *  - Exportar e importar Excel (preview old→new antes de aplicar)
 */

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Search, RefreshCw, Loader2, Check, Pencil, Download, Upload, Zap, X, RefreshCcw,
} from "lucide-react";
import { useProjectStore } from "@/stores/projectStore";
import { API_URL } from "@/lib/api";
import type { EntityRow, ElementRow, MaterialRow, ImportChange, RenameOp, ProgressState } from "./types";
import { VirtualList } from "@/components/ifc-material/VirtualList";
import { ProgressBanner } from "@/components/ifc-material/ProgressBanner";

// ── Helpers de caché de tipos de entidad (sessionStorage, sesión corriente) ──
// La clave incluye la mtime del archivo → se invalida automáticamente si el IFC
// cambia en disco (por un re-export, por ejemplo).
function etCacheKey(path: string, mtime: number) {
  return `ifc-mat-et:${encodeURIComponent(path)}:${mtime}`;
}
function readEtCache(path: string, mtime: number): EntityRow[] | null {
  try {
    const raw = sessionStorage.getItem(etCacheKey(path, mtime));
    return raw ? (JSON.parse(raw) as EntityRow[]) : null;
  } catch { return null; }
}
function writeEtCache(path: string, mtime: number, rows: EntityRow[]) {
  try {
    sessionStorage.setItem(etCacheKey(path, mtime), JSON.stringify(rows));
  } catch { /* quota exceeded — ignorar */ }
}
/** Borra TODAS las entradas ifc-mat-et:* de sessionStorage (fuerza recarga fresca). */
function clearAllEtCache() {
  try {
    const keys = Object.keys(sessionStorage).filter(k => k.startsWith("ifc-mat-et:"));
    keys.forEach(k => sessionStorage.removeItem(k));
  } catch { /* ignorar */ }
}

/** Fetch entity-types para un archivo y guarda en caché si mtime conocida.
 *  Nota: usa la variable API_URL del módulo (ya importada del resto del archivo). */
async function fetchEntityTypes(
  apiUrl: string, path: string, mtime: number, signal?: AbortSignal,
): Promise<EntityRow[]> {
  try {
    const res = await fetch(`${apiUrl}/api/ifc/material/entity-types`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [path] }),
      signal,
    });
    if (!res.ok || signal?.aborted) return [];
    const json: { rows: EntityRow[]; file_mtimes?: Record<string, number> } = await res.json();
    if (signal?.aborted) return [];
    const rows = json.rows;
    const mt = json.file_mtimes?.[path] ?? mtime;
    if (mt > 0) writeEtCache(path, mt, rows);
    return rows;
  } catch (err) {
    if ((err as Error)?.name === "AbortError") return [];
    return [];
  }
}

// ── Component ───────────────────────────────────────────────────────────────
export default function IFCMaterialPage() {
  const { files: storeFiles, selectedPaths } = useProjectStore();

  const targetPaths = useMemo(() => selectedPaths, [selectedPaths]);

  // AbortController para cancelar fetches en curso al desmontar o al relanzar loadAll
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  // Panels state
  const [entityRows, setEntityRows] = useState<EntityRow[]>([]);
  const [selEntities, setSelEntities] = useState<Set<string>>(new Set());
  // allElementRows = todos los elementos de todos los tipos (cargados una sola vez)
  // elementRows    = filtrado en cliente por selEntities (sin API call en cada toggle)
  const [allElementRows, setAllElementRows] = useState<ElementRow[]>([]);
  const elementRows = useMemo(
    () => allElementRows.filter(e => selEntities.has(e.entity_type)),
    [allElementRows, selEntities],
  );
  const [selElements, setSelElements] = useState<Set<string>>(new Set());

  const [loadingEntities, setLoadingEntities] = useState(false);
  const [loadingElements, setLoadingElements] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [filterText, setFilterText] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // Global material rename
  const [editingMat, setEditingMat] = useState<string>("");
  const [editingMatInput, setEditingMatInput] = useState("");
  // Bulk rename for selected elements
  const [bulkInput, setBulkInput] = useState("");
  const [saving, setSaving] = useState(false);
  // Cola de renombrados: se acumulan en memoria y se escriben a disco todos
  // juntos (1 escritura por archivo) al pulsar "Aplicar todo", en vez de una
  // escritura completa del IFC por cada material renombrado.
  const pendingIdRef = useRef(0);
  const [pendingChanges, setPendingChanges] = useState<
    { id: number; label: string; count: number; ops: RenameOp[] }[]
  >([]);
  // Ref mutable para leer pendingChanges dentro de loadAll sin añadirlo como dep
  const pendingChangesRef = useRef(pendingChanges);
  useEffect(() => { pendingChangesRef.current = pendingChanges; }, [pendingChanges]);
  const [progress, setProgress] = useState<{
    label: string; phase: string;
    done?: number; total?: number;
  } | null>(null);

  // Excel import
  const [importChanges, setImportChanges] = useState<ImportChange[]>([]);
  const [importMode, setImportMode] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Pset sync
  const [syncing, setSyncing] = useState(false);
  // Archivos con cambios pendientes de sincronizar a Psets
  const [dirtyPaths, _setDirtyPaths] = useState<Set<string>>(new Set());
  // Ref mutable para leer dirtyPaths dentro de loadAll sin añadirlo como dep
  const dirtyRef = useRef<Set<string>>(new Set());
  const setDirtyPaths = useCallback((v: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    const next = typeof v === "function" ? v(dirtyRef.current) : v;
    dirtyRef.current = next;
    _setDirtyPaths(next);
  }, []);

  // allSelected: cortocircuito O(1) para "todos seleccionados"
  // Evita el spread O(n) al hacer "Seleccionar todo" con 7500+ elementos
  const [allSelected, setAllSelected] = useState(true);

  // Active material filter (click on material → pin matching elements to top)
  const [activeMaterialFilter, setActiveMaterialFilter] = useState<string | null>(null);

  // ── Materiales: agregación 100% en cliente ────────────────────────────────
  const materialRows = useMemo<MaterialRow[]>(() => {
    const merged: Record<string, { name: string; element_count: number; color: string; files: Set<string> }> = {};
    for (const e of elementRows) {
      if (!allSelected && !selElements.has(e.uid)) continue;
      let g = merged[e.material_name];
      if (!g) { g = { name: e.material_name, element_count: 0, color: e.mat_color, files: new Set() }; merged[e.material_name] = g; }
      g.element_count += 1;
      g.files.add(e.path);
    }
    return Object.values(merged)
      .map(g => ({ name: g.name, element_count: g.element_count, color: g.color, file_count: g.files.size, multi_file: g.files.size > 1 }))
      .sort((a, b) => b.element_count - a.element_count);
  }, [elementRows, selElements, allSelected]);

  // ── Helper: nombre corto de archivo ──────────────────────────────────────
  const shortName = (path: string) =>
    path.replace(/\\/g, "/").split("/").pop()?.replace(/\.ifc$/i, "") ?? path;

  // Estimación de cuántos elementos tiene cada archivo (suma de entity-types ya
  // cargados), usada solo para animar la barra de progreso — ifcopenshell no
  // expone un callback de "N de M entidades parseadas" durante la apertura del
  // archivo, así que esto interpola hacia el total conocido en vez de mostrar
  // un progreso literal del servidor.
  const fileExpectedCountRef = useRef<Record<string, number>>({});

  // ── Carga elementos en paralelo (todos los archivos a la vez) ────────────
  // Promise.allSettled: un archivo fallido no bloquea los que sí cargan.
  const loadElementsByFile = useCallback(async (
    paths: string[], allTypes: string[], totalHint: number, progressLabel: string,
    signal?: AbortSignal,
    // Llamado en cuanto termina CADA archivo, para que la UI vaya mostrando
    // elementos/materiales progresivamente en vez de esperar a los N archivos.
    onFileRows?: (rows: ElementRow[]) => void,
  ): Promise<ElementRow[]> => {
    if (signal?.aborted) return [];

    // Progreso global en ELEMENTOS (no en archivos): con esto la barra visual
    // se llena de forma proporcional y suave (300/3000, 600/3000…) en vez de
    // saltar solo de 0% a 50% a 100% por archivo completado.
    const overallTotal = paths.reduce((s, p) => s + (fileExpectedCountRef.current[p] ?? 0), 0) || paths.length;
    const perFileDone: Record<string, number> = {};
    const emitOverall = (currentFileLabel: string) => {
      if (signal?.aborted) return;
      const doneSum = Object.values(perFileDone).reduce((a, b) => a + b, 0);
      setProgress({
        label: progressLabel,
        phase: currentFileLabel,
        done: Math.round(doneSum), total: overallTotal,
      });
    };

    emitOverall(`Cargando ${paths.length} archivo(s) en paralelo…`);
    let completed = 0;

    const settled = await Promise.allSettled(
      paths.map(async (path) => {
        if (signal?.aborted) return [] as ElementRow[];

        // Animación de progreso: interpola de 0 al total estimado del archivo
        // a lo largo de una duración estimada (≈1ms/elemento, calibrado contra
        // un IFC real de 130MB/9200 elementos ≈ 9s). Se detiene en 92% hasta
        // que llega la respuesta real, para no dar sensación de "completo" antes de tiempo.
        const expected = fileExpectedCountRef.current[path] ?? 0;
        perFileDone[path] = 0;
        let tickHandle: ReturnType<typeof setInterval> | undefined;
        if (expected > 0) {
          const estMs = Math.min(60000, Math.max(800, expected * 1.0));
          const startedAt = performance.now();
          tickHandle = setInterval(() => {
            if (signal?.aborted) return;
            const frac = Math.min(0.92, (performance.now() - startedAt) / estMs);
            const approx = Math.round(expected * frac);
            perFileDone[path] = approx;
            emitOverall(`${shortName(path)} · ${approx}/${expected} elemento(s) (estimado)…`);
          }, 200);
        }

        try {
          const res = await fetch(`${API_URL}/api/ifc/material/elements`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paths: [path], entity_types: allTypes }),
            signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status} — ${shortName(path)}`);
          const json: { rows: ElementRow[] } = await res.json();
          completed++;
          perFileDone[path] = json.rows.length;
          if (!signal?.aborted) {
            emitOverall(`${shortName(path)} · listo (${completed}/${paths.length}) · ${json.rows.length} elemento(s)`);
            onFileRows?.(json.rows);
          }
          return json.rows;
        } finally {
          if (tickHandle) clearInterval(tickHandle);
        }
      }),
    );

    const results: ElementRow[] = [];
    for (const r of settled) {
      if (r.status === "fulfilled") results.push(...r.value);
    }
    return results;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetPaths]);

  // ── Recarga solo elementos (post-rename/sync/import) ─────────────────────
  const reloadElements = useCallback(async (allTypes: string[], totalHint = 0) => {
    if (targetPaths.length === 0 || allTypes.length === 0) return;
    setLoadingElements(true);
    try {
      const rows = await loadElementsByFile(targetPaths, allTypes, totalHint, "Recargando elementos");
      setAllElementRows(rows);
      setAllSelected(true);
      setSelElements(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoadingElements(false);
    }
  }, [targetPaths, loadElementsByFile]);

  // ── Carga inicial: tipos + TODOS los elementos en secuencia ──────────────
  const loadAll = useCallback(async () => {
    // Cancelar carga anterior (ej. navegación rapida o cambio de selección)
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;

    // Advertir si hay cambios EN COLA sin guardar (aún no escritos a disco) — más
    // crítico que el aviso de sincronización, porque perderlos borra el trabajo.
    if (pendingChangesRef.current.length > 0 && allElementRows.length > 0) {
      const total = pendingChangesRef.current.reduce((s, p) => s + p.count, 0);
      const ok = window.confirm(
        `Tienes ${pendingChangesRef.current.length} cambio(s) sin guardar (${total} elemento(s)).\n¿Continuar y perderlos?\n\n(Pulsa Cancelar para aplicarlos primero)`
      );
      if (!ok) return;
    }
    setPendingChanges([]);
    // Advertir si hay cambios pendientes de sincronizar antes de cambiar selección
    if (dirtyRef.current.size > 0 && allElementRows.length > 0) {
      const ok = window.confirm(
        `Tienes cambios sin sincronizar en ${dirtyRef.current.size} archivo(s).\n¿Continuar y perder los cambios?\n\n(Pulsa Cancelar para sincronizar primero)`
      );
      if (!ok) return;
    }
    setDirtyPaths(new Set()); // fresh load = nada pendiente de sincronizar
    if (targetPaths.length === 0) {
      setEntityRows([]); setAllElementRows([]);
      setSelEntities(new Set()); setSelElements(new Set());
      setAllSelected(true);
      return;
    }
    setLoadingEntities(true); setError(null);
    try {
      // Carga tipos por archivo en paralelo con progreso progresivo.
      // Cada archivo que termina actualiza inmediatamente el panel de tipos —
      // el usuario ve resultados al cabo de ~segundos, no de minutos.
      setProgress({ label: "Cargando tipos de elemento", phase: `Verificando archivos…` });
      const mergedTypes: Record<string, number> = {};
      let etDone = 0;

      // ── Paso A: obtener mtimes de todos los archivos con una sola llamada ──
      // os.stat() es instantáneo; no abre los IFC. Permite validar la caché.
      let fileMtimes: Record<string, number> = {};
      try {
        const mtRes = await fetch(`${API_URL}/api/ifc/material/file-mtimes`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths: targetPaths }), signal: ctl.signal,
        });
        if (mtRes.ok && !ctl.signal.aborted) {
          const mtJson: { file_mtimes: Record<string, number> } = await mtRes.json();
          fileMtimes = mtJson.file_mtimes;
        }
      } catch { /* no bloquear si falla */ }

      if (ctl.signal.aborted) return;

      // ── Paso B: para cada archivo, usar caché o pedir entity-types ──────────
      setProgress({ label: "Cargando tipos de elemento", phase: `0/${targetPaths.length} archivos…`, done: 0, total: targetPaths.length });

      await Promise.allSettled(
        targetPaths.map(async (path) => {
          if (ctl.signal.aborted) return;
          const mtime = fileMtimes[path] ?? 0;
          let rows: EntityRow[];
          let fromCache = false;

          // Intentar caché (solo válida si tenemos mtime y hay entrada con esa mtime)
          if (mtime > 0) {
            const cached = readEtCache(path, mtime);
            if (cached) {
              rows = cached;
              fromCache = true;
            } else {
              rows = await fetchEntityTypes(API_URL, path, mtime, ctl.signal);
            }
          } else {
            rows = await fetchEntityTypes(API_URL, path, mtime, ctl.signal);
          }

          if (ctl.signal.aborted) return;
          for (const r of rows) {
            mergedTypes[r.entity_type] = (mergedTypes[r.entity_type] ?? 0) + r.element_count;
          }
          // Guardar el total de este archivo para animar su barra de progreso
          // durante la carga de elementos (paso siguiente).
          fileExpectedCountRef.current[path] = rows.reduce((s, r) => s + r.element_count, 0);
          etDone++;
          if (!ctl.signal.aborted) {
            const currentRows = Object.entries(mergedTypes)
              .map(([entity_type, element_count]) => ({ entity_type, element_count }))
              .sort((a, b) => b.element_count - a.element_count);
            setEntityRows(currentRows);
            setSelEntities(new Set(currentRows.map(r => r.entity_type)));
            setProgress({
              label: "Cargando tipos de elemento",
              phase: `${etDone}/${targetPaths.length} archivos${fromCache ? " ⚡caché" : ""} cargados`,
              done: etDone, total: targetPaths.length,
            });
          }
        })
      );

      if (ctl.signal.aborted) return;
      setLoadingEntities(false);

      const finalRows = Object.entries(mergedTypes)
        .map(([entity_type, element_count]) => ({ entity_type, element_count }))
        .sort((a, b) => b.element_count - a.element_count);
      if (finalRows.length === 0) return;
      const allTypes = finalRows.map(r => r.entity_type);
      const totalHint = finalRows.reduce((s, r) => s + r.element_count, 0);
      setLoadingElements(true);
      // Carga progresiva: se vacía la lista y cada archivo que termina se añade
      // al momento — con 25 modelos el usuario ya ve (y puede filtrar) los
      // primeros en segundos, sin esperar a que acabe el más pesado.
      setAllElementRows([]);
      setAllSelected(true);
      setSelElements(new Set());
      setActiveMaterialFilter(null);
      // Sin reemplazo final: los rows ya se añadieron uno a uno, y reemplazar
      // pisaría renombrados en cola hechos mientras aún cargaba.
      await loadElementsByFile(
        targetPaths, allTypes, totalHint, "Cargando elementos", ctl.signal,
        (fileRows) => {
          if (ctl.signal.aborted || fileRows.length === 0) return;
          setAllElementRows(prev => prev.concat(fileRows));
        },
      );
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return; // navegación normal, no es un error
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      if (!ctl.signal.aborted) {
        setLoadingEntities(false);
        setLoadingElements(false);
        setProgress(null);
      }
    }
  }, [targetPaths, loadElementsByFile]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Recarga forzada: borra caché local para que todo se re-descargue del servidor
  const forceReload = useCallback(() => {
    clearAllEtCache();
    loadAll();
  }, [loadAll]);

  // ── Toggle helpers ─────────────────────────────────────────────────────────
  const toggleEntity = (et: string) => {
    setSelEntities(prev => {
      const next = new Set(prev);
      next.has(et) ? next.delete(et) : next.add(et);
      return next;
    });
  };
  const toggleAllEntities = () => {
    setSelEntities(prev => prev.size === entityRows.length ? new Set() : new Set(entityRows.map(r => r.entity_type)));
  };

  const toggleElement = (uid: string) => {
    setSelElements(prev => {
      const next = new Set(prev);
      next.has(uid) ? next.delete(uid) : next.add(uid);
      return next;
    });
  };
  const toggleAllElements = () => {
    if (allSelected) {
      setAllSelected(false);
      setSelElements(new Set());
    } else {
      setAllSelected(true);
      setSelElements(new Set());
    }
  };

  // Click a material → select only elements with that material + pin them to top
  const selectByMaterial = (matName: string) => {
    if (activeMaterialFilter === matName) {
      setActiveMaterialFilter(null);
      setAllSelected(true);
      setSelElements(new Set());
    } else {
      setActiveMaterialFilter(matName);
      setAllSelected(false);
      setSelElements(new Set(elementRows.filter(e => e.material_name === matName).map(e => e.uid)));
    }
  };

  // Elements sorted: matching active filter first, rest after
  const sortedElementRows = useMemo(() => {
    if (!activeMaterialFilter) return elementRows;
    const match = elementRows.filter(e => e.material_name === activeMaterialFilter);
    const rest  = elementRows.filter(e => e.material_name !== activeMaterialFilter);
    return [...match, ...rest];
  }, [elementRows, activeMaterialFilter]);

  // ── Rename operations ──────────────────────────────────────────────────────
  // Parche local (optimista): refleja el material "en cola" en la vista sin
  // tocar el backend todavía — el archivo en disco no cambia hasta aplicar.
  const patchLocalMaterial = useCallback((ops: RenameOp[]) => {
    const stepIdMap = new Map<string, string>();
    for (const op of ops) {
      for (const sid of op.step_ids) stepIdMap.set(`${op.path}|${sid}`, op.new_material);
    }
    setAllElementRows(prev => {
      const colorCache: Record<string, string> = {};
      for (const op of ops) {
        if (!colorCache[op.new_material]) {
          const sample = prev.find(e => e.material_name === op.new_material);
          colorCache[op.new_material] = sample?.mat_color ?? "#888888";
        }
      }
      return prev.map(row => {
        const newMat = stepIdMap.get(`${row.path}|${row.step_id}`);
        if (!newMat) return row;
        return { ...row, material_name: newMat, mat_color: colorCache[newMat] ?? "#888888" };
      });
    });
  }, []);

  // Encola un renombrado (pencil o bulk): NO escribe a disco. Se acumula junto
  // con otros cambios hasta que el usuario pulse "Aplicar todo".
  const queueChange = useCallback((ops: RenameOp[], label: string) => {
    const count = ops.reduce((s, o) => s + o.step_ids.length, 0);
    if (count === 0) { setMsg({ text: "Nada que renombrar", ok: false }); return; }
    patchLocalMaterial(ops);
    setPendingChanges(prev => [...prev, { id: pendingIdRef.current++, label, count, ops }]);
    setMsg({ text: `En cola: ${label} (${count} elem.) · pulsa "Aplicar todo" para guardar en disco`, ok: true });
  }, [patchLocalMaterial]);

  // Aplica TODOS los cambios en cola en una sola llamada al backend, que a su
  // vez agrupa por archivo y escribe cada IFC UNA sola vez (ver material_rename
  // en routers/ifc.py) sin importar cuántos materiales distintos se cambiaron.
  const applyPendingChanges = useCallback(async () => {
    if (pendingChanges.length === 0) return;
    const allOps = pendingChanges.flatMap(p => p.ops);
    const total = allOps.reduce((s, o) => s + o.step_ids.length, 0);
    const affectedFiles = Array.from(new Set(allOps.map(o => shortName(o.path))));
    const confirmMsg =
      `¿Guardar ${pendingChanges.length} cambio(s) (${total} elemento(s)) en ${affectedFiles.length} archivo(s)?\n\n` +
      pendingChanges.map(p => `• ${p.label} (${p.count} elem.)`).join("\n") +
      `\n\nArchivos: ${affectedFiles.join(", ")}`;
    if (!window.confirm(confirmMsg)) return;
    setSaving(true); setMsg(null);
    setProgress({ label: "Aplicando cambios", phase: `Escribiendo en IFC · ${total} elemento(s) en ${affectedFiles.length} archivo(s)...` });
    try {
      const res = await fetch(`${API_URL}/api/ifc/material/rename`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ops: allOps }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: { total_changed: number; errors?: string[] } = await res.json();
      setDirtyPaths(prev => {
        const next = new Set(prev);
        for (const o of allOps) next.add(o.path);
        return next;
      });
      setPendingChanges([]);
      const errPart = json.errors?.length ? ` (${json.errors.length} error(es))` : "";
      setMsg({ text: `${json.total_changed} elemento(s) guardados en ${affectedFiles.length} archivo(s)${errPart}`, ok: !json.errors?.length });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Error al guardar", ok: false });
    } finally {
      setSaving(false);
      setProgress(null);
    }
  }, [pendingChanges]);

  // Descarta la cola sin escribir a disco y recarga desde el servidor para
  // revertir el parche local optimista.
  const discardPendingChanges = useCallback(() => {
    if (pendingChanges.length === 0) return;
    const total = pendingChanges.reduce((s, p) => s + p.count, 0);
    if (!window.confirm(`¿Descartar ${pendingChanges.length} cambio(s) sin guardar (${total} elemento(s))?`)) return;
    setPendingChanges([]);
    const allTypes = entityRows.map(r => r.entity_type);
    const totalHint = entityRows.reduce((s, r) => s + r.element_count, 0);
    reloadElements(allTypes, totalHint);
  }, [pendingChanges, entityRows, reloadElements]);

  const saveGlobalRename = useCallback((oldName: string) => {
    const newName = editingMatInput.trim();
    if (!newName || newName === oldName) { setEditingMat(""); return; }
    const byPath: Record<string, number[]> = {};
    for (const e of elementRows) {
      // Mismo criterio que materialRows: con "Todos" marcado (allSelected) se
      // incluyen todos los elementos de ese material, no solo los marcados a
      // mano en selElements — si no, con la selección por defecto (allSelected
      // = true, selElements vacío) esto nunca encontraba nada que renombrar,
      // sin importar el material.
      if ((allSelected || selElements.has(e.uid)) && e.material_name === oldName) {
        if (!byPath[e.path]) byPath[e.path] = [];
        byPath[e.path].push(e.step_id);
      }
    }
    const ops = Object.entries(byPath).map(([path, step_ids]) => ({
      path, old_material: oldName, new_material: newName, step_ids,
    }));
    setEditingMat("");
    queueChange(ops, `'${oldName}' → '${newName}'`);
  }, [editingMatInput, elementRows, selElements, allSelected, queueChange]);

  const saveBulkRename = useCallback(() => {
    const newName = bulkInput.trim();
    if (!newName) return;
    const byKey: Record<string, { path: string; old_material: string; step_ids: number[] }> = {};
    for (const e of elementRows) {
      // Mismo criterio que materialRows (ver comentario en saveGlobalRename).
      if (!allSelected && !selElements.has(e.uid)) continue;
      const key = `${e.path}||${e.material_name}`;
      if (!byKey[key]) byKey[key] = { path: e.path, old_material: e.material_name, step_ids: [] };
      byKey[key].step_ids.push(e.step_id);
    }
    const ops = Object.values(byKey).map(g => ({ ...g, new_material: newName }));
    setBulkInput("");
    queueChange(ops, `→ '${newName}'`);
  }, [bulkInput, elementRows, selElements, allSelected, queueChange]);

  // ── Excel export ───────────────────────────────────────────────────────────
  const exportExcel = useCallback(async (filterMaterial?: string) => {
    const rows = elementRows.filter(e => selElements.has(e.uid));
    try {
      const res = await fetch(`${API_URL}/api/ifc/material/export-excel`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ element_rows: rows, filter_material: filterMaterial ?? null }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: { base64: string; filename: string } = await res.json();
      const bin = atob(json.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filterMaterial ? `material_${filterMaterial}.xlsx` : json.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Error al exportar", ok: false });
    }
  }, [elementRows, selElements]);

  // ── Excel import ───────────────────────────────────────────────────────────
  const onImportFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (allElementRows.length === 0) {
      setMsg({ text: "Carga los elementos primero antes de importar Excel", ok: false });
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    const folder = allElementRows[0]?.path ? allElementRows[0].path.replace(/[/\\][^/\\]*$/, "") : "";
    const fd = new FormData();
    fd.append("file", file);
    fd.append("folder", folder);
    setMsg(null);
    try {
      const res = await fetch(`${API_URL}/api/ifc/material/import-excel-preview`, { method: "POST", body: fd });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: { changes: ImportChange[] } = await res.json();
      if (json.changes.length === 0) {
        setMsg({ text: "El Excel coincide con el estado actual. Sin cambios.", ok: true });
      } else {
        setImportChanges(json.changes);
        setImportMode(true);
      }
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : "Error al importar", ok: false });
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [elementRows]);

  const applyImport = useCallback(async () => {
    setSaving(true);
    const allTypes = entityRows.map(r => r.entity_type);
    const totalHint = entityRows.reduce((s, r) => s + r.element_count, 0);
    setProgress({ label: "Aplicando cambios Excel", phase: `${importChanges.length} modificación(es) pendientes...` });
    try {
      const res = await fetch(`${API_URL}/api/ifc/material/import-excel-apply`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes: importChanges }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: { total_changed: number } = await res.json();
      setMsg({ text: `${json.total_changed} elemento(s) actualizados desde Excel`, ok: true });
      setImportMode(false); setImportChanges([]);
      // Marcar todos los archivos afectados por el import como sucios
      setDirtyPaths(prev => {
        const next = new Set(prev);
        for (const c of importChanges) next.add(c.path);
        return next;
      });
      await reloadElements(allTypes, totalHint);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Error al aplicar", ok: false });
    } finally {
      setSaving(false);
      setProgress(null);
    }
  }, [importChanges, entityRows, reloadElements]);

  // ── Sync IfcMaterial → Pset "Material" property (solo archivos con cambios) ──
  const syncAllToPsets = useCallback(async () => {
    if (targetPaths.length === 0) return;
    // Solo sincronizar archivos que tienen cambios pendientes
    const pathsToSync = targetPaths.filter(p => dirtyPaths.has(p));
    if (pathsToSync.length === 0) {
      setMsg({ text: "Sin cambios pendientes de sincronizar", ok: true });
      return;
    }
    setSyncing(true);
    const allTypes = entityRows.map(r => r.entity_type);
    const totalHint = entityRows.reduce((s, r) => s + r.element_count, 0);
    let totalElements = 0, totalPsets = 0;
    const allErrors: string[] = [];
    try {
      for (let i = 0; i < pathsToSync.length; i++) {
        const fname = shortName(pathsToSync[i]);
        setProgress({
          label: "Sincronizar IFC → Psets",
          phase: `${fname} · archivo ${i + 1}/${pathsToSync.length}`,
          done: i, total: pathsToSync.length,
        });
        const res = await fetch(`${API_URL}/api/ifc/material/sync-all-to-psets`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths: [pathsToSync[i]] }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: { total_elements: number; total_psets_updated: number; errors: string[] } = await res.json();
        totalElements += json.total_elements;
        totalPsets += json.total_psets_updated;
        allErrors.push(...json.errors);
        setProgress({
          label: "Sincronizar IFC → Psets",
          phase: `${fname} · ${json.total_psets_updated} Psets escritos`,
          done: i + 1, total: pathsToSync.length,
        });
      }
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith("psets-index:") || k.startsWith("pset-values:"))) keysToRemove.push(k);
      }
      keysToRemove.forEach(k => localStorage.removeItem(k));
      const errPart = allErrors.length > 0 ? ` (${allErrors.length} error(es))` : "";
      setMsg({ text: `${totalElements} elem · ${totalPsets} Psets sincronizados${errPart}`, ok: allErrors.length === 0 });
      setDirtyPaths(new Set()); // sync completado → todo limpio
      await reloadElements(allTypes, totalHint);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Error al sincronizar", ok: false });
    } finally {
      setSyncing(false);
      setProgress(null);
    }
  }, [targetPaths, dirtyPaths, entityRows, reloadElements]);

  // ── Derived ─────────────────────────────────────────────────────────────
  const filteredMaterials = useMemo(() => {
    if (!filterText) return materialRows;
    const ft = filterText.toLowerCase();
    return materialRows.filter(m => m.name.toLowerCase().includes(ft));
  }, [materialRows, filterText]);

  const totalMatElements = useMemo(
    () => materialRows.reduce((s, m) => s + m.element_count, 0),
    [materialRows],
  );
  const fileLabel = selectedPaths.length > 0
    ? `${selectedPaths.length} archivo(s) seleccionado(s)`
    : "ningún archivo seleccionado — usa el árbol";

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <h1 style={{
          fontSize: 20, fontWeight: 700, color: "var(--cyan)", letterSpacing: "0.08em", margin: 0,
        }}>
          IFC MATERIAL
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
          Análisis y edición de materiales por elemento · {fileLabel} · usa el árbol para elegir archivos
        </p>
      </div>

      {progress && <ProgressBanner label={progress.label} phase={progress.phase} />}
      {error && (
        <div style={{ background: "rgba(255,51,85,0.1)", border: "1px solid var(--red)", borderRadius: 6, padding: "8px 14px", marginBottom: 12, color: "var(--red)", fontSize: 11 }}>{error}</div>
      )}
      {msg && (
        <div style={{
          background: msg.ok ? "rgba(63,190,138,0.1)" : "rgba(255,51,85,0.1)",
          border: `1px solid ${msg.ok ? "var(--green)" : "var(--red)"}`,
          borderRadius: 6, padding: "8px 14px", marginBottom: 12,
          color: msg.ok ? "var(--green)" : "var(--red)", fontSize: 12,
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <span>{msg.ok ? "✅ " : ""}{msg.text}</span>
          <X size={14} style={{ cursor: "pointer" }} onClick={() => setMsg(null)} />
        </div>
      )}

      {/* Cola de renombrados pendientes: nada se escribe a disco hasta "Aplicar todo" */}
      {pendingChanges.length > 0 && (
        <div className="card-cyber" style={{ padding: 14, marginBottom: 14, border: "1px solid var(--yellow)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--yellow)" }}>
              {pendingChanges.length} cambio(s) en cola · {pendingChanges.reduce((s, p) => s + p.count, 0)} elemento(s) · sin guardar todavía
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={applyPendingChanges} disabled={saving} style={btnStyle("var(--yellow)", "rgba(217,164,65,0.12)")}>
                {saving ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Aplicar todo
              </button>
              <button onClick={discardPendingChanges} disabled={saving} style={btnStyle("var(--text-muted)", "transparent")}>
                <X size={13} /> Descartar
              </button>
            </div>
          </div>
          <div style={{ maxHeight: 140, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
            {pendingChanges.map(p => (
              <div key={p.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "3px 0" }}>
                <span style={{ color: "var(--text)" }}>{p.label}</span>
                <span style={{ color: "var(--text-muted)" }}>{p.count} elem.</span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 8 }}>
            Ningún archivo se escribe a disco hasta que pulses &quot;Aplicar todo&quot; — puedes seguir renombrando otros materiales antes de guardar. Al guardar, cada archivo se reescribe una única vez sin importar cuántos materiales hayas cambiado.
          </div>
        </div>
      )}

      {/* Sincronizar IFC → Psets: qué archivos quedaron pendientes y qué hace */}
      {pendingChanges.length === 0 && dirtyPaths.size > 0 && (
        <div className="card-cyber" style={{ padding: 12, marginBottom: 14, border: "1px solid var(--magenta)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14 }}>
            <div style={{ fontSize: 11, color: "var(--text)" }}>
              <strong style={{ color: "var(--magenta)" }}>Sincronizar IFC → Psets</strong> pendiente en {dirtyPaths.size} archivo(s): {Array.from(dirtyPaths).map(shortName).join(", ")}
              <div style={{ color: "var(--text-muted)", marginTop: 4 }}>
                Escribe el material actual como texto en la propiedad &quot;Material&quot; de todos los Psets de los elementos afectados, para que Value Search y otras herramientas muestren el mismo valor que aquí.
              </div>
            </div>
            <button onClick={syncAllToPsets} disabled={syncing} style={{ ...btnStyle("var(--magenta)", "rgba(122,111,217,0.12)"), flexShrink: 0 }}>
              {syncing ? <Loader2 size={13} className="spin" /> : <RefreshCcw size={13} />} Sincronizar ({dirtyPaths.size})
            </button>
          </div>
        </div>
      )}

      {/* Excel import preview banner */}
      {importMode && (
        <div className="card-cyber" style={{ padding: 14, marginBottom: 14, border: "1px solid var(--magenta)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--magenta)" }}>
              {importChanges.length} cambio(s) detectado(s) desde Excel
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={applyImport} disabled={saving} style={btnStyle("var(--magenta)", "rgba(122,111,217,0.12)")}>
                {saving ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Aplicar todos
              </button>
              <button onClick={() => { setImportMode(false); setImportChanges([]); }} style={btnStyle("var(--text-muted)", "transparent")}>
                <X size={13} /> Cancelar
              </button>
            </div>
          </div>
          <div style={{ maxHeight: 180, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
            {importChanges.map((c, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11, padding: "3px 0" }}>
                <span style={{ color: "var(--cyan)", minWidth: 90 }}>{c.entity_type.replace(/^Ifc/, "")}</span>
                <span style={{ color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.element_name} <span style={{ color: "var(--text-muted)", opacity: 0.6 }}>· {c.ifc_file}</span></span>
                <span style={{ color: "var(--red)", textDecoration: "line-through" }}>{c.old_material}</span>
                <span style={{ color: "var(--text-muted)" }}>→</span>
                <span style={{ color: "var(--green)" }}>{c.new_material}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── 3-column cascade ── */}
      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr 300px", gap: 12, alignItems: "start" }}>

        {/* ── Panel 1: Tipos de elemento ── */}
        <div className="card-cyber" style={{ padding: 0, overflow: "hidden", maxHeight: "calc(100vh - 240px)", display: "flex", flexDirection: "column" }}>
          <PanelHeader title="TIPOS DE ELEMENTO" count={`${selEntities.size}/${entityRows.length}`} loading={loadingEntities} onReload={forceReload} />
          <div style={{ padding: "4px 8px", borderBottom: "1px solid var(--border)" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text-muted)", cursor: "pointer" }}>
              <Checkbox checked={selEntities.size === entityRows.length && entityRows.length > 0} onClick={toggleAllEntities} />
              Todos
            </label>
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {entityRows.map(r => {
              const checked = selEntities.has(r.entity_type);
              return (
                <div key={r.entity_type} onClick={() => toggleEntity(r.entity_type)}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", cursor: "pointer", borderBottom: "1px solid rgba(30,45,74,0.3)", background: checked ? "rgba(91,140,255,0.06)" : "transparent" }}>
                  <Checkbox checked={checked} />
                  <span style={{ fontSize: 10.5, color: checked ? "var(--cyan)" : "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.entity_type.replace(/^Ifc/, "")}
                  </span>
                  <span style={{ fontSize: 9, color: "var(--text-muted)" }}>{r.element_count}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Panel 2: Elementos ── */}
        <div className="card-cyber" style={{ padding: 0, overflow: "hidden", maxHeight: "calc(100vh - 240px)", display: "flex", flexDirection: "column" }}>
          <PanelHeader title="ELEMENTOS" count={`${allSelected ? elementRows.length : selElements.size}/${elementRows.length}`} loading={loadingElements} />
          {selElements.size >= 2 && (
            <div style={{ display: "flex", gap: 6, padding: "6px 8px", borderBottom: "1px solid var(--border)", background: "rgba(122,111,217,0.04)" }}>
              <input
                value={bulkInput}
                onChange={(e) => setBulkInput(e.target.value)}
                placeholder={`Nuevo material para ${selElements.size} elem...`}
                style={{ flex: 1, background: "var(--background)", border: "1px solid var(--border)", borderRadius: 4, padding: "4px 8px", color: "var(--text)", fontSize: 11, fontFamily: "inherit", outline: "none" }}
              />
              <button onClick={saveBulkRename} disabled={saving || !bulkInput.trim()} style={btnStyle("var(--magenta)", "rgba(122,111,217,0.12)")}>
                {saving ? <Loader2 size={12} className="spin" /> : <Zap size={12} />} Aplicar
              </button>
            </div>
          )}
          <div style={{ padding: "4px 8px", borderBottom: "1px solid var(--border)" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text-muted)", cursor: "pointer" }}>
              <Checkbox checked={allSelected && elementRows.length > 0} onClick={toggleAllElements} />
              Todos
            </label>
          </div>
          {loadingElements && sortedElementRows.length === 0 ? (
            <LoadingRow />
          ) : (
            <VirtualList
              items={sortedElementRows}
              rowHeight={28}
              keyExtractor={(r) => r.uid}
              renderRow={(r) => {
                const checked = selElements.has(r.uid);
                const dimmed = activeMaterialFilter !== null && !checked;
                return (
                  <div onClick={() => toggleElement(r.uid)}
                    style={{ display: "flex", alignItems: "center", gap: 6, height: "100%", padding: "0 8px", boxSizing: "border-box", cursor: "pointer", borderBottom: "1px solid rgba(30,45,74,0.3)", background: checked ? "rgba(91,140,255,0.06)" : "transparent", opacity: dimmed ? 0.35 : 1 }}>
                    <Checkbox checked={checked} />
                    <span style={{ fontSize: 9, color: "var(--cyan)", background: "rgba(91,140,255,0.08)", borderRadius: 3, padding: "1px 5px", flexShrink: 0 }}>
                      {r.entity_type.replace(/^Ifc/, "")}
                    </span>
                    {r.material_source === "pset_fallback" && (
                      <span title="Material desde Pset (sin IfcRelAssociatesMaterial)" style={{ fontSize: 7, color: "var(--yellow)", background: "rgba(217,164,65,0.1)", borderRadius: 2, padding: "1px 3px", flexShrink: 0, lineHeight: 1 }}>
                        P
                      </span>
                    )}
                    <span style={{ fontSize: 10.5, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.name}>
                      {r.name}
                    </span>
                    <span style={{ width: 9, height: 9, borderRadius: 2, background: r.mat_color, flexShrink: 0 }} title={r.material_name} />
                    <span style={{ fontSize: 9, color: "var(--text-muted)", maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.material_name}>
                      {r.material_name}
                    </span>
                  </div>
                );
              }}
            />
          )}
        </div>

        {/* ── Panel 3: Materiales ── */}
        <div className="card-cyber" style={{ padding: 0, overflow: "hidden", maxHeight: "calc(100vh - 240px)", display: "flex", flexDirection: "column" }}>
          <PanelHeader title="MATERIALES" count={`${totalMatElements} elem`} loading={loadingElements} />
          <div style={{ display: "flex", gap: 6, padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
            <button onClick={() => exportExcel()} style={btnStyle("var(--green)", "rgba(63,190,138,0.1)")}>
              <Download size={12} /> Exportar
            </button>
            <button onClick={() => fileInputRef.current?.click()} style={btnStyle("var(--cyan)", "rgba(91,140,255,0.08)")}>
              <Upload size={12} /> Importar
            </button>
            <button
              onClick={syncAllToPsets}
              disabled={syncing || targetPaths.length === 0 || pendingChanges.length > 0}
              title={
                pendingChanges.length > 0
                  ? "Aplica primero los cambios en cola (\"Aplicar todo\")"
                  : dirtyPaths.size === 0 ? "Sin cambios pendientes" : `Sincronizar ${dirtyPaths.size} archivo(s) con cambios a Psets`
              }
              style={btnStyle(
                dirtyPaths.size > 0 ? "var(--magenta)" : "var(--text-muted)",
                dirtyPaths.size > 0 ? "rgba(122,111,217,0.1)" : "rgba(255,255,255,0.03)",
              )}
            >
              {syncing ? <Loader2 size={12} className="spin" /> : <RefreshCcw size={12} />}
              {dirtyPaths.size > 0 ? `Sincronizar (${dirtyPaths.size})` : "Sincronizar"}
            </button>
            <input ref={fileInputRef} type="file" accept=".xlsx" style={{ display: "none" }} onChange={onImportFile} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
            <Search size={13} color="var(--text-muted)" />
            <input
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="Buscar material..."
              style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "var(--text)", fontSize: 11, fontFamily: "inherit" }}
            />
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {filteredMaterials.map(m => {
              const isEditing = editingMat === m.name;
              return (
                <div key={m.name} style={{ borderBottom: "1px solid rgba(30,45,74,0.3)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px" }}>
                    <span
                      onClick={() => exportExcel(m.name)}
                      title="Exportar este material a Excel"
                      style={{ width: 11, height: 11, borderRadius: 2, background: m.color, flexShrink: 0, cursor: "pointer" }}
                    />
                    {isEditing ? (
                      <input
                        autoFocus
                        value={editingMatInput}
                        onChange={(e) => setEditingMatInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") saveGlobalRename(m.name); if (e.key === "Escape") setEditingMat(""); }}
                        onBlur={() => saveGlobalRename(m.name)}
                        style={{ flex: 1, background: "var(--background)", border: "1px solid var(--cyan)", borderRadius: 4, padding: "2px 6px", color: "var(--text)", fontSize: 11, fontFamily: "inherit", outline: "none" }}
                      />
                    ) : (
                      <span
                        onClick={() => selectByMaterial(m.name)}
                        title="Click: seleccionar elementos con este material"
                        style={{ fontSize: 11, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" }}>
                        {m.name}
                      </span>
                    )}
                    {m.multi_file && (
                      <span style={{ fontSize: 8, color: "var(--yellow)", background: "rgba(217,164,65,0.1)", borderRadius: 3, padding: "1px 4px", flexShrink: 0 }} title={`${m.file_count} archivos`}>
                        {m.file_count}f
                      </span>
                    )}
                    <span style={{ fontSize: 9, color: "var(--text-muted)", flexShrink: 0 }}>{m.element_count}</span>
                    {!isEditing && (
                      <Pencil
                        size={11} color="var(--text-muted)"
                        style={{ cursor: "pointer", flexShrink: 0 }}
                        onClick={() => { setEditingMat(m.name); setEditingMatInput(m.name); }}
                      />
                    )}
                  </div>
                </div>
              );
            })}
            {loadingElements && <LoadingRow />}
            {!loadingElements && materialRows.length === 0 && (
              <div style={{ padding: 30, textAlign: "center", color: "var(--text-muted)", fontSize: 11 }}>
                Selecciona elementos para ver sus materiales
              </div>
            )}
          </div>
        </div>
      </div>

      <style jsx>{`
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
        @keyframes progress-slide {
          0%   { transform: translateX(-100%); }
          50%  { transform: translateX(160%); }
          100% { transform: translateX(160%); }
        }
      `}</style>
    </div>
  );
}

// ── Small components ─────────────────────────────────────────────────────────
function PanelHeader({ title, count, loading, onReload }: { title: string; count: string; loading: boolean; onReload?: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", borderBottom: "1px solid var(--border)", background: "rgba(255,255,255,0.02)", flexShrink: 0 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: "var(--cyan)", letterSpacing: "0.08em", flex: 1 }}>{title}</span>
      <span style={{ fontSize: 9, color: "var(--text-muted)", background: "rgba(91,140,255,0.06)", borderRadius: 3, padding: "1px 6px" }}>{count}</span>
      {loading && <Loader2 size={12} className="spin" color="var(--cyan)" />}
      {onReload && !loading && (
        <RefreshCw size={12} color="var(--text-muted)" style={{ cursor: "pointer" }} onClick={onReload} />
      )}
    </div>
  );
}

function Checkbox({ checked, onClick }: { checked: boolean; onClick?: (e: React.MouseEvent) => void }) {
  return (
    <div
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(e); } : undefined}
      style={{
        width: 11, height: 11, borderRadius: 2, flexShrink: 0,
        border: `1px solid ${checked ? "var(--cyan)" : "var(--border-bright)"}`,
        background: checked ? "var(--cyan)" : "transparent",
        display: "flex", alignItems: "center", justifyContent: "center",
        cursor: onClick ? "pointer" : "inherit",
      }}>
      {checked && <Check size={7} color="var(--background)" strokeWidth={3} />}
    </div>
  );
}

function LoadingRow() {
  return (
    <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)", fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
      <Loader2 size={14} className="spin" /> Cargando...
    </div>
  );
}

function btnStyle(color: string, bg: string): React.CSSProperties {
  return {
    display: "flex", alignItems: "center", gap: 4,
    fontSize: 10, fontWeight: 700, fontFamily: "inherit",
    background: bg, border: `1px solid ${color}`, color,
    borderRadius: 4, padding: "4px 10px", cursor: "pointer", whiteSpace: "nowrap",
  };
}
