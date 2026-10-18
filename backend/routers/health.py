from fastapi import APIRouter

from core import system_stats

router = APIRouter()

@router.get("/healthz")
def health():
    return {"status": "ok", "service": "ifc-hub-v2-api"}


@router.get("/api/system/stats")
def system_stats_endpoint():
    """Snapshot de RAM del proceso + cachés IFC, para el indicador del Navbar."""
    return system_stats.get_stats()


@router.post("/api/system/clear-cache")
def clear_cache_endpoint():
    """Vacía todas las cachés IFC del backend (modelos + geometría + derivadas)."""
    system_stats.clear_all()
    return system_stats.get_stats()
