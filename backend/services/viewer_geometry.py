"""Extrae geometría 3D de archivos IFC para el visor.

En lugar de parsear IFC en el navegador con WASM (frágil y dependiente de CDN),
extraemos la geometría en el backend con ifcopenshell y la enviamos como
un buffer binario compacto que Three.js puede consumir directamente.

Formato de respuesta: JSON con arrays Float32/Int32 codificados en base64.
  {
    "positions": "<base64 Float32Array>",   # [x,y,z, x,y,z, ...]
    "normals":   "<base64 Float32Array>",   # [nx,ny,nz, ...]  (misma longitud)
    "indices":   "<base64 Uint32Array>",    # [i,j,k, i,j,k, ...]
    "colors":    "<base64 Float32Array>",   # [r,g,b, ...]  (por vértice)
    "ids":       "<base64 Int32Array>",     # step_id IFC por vértice
    "elements":  [{ "step_id", "type", "name", "guid" }, ...]
  }
"""
import base64
import json
import struct
from typing import Any

from services.ifc_sync import _open_cached

# ── Cache geometría ya extraída ───────────────────────────────────────────────
_GEOM_CACHE: dict[str, bytes] = {}   # ifc_path → JSON bytes


def _b64_f32(arr: list[float]) -> str:
    """Empaqueta floats como Float32 y codifica en base64."""
    if not arr:
        return ""
    return base64.b64encode(struct.pack(f"{len(arr)}f", *arr)).decode()


def _b64_u32(arr: list[int]) -> str:
    """Empaqueta ints como Uint32 y codifica en base64."""
    if not arr:
        return ""
    return base64.b64encode(struct.pack(f"{len(arr)}I", *arr)).decode()


def _b64_i32(arr: list[int]) -> str:
    """Empaqueta ints como Int32 y codifica en base64."""
    if not arr:
        return ""
    return base64.b64encode(struct.pack(f"{len(arr)}i", *arr)).decode()


# Paleta de colores por tipo IFC
_TYPE_COLOR: dict[str, tuple[float, float, float]] = {
    "IfcWall":                 (0.78, 0.78, 0.78),
    "IfcWallStandardCase":     (0.78, 0.78, 0.78),
    "IfcSlab":                 (0.65, 0.65, 0.60),
    "IfcRoof":                 (0.80, 0.55, 0.35),
    "IfcColumn":               (0.55, 0.75, 0.90),
    "IfcBeam":                 (0.55, 0.70, 0.90),
    "IfcDoor":                 (0.90, 0.80, 0.45),
    "IfcWindow":               (0.55, 0.85, 0.95),
    "IfcRailing":              (0.60, 0.60, 0.65),
    "IfcStair":                (0.80, 0.70, 0.55),
    "IfcStairFlight":          (0.80, 0.70, 0.55),
    "IfcCovering":             (0.70, 0.65, 0.60),
    "IfcFurnishingElement":    (0.75, 0.65, 0.50),
    "IfcBuildingElementProxy": (0.62, 0.60, 0.56),
    "IfcMember":               (0.50, 0.70, 0.85),
    "IfcPlate":                (0.55, 0.80, 0.70),
    "IfcFlowSegment":          (0.30, 0.60, 0.30),
    "IfcPipeSegment":          (0.30, 0.60, 0.30),
    "IfcDuctSegment":          (0.60, 0.40, 0.65),
    "IfcCableSegment":         (0.90, 0.70, 0.20),
    # IFC4x3 infraestructura ferroviaria / civil
    "IfcRail":                 (0.22, 0.22, 0.25),   # acero de vía
    "IfcTrackElement":         (0.22, 0.22, 0.25),
    "IfcCourse":               (0.68, 0.64, 0.56),   # balasto / capa
    "IfcPavement":             (0.58, 0.56, 0.52),
    "IfcBridge":               (0.66, 0.62, 0.56),
    "IfcBridgePart":           (0.66, 0.62, 0.56),
    "IfcBuiltElement":         (0.62, 0.60, 0.56),
    "IfcCivilElement":         (0.60, 0.58, 0.52),
    "IfcEarthworksCut":        (0.62, 0.54, 0.40),
    "IfcEarthworksFill":       (0.58, 0.50, 0.38),
}
_DEFAULT_COLOR = (0.62, 0.60, 0.56)


