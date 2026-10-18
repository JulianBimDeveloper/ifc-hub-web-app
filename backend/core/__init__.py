"""Núcleo transversal del backend IFC Hub v2.

Módulos:
    - config:          settings centralizados (variables de entorno + .env).
    - logging_config:  configuración de logging unificada.
    - model_pool:      pool LRU thread-safe de modelos ifcopenshell.
    - resilience:      escritura atómica, coerción de tipos, decorador `safe`
                       y cliente PocketBase con timeout/reintento/circuit-breaker.

Filosofía: velocidad de respuesta y degradación elegante — los fallos
pequeños se loggean y se continúa; la generalidad nunca se cae.
"""

from core.config import settings
from core.logging_config import setup_logging, get_logger

__all__ = ["settings", "setup_logging", "get_logger"]
