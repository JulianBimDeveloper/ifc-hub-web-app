/**
 * projectStore — Global IFC project state
 *
 * Supports multiple sources (folders + individual files).
 * Each tool reads `files` to get the full aggregate list.
 * `folderPath` is kept for backward compat (= first folder source path).
 */

import { useCallback } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IFCSource {
  id: string;               // unique ID (timestamp-based)
  type: "folder" | "file";  // folder scanned recursively; file = individual .ifc
  path: string;             // folder path (for folder type) or "" (for file type)
  label: string;            // display name shown in UI chips
}

export interface IFCTopType {
  type: string;
  count: number;
}

export interface IFCFileEntry {
  filename: string;
  path: string;
  sourceId: string;   // which source this file belongs to
}

export interface IFCFileInfo {
  schema: string;
  element_count: number;
  file_size_mb: number;
  last_modified: number;
  project_name: string;
  project_description: string;
  author: string;
  organization: string;
  originating_system: string;  // "Autodesk Revit 25.4.41.14..." or "Autodesk Civil 3D 2025..."
  top_types?: IFCTopType[];
}

// ── Store interface ───────────────────────────────────────────────────────────

interface ProjectState {
  // ── Sources ──────────────────────────────────────────────────────────────
  sources: IFCSource[];

  // Backward-compat convenience — first folder source's path (or "")
  folderPath: string;

  // ── Files (aggregate from all sources, deduped by path) ──────────────────
  files: IFCFileEntry[];

  // ── Status ────────────────────────────────────────────────────────────────
  scanning: boolean;
  scanError: string;

  // ── Per-file metadata (loaded async in Models page) ───────────────────────
  fileInfos: Record<string, IFCFileInfo>;
  infoLoading: Record<string, boolean>;

  // ── File selection (for tools like classifier, validator, etc.) ────────────
  selectedPaths: string[];  // array of selected file paths (persistent)

  // ── Multi-source actions ──────────────────────────────────────────────────
  addFolderSource: (id: string, path: string, label: string, newFiles: Omit<IFCFileEntry, "sourceId">[]) => void;
  addFileSource:   (id: string, label: string, newFiles: Omit<IFCFileEntry, "sourceId">[]) => void;
  removeSource:    (id: string) => void;

  // ── Selection actions ──────────────────────────────────────────────────────
  toggleFileSelection: (path: string) => void;  // toggle single file
  setSelectedPaths: (paths: string[]) => void;  // set selection to a specific list
  selectAllFiles: () => void;                   // select all files
  clearSelection: () => void;                   // clear all selections

