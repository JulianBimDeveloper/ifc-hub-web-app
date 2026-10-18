"""Utilidades de resiliencia del backend IFC Hub v2.

Contenido:
    - atomic_write_model:    escritura atómica de modelos IFC (tmp + replace).
    - coerce_property_value: coerción de tipos al editar propiedades IFC.
    - safe:                  decorador que degrada excepciones a un default.
    - PBClient:              cliente PocketBase con timeout, reintento y
                             circuit-breaker. Nunca lanza: devuelve fallback.

Filosofía: los fallos pequeños se loggean y se continúa con resultado
parcial; la generalidad nunca se cae.
"""

import functools
import os
import threading
import time

from core.config import settings
from core.logging_config import get_logger

logger = get_logger(__name__)


# ── Escritura atómica de modelos IFC ──────────────────────────────────────────

def atomic_write_model(model, path: str) -> None:
    """Escribe un modelo ifcopenshell de forma atómica.

    Escribe primero a `path + '.tmp'` y después hace `os.replace(tmp, path)`
    (operación atómica a nivel de filesystem). Así, si el proceso muere o
    falla a mitad de escritura, el IFC original queda intacto — nunca se
    deja un archivo corrupto/truncado en disco.

    Si la escritura del tmp falla, se borra el residuo y se relanza la
    excepción (el llamante decide cómo degradar).
    """
    tmp = path + ".tmp"
    try:
        try:
            # format=".ifc" fuerza STEP aunque la extensión sea .tmp
            model.write(tmp, format=".ifc")
        except TypeError:
            # Versiones antiguas de ifcopenshell sin parámetro `format`
            model.write(tmp)
        os.replace(tmp, path)
    except Exception:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            logger.warning("No se pudo borrar el temporal %s", tmp)
        raise
    # Notificar al pool: si el modelo escrito es la instancia cacheada se
    # conserva (sin re-parseo); si no, se invalida para no servir datos viejos.
    try:
        from core.model_pool import model_pool
        model_pool.on_write(path, model)
    except Exception:
        logger.debug("No se pudo notificar la escritura al pool para %s", path)


# ── Coerción de tipos en propiedades IFC ──────────────────────────────────────

_TRUE_STRINGS = {"true", "1", "yes", "si", "sí", ".t.", "t", "verdadero"}
_FALSE_STRINGS = {"false", "0", "no", ".f.", "f", "falso", ""}


def coerce_property_value(prop, new_value):
    """Coerciona `new_value` al tipo del wrappedValue actual de la propiedad.

    Dado un IfcPropertySingleValue existente, devuelve el nuevo valor con el
    mismo tipo Python que `prop.NominalValue.wrappedValue` (int→int,
    float→float, bool→parse "true/1", str→str). Evita corromper el tipado
    del IFC al editar desde la UI (donde todo llega como string).

    Degradación elegante: si la coerción falla, loggea un warning y devuelve
    el string tal cual. NUNCA lanza.
    """
    try:
        nv = getattr(prop, "NominalValue", None)
        current = getattr(nv, "wrappedValue", None) if nv is not None else None
        if current is None:
            return new_value

        target_type = type(current)
        if isinstance(new_value, target_type):
            return new_value

        if target_type is bool:
            return str(new_value).strip().lower() in _TRUE_STRINGS
        if target_type is int:
            # Aceptar "3.0" → 3 (la UI puede mandar decimales en campos enteros)
            return int(float(str(new_value).strip().replace(",", ".")))
        if target_type is float:
            return float(str(new_value).strip().replace(",", "."))
        if target_type is str:
            return str(new_value)
        # Tipos exóticos (tuplas, enums...) → intentar construcción directa
        return target_type(new_value)
    except Exception as exc:
        logger.warning(
            "Coerción de tipo fallida en '%s' (valor=%r): %s — se usa string",
            getattr(prop, "Name", "?"), new_value, exc,
        )
        return new_value


# ── Decorador de degradación elegante ─────────────────────────────────────────

def safe(default=None, log: bool = True):
    """Decorador: captura cualquier Exception, loggea y devuelve `default`.

    Para operaciones pequeñas no críticas (leer una propiedad opcional,
    un fallback cosmético...) donde un fallo individual jamás debe tumbar
    la operación general.

    Uso:
        @safe(default=[])
        def leer_capas(model): ...
    """
    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except Exception as exc:
                if log:
                    logger.warning("safe(%s): %s", fn.__name__, exc)
                return default
        return wrapper
    return decorator


