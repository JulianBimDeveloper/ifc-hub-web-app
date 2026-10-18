"""Telemetría fire-and-forget para el dashboard del IFC HUB.

Cada herramienta llama a `log_event(...)` después de una acción significativa.
Los errores de red NUNCA se propagan ni bloquean: el envío a PocketBase se
hace en un hilo daemon en segundo plano usando `PBClient` (timeout, reintento
y circuit-breaker). Si PocketBase está caído, la UI sigue funcionando
exactamente igual y sin latencia añadida.
"""

import threading
import time
from contextlib import contextmanager

from core.logging_config import get_logger
from core.resilience import pb_client

logger = get_logger(__name__)

_COLLECTION = "ifc_hub_events"


def log_event(
    tool: str,
    action: str,
    ok: bool,
    target_count: int = 0,
    secondary_count: int = 0,
    duration_ms: int = 0,
) -> None:
    """Registra un evento en `ifc_hub_events`. Nunca lanza ni bloquea.

    El POST se despacha en un hilo daemon: el endpoint que llama retorna
    inmediatamente aunque PocketBase esté caído o lento.
    """
    payload = {
        "tool":            tool,
        "action":          action,
        "ok":              bool(ok),
        "target_count":    int(target_count),
        "secondary_count": int(secondary_count),
        "duration_ms":     int(duration_ms),
    }

    def _send() -> None:
        try:
            pb_client.create_record(_COLLECTION, payload)
        except Exception as exc:  # PBClient ya no lanza, esto es cinturón extra
            logger.debug("Telemetría descartada (%s/%s): %s", tool, action, exc)

    try:
        threading.Thread(target=_send, daemon=True).start()
    except Exception as exc:
        # Sin recursos para un hilo → descartar el evento, jamás romper la UI
        logger.debug("Telemetría no despachada (%s/%s): %s", tool, action, exc)


@contextmanager
def track(tool: str, action: str):
    """Context manager: mide duración y registra al salir.

    Uso:
        with track("classifier", "classify") as t:
            ...trabajo...
            t["target"]    = elementos_clasificados
            t["secondary"] = duplicados_corregidos
            t["ok"]        = True
    """
    t0 = time.time()
    state = {"ok": False, "target": 0, "secondary": 0}
    try:
        yield state
    finally:
        log_event(
            tool, action, state["ok"],
            state["target"], state["secondary"],
            int((time.time() - t0) * 1000),
        )