def _color_from_name(name: str) -> tuple[float, float, float] | None:
    """Heurística de color por nombre del elemento (convenio Civil 3D / IFC4x3 rail)."""
    nl = (name or "").lower()
    # Acero / carril
    if any(k in nl for k in ("rail", "carril", "acero", "steel", "metalic", "metal")):
        return (0.22, 0.22, 0.25)
    # Hormigón estructural
    if any(k in nl for k in ("losa", "tablero", "viga", "dintel", "hormig", "concret",
                              "slab", "deck", "beam", "girder")):
        return (0.68, 0.66, 0.60)
    # Pilares / apoyos
    if any(k in nl for k in ("pila", "pilar", "pier", "support", "apoyo", "zapata",
                              "cimiento", "foundation")):
        return (0.72, 0.70, 0.64)
    # Balasto / capas de vía
    if any(k in nl for k in ("balasto", "ballast", "grava", "gravel")):
        return (0.55, 0.52, 0.46)
    # Traviesa / durmiente
    if any(k in nl for k in ("traviesa", "sleeper", "durmiente", "crosstie")):
        return (0.35, 0.30, 0.24)
    # Relleno / tierra
    if any(k in nl for k in ("rellen", "tierra", "talud", "terraplen", "embankment",
                              "earth", "fill", "slope")):
        return (0.60, 0.52, 0.36)
    # Drenaje / tubería
    if any(k in nl for k in ("drena", "tubo", "pipe", "cuneta", "drain")):
        return (0.30, 0.55, 0.35)
    return None


def extract_geometry(ifc_path: str, force: bool = False) -> bytes:
    """Extrae toda la geometría visible del IFC y devuelve JSON compacto (bytes).

    Usa caché en memoria. Llama con force=True para re-extraer.
    """
    if not force and ifc_path in _GEOM_CACHE:
        return _GEOM_CACHE[ifc_path]

    try:
        import ifcopenshell
        import ifcopenshell.geom
    except ImportError:
        return json.dumps({"error": "ifcopenshell not installed",
                           "positions": "", "normals": "", "indices": "",
                           "colors": "", "ids": "", "elements": []}).encode()

    try:
        model = _open_cached(ifc_path)
    except Exception as e:
        return json.dumps({"error": str(e),
                           "positions": "", "normals": "", "indices": "",
                           "colors": "", "ids": "", "elements": []}).encode()

    import multiprocessing
    num_threads = max(1, min(multiprocessing.cpu_count(), 4))

    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)
    settings.set(settings.WELD_VERTICES,    True)

    pos_buf:   list[float] = []
    nor_buf:   list[float] = []
    col_buf:   list[float] = []
    id_buf:    list[int]   = []
    idx_buf:   list[int]   = []
    elements:  list[dict]  = []

    vert_offset = 0

    try:
        it = ifcopenshell.geom.iterator(settings, model, num_threads)
    except Exception as e:
        return json.dumps({"error": f"iterator failed: {e}",
                           "positions": "", "normals": "", "indices": "",
                           "colors": "", "ids": "", "elements": []}).encode()

    if not it.initialize():
        data = {"positions": "", "normals": "", "indices": "",
                "colors": "", "ids": "", "elements": []}
        out = json.dumps(data).encode()
        _GEOM_CACHE[ifc_path] = out
        return out

    while True:
        try:
            shape = it.get()
            geo   = shape.geometry

            v  = geo.verts   # flat [x0,y0,z0, x1,y1,z1, ...]
            f  = geo.faces   # flat [i0,j0,k0, ...]
            n  = getattr(geo, "normals", [])

            nv = len(v) // 3
            if nv == 0 or not f:
                if not it.next():
                    break
                continue

            # ── Color ────────────────────────────────────────────────────────
            r, g, b = _DEFAULT_COLOR
            try:
                entity = model.by_guid(shape.guid)
                etype  = entity.is_a()  if entity else ""
                ename  = getattr(entity, "Name",     "") or ""
                step_id = entity.id() if entity else 0
                r, g, b = _TYPE_COLOR.get(etype, _DEFAULT_COLOR)
            except Exception:
                etype, ename, step_id = "", "", 0

            # Intentar extraer color del material IFC (más preciso que tipo)
            try:
                if geo.materials and len(geo.materials) > 0:
                    m = geo.materials[0]
                    d = getattr(m, "diffuse", None)
                    if d is not None:
                        mr, mg, mb = float(d.r), float(d.g), float(d.b)
                        # Solo usar si es un color no-gris puro
                        if not (0.45 < mr < 0.55 and 0.45 < mg < 0.55 and 0.45 < mb < 0.55):
                            r, g, b = mr, mg, mb
            except Exception:
                pass

            # ── Buffers ──────────────────────────────────────────────────────
            pos_buf.extend(v)

            if n and len(n) == len(v):
                nor_buf.extend(n)
            else:
                # Normal nula → Three.js la calcula automáticamente
                nor_buf.extend([0.0, 0.0, 0.0] * nv)

            col_buf.extend([r, g, b] * nv)
            id_buf.extend([step_id] * nv)

            # Índices con offset acumulado
            idx_buf.extend(fi + vert_offset for fi in f)
            vert_offset += nv

            elements.append({
                "step_id": step_id,
                "type":    etype,
                "name":    ename,
                "guid":    shape.guid,
            })

        except Exception:
            pass  # Saltar elementos con errores de geometría

        if not it.next():
            break

    data: dict[str, Any] = {
        "positions": _b64_f32(pos_buf),
        "normals":   _b64_f32(nor_buf),
        "indices":   _b64_u32(idx_buf),
        "colors":    _b64_f32(col_buf),
        "ids":       _b64_i32(id_buf),
        "elements":  elements,
        "vertex_count":  len(pos_buf) // 3,
        "triangle_count": len(idx_buf) // 3,
    }
    out = json.dumps(data, separators=(",", ":")).encode()
    _GEOM_CACHE[ifc_path] = out
    return out


