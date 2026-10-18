import os
import asyncio
from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse, Response

router = APIRouter()


def _file_etag(path: str) -> str:
    """ETag estable basado en mtime+size; permite 304 Not Modified."""
    try:
        st = os.stat(path)
        return f'"{int(st.st_mtime)}-{st.st_size}"'
    except OSError:
        return ""

_ASSETS = os.path.join(os.path.dirname(__file__), "..", "..", "..",
                        "ifc-hub", "assets")

# Visor nuevo (That Open Platform, viewer-next/) — reemplaza al legado de
# three.js+IFCB de arriba. dist/ lo monta main.py como estático en /viewer-static;
# aquí solo se sirve el HTML.
_VIEWER_NEXT_HTML = os.path.abspath(os.path.join(
    os.path.dirname(__file__), "..", "..", "viewer-next", "dist", "index.html",
))

# token → file path registry (shared with v1 state or standalone)
_TOKEN_MAP: dict[str, str] = {}


def register_token(token: str, path: str):
    _TOKEN_MAP[token] = path


def get_path(token: str):
    return _TOKEN_MAP.get(token)


@router.get("/viewer-html")
async def viewer_html():
    """Sirve el visor That Open Platform (viewer-next/dist/index.html).

    El visor legado (three.js + IFCB) queda en `ifc-hub/assets/viewer/` sin
    servirse desde aquí (ver CLAUDE.md / plan de migración) hasta la fase de
    limpieza final; si el build nuevo no existe todavía, se cae a él como
    fallback para no dejar /viewer-html en 404 durante el desarrollo.
    """
    if os.path.isfile(_VIEWER_NEXT_HTML):
        return FileResponse(_VIEWER_NEXT_HTML, media_type="text/html",
                            headers={"Cache-Control": "no-cache"})

    legacy_path = os.path.abspath(os.path.join(_ASSETS, "viewer", "index.html"))
    if os.path.isfile(legacy_path):
        return FileResponse(legacy_path, media_type="text/html",
                            headers={"Cache-Control": "no-cache"})

    return Response(status_code=404, content="viewer html not found",
                    media_type="text/plain")


@router.get("/viewer-geom-bin")
async def viewer_geom_bin(request: Request, token: str = "", path: str = ""):
    """Geometría IFC como buffer binario IFCB (sin base64, sin JSON wrapper).

    5-10x más rápido que /viewer-geom en serialización Python.
    Payload -33% vs base64. El browser lo lee con arrayBuffer() zero-copy.

    Acepta token (legacy v1) o path directo (v2, para uso en localhost).

    Formato IFCB v1:
      [4B] magic "IFCB" | [4B] n_verts | [4B] n_tris | [4B] json_len
      positions(F32) | normals(F32) | colors(F32) | ids(I32) | indices(U32)
      elements_json(UTF-8, json_len bytes)
    """
    # Resolver ruta: token tiene prioridad, luego path directo
    resolved = get_path(token) if token else path
    if not resolved:
        return Response(status_code=400, content="missing token or path",
                        media_type="text/plain")
    if not os.path.isfile(resolved):
        return Response(status_code=404, content="not found",
                        media_type="text/plain")
    path = resolved  # reusar variable para el resto del handler

    # ── ETag / 304: si el navegador ya tiene esta versión, no reenviar bytes ──
    etag = _file_etag(path)
    if etag and request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={
            "ETag": etag,
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=600",
        })

    from services.viewer_geometry import extract_geometry_binary
    loop = asyncio.get_event_loop()
    try:
        bin_data = await loop.run_in_executor(None, extract_geometry_binary, path)
    except Exception as e:
        import struct, json
        err_json = json.dumps({"error": str(e), "elements": []}).encode()
        header   = struct.pack("<4sIII", b"IFCB", 0, 0, len(err_json))
        bin_data = header + err_json

    headers = {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=600",
    }
    if etag:
        headers["ETag"] = etag
    return Response(
        content=bin_data,
        media_type="application/octet-stream",
        headers=headers,
    )


