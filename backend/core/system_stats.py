"""Snapshot de memoria/caché del proceso backend, para el indicador del Navbar.

El backend mantiene varias cachés independientes de archivos IFC abiertos
(`model_pool`, y las derivadas de `services.ifc_sync`/`services.viewer_geometry`).
Solo `model_pool` tiene límite (LRU); las demás crecen un entry por cada
archivo distinto que el usuario visita con cualquier herramienta y solo se
liberan a mano — es la causa más probable de que la RAM del proceso "se
vaya sumando" según se pasa de una herramienta a otra en la misma sesión.

Este módulo expone `get_stats()` (RSS del proceso vía psutil + tamaño de cada
caché) y `clear_all()` para vaciarlas todas desde el Navbar sin reiniciar el
backend.
"""

import os


def get_stats() -> dict:
    """Snapshot de memoria de proceso (RSS en MB) + tamaño de cada caché IFC."""
    from core.model_pool import model_pool
    from services import ifc_sync, viewer_geometry

    try:
        import psutil
        proc = psutil.Process(os.getpid())
        rss_mb = round(proc.memory_info().rss / 1e6, 1)
        vmem = psutil.virtual_memory()
        system_total_mb = round(vmem.total / 1e6, 0)
        system_percent = vmem.percent
    except Exception:
        rss_mb = 0.0
        system_total_mb = 0.0
        system_percent = 0.0

    pool_stats = model_pool.stats()
    sync_stats = ifc_sync.cache_stats()
    geom_stats = viewer_geometry.stats()

    # Tamaño en disco de los archivos actualmente cacheados en el pool
    # (proxy honesto del coste de cada uno — ifcopenshell no expone el
    # tamaño real en memoria de un modelo ya parseado).
    models = []
    for path in pool_stats["paths"]:
        try:
            size_mb = round(os.path.getsize(path) / 1e6, 1)
        except OSError:
            size_mb = None
        models.append({"path": path, "name": os.path.basename(path), "size_mb": size_mb})

    return {
        "process": {
            "rss_mb": rss_mb,
            "system_total_mb": system_total_mb,
            "system_percent": system_percent,
        },
        "model_pool": {
            "size": pool_stats["size"],
            "max_size": pool_stats["max_size"],
            "hits": pool_stats["hits"],
            "misses": pool_stats["misses"],
            "evictions": pool_stats["evictions"],
            "models": models,
        },
        # Cachés derivadas SIN límite — lo que de verdad puede acumularse.
        "derived_caches": {
            **sync_stats,
            **geom_stats,
        },
    }


def clear_all() -> None:
    """Vacía TODAS las cachés IFC del proceso (modelos + derivadas)."""
    from services import ifc_sync, viewer_geometry

    ifc_sync.clear_ifc_cache()   # ya limpia model_pool + sus propias derivadas
    viewer_geometry.clear_all()