def invalidate_cache(ifc_path: str) -> None:
    """Elimina la caché de geometría de un archivo (p.ej. tras edición)."""
    _GEOM_CACHE.pop(ifc_path, None)
    _BIN_CACHE.pop(ifc_path, None)
    try:
        key = _disk_cache_key(ifc_path)
        if key:
            _os.remove(_disk_cache_path(key))
    except OSError:
        pass


def stats() -> dict:
    """Tamaño (nº de archivos) de las cachés de geometría en memoria."""
    return {
        "geom_json_cache": len(_GEOM_CACHE),
        "geom_bin_cache": len(_BIN_CACHE),
    }


def clear_all() -> None:
    """Vacía las cachés de geometría EN MEMORIA (no la caché en disco —
    esa es intencionalmente persistente entre reinicios del backend)."""
    _GEOM_CACHE.clear()
    _BIN_CACHE.clear()


# ── Cache binario ─────────────────────────────────────────────────────────────
_BIN_CACHE: dict[str, bytes] = {}   # ifc_path → bytes binario IFCB

# ── Cache binario EN DISCO ────────────────────────────────────────────────────
# Sobrevive a reinicios del servidor → re-abrir un IFC ya procesado es instantáneo
# (como BIM Vision). Clave = hash(ruta + mtime + size); fichero <hash>.ifcb.
import os as _os
import hashlib as _hashlib

# IMPORTANTE: la caché NO debe estar dentro de backend/ porque uvicorn --reload
# vigila ese árbol y cada .ifcb escrito dispararía un reinicio del servidor
# (tormenta de reinicios → API offline). La ubicamos en el home del usuario.
_GEOM_CACHE_DIR = _os.environ.get(
    "IFC_HUB_GEOM_CACHE",
    _os.path.join(_os.path.expanduser("~"), ".ifc-hub-v2", "geom_cache"),
)


def _disk_cache_key(ifc_path: str) -> str | None:
    """Devuelve una clave estable basada en ruta+mtime+size, o None si no existe."""
    try:
        st = _os.stat(ifc_path)
    except OSError:
        return None
    raw = f"{_os.path.abspath(ifc_path)}|{int(st.st_mtime)}|{st.st_size}"
    return _hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _disk_cache_path(key: str) -> str:
    return _os.path.join(_GEOM_CACHE_DIR, f"{key}.ifcb")


# Teselación de curvas (solo afecta a IFC con BREP real — extrusiones/barridos
# de Revit. Los IFC de Civil3D exportan IfcTriangulatedFaceSet ya pre-mallado,
# así que estos valores no tienen ningún efecto sobre ellos).
#
# Medido sobre 442_MAM_ESTRUCTURA_RVT (81.200 tris con el valor viejo 0.01):
#   linear=0.003 angular=0.3 circle_segments=24 -> 113.960 tris, mismo tiempo
#   de extracción (~9s, el cuello de botella es el recorte booleano, no la
#   teselación) → sin coste de rendimiento real, curvas notablemente más lisas.
_FAST_DEFLECTION      = 0.003   # antes 0.01 (1cm) — demasiado grueso, ver arriba
_ANGULAR_DEFLECTION   = 0.3     # rad; antes 0.5 (default ifcopenshell)
_CIRCLE_SEGMENTS      = 24      # antes 16 (default) — perfiles circulares/tubos


