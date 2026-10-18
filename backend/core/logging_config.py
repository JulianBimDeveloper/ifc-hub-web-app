"""Configuración de logging unificada del backend IFC Hub v2.

Reemplaza los `print(..., file=sys.stderr)` dispersos por un logging
consistente con timestamps, nivel y nombre de módulo. El nivel se toma
de `settings.LOG_LEVEL` (variable de entorno LOG_LEVEL).
"""

import logging

from core.config import settings

_FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"
_configured = False


def setup_logging() -> None:
    """Configura el root logger una sola vez (idempotente).

    Se llama al inicio de `main.py`. Si uvicorn ya añadió handlers, solo
    ajusta nivel y formato sin duplicar salida.
    """
    global _configured
    if _configured:
        return
    level = getattr(logging, settings.LOG_LEVEL, logging.INFO)
    logging.basicConfig(level=level, format=_FORMAT)
    # basicConfig es no-op si ya hay handlers: forzar nivel/formato igualmente
    root = logging.getLogger()
    root.setLevel(level)
    for handler in root.handlers:
        handler.setFormatter(logging.Formatter(_FORMAT))
    _configured = True


def get_logger(name: str) -> logging.Logger:
    """Devuelve un logger con nombre de módulo (p.ej. `get_logger(__name__)`)."""
    return logging.getLogger(name)