  // ── Legacy / compat actions ───────────────────────────────────────────────
  setFolder:      (path: string) => void;
  setFiles:       (files: IFCFileEntry[]) => void;
  setScanning:    (v: boolean) => void;
  setScanError:   (e: string) => void;
  setFileInfo:    (path: string, info: IFCFileInfo) => void;
  setInfoLoading: (path: string, v: boolean) => void;
  clearProject:   () => void;
  removeBrokenSources: (brokenSourceIds: string[]) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function firstFolderPath(sources: IFCSource[]): string {
  return sources.find(s => s.type === "folder")?.path ?? "";
}

// Deduplica selectedPaths y descarta los que ya no existen en `files`.
// Evita el bug de conteo: selecciones "fantasma" persistidas que no coinciden
// con los archivos re-escaneados se acumulaban y duplicaban el contador.
function reconcileSelection(paths: string[], files: IFCFileEntry[]): string[] {
  const valid = new Set(files.map(f => f.path));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (valid.has(p) && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

// Lazy-load fileInfos for all files that don't have it yet
export async function ensureFileInfosLoaded(
  files: IFCFileEntry[],
  fileInfos: Record<string, IFCFileInfo>,
  apiUrl: string = "http://127.0.0.1:8020"
) {
  const missingPaths = files.filter(f => !fileInfos[f.path]).map(f => f.path);
  if (missingPaths.length === 0) return;

  const store = useProjectStore.getState();
  for (const path of missingPaths) {
    store.setInfoLoading(path, true);
    try {
      const res = await fetch(
        `${apiUrl}/api/ifc/info?path=${encodeURIComponent(path)}`,
        { signal: AbortSignal.timeout(30000) }
      );
      if (res.ok) {
        const info = await res.json();
        store.setFileInfo(path, info);
      }
    } catch {
      // silent
    } finally {
      store.setInfoLoading(path, false);
    }
  }
}

// ── Store ─────────────────────────────────────────────────────────────────────

// ── Hook to ensure file info badges (origin + schema) are loaded ──────────────

export function useEnsureFileInfoLabels(apiUrl: string = "http://127.0.0.1:8020") {
  const { files, fileInfos, setFileInfo, setInfoLoading } = useProjectStore();

  // Stable across renders unless files/fileInfos actually change. Without this,
  // callers get a brand-new function on every render; an effect that depends
  // on it (e.g. `useEffect(() => { ensureLoaded() }, [files.length, ensureLoaded])`)
  // then re-fires every render, and since ensureLoaded's own state updates
  // (setFileInfo/setInfoLoading) trigger a re-render themselves, the whole
  // thing spins into a "Maximum update depth exceeded" loop.
  const ensureLoaded = useCallback(async () => {
    const missingPaths = files.filter(f => !fileInfos[f.path]).map(f => f.path);
    if (missingPaths.length === 0) return;

    for (const path of missingPaths) {
      setInfoLoading(path, true);
      try {
        const res = await fetch(
          `${apiUrl}/api/ifc/info?path=${encodeURIComponent(path)}`,
          { signal: AbortSignal.timeout(30000) }
        );
        if (res.ok) {
          const info = await res.json();
          setFileInfo(path, info);
        }
      } catch {
        // silent
      } finally {
        setInfoLoading(path, false);
      }
    }
  }, [files, fileInfos, apiUrl, setFileInfo, setInfoLoading]);

  return { ensureLoaded };
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set) => ({
      sources:        [],
      folderPath:     "",
      files:          [],
      scanning:       false,
      scanError:      "",
      fileInfos:      {},
      infoLoading:    {},
      selectedPaths:  [],  // Start with no selection

      // ── Add a scanned folder source ─────────────────────────────────────
      addFolderSource: (id, path, label, newFiles) =>
        set((s) => {
          // Replace existing source with same id if present
          const sources: IFCSource[] = [
            ...s.sources.filter(src => src.id !== id),
            { id, type: "folder", path, label },
          ];
          // Dedup: keep existing files not from this source, add all new ones
          const otherFiles = s.files.filter(f => f.sourceId !== id);
          const withId = newFiles.map(f => ({ ...f, sourceId: id }));
          const existingPaths = new Set(otherFiles.map(f => f.path));
          const deduped = withId.filter(f => !existingPaths.has(f.path));
          const files = [...otherFiles, ...deduped];
          return {
            sources,
            folderPath: firstFolderPath(sources),
            files,
            selectedPaths: reconcileSelection(s.selectedPaths, files),
          };
        }),

      // ── Add individual files source ──────────────────────────────────────
      addFileSource: (id, label, newFiles) =>
        set((s) => {
          const sources: IFCSource[] = [
            ...s.sources.filter(src => src.id !== id),
            { id, type: "file", path: "", label },
          ];
          const otherFiles = s.files.filter(f => f.sourceId !== id);
          const withId = newFiles.map(f => ({ ...f, sourceId: id }));
          const existingPaths = new Set(otherFiles.map(f => f.path));
          const deduped = withId.filter(f => !existingPaths.has(f.path));
          const files = [...otherFiles, ...deduped];
          return {
            sources,
            // folderPath unchanged
            files,
            selectedPaths: reconcileSelection(s.selectedPaths, files),
          };
        }),

      // ── Remove a source and all its files ────────────────────────────────
      removeSource: (id) =>
        set((s) => {
          const sources = s.sources.filter(src => src.id !== id);
          const files   = s.files.filter(f => f.sourceId !== id);
          // Clean up fileInfos for removed files
          const removedPaths = new Set(
            s.files.filter(f => f.sourceId === id).map(f => f.path)
          );
          const fileInfos = Object.fromEntries(
            Object.entries(s.fileInfos).filter(([k]) => !removedPaths.has(k))
          );
          return {
            sources, files, fileInfos,
            folderPath: firstFolderPath(sources),
            selectedPaths: reconcileSelection(s.selectedPaths, files),
          };
        }),

      // ── Legacy actions (kept for backward compat) ─────────────────────────
      setFolder:    (path) => set({ folderPath: path }),
      setFiles:     (files) => set({ files }),
      setScanning:  (v) => set({ scanning: v }),
      setScanError: (e) => set({ scanError: e }),

      setFileInfo: (path, info) =>
        set((s) => ({ fileInfos: { ...s.fileInfos, [path]: info } })),

      setInfoLoading: (path, v) =>
        set((s) => ({ infoLoading: { ...s.infoLoading, [path]: v } })),

      // ── Selection actions ────────────────────────────────────────────────────
      toggleFileSelection: (path) =>
        set((s) => {
          const selected = s.selectedPaths.includes(path);
          return {
            selectedPaths: selected
              ? s.selectedPaths.filter(p => p !== path)
              : [...s.selectedPaths, path],
          };
        }),

      setSelectedPaths: (paths) => set({ selectedPaths: Array.from(new Set(paths)) }),

      selectAllFiles: () =>
        set((s) => ({
          selectedPaths: s.files.map(f => f.path),
        })),

      clearSelection: () =>
        set({ selectedPaths: [] }),

      clearProject: () =>
        set({ sources: [], folderPath: "", files: [], fileInfos: {}, scanError: "", infoLoading: {}, selectedPaths: [] }),

      removeBrokenSources: (brokenSourceIds: string[]) =>
        set((s) => {
          if (brokenSourceIds.length === 0) return s;
          const ids = new Set(brokenSourceIds);
          const sources = s.sources.filter(src => !ids.has(src.id));
          const files   = s.files.filter(f => !ids.has(f.sourceId));
          const removedPaths = new Set(s.files.filter(f => ids.has(f.sourceId)).map(f => f.path));
          const fileInfos = Object.fromEntries(
            Object.entries(s.fileInfos).filter(([k]) => !removedPaths.has(k))
          );
          return {
            sources, files, fileInfos,
            folderPath: firstFolderPath(sources),
            selectedPaths: reconcileSelection(s.selectedPaths, files),
          };
        }),
    }),
    {
      name: "ifc-hub-project",
      // fileInfos NO se persiste: con proyectos grandes (decenas de IFC, cada
      // uno con su lista de top_types) el JSON crece hasta superar la cuota de
      // localStorage (~5-10MB), y entonces CUALQUIER set() posterior -- incluso
      // uno trivial como setScanError -- revienta con QuotaExceededError y
      // rompe la página entera. fileInfos ya se recarga bajo demanda desde el
      // backend (ver ensureFileInfosLoaded/useEnsureFileInfoLabels) así que no
      // hace falta persistirlo -- perderlo en un refresh solo cuesta un
      // refetch barato, no un dato real del usuario.
      partialize: (s) => ({
        sources:       s.sources,
        folderPath:    s.folderPath,
        files:         s.files,
        selectedPaths: s.selectedPaths,    // Persist file selection across sessions
      }),
      // Red de seguridad: si el estado persistido crece por otra vía y vuelve
      // a superar la cuota, no dejar que rompa toda la app con un error sin
      // capturar -- se pierde la persistencia de esta escritura, no la sesión.
      storage: createJSONStorage(() => ({
        getItem: (name) => localStorage.getItem(name),
        setItem: (name, value) => {
          try {
            localStorage.setItem(name, value);
          } catch (e) {
            console.warn(`projectStore: no se pudo persistir "${name}" (¿localStorage lleno?)`, e);
          }
        },
        removeItem: (name) => localStorage.removeItem(name),
      })),
      // Al rehidratar, limpiar selecciones fantasma/duplicadas que ya no existen
      // en `files` (estado heredado de sesiones previas con paths distintos).
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.selectedPaths = reconcileSelection(state.selectedPaths, state.files);
        }
      },
    }
  )
);