def _apply_fast_tessellation(settings) -> None:
    """Aplica una teselación más fina que el default 'rápido' anterior, sin
    coste medible en tiempo de extracción (ver comentario arriba)."""
    for _name, _value in (
        ("mesher_linear_deflection",  _FAST_DEFLECTION),
        ("mesher_angular_deflection", _ANGULAR_DEFLECTION),
        ("circle_segments",           _CIRCLE_SEGMENTS),
    ):
        try:
            settings.set(_name, _value)
        except Exception:
            pass


def _disk_cache_read(ifc_path: str) -> bytes | None:
    key = _disk_cache_key(ifc_path)
    if not key:
        return None
    fp = _disk_cache_path(key)
    try:
        with open(fp, "rb") as fh:
            return fh.read()
    except OSError:
        return None


def _disk_cache_write(ifc_path: str, data: bytes) -> None:
    key = _disk_cache_key(ifc_path)
    if not key:
        return
    try:
        _os.makedirs(_GEOM_CACHE_DIR, exist_ok=True)
        fp = _disk_cache_path(key)
        tmp = fp + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(data)
        _os.replace(tmp, fp)   # escritura atómica
    except OSError:
        pass


def extract_geometry_binary(ifc_path: str, force: bool = False) -> bytes:
    """Extrae geometría y devuelve un buffer binario compacto (formato IFCB v1).

    Formato:
      [4B]  magic  = b"IFCB"
      [4B]  n_verts  (uint32 LE)
      [4B]  n_tris   (uint32 LE)
      [4B]  json_len (uint32 LE)  ← longitud del bloque JSON final
      [n_verts*12B]  positions Float32 [x,y,z, …]
      [n_verts*12B]  normals   Float32 [nx,ny,nz, …]
      [n_verts*12B]  colors    Float32 [r,g,b, …]
      [n_verts*4B]   ids       Int32   [step_id, …]
      [n_tris*12B]   indices   Uint32  [i,j,k, …]
      [json_len B]   elements  UTF-8 JSON

    Todos los offsets están alineados a 4 bytes → zero-copy en browser con
    new Float32Array(buf, offset, length) sin necesidad de copiar.

    Ventajas vs JSON+base64:
    - numpy.tobytes() en lugar de struct.pack(N floats) → 5-10x más rápido
    - sin overhead base64 → -33% tamaño de payload
    - browser usa arrayBuffer() → TypedArray zero-copy, sin atob()
    """
    if not force and ifc_path in _BIN_CACHE:
        return _BIN_CACHE[ifc_path]

    # ── Caché en disco (sobrevive a reinicios) ────────────────────────────────
    if not force:
        disk = _disk_cache_read(ifc_path)
        if disk is not None:
            _BIN_CACHE[ifc_path] = disk   # promover a memoria
            return disk

    try:
        import ifcopenshell
        import ifcopenshell.geom
        import numpy as np
    except ImportError as exc:
        # Devolver buffer vacío con error codificado en el json trailing
        err_json = json.dumps({"error": str(exc), "elements": []}).encode()
        header = struct.pack("<4sIII", b"IFCB", 0, 0, len(err_json))
        return header + err_json

    try:
        model = _open_cached(ifc_path)
    except Exception as exc:
        err_json = json.dumps({"error": str(exc), "elements": []}).encode()
        header = struct.pack("<4sIII", b"IFCB", 0, 0, len(err_json))
        return header + err_json

    import multiprocessing
    # Usar todos los núcleos (hasta 8) — la extracción ifcopenshell es CPU-bound
    num_threads = max(1, min(multiprocessing.cpu_count(), 8))

    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)
    settings.set(settings.WELD_VERTICES,    True)
    _apply_fast_tessellation(settings)

    # Listas de arrays numpy por shape (concatenamos al final → O(n) total)
    all_pos:  list = []
    all_nor:  list = []
    all_col:  list = []
    all_ids:  list = []
    all_idx:  list = []
    elements: list = []
    vert_offset: int = 0

    try:
        it = ifcopenshell.geom.iterator(settings, model, num_threads)
    except Exception as exc:
        err_json = json.dumps({"error": f"iterator failed: {exc}", "elements": []}).encode()
        header = struct.pack("<4sIII", b"IFCB", 0, 0, len(err_json))
        return header + err_json

    if not it.initialize():
        out = _empty_bin()
        _BIN_CACHE[ifc_path] = out
        return out

    while True:
        try:
            shape = it.get()
            geo   = shape.geometry

            raw_verts = geo.verts   # tuple/list flat [x0,y0,z0, …]
            raw_faces = geo.faces   # tuple/list flat [i0,j0,k0, …]
            nv = len(raw_verts) // 3

            if nv == 0 or not raw_faces:
                if not it.next():
                    break
                continue

            # ── Posiciones ────────────────────────────────────────────────────
            pos_arr = np.array(raw_verts, dtype=np.float32)
            all_pos.append(pos_arr)

            # ── Normales ──────────────────────────────────────────────────────
            raw_nor = getattr(geo, "normals", None)
            if raw_nor and len(raw_nor) == len(raw_verts):
                all_nor.append(np.array(raw_nor, dtype=np.float32))
            else:
                all_nor.append(np.zeros(nv * 3, dtype=np.float32))

            # ── Color (tipo + material) ───────────────────────────────────────
            r, g, b = _DEFAULT_COLOR
            etype = ename = ""
            step_id = 0
            try:
                entity  = model.by_guid(shape.guid)
                etype   = entity.is_a()      if entity else ""
                ename   = getattr(entity, "Name", "") or ""
                step_id = entity.id()        if entity else 0
                r, g, b = _TYPE_COLOR.get(etype, _DEFAULT_COLOR)
            except Exception:
                pass

            # Jerarquía de color: 1) material IFC  2) nombre  3) tipo  4) default
            # Prioridad 1: material diffuse del IFC (respetamos el diseño original)
            mat_color_used = False
            try:
                if geo.materials and len(geo.materials) > 0:
                    d = getattr(geo.materials[0], "diffuse", None)
                    if d is not None:
                        mr, mg, mb = float(d.r), float(d.g), float(d.b)
                        # Rechazar solo negro puro (0,0,0) que indica "sin asignar"
                        if mr > 0.01 or mg > 0.01 or mb > 0.01:
                            r, g, b = mr, mg, mb
                            mat_color_used = True
            except Exception:
                pass

            # Prioridad 2: heurística por nombre (Civil 3D no siempre exporta estilos)
            if not mat_color_used:
                nc = _color_from_name(ename)
                if nc:
                    r, g, b = nc

            # tile [r,g,b] nv veces → Float32 de longitud nv*3
            all_col.append(np.tile(np.array([r, g, b], dtype=np.float32), nv))

            # ── IDs ───────────────────────────────────────────────────────────
            all_ids.append(np.full(nv, fill_value=step_id, dtype=np.int32))

            # ── Índices (con offset acumulado) ────────────────────────────────
            face_arr = np.array(raw_faces, dtype=np.uint32)
            face_arr += vert_offset
            all_idx.append(face_arr)
            vert_offset += nv

            elements.append({
                "step_id": step_id,
                "type":    etype,
                "name":    ename,
                "guid":    shape.guid,
            })

        except Exception:
            pass

        if not it.next():
            break

    # ── Concatenar ────────────────────────────────────────────────────────────
    if not all_pos:
        out = _empty_bin()
        _BIN_CACHE[ifc_path] = out
        return out

    positions_b = np.concatenate(all_pos).astype(np.float32).tobytes()
    normals_b   = np.concatenate(all_nor).astype(np.float32).tobytes()
    colors_b    = np.concatenate(all_col).astype(np.float32).tobytes()
    ids_b       = np.concatenate(all_ids).astype(np.int32).tobytes()
    indices_b   = np.concatenate(all_idx).astype(np.uint32).tobytes()

    n_verts = vert_offset
    n_tris  = sum(len(a) for a in all_idx) // 3

    elems_json = json.dumps(elements, separators=(",", ":")).encode("utf-8")
    header = struct.pack("<4sIII", b"IFCB", n_verts, n_tris, len(elems_json))

    out = header + positions_b + normals_b + colors_b + ids_b + indices_b + elems_json
    _BIN_CACHE[ifc_path] = out
    _disk_cache_write(ifc_path, out)   # persistir → instantáneo tras reinicio
    return out


def _empty_bin() -> bytes:
    """Devuelve un buffer IFCB vacío (0 vértices, 0 triángulos)."""
    elems_json = b"[]"
    return struct.pack("<4sIII", b"IFCB", 0, 0, len(elems_json)) + elems_json
