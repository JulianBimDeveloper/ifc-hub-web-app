/**
 * toolStatusStore — Live health-per-tool registry, feeds the FractalStatus widget.
 *
 * Each tool page publishes its own aggregate semaphore here (same RowStatus
 * vocabulary already used locally in ifc-classify / ifc-sets / ifc-project-default:
 * match/diff/missing/loading/none). Not persisted — recomputed live from IFC data
 * every time a page mounts or its selection changes.
 *
 * `fileStatuses` is the per-model breakdown (tool slug → file path → health),
 * which is what the fractal tree actually draws: one branch per model, one dot
 * per tool on it. It survives navigation (zustand lives for the session), so a
 * tool's dots keep their last known color after leaving its page.
 */

import { create } from "zustand";

export type ToolHealth = "match" | "diff" | "missing" | "loading" | "none";

interface ToolStatusState {
  statuses: Record<string, ToolHealth>;
  fileStatuses: Record<string, Record<string, ToolHealth>>;
  setToolStatus: (toolSlug: string, status: ToolHealth) => void;
  setFileStatuses: (toolSlug: string, byPath: Record<string, ToolHealth>) => void;
}

function sameMap(a: Record<string, ToolHealth> | undefined, b: Record<string, ToolHealth>): boolean {
  if (!a) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every(k => a[k] === b[k]);
}

export const useToolStatusStore = create<ToolStatusState>((set) => ({
  statuses: {},
  fileStatuses: {},
  setToolStatus: (toolSlug, status) =>
    set((s) =>
      s.statuses[toolSlug] === status ? s : { statuses: { ...s.statuses, [toolSlug]: status } }
    ),
  setFileStatuses: (toolSlug, byPath) =>
    set((s) =>
      sameMap(s.fileStatuses[toolSlug], byPath) ? s : { fileStatuses: { ...s.fileStatuses, [toolSlug]: byPath } }
    ),
}));
