"""Repositorio IFC — puerta ÚNICA de acceso a modelos IFC del backend.

Por qué existe:
    El backend abría modelos IFC de tres formas distintas (``ifcopenshell.open``
    crudo, ``model_pool.get``, ``_open_cached``) y escribía de dos (``model.write``
    directo y ``atomic_write_model``). Esa dispersión causaba: re-parseo de
    archivos de cientos de MB, lecturas concurrentes sin lock, y escrituras no
    atómicas que podían corromper el IFC original.

    Este módulo centraliza TODO el acceso en una sola fachada fina sobre la
    infraestructura ya existente (``core.model_pool`` y ``core.resilience``).
    No cambia rutas ni contratos de API: es una capa interna.

Regla de equipo:
    Ninguna ruta de lectura/escritura de IFC debería abrir o escribir fuera de
    este repositorio. (Vigilable con un grep de ``ifcopenshell.open`` / ``.write(``
    en CI.)

Uso típico de lectura:
    from core.ifc_repository import repo
    model = repo.get(path)            # cacheado en el pool LRU, lock por archivo

Uso típico de escritura (transacción atómica y aislada de lectores):
    with repo.transaction(path) as model:   # toma el lock del archivo
        ...  # mutar `model`
        repo.write(model, path)             # escritura atómica + invalida pool
"""

import os
from contextlib import contextmanager

from core.config import settings
from core.logging_config import get_logger
from core.model_pool import model_pool
from core.resilience import atomic_write_model

logger = get_logger(__name__)


class PathNotAllowed(ValueError):
    """La ruta solicitada queda fuera de las raíces permitidas (IFC_ALLOWED_ROOTS)."""


class IFCRepository:
    """Fachada fina y stateless sobre el pool de modelos y la escritura atómica."""

    # ── Validación de rutas ────────────────────────────────────────────────

    @staticmethod
    def safe_path(path: str) -> str:
        """Normaliza y valida una ruta de IFC.

        - Siempre devuelve la ruta normalizada (``realpath``), resolviendo
          ``..`` y enlaces simbólicos.
        - Si ``settings.IFC_ALLOWED_ROOTS`` está configurado, exige que la ruta
          quede DENTRO de alguna de esas raíces; si no, lanza ``PathNotAllowed``.
        - Si no hay raíces configuradas, es permisivo (comportamiento actual):
          solo normaliza, no restringe.

        No comprueba existencia del archivo (eso es responsabilidad del llamante,
        que suele devolver 404). Aquí solo se valida que la ubicación sea legítima.
        """
        if not path or not isinstance(path, str):
            raise PathNotAllowed("Ruta vacía o inválida")
        norm = os.path.realpath(path)
        roots = settings.IFC_ALLOWED_ROOTS
        if not roots:
            return norm
        for root in roots:
            root_real = os.path.realpath(root)
            try:
                if os.path.commonpath([norm, root_real]) == root_real:
                    return norm
            except ValueError:
                # commonpath lanza si las rutas están en unidades distintas (Windows)
                continue
        raise PathNotAllowed(f"Ruta fuera de las carpetas permitidas: {path}")

    # ── Lectura ─────────────────────────────────────────────────────────────

    def get(self, path: str, validate: bool = False):
        """Devuelve el modelo IFC desde el pool LRU (cacheado, lock por archivo).

        Con ``validate=True`` aplica ``safe_path`` antes de abrir. Por defecto
        ``False`` para no alterar el comportamiento de los llamantes existentes
        que aún no pasan por la validación.
        """
        if validate:
            path = self.safe_path(path)
        return model_pool.get(path)

    # ── Escritura ─────────────────────────────────────────────────────────

    def write(self, model, path: str) -> None:
        """Escribe el modelo de forma atómica (tmp + replace) y notifica al pool.

        Delega en ``atomic_write_model``: si la escritura falla a mitad, el
        archivo original queda intacto. Nunca deja un IFC truncado en disco.
        """
        atomic_write_model(model, path)

    # ── Transacción (lock por archivo que cubre mutate + write) ─────────────

    @contextmanager
    def transaction(self, path: str, validate: bool = False):
        """Context manager que abre el modelo bajo el lock del archivo.

        Mantiene el lock durante TODO el bloque, de modo que ningún otro hilo
        (lector o escritor) acceda al mismo archivo mientras se muta. Hace
        ``yield`` del modelo ya abierto para comodidad del llamante:

            with repo.transaction(path) as model:
                ...  # mutar model
                repo.write(model, path)

        Resuelve la carrera "leer un modelo a medio mutar" (lock reentrante:
        ``get`` dentro del bloque no se auto-bloquea).
        """
        if validate:
            path = self.safe_path(path)
        with model_pool.lock(path):
            model = model_pool.get(path)
            yield model

    # ── Diagnóstico ─────────────────────────────────────────────────────────

    @staticmethod
    def stats() -> dict:
        return model_pool.stats()


# Instancia global compartida: `from core.ifc_repository import repo`
repo = IFCRepository()
