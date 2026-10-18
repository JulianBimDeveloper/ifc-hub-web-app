"""Settings centralizados del backend IFC Hub v2.

Lee variables de entorno (con defaults seguros para desarrollo local) y,
opcionalmente, un archivo `.env` situado junto al paquete `backend/`.
Sin dependencias externas: parser manual de .env y dataclass estándar.

Uso:
    from core.config import settings
    settings.POCKETBASE_URL
"""

import os
from dataclasses import dataclass, field

# Directorio backend/ (padre de core/)
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_env_file(path: str) -> None:
    """Carga un archivo .env simple (KEY=VALUE) sin pisar variables ya definidas.

    Parser deliberadamente mínimo: ignora comentarios, líneas vacías y
    cualquier línea malformada (degradación elegante, nunca lanza).
    """
    try:
        if not os.path.isfile(path):
            return
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except Exception:
        # Un .env corrupto jamás debe impedir el arranque del backend
        pass


_load_env_file(os.path.join(_BACKEND_DIR, ".env"))


def _env_int(name: str, default: int) -> int:
    """Lee un entero de entorno; ante valor inválido usa el default."""
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    """Lee un float de entorno; ante valor inválido usa el default."""
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class Settings:
    """Configuración global inmutable, resuelta una vez al importar el módulo."""

    # URL base de PocketBase (sin barra final)
    POCKETBASE_URL: str = field(
        default_factory=lambda: os.environ.get(
            "POCKETBASE_URL", "http://127.0.0.1:8090"
        ).rstrip("/")
    )
    # Orígenes CORS permitidos (lista parseada desde CSV)
    CORS_ORIGINS: list = field(
        default_factory=lambda: [
            o.strip()
            for o in os.environ.get(
                "CORS_ORIGINS", "http://localhost:3020,http://127.0.0.1:3020"
            ).split(",")
            if o.strip()
        ]
    )
    # Máximo de modelos IFC abiertos simultáneamente en el pool LRU
    MODEL_CACHE_MAX: int = field(default_factory=lambda: _env_int("MODEL_CACHE_MAX", 4))
    # TTL en segundos de cada modelo cacheado (0 = sin TTL)
    MODEL_CACHE_TTL_S: float = field(
        default_factory=lambda: _env_float("MODEL_CACHE_TTL_S", 900)
    )
    # Timeout por defecto de las llamadas a PocketBase
    PB_TIMEOUT_S: float = field(default_factory=lambda: _env_float("PB_TIMEOUT_S", 5))
    # Raíces de filesystem permitidas para abrir/escribir IFC (CSV de rutas).
    # Vacío = permisivo (comportamiento actual): solo se normaliza la ruta, sin
    # restringir. Al definir IFC_ALLOWED_ROOTS, cualquier ruta fuera de esas
    # carpetas se rechaza (defensa contra path-traversal / escritura arbitraria).
    # Se expanden %VARIABLES% y ~ para que el mismo .env sirva en cualquier PC
    # (p.ej. %USERPROFILE%\OneDrive - ...\Documentos\EXPORT).
    IFC_ALLOWED_ROOTS: list = field(
        default_factory=lambda: [
            os.path.normpath(os.path.expanduser(os.path.expandvars(r.strip())))
            for r in os.environ.get("IFC_ALLOWED_ROOTS", "").split(os.pathsep)
            if r.strip()
        ]
    )
    # Nivel de logging global (DEBUG/INFO/WARNING/ERROR)
    LOG_LEVEL: str = field(
        default_factory=lambda: os.environ.get("LOG_LEVEL", "INFO").upper()
    )
    # Etapa de entrega activa del proyecto. midp_mapping conserva el histórico de
    # todas las etapas (MOI, MOM, ...) sin borrar filas al avanzar de etapa;
    # cambiar aquí (o vía env MIDP_ETAPA_ACTIVA) cuando el proyecto avance.
    MIDP_ETAPA_ACTIVA: str = field(
        default_factory=lambda: os.environ.get("MIDP_ETAPA_ACTIVA", "MOM")
    )
    # URL base de BIMRail Hub (servidor Speckle self-hosted, ver
    # DEPLOYMENT/speckle-server/) — usado para construir los enlaces del visor.
    SPECKLE_URL: str = field(
        default_factory=lambda: os.environ.get("SPECKLE_URL", "http://127.0.0.1").rstrip("/")
    )


# Singleton importable: `from core.config import settings`
settings = Settings()