# ── Cliente PocketBase resiliente ─────────────────────────────────────────────

class PBClient:
    """Wrapper fino sobre `requests` para PocketBase.

    Garantías:
        - timeout=settings.PB_TIMEOUT_S en TODAS las llamadas.
        - 1 reintento automático ante errores de red.
        - Circuit-breaker: tras 5 fallos consecutivos se "abre" durante 30s
          y devuelve el fallback inmediatamente, sin esperar timeouts —
          si PocketBase está caído, los endpoints no se ralentizan.
        - NUNCA lanza: devuelve `fallback` y loggea.
    """

    FAILURE_THRESHOLD = 5     # fallos consecutivos para abrir el circuito
    OPEN_SECONDS = 30.0       # tiempo que el circuito permanece abierto

    def __init__(self, base_url: str | None = None, timeout: float | None = None):
        self.base_url = (base_url or settings.POCKETBASE_URL).rstrip("/")
        self.timeout = timeout if timeout is not None else settings.PB_TIMEOUT_S
        self._failures = 0
        self._opened_at = 0.0
        self._lock = threading.Lock()

    # ── Circuit-breaker ───────────────────────────────────────────────────

    def _circuit_open(self) -> bool:
        """True si el circuito está abierto (PB considerado caído)."""
        with self._lock:
            if self._failures < self.FAILURE_THRESHOLD:
                return False
            if (time.time() - self._opened_at) > self.OPEN_SECONDS:
                # Half-open: permitir un intento de sondeo
                self._failures = self.FAILURE_THRESHOLD - 1
                return False
            return True

    def _record_success(self) -> None:
        with self._lock:
            self._failures = 0

    def _record_failure(self) -> None:
        with self._lock:
            self._failures += 1
            if self._failures == self.FAILURE_THRESHOLD:
                self._opened_at = time.time()
                logger.warning(
                    "PBClient: circuito ABIERTO %ss tras %s fallos (PB caído en %s)",
                    self.OPEN_SECONDS, self._failures, self.base_url,
                )

    # ── Núcleo HTTP ───────────────────────────────────────────────────────

    def _request(self, method: str, url: str, **kwargs):
        """Una llamada HTTP con 1 reintento. Lanza si ambos intentos fallan."""
        import requests  # lazy: módulo importable sin la lib
        kwargs.setdefault("timeout", self.timeout)
        last_exc: Exception | None = None
        for attempt in (1, 2):
            try:
                return requests.request(method, url, **kwargs)
            except Exception as exc:
                last_exc = exc
                if attempt == 1:
                    logger.debug("PBClient: reintento %s %s (%s)", method, url, exc)
        raise last_exc  # type: ignore[misc]

    # ── API pública ───────────────────────────────────────────────────────

    def get_records(self, collection: str, params: dict | None = None,
                    fallback: list | None = None) -> list:
        """Pagina todos los registros de una colección. Nunca lanza.

        Devuelve `fallback` (por defecto []) si PB está caído o responde mal,
        o los registros acumulados hasta el punto del fallo (resultado parcial).
        """
        fallback = [] if fallback is None else fallback
        if self._circuit_open():
            return fallback

        results: list = []
        page = 1
        base_params: dict = {"perPage": 500}
        if params:
            base_params.update(params)
        url = f"{self.base_url}/api/collections/{collection}/records"
        try:
            while True:
                base_params["page"] = page
                resp = self._request("GET", url, params=base_params)
                data = resp.json()
                items = data.get("items", [])
                results.extend(items)
                if page >= data.get("totalPages", 1) or not items:
                    break
                page += 1
            self._record_success()
            return results
        except Exception as exc:
            self._record_failure()
            logger.warning("PBClient.get_records(%s) falló: %s", collection, exc)
            # Resultado parcial si alguna página llegó a leerse
            return results if results else fallback

    def create_record(self, collection: str, data: dict, fallback=None):
        """Crea un registro. Nunca lanza: devuelve el JSON creado o `fallback`."""
        if self._circuit_open():
            return fallback
        url = f"{self.base_url}/api/collections/{collection}/records"
        try:
            resp = self._request("POST", url, json=data)
            self._record_success()
            try:
                return resp.json()
            except Exception:
                return fallback
        except Exception as exc:
            self._record_failure()
            logger.warning("PBClient.create_record(%s) falló: %s", collection, exc)
            return fallback


# Instancia global compartida (circuit-breaker común a todo el backend)
pb_client = PBClient()
