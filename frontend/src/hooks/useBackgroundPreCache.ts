/**
 * useBackgroundPreCache
 *
 * Capa de caché arquitectónica: cuando cambia `selectedPaths`, pre-descarga
 * TODOS los datos caros de cada herramienta y los guarda en localStorage.
 *
 * Las herramientas leen primero de localStorage (instantáneo) y solo llaman al
 * backend si falta la caché (primera carga, o tras un clear).
 *
 * Claves de caché (deben coincidir exactamente con lo que lee cada tool):
 *   psets-index:{sorted_paths}                   → Value Search panel 1
 *   pset-values:{sorted_paths}:{pset_name}       → Value Search paneles 2+3
 *
 * Estrategia:
 *   Paso 1: fetch psets-index (para saber qué psets existen)
 *   Paso 2: por cada pset, fetch precalculate-pset-values con concurrencia
 *           acotada (pool de workers, no batches bloqueantes)
 *
 * Resiliencia y fluidez (filosofía del proyecto):
 *   - DEBOUNCE 500 ms: si el usuario clica rápido varias carpetas, solo se
 *     lanza la última combinación; nada de ráfagas de fetches intermedios.
 *   - DEDUPLICACIÓN module-level: las claves en vuelo se registran en un Set
 *     compartido; jamás se repite una request que ya está en marcha. Las "ya
 *     pedidas" se deduplican vía localStorage (así el invalidado manual de
 *     claves por las tools sigue forzando re-fetch, como siempre).
 *   - ABORT: cualquier cambio de selección o desmontaje cancela los prefetch
 *     en vuelo al instante.
 *   - FALLOS SILENCIOSOS: esto es caché de fondo; un fallo se anota con
 *     console.debug y la app sigue. Las tools harán su propio fetch si falta.
 *
 * Este hook se llama UNA vez desde el Sidebar (siempre montado).
 * Devuelve { status, done, total } para un indicador sutil en el sidebar.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useProjectStore } from "@/stores/projectStore";
import { apiFetch } from "@/lib/api";

/** Debounce sobre cambios de selección (ms). */
const DEBOUNCE_MS = 500;
/** Peticiones de valores de pset en paralelo (pool de workers). */
const CONCURRENCY = 3;
/** Timeout generoso: precalcular valores de un pset grande puede tardar. */
const PREFETCH_TIMEOUT_MS = 120_000;

/**
 * Claves en vuelo a nivel de módulo (compartidas entre montajes del hook):
 * evita repetir una request idéntica mientras otra igual sigue en marcha.
 * Las completadas se deduplican por localStorage, no aquí, para respetar la
 * invalidación manual que hacen las tools (localStorage.removeItem → refetch).
 */
const inflightKeys = new Set<string>();

// ── Helpers de clave de caché (deben coincidir con las tools) ────────────────

export function cacheKeyPsetsIndex(paths: string[]): string {
  return `psets-index:${[...paths].sort().join(",")}`;
}

export function cacheKeyPsetValues(paths: string[], pset: string): string {
  return `pset-values:${[...paths].sort().join(",")}:${pset}`;
}

export function clearAllCache(paths: string[]) {
  const prefix = `psets-index:${[...paths].sort().join(",")}`;
  const prefix2 = `pset-values:${[...paths].sort().join(",")}:`;
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key && (key === prefix || key.startsWith(prefix2))) {
      localStorage.removeItem(key);
    }
  }
}

// ── Tipos de estado ───────────────────────────────────────────────────────────

export type PreCacheStatus = "idle" | "loading" | "done" | "error";

export interface PreCacheState {
  status: PreCacheStatus;
  done: number;    // psets cacheados
  total: number;   // total de psets a cachear
}

