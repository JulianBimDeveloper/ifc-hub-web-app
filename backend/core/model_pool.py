"""Pool LRU thread-safe de modelos ifcopenshell abiertos.

Por qué existe este módulo:
    - Un IFC de infraestructura puede ocupar 500 MB en disco y bastante más
      en memoria una vez parseado. Cachear modelos sin límite (dict global)
      provoca OOM cuando el usuario navega entre muchos archivos.
    - FastAPI ejecuta los endpoints síncronos en un threadpool: dos requests
      simultáneas sobre el mismo archivo podían abrir/parsear el mismo IFC
      dos veces (CPU duplicada) o, peor, leer mientras otro hilo escribía
      (corrupción / estado inconsistente).

Solución:
    - LRU acotado por `settings.MODEL_CACHE_MAX` con TTL opcional.
    - Invalidación automática por mtime: si el archivo cambió en disco
      (re-export desde Revit/Civil3D, escritura propia), se recarga.
    - Lock por archivo (dict de locks bajo un lock global): el parseo de un
      IFC grande no bloquea el acceso a otros archivos ya cacheados.
    - `ifcopenshell` se importa de forma lazy DENTRO de los métodos para que
      el módulo compile/importe en entornos sin la librería.
"""

import os
import threading
import time
from collections import OrderedDict
from contextlib import contextmanager

from core.config import settings
from core.logging_config import get_logger

logger = get_logger(__name__)


class IFCModelPool:
    """Pool LRU de modelos IFC abiertos con invalidación por mtime y TTL."""

    def __init__(self, max_size: int | None = None, ttl_s: float | None = None):
        self._max_size = max_size if max_size is not None else settings.MODEL_CACHE_MAX
        self._ttl_s = ttl_s if ttl_s is not None else settings.MODEL_CACHE_TTL_S
        # path -> {"model", "mtime", "loaded_at"} — orden = LRU (último al final)
        self._entries: "OrderedDict[str, dict]" = OrderedDict()
        self._global_lock = threading.Lock()       # protege _entries y _locks
        # Lock por archivo: RLock (reentrante) para que un writer pueda mantener
        # el lock durante toda su transacción mutate+write y, dentro de ella,
        # llamar a get() sobre el mismo path sin auto-bloquearse. Lectores de
        # OTROS hilos sí esperan → se serializa la lectura-durante-escritura.
        self._locks: dict[str, threading.RLock] = {}  # lock por archivo
        self._hits = 0
        self._misses = 0
        self._evictions = 0

    # ── Internos ──────────────────────────────────────────────────────────

    def _file_lock(self, path: str) -> threading.RLock:
        """Devuelve (creando si hace falta) el lock reentrante de un archivo."""
        with self._global_lock:
            lock = self._locks.get(path)
            if lock is None:
                lock = threading.RLock()
                self._locks[path] = lock
            return lock

    @staticmethod
    def _mtime(path: str) -> float:
        try:
            return os.path.getmtime(path)
        except OSError:
            return 0.0

    def _entry_valid(self, entry: dict, current_mtime: float) -> bool:
        """Un entry es válido si el archivo no cambió y no expiró su TTL."""
        if entry["mtime"] != current_mtime:
            return False
        if self._ttl_s and (time.time() - entry["loaded_at"]) > self._ttl_s:
            return False
        return True

    # ── API pública ───────────────────────────────────────────────────────

    @contextmanager
    def lock(self, path: str):
        """Context manager que toma el lock reentrante del archivo.

        Pensado para envolver una transacción completa de escritura:

            with model_pool.lock(path):
                model = model_pool.get(path)   # reentrante: no se bloquea
                ...  # mutar el modelo
                atomic_write_model(model, path)

        Mientras el bloque está activo, cualquier otra request (lector o
        escritor) sobre el MISMO archivo espera, eliminando la carrera de
        leer un modelo a medio mutar. Accesos a OTROS archivos no se ven
        afectados (lock por archivo, no global).
        """
        lk = self._file_lock(path)
        lk.acquire()
        try:
            yield
        finally:
            lk.release()

    def get(self, path: str):
        """Devuelve el modelo ifcopenshell del archivo, cacheado si es posible.

        Thread-safe: el parseo de cada archivo se serializa con un lock
        propio, de modo que N requests concurrentes sobre el mismo IFC
        solo lo parsean una vez.
        """
        lock = self._file_lock(path)
        with lock:
            current_mtime = self._mtime(path)

            with self._global_lock:
                entry = self._entries.get(path)
                if entry is not None and self._entry_valid(entry, current_mtime):
                    self._entries.move_to_end(path)   # refresco LRU
                    self._hits += 1
                    return entry["model"]
                # Inválido o inexistente → descartar antes de recargar
                self._entries.pop(path, None)

            # Parseo fuera del lock global (puede tardar segundos en IFC grandes)
            import ifcopenshell  # lazy: permite compilar sin la lib instalada
            self._misses += 1
            t0 = time.time()
            model = ifcopenshell.open(path)
            logger.debug(
                "IFC abierto: %s (%.2fs)", os.path.basename(path), time.time() - t0
            )

            with self._global_lock:
                self._entries[path] = {
                    "model": model,
                    "mtime": current_mtime,
                    "loaded_at": time.time(),
                }
                self._entries.move_to_end(path)
                # Evicción LRU: liberar los modelos menos usados
                while len(self._entries) > self._max_size:
                    evicted_path, _ = self._entries.popitem(last=False)
                    self._evictions += 1
                    logger.debug("Pool IFC: evicción LRU de %s", evicted_path)
            return model

    def invalidate(self, path: str) -> None:
        """Expulsa un archivo del pool (p.ej. tras escribirlo en disco)."""
        with self._global_lock:
            self._entries.pop(path, None)

    def clear(self) -> None:
        """Vacía el pool por completo."""
        with self._global_lock:
            self._entries.clear()

    def on_write(self, path: str, model=None) -> None:
        """Notifica al pool que `path` acaba de escribirse a disco.

        - Si el modelo escrito ES la instancia cacheada, se re-sincroniza el
          mtime: el contenido en memoria coincide con el disco y se evita un
          re-parseo en la siguiente request (velocidad).
        - Si es otra instancia (o se desconoce), se invalida la entrada para
          no servir jamás un modelo obsoleto (integridad sobre velocidad).
        """
        with self._global_lock:
            entry = self._entries.get(path)
            if entry is None:
                return
            if model is not None and entry["model"] is model:
                entry["mtime"] = self._mtime(path)
                entry["loaded_at"] = time.time()
            else:
                self._entries.pop(path, None)

    def stats(self) -> dict:
        """Métricas del pool para diagnóstico."""
        with self._global_lock:
            return {
                "size": len(self._entries),
                "max_size": self._max_size,
                "ttl_s": self._ttl_s,
                "hits": self._hits,
                "misses": self._misses,
                "evictions": self._evictions,
                "paths": list(self._entries.keys()),
            }


# Instancia global compartida por todo el backend
model_pool = IFCModelPool()
