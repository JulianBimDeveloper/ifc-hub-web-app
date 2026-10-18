"use client";

import { useState, useCallback, useRef } from "react";
import { API_URL } from "@/lib/api";
import type { FileScanResult, ReviewMode, BulkFillRequest } from "./reviewTypes";

const CONCURRENCY = 2;

export function useReviewScan() {
  const [results, setResults]       = useState<Record<string, FileScanResult>>({});
  const [scanning, setScanning]     = useState(false);
  const [progress, setProgress]     = useState({ done: 0, total: 0 });
  const [reviewId, setReviewId]     = useState<string | null>(null);
  const [mode, setMode]             = useState<ReviewMode>("live");
  const abortRef                    = useRef<AbortController | null>(null);

  const scanPaths = useCallback(async (
    paths: string[],
    currentReviewId: string | null = null,
    currentMode: ReviewMode = "live",
  ) => {
    if (paths.length === 0) return;

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setScanning(true);
    setProgress({ done: 0, total: paths.length });

    // Marcar todos como loading
    setResults(prev => {
      const next = { ...prev };
      for (const p of paths) {
        next[p] = { ...next[p], path: p, filename: p.split(/[\\/]/).pop() ?? p, loading: true };
      }
      return next;
    });

    let done = 0;

    const run = async (path: string) => {
      if (ctrl.signal.aborted) return;
      try {
        const endpoint = (currentMode === "client" && currentReviewId)
          ? "/api/ifc/client-review/compare"
          : "/api/ifc/client-review/scan";

        const body = (currentMode === "client" && currentReviewId)
          ? { review_id: currentReviewId, path }
          : { path, levels: ["file", "project", "element"] };

        const res = await fetch(`${API_URL}${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        const data: FileScanResult = res.ok ? await res.json() : { path, filename: path.split(/[\\/]/).pop() ?? path, error: `HTTP ${res.status}` };
        setResults(prev => ({ ...prev, [path]: { ...data, loading: false } }));
      } catch (e: unknown) {
        if ((e as Error)?.name !== "AbortError") {
          setResults(prev => ({ ...prev, [path]: { path, filename: path.split(/[\\/]/).pop() ?? path, error: String(e), loading: false } }));
        }
      } finally {
        done++;
        setProgress(p => ({ ...p, done }));
      }
    };

    // Cola con concurrencia CONCURRENCY
    const queue = [...paths];
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length > 0) {
        const p = queue.shift()!;
        await run(p);
      }
    });
    await Promise.all(workers);

    if (!ctrl.signal.aborted) setScanning(false);
  }, []);

  const rescanPaths = useCallback((paths: string[]) => {
    return scanPaths(paths, reviewId, mode);
  }, [scanPaths, reviewId, mode]);

  const importExcel = useCallback(async (file: File): Promise<string | null> => {
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch(`${API_URL}/api/ifc/client-review/import-excel`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setReviewId(data.review_id);
      return data.review_id;
    } catch {
      return null;
    }
  }, []);

  const bulkFill = useCallback(async (req: BulkFillRequest): Promise<{ ok: boolean; updated: number; error?: string }> => {
    try {
      const res = await fetch(`${API_URL}/api/ifc/client-review/bulk-fill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
        return { ok: false, updated: 0, error: err.detail ?? String(err) };
      }
      return await res.json();
    } catch (e) {
      return { ok: false, updated: 0, error: String(e) };
    }
  }, []);

  const updateProperty = useCallback(async (
    path: string, global_id: string, pset_name: string, prop_name: string, value: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(`${API_URL}/api/ifc/update-property`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, global_id, pset_name, prop_name, value }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
        return { ok: false, error: err.detail ?? String(err) };
      }
      // Re-escanear solo este archivo
      await scanPaths([path], reviewId, mode);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }, [scanPaths, reviewId, mode]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setScanning(false);
  }, []);

  const clearCache = useCallback(async () => {
    try {
      await fetch(`${API_URL}/api/ifc/client-review/cache`, { method: "DELETE" });
    } catch {
      // ignore
    }
  }, []);

  // ── Export Excel ─────────────────────────────────────────────────────────────
  // Construye las hojas siguiendo EXACTAMENTE el orden y las cabeceras
  // ("Grupo\nSubcabecera") del esquema del backend — el mismo que usa /scan —
  // para que el xlsx generado calque la estructura del Excel del cliente.
  // Devuelve un resumen (incluidos archivos que faltaron) para que la UI
  // pueda avisar en vez de exportar en silencio una tabla incompleta.
  const exportExcel = useCallback(async (
    tabs: Array<"file" | "project" | "element">,
    filename = "client_review.xlsx",
  ): Promise<{ ok: boolean; missingFiles: string[]; erroredFiles: string[] }> => {
    const allEntries = Object.values(results);
    const files = allEntries.filter(r => !r.error && !r.loading);
    const missingFiles = allEntries.filter(r => r.loading).map(r => r.filename);
    const erroredFiles = allEntries.filter(r => r.error).map(r => r.filename);

    if (files.length === 0) return { ok: false, missingFiles, erroredFiles };

    let schema: Record<string, Array<{ key: string; label: string }>> = {};
    try {
      const res = await fetch(`${API_URL}/api/ifc/client-review/schema`);
      if (res.ok) schema = await res.json();
    } catch {
      // sin schema no podemos calcar cabeceras — se aborta más abajo si falta el nivel
    }

    type SheetData = { columns: string[]; rows: (string | number | null)[][] };
    const data: Record<string, SheetData> = {};

    const levelToSheet: Record<"file" | "project" | "element", string> = {
      file: "IfcFile", project: "IfcProject", element: "IfcElement",
    };

    for (const level of tabs) {
      const cols = schema[level];
      if (!cols || cols.length === 0) continue;

      if (level === "element") {
        const rows = files.flatMap(r => (r.elements ?? []).map(el => el.cells));
        if (rows.length === 0) continue;
        data[levelToSheet[level]] = {
          columns: cols.map(c => c.label),
          rows: rows.map(cells => cols.map(c => cells[c.key]?.v ?? "")),
        };
      } else {
        const rowKey = level === "file" ? "file_row" : "project_row";
        const rowsSrc = files.filter(r => r[rowKey]);
        if (rowsSrc.length === 0) continue;
        data[levelToSheet[level]] = {
          columns: cols.map(c => c.label),
          rows: rowsSrc.map(r => cols.map(c => r[rowKey]![c.key]?.v ?? "")),
        };
      }
    }

    if (Object.keys(data).length === 0) return { ok: false, missingFiles, erroredFiles };

    try {
      const res = await fetch(`${API_URL}/api/ifc/client-review/export-excel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      return { ok: true, missingFiles, erroredFiles };
    } catch (e) {
      console.error("Export Excel failed:", e);
      return { ok: false, missingFiles, erroredFiles };
    }
  }, [results]);

  // ── Import Edits ─────────────────────────────────────────────────────────────
  // Uploads an edited xlsx and writes pset values back to IFC files.
  const importEdits = useCallback(async (file: File): Promise<Record<string, { updated: number; skipped: number; errors: string[] }> | null> => {
    const pathsByFilename: Record<string, string> = {};
    for (const r of Object.values(results)) {
      if (r.filename && r.path) pathsByFilename[r.filename] = r.path;
    }

    const fd = new FormData();
    fd.append("file", file);
    fd.append("paths_json", JSON.stringify(pathsByFilename));

    try {
      const res = await fetch(`${API_URL}/api/ifc/client-review/import-edits`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      // Re-scan all affected files
      const affected = Object.values(results).map(r => r.path).filter(Boolean) as string[];
      if (affected.length > 0) await scanPaths(affected, reviewId, mode);
      return json.per_file ?? null;
    } catch (e) {
      console.error("Import edits failed:", e);
      return null;
    }
  }, [results, scanPaths, reviewId, mode]);

  return {
    results, scanning, progress,
    reviewId, setReviewId,
    mode, setMode,
    scanPaths, rescanPaths,
    importExcel, bulkFill, updateProperty,
    stop, clearCache,
    exportExcel, importEdits,
  };
}
