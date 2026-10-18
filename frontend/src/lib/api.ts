/**
 * Capa central de acceso a la API del backend (FastAPI).
 *
 * Filosofía: velocidad y resiliencia. Un fetch que falla no debe colgar la UI
 * indefinidamente ni tumbar la app; por eso TODAS las llamadas pasan por aquí
 * y obtienen gratis:
 *
 *   1. Timeout configurable (default 30 s) vía AbortController — sin esto, un
 *      backend colgado deja promesas vivas para siempre y la UI "en loading".
 *   2. Un (1) reintento automático SOLO ante fallo de red (TypeError de fetch:
 *      backend reiniciándose, red parpadeando). Nunca ante 4xx/5xx: una
 *      respuesta HTTP es una respuesta, repetirla no la cambia y puede duplicar
 *      efectos en el servidor.
 *   3. Errores normalizados (`ApiError`) con status + detail del backend, para
 *      que los consumidores no tengan que parsear strings de mensajes.
 *
 * Compatibilidad: `apiJSON`, `healthCheck` y `API_URL` mantienen sus firmas
 * históricas. `apiFetch<T>` es ahora el helper central tipado (devuelve el
 * JSON parseado); para respuestas crudas (blobs, streams) usar `apiFetchRaw`.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8020";

/** Timeout por defecto para llamadas normales (ms). */
const DEFAULT_TIMEOUT_MS = 30_000;

// ── Error normalizado ────────────────────────────────────────────────────────

/**
 * Error normalizado de la API.
 *
 * - `status`: código HTTP (0 si la petición ni siquiera llegó: red caída,
 *   timeout, abort externo).
 * - `detail`: cuerpo de error del backend si era JSON (FastAPI suele devolver
 *   `{ detail: ... }`), o `undefined` si no había cuerpo parseable.
 *
 * Extiende `Error`, así que el código existente que hacía `catch (e) { e.message }`
 * sigue funcionando sin cambios.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    // Necesario para que `instanceof ApiError` funcione tras transpilación.
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

// ── Opciones extendidas ──────────────────────────────────────────────────────

/**
 * Opciones de `apiFetch`/`apiFetchRaw`. Extiende `RequestInit` estándar, por lo
 * que cualquier llamada existente con `{ method, headers, body, signal }` sigue
 * siendo válida tal cual.
 */
export interface ApiFetchOptions extends RequestInit {
  /**
   * Timeout en ms (default 30 000). Subirlo para operaciones largas
   * (bulk, extracción de geometría: 60 000–120 000).
   */
  timeoutMs?: number;
  /**
   * Reintentar 1 vez ante fallo de red puro (default true).
   * Poner a false en operaciones con efectos no idempotentes.
   */
  retryOnNetworkError?: boolean;
}

// ── Núcleo: fetch con timeout + retry + errores normalizados ────────────────

/**
 * Un intento de fetch con timeout propio, respetando además el `signal`
 * externo del llamador (cualquiera de los dos aborta la petición).
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal: AbortSignal | null | undefined
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new DOMException(`Timeout tras ${timeoutMs} ms`, "TimeoutError")),
    timeoutMs
  );
  const onExternalAbort = () => ctrl.abort(externalSignal?.reason);

  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Versión "cruda" del helper central: devuelve el `Response` sin parsear
 * (para blobs, descargas, streams), pero con timeout, reintento de red y
 * `ApiError` normalizado ante respuestas no-OK.
 *
 * @throws {ApiError} status real en respuestas HTTP no-OK; status 0 en fallos
 *   de red/timeout. Los aborts externos (AbortError del llamador) se relanzan
 *   tal cual para que el código de cancelación los distinga.
 */
export async function apiFetchRaw(
  path: string,
  opts: ApiFetchOptions = {}
): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryOnNetworkError = true,
    signal,
    ...init
  } = opts;

  const url = `${API_URL}${path}`;
  const maxAttempts = retryOnNetworkError ? 2 : 1;
  let lastNetworkError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetchWithTimeout(url, init, timeoutMs, signal);
    } catch (err) {
      // Abort del llamador → relanzar intacto: la cancelación no es un error.
      if (signal?.aborted) throw err;
      // Timeout propio → ApiError(0), sin reintento (el backend está lento,
      // no caído; reintentar duplicaría carga).
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new ApiError(0, `API ${path} → timeout (${timeoutMs} ms)`);
      }
      if (err instanceof DOMException && err.name === "AbortError") {
        // Abort de nuestro propio controller con razón timeout.
        throw new ApiError(0, `API ${path} → timeout (${timeoutMs} ms)`);
      }
      // TypeError = fallo de red puro (DNS, conexión rechazada). Único caso
      // donde reintentar tiene sentido: el backend pudo estar reiniciándose.
      if (err instanceof TypeError && attempt < maxAttempts) {
        lastNetworkError = err;
        continue;
      }
      throw new ApiError(0, `API ${path} → fallo de red: ${(err as Error)?.message ?? err}`);
    }

    if (!res.ok) {
      // Respuesta HTTP recibida → NUNCA reintentar. Extraer detail si es JSON.
      let detail: unknown;
      try {
        detail = await res.clone().json();
      } catch {
        detail = undefined;
      }
      throw new ApiError(res.status, `API ${path} → ${res.status}`, detail);
    }
    return res;
  }

  // Inalcanzable en la práctica (el bucle siempre devuelve o lanza).
  throw new ApiError(0, `API ${path} → fallo de red: ${lastNetworkError}`);
}

/**
 * Helper central tipado: fetch + timeout + retry + parseo JSON.
 *
 * Uso típico:
 *   const data = await apiFetch<MiTipo>("/api/algo");
 *   const lento = await apiFetch<Geom>("/api/geom", { timeoutMs: 120_000 });
 *
 * @throws {ApiError} ver `apiFetchRaw`.
 */
export async function apiFetch<T = unknown>(
  path: string,
  opts: ApiFetchOptions = {}
): Promise<T> {
  const res = await apiFetchRaw(path, opts);
  return res.json() as Promise<T>;
}

/**
 * Alias histórico de `apiFetch<T>` — se mantiene por compatibilidad con el
 * código existente (p. ej. `healthCheck`).
 */
export async function apiJSON<T>(path: string, opts?: ApiFetchOptions): Promise<T> {
  return apiFetch<T>(path, opts);
}

/** Ping de salud del backend (lo consume el Navbar). */
export async function healthCheck(): Promise<{ status: string }> {
  return apiJSON("/healthz");
}

// ── Diagnóstico de memoria/caché (indicador del Navbar) ──────────────────────

export interface SystemStats {
  process: { rss_mb: number; system_total_mb: number; system_percent: number };
  model_pool: {
    size: number;
    max_size: number;
    hits: number;
    misses: number;
    evictions: number;
    models: { path: string; name: string; size_mb: number | null }[];
  };
  derived_caches: {
    pset_index_cache: number;
    pset_mat_cache: number;
    entity_type_rows_cache: number;
    elements_cache: number;
    geom_json_cache: number;
    geom_bin_cache: number;
  };
}

export async function getSystemStats(): Promise<SystemStats> {
  return apiJSON("/api/system/stats", { timeoutMs: 5000 });
}

export async function clearSystemCache(): Promise<SystemStats> {
  return apiFetch<SystemStats>("/api/system/clear-cache", { method: "POST", timeoutMs: 10000 });
}

export { API_URL };
