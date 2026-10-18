/**
 * useViewerGeomPreCache
 *
 * Pre-extrae la geometría 3D de los IFC seleccionados EN SEGUNDO PLANO, en
 * cuanto cambia `selectedPaths`. Llama al endpoint ligero `/viewer-geom-warm`
 * (devuelve solo el conteo de triángulos, no los megabytes del binario), de
 * modo que el backend deja la geometría cacheada (memoria + disco).
 *
 * Resultado: cuando el usuario navega al visor y pulsa "Cargar en visor", la
 * geometría ya está caliente → la carga es prácticamente instantánea, como en
 * visores nativos tipo BIM Vision.
 *
 * Espejo de useBackgroundPreCache (que precalienta psets), pero para geometría.
 * Se llama UNA vez desde el Sidebar (siempre montado).
 *
 * Resiliencia y fluidez (filosofía del proyecto):
 *   - DEBOUNCE 500 ms: clics rápidos en varias carpetas → solo se calienta la
 *     combinación final, sin ráfagas intermedias.
 *   - DEDUPLICACIÓN module-level: paths ya calentados o en vuelo se registran
 *     en Sets compartidos; nunca se repite trabajo (sobrevive a remontajes).
 *   - CONCURRENCIA acotada (pool de 3 workers): extraer geometría es lo más
 *     caro del backend, no hay que saturarlo.
 *   - ABORT: cambio de selección o desmontaje cancela los warms en vuelo.
 *   - FALLOS SILENCIOSOS: es caché de fondo; si un warm falla, el visor hará
 *     la extracción al cargar (más lento, pero la app sigue). console.debug.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { usePathname } from "next/navigation";
import { useProjectStore } from "@/stores/projectStore";
import { apiFetch } from "@/lib/api";

/** Debounce sobre cambios de selección (ms). */
const DEBOUNCE_MS = 500;
/** Peticiones de warming en paralelo. */
const CONCURRENCY = 3;
/** Timeout generoso: extraer geometría de un IFC grande puede tardar minutos. */
const WARM_TIMEOUT_MS = 120_000;

/**
 * Dedup a nivel de módulo (compartido entre montajes del hook):
 * - `warmedPaths`: paths ya calentados en esta sesión del navegador.
 * - `inflightPaths`: paths cuyo warm está en vuelo ahora mismo.
 */
const warmedPaths = new Set<string>();
const inflightPaths = new Set<string>();

export type GeomWarmStatus = "idle" | "loading" | "done" | "error";

export interface GeomWarmState {
  status: GeomWarmStatus;
  done: number;   // archivos calentados
  total: number;  // total a calentar
}

// Precalentar geometría 3D en segundo plano solo aporta algo en las páginas
// que de verdad van a RENDERIZAR o COMPARAR geometría — el Visor y Duplicates
// (que compara mallas para detectar elementos repetidos). Para cualquier otra
// herramienta es puro coste: la extracción/teselación de ifcopenshell es cara
// en archivos de cientos de MB, no libera el GIL durante la triangulación, y
// compite por CPU con la herramienta que el usuario tiene realmente abierta
// — en el peor caso bloquea hasta el propio /healthz, que el Navbar reporta
// como "API offline" aunque el backend no haya caído, solo esté saturado.
//
// Antes era una lista de EXCLUSIÓN (bloquear en /ifc-material, /ifc-client-review,
// /ifc-classify) que había que recordar ampliar con cada herramienta nueva —
// se quedó corta y coló /ifc-project-default, que solo escribe atributos de
// cabecera del IFC y no toca geometría. Lista de INCLUSIÓN: por defecto no se
// calienta nada, así una herramienta nueva no puede volver a heredar este bug.
const GEOM_WARM_ROUTES = ["/viewer", "/ifc-duplicates"];

export function useViewerGeomPreCache(): GeomWarmState {
  const { selectedPaths } = useProjectStore();
  const pathname = usePathname();
  const skip = !GEOM_WARM_ROUTES.some((r) => pathname?.startsWith(r));

  const [state, setState] = useState<GeomWarmState>({ status: "idle", done: 0, total: 0 });

  const abortRef = useRef<AbortController | null>(null);
  const lastKeyRef = useRef<string>("");

  const run = useCallback(async (paths: string[]) => {
    if (paths.length === 0) {
      setState({ status: "idle", done: 0, total: 0 });
      return;
    }

    // Dedup: ni lo ya calentado ni lo que otro run tiene en vuelo
    const toWarm = paths.filter(
      (p) => !warmedPaths.has(p) && !inflightPaths.has(p)
    );
    if (toWarm.length === 0) {
      setState({ status: "done", done: paths.length, total: paths.length });
      return;
    }

    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    let done = paths.length - toWarm.length;
    setState({ status: "loading", done, total: paths.length });

    // Pool de workers con concurrencia acotada
    let cursor = 0;
    const worker = async () => {
      while (cursor < toWarm.length && !abort.signal.aborted) {
        const p = toWarm[cursor++];
        inflightPaths.add(p);
        try {
          await apiFetch<unknown>(
            `/api/viewer-geom-warm?path=${encodeURIComponent(p)}`,
            { signal: abort.signal, timeoutMs: WARM_TIMEOUT_MS }
          );
          warmedPaths.add(p);
        } catch (err) {
          // Caché de fondo: el fallo de un warm jamás molesta al usuario
          console.debug("[geomWarm] warm omitido:", p, err);
        } finally {
          inflightPaths.delete(p);
        }
        done++;
        if (!abort.signal.aborted) {
          setState({ status: "loading", done, total: paths.length });
        }
      }
    };

    try {
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, toWarm.length) }, () => worker())
      );
      if (!abort.signal.aborted) {
        setState({ status: "done", done: paths.length, total: paths.length });
      }
    } catch (err) {
      // Inalcanzable en la práctica (los workers tragan sus errores), pero
      // por si acaso: indicador sutil, sin ruido.
      console.debug("[geomWarm] run falló:", err);
      if (!abort.signal.aborted) setState({ status: "error", done, total: paths.length });
    }
  }, []);

  useEffect(() => {
    if (skip) {
      // En páginas donde la geometría no aporta nada, no competir por CPU
      // con la herramienta activa. Aborta cualquier warm en vuelo al entrar.
      abortRef.current?.abort();
      return;
    }
    const key = [...selectedPaths].sort().join(",");
    if (key === lastKeyRef.current) return;

    // Debounce: solo se lanza la última combinación tras 500 ms de calma;
    // cada cambio cancela el timer pendiente y aborta los warms en vuelo.
    const timer = setTimeout(() => {
      lastKeyRef.current = key;
      run(selectedPaths);
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      abortRef.current?.abort(); // cambio de selección o desmontaje → abortar
    };
  }, [selectedPaths, run, skip]);

  return state;
}
