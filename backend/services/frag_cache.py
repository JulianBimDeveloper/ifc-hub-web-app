"""Caché en disco de conversiones IFC -> Fragments (.frag).

Mismo patrón que la caché de geometría IFCB en ``viewer_geometry.py`` (clave =
sha1(ruta_absoluta|mtime|size), fuera de ``backend/`` para no disparar el
reload de uvicorn), pero aquí el "extractor" es un subproceso Node que corre
``frag_converter/convert_one.mjs`` (paquete validado en SPIKE_VISOR contra la
federación ADIF real: 401MB -> 81MB en 162s).

Por qué un subproceso y no un servicio Node separado: la conversión es un
proceso corto y aislado (un IFC -> un .frag); no hay estado que justifique un
servidor Node persistente, y así el backend sigue siendo Python puro salvo por
esta única invocación puntual.
"""

import hashlib
import json
import os
import subprocess

from core.logging_config import get_logger

logger = get_logger(__name__)

_FRAG_CACHE_DIR = os.environ.get(
    "IFC_HUB_FRAG_CACHE",
    os.path.join(os.path.expanduser("~"), ".ifc-hub-v2", "frag_cache"),
)

_CONVERTER_DIR = os.path.join(os.path.dirname(__file__), "..", "frag_converter")
_CONVERTER_SCRIPT = os.path.join(_CONVERTER_DIR, "convert_one.mjs")

_CONVERT_TIMEOUT_SECS = int(os.environ.get("IFC_HUB_FRAG_CONVERT_TIMEOUT", "900"))


class FragConversionError(RuntimeError):
    """La conversión Node fallo o el binario `node` no está disponible."""


def _disk_cache_key(ifc_path: str) -> str | None:
    try:
        st = os.stat(ifc_path)
    except OSError:
        return None
    raw = f"{os.path.abspath(ifc_path)}|{int(st.st_mtime)}|{st.st_size}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _disk_cache_path(key: str) -> str:
    return os.path.join(_FRAG_CACHE_DIR, f"{key}.frag")


def get_fragments_path(ifc_path: str) -> str:
    """Devuelve la ruta al .frag cacheado para `ifc_path`, convirtiendo si hace falta.

    Lanza FileNotFoundError si el IFC no existe, o FragConversionError si el
    subproceso Node falla (ver mensaje de error del propio `convert_one.mjs`).
    """
    if not os.path.isfile(ifc_path):
        raise FileNotFoundError(ifc_path)

    key = _disk_cache_key(ifc_path)
    if key is None:
        raise FileNotFoundError(ifc_path)

    cache_path = _disk_cache_path(key)
    if os.path.isfile(cache_path):
        return cache_path

    os.makedirs(_FRAG_CACHE_DIR, exist_ok=True)
    tmp_path = cache_path + ".tmp"

    logger.info("frag_cache: convirtiendo %s -> %s", ifc_path, cache_path)
    try:
        result = subprocess.run(
            ["node", _CONVERTER_SCRIPT, os.path.abspath(ifc_path), tmp_path],
            cwd=_CONVERTER_DIR,
            capture_output=True,
            text=True,
            timeout=_CONVERT_TIMEOUT_SECS,
        )
    except FileNotFoundError as e:
        raise FragConversionError(
            "No se encontró el binario 'node' en PATH del backend"
        ) from e
    except subprocess.TimeoutExpired as e:
        raise FragConversionError(
            f"Conversión de {ifc_path} superó el timeout de {_CONVERT_TIMEOUT_SECS}s"
        ) from e

    stdout = (result.stdout or "").strip().splitlines()
    payload = {}
    if stdout:
        try:
            payload = json.loads(stdout[-1])
        except json.JSONDecodeError:
            payload = {}

    if result.returncode != 0 or not payload.get("ok"):
        error_msg = payload.get("error") or result.stderr or "conversión Node fallida"
        raise FragConversionError(error_msg)

    os.replace(tmp_path, cache_path)
    logger.info(
        "frag_cache: OK %s (%.1fMB -> %.1fMB en %.1fs)",
        os.path.basename(ifc_path),
        payload.get("ifcBytes", 0) / 1048576,
        payload.get("fragBytes", 0) / 1048576,
        payload.get("secs", 0),
    )
    return cache_path


def stats() -> dict:
    try:
        files = [f for f in os.listdir(_FRAG_CACHE_DIR) if f.endswith(".frag")]
    except OSError:
        files = []
    return {"frag_cache_dir": _FRAG_CACHE_DIR, "cached_files": len(files)}