@router.get("/viewer-geom-warm")
async def viewer_geom_warm(token: str = "", path: str = ""):
    """Pre-extrae y cachea la geometría SIN devolver el binario pesado.

    Lo usa el pre-cache en segundo plano: dispara este endpoint al seleccionar
    archivos para que, al pulsar "Cargar en visor", la geometría ya esté en
    caché (memoria/disco) y la carga sea instantánea.
    Devuelve un JSON pequeño con el conteo de triángulos.
    """
    resolved = get_path(token) if token else path
    if not resolved or not os.path.isfile(resolved):
        return JSONResponse({"cached": False, "error": "not found"}, status_code=404)

    import struct
    from services.viewer_geometry import extract_geometry_binary
    loop = asyncio.get_event_loop()
    try:
        bin_data = await loop.run_in_executor(None, extract_geometry_binary, resolved)
        # Cabecera IFCB: magic(4) | n_verts(u32) | n_tris(u32) | json_len(u32)
        _magic, n_verts, n_tris, _jl = struct.unpack("<4sIII", bin_data[:16])
        return JSONResponse(
            {"cached": True, "verts": int(n_verts), "tris": int(n_tris)},
            headers={"Access-Control-Allow-Origin": "*"},
        )
    except Exception as e:
        return JSONResponse({"cached": False, "error": str(e)}, status_code=500)


@router.get("/viewer-frag")
async def viewer_frag(request: Request, path: str = ""):
    """Geometría IFC como Fragments (.frag) — visor That Open Platform.

    Convierte con el subproceso Node de `frag_converter/` (cacheado en disco,
    ver services/frag_cache.py) y sirve el binario resultante. Mismo patrón
    ETag/304 que /viewer-geom-bin.
    """
    if not path:
        return Response(status_code=400, content="missing path",
                        media_type="text/plain")
    if not os.path.isfile(path):
        return Response(status_code=404, content="not found",
                        media_type="text/plain")

    from services.frag_cache import FragConversionError, get_fragments_path

    loop = asyncio.get_event_loop()
    try:
        frag_path = await loop.run_in_executor(None, get_fragments_path, path)
    except FragConversionError as e:
        return Response(status_code=500, content=str(e), media_type="text/plain")
    except FileNotFoundError:
        return Response(status_code=404, content="not found",
                        media_type="text/plain")

    etag = _file_etag(frag_path)
    if etag and request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={
            "ETag": etag,
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=600",
        })

    headers = {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=600",
    }
    if etag:
        headers["ETag"] = etag
    return FileResponse(frag_path, media_type="application/octet-stream", headers=headers)


@router.get("/viewer-geom-patch")
async def viewer_geom_patch(request: Request, path: str = ""):
    """Geometría "parche" (ifcopenshell) para representaciones que web-ifc no
    tesela (IfcFacetedBrep con huecos, IfcSurfaceCurveSweptAreaSolid — ver
    services/geom_patch.py). Vacía (n_verts=0) en el caso normal de un IFC
    sin estas representaciones.
    """
    if not path:
        return Response(status_code=400, content="missing path",
                        media_type="text/plain")
    if not os.path.isfile(path):
        return Response(status_code=404, content="not found",
                        media_type="text/plain")

    from services.geom_patch import get_patch_path

    loop = asyncio.get_event_loop()
    try:
        patch_path = await loop.run_in_executor(None, get_patch_path, path)
    except Exception as e:
        return Response(status_code=500, content=str(e), media_type="text/plain")

    etag = _file_etag(patch_path)
    if etag and request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={
            "ETag": etag,
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=600",
        })

    headers = {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=600",
    }
    if etag:
        headers["ETag"] = etag
    return FileResponse(patch_path, media_type="application/octet-stream", headers=headers)


@router.get("/viewer-geom")
async def viewer_geom(token: str = ""):
    import json
    if not token:
        return Response(status_code=400, content="missing token",
                        media_type="text/plain")
    path = get_path(token)
    if not path or not os.path.isfile(path):
        return Response(status_code=404, content="not found",
                        media_type="text/plain")

    from services.viewer_geometry import extract_geometry
    loop = asyncio.get_event_loop()
    try:
        geom_json = await loop.run_in_executor(None, extract_geometry, path)
    except Exception as e:
        geom_json = json.dumps({"error": str(e), "positions": "",
                                "normals": "", "indices": "",
                                "colors": "", "ids": "",
                                "elements": []}).encode()

    return Response(
        content=geom_json,
        media_type="application/json",
        headers={
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=600",
        },
    )