interface PsetsIndexResponse {
  psets: Array<{ name: string; props: string[] }>;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useBackgroundPreCache(): PreCacheState {
  const { selectedPaths } = useProjectStore();

  const [state, setState] = useState<PreCacheState>({
    status: "idle",
    done: 0,
    total: 0,
  });

  // Controller para cancelar el run en vuelo si la selección cambia
  const abortRef = useRef<AbortController | null>(null);
  // Última combinación procesada → evita runs duplicados
  const lastKeyRef = useRef<string>("");

  const run = useCallback(async (paths: string[]) => {
    if (paths.length === 0) {
      setState({ status: "idle", done: 0, total: 0 });
      return;
    }

    // ── Paso 0: ¿ya está todo en localStorage? → ni un solo fetch ─────────
    const psetsKey = cacheKeyPsetsIndex(paths);
    let psetsData: PsetsIndexResponse | null = null;

    const cachedPsets = localStorage.getItem(psetsKey);
    if (cachedPsets) {
      try {
        psetsData = JSON.parse(cachedPsets);
      } catch {
        psetsData = null;
      }
    }

    if (psetsData) {
      const missing = psetsData.psets.filter(
        (p) => !localStorage.getItem(cacheKeyPsetValues(paths, p.name))
      );
      if (missing.length === 0) {
        setState({ status: "done", done: psetsData.psets.length, total: psetsData.psets.length });
        return;
      }
    }

    // ── Cancelar cualquier run anterior ───────────────────────────────────
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    setState({ status: "loading", done: 0, total: 0 });

    try {
      // ── Paso 1: fetch psets-index (con dedup en vuelo) ────────────────
      if (!psetsData) {
        if (inflightKeys.has(psetsKey)) {
          // Otra instancia ya lo está pidiendo → no duplicar ni quedar "loading"
          setState({ status: "idle", done: 0, total: 0 });
          return;
        }
        inflightKeys.add(psetsKey);
        try {
          const q = paths.map((p) => `paths=${encodeURIComponent(p)}`).join("&");
          psetsData = await apiFetch<PsetsIndexResponse>(
            `/api/ifc/psets-index?${q}`,
            { signal: abort.signal, timeoutMs: PREFETCH_TIMEOUT_MS }
          );
          localStorage.setItem(psetsKey, JSON.stringify(psetsData));
        } finally {
          inflightKeys.delete(psetsKey);
        }
      }

      if (abort.signal.aborted) return;

      const allPsets = psetsData!.psets ?? [];
      // Solo pedir los psets que NO están ya en localStorage
      const toFetch = allPsets.filter(
        (p) => !localStorage.getItem(cacheKeyPsetValues(paths, p.name))
      );

      let done = allPsets.length - toFetch.length;
      setState({ status: "loading", done, total: allPsets.length });

      // ── Paso 2: pool de workers con concurrencia acotada ──────────────
      // (mejor que batches: un pset lento no bloquea al resto del lote)
      let cursor = 0;
      const worker = async () => {
        while (cursor < toFetch.length && !abort.signal.aborted) {
          const pset = toFetch[cursor++];
          const valKey = cacheKeyPsetValues(paths, pset.name);

          // Dedup: ni repetir lo cacheado ni lo que ya está en vuelo
          if (!localStorage.getItem(valKey) && !inflightKeys.has(valKey)) {
            inflightKeys.add(valKey);
            try {
              const q = paths.map((p) => `paths=${encodeURIComponent(p)}`).join("&");
              const data = await apiFetch<unknown>(
                `/api/ifc/precalculate-pset-values?${q}&pset=${encodeURIComponent(pset.name)}`,
                { signal: abort.signal, timeoutMs: PREFETCH_TIMEOUT_MS }
              );
              localStorage.setItem(valKey, JSON.stringify(data));
            } catch (err) {
              // Caché de fondo: los fallos individuales jamás molestan
              console.debug("[preCache] pset omitido:", pset.name, err);
            } finally {
              inflightKeys.delete(valKey);
            }
          }

          done++;
          if (!abort.signal.aborted) {
            setState({ status: "loading", done, total: allPsets.length });
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, toFetch.length) }, () => worker())
      );

      if (!abort.signal.aborted) {
        setState({ status: "done", done: allPsets.length, total: allPsets.length });
      }
    } catch (err: unknown) {
      if (abort.signal.aborted || (err as Error)?.name === "AbortError") return;
      // Fallo del índice: indicador sutil, sin ruido (las tools harán su fetch)
      console.debug("[preCache] psets-index falló:", err);
      setState({ status: "error", done: 0, total: 0 });
    }
  }, []);

  useEffect(() => {
    const key = [...selectedPaths].sort().join(",");
    if (key === lastKeyRef.current) return;

    // Debounce: si el usuario clica rápido varias carpetas, solo se lanza la
    // última combinación; cada cambio cancela el timer y el run anteriores.
    const timer = setTimeout(() => {
      lastKeyRef.current = key;
      run(selectedPaths);
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      abortRef.current?.abort(); // cambio de selección o desmontaje → abortar
    };
  }, [selectedPaths, run]);

  return state;
}
