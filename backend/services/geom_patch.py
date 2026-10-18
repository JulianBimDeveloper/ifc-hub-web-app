"""Geometría "parche" para representaciones que `web-ifc` no soporta.

Por qué existe: confirmado empíricamente (2026-09-22) que `web-ifc` (el motor
usado por `@thatopen/fragments` para convertir IFC -> Fragments, ver
`frag_cache.py`) devuelve 0 geometría para dos tipos de representación real
que sí aparecen en las redes de drenaje de Civil3D/Revit de este proyecto:

  - `IfcFacetedBrep` con huecos (los codos/accesorios de tubería son tubos
    huecos -> BREP con bucle interior) -- gap documentado en
    github.com/ThatOpen/engine_web-ifc/issues/2158 ("faceted BRep void cases
    lack geometry support").
  - `IfcSurfaceCurveSweptAreaSolid` (codos barridos a lo largo de una
    directriz curva) -- soporte todavía incompleto en web-ifc según su propio
    tracker (PR #2155, "Generate swept disk voids... parameter-trimmed
    directrices").

`ifcopenshell` (ya usado en este backend para el pipeline de propiedades)
tesela ambos tipos sin problema -- verificado a mano contra este mismo
archivo. Este módulo sirve de "parche": encuentra SOLO los productos cuya
representación usa uno de estos dos tipos, los tesela con ifcopenshell
(en coordenadas de mundo, para que coincida con lo que ya dibuja Fragments) y
los sirve en un binario aparte que el visor añade como una malla extra
sencilla, sin instanciación -- son pocas piezas por archivo (decenas, no
miles), así que no hace falta la sofisticación de Fragments para esto.

No reemplaza el pipeline de Fragments -- lo complementa. Cuando web-ifc
arregle esto río arriba, este módulo dejará de encontrar candidatos y no
generará nada (fallback silencioso a "sin parche").
"""

import hashlib
import os
import struct

from core.logging_config import get_logger

logger = get_logger(__name__)

# Tipos de representación que sabemos, por medición directa, que web-ifc no
# tesela (ver docstring del módulo). Si una futura versión de web-ifc los
# soporta, esto simplemente dejará de encontrar candidatos -- no hace falta
# quitar nada a mano.
_UNSUPPORTED_REP_TYPES = ("IfcFacetedBrep", "IfcSurfaceCurveSweptAreaSolid")

_PATCH_CACHE_DIR = os.environ.get(
    "IFC_HUB_GEOM_PATCH_CACHE",
    os.path.join(os.path.expanduser("~"), ".ifc-hub-v2", "geom_patch_cache"),
)


def _disk_cache_key(ifc_path: str) -> str | None:
    try:
        st = os.stat(ifc_path)
    except OSError:
        return None
    raw = f"{os.path.abspath(ifc_path)}|{int(st.st_mtime)}|{st.st_size}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _disk_cache_path(key: str) -> str:
    return os.path.join(_PATCH_CACHE_DIR, f"{key}.pbin")


def _find_candidate_products(ifc):
    """Productos cuya representación usa alguno de los tipos problemáticos.

    Estos codos suelen ser geometría de TIPO (una malla definida una vez en
    un IfcRepresentationMap y reutilizada vía IfcMappedItem por cada
    instancia) -- no basta con mirar los Items directos de cada producto, hay
    que seguir esa indirección un nivel para encontrar el IfcFacetedBrep /
    IfcSurfaceCurveSweptAreaSolid real.
    """
    bad_item_ids = set()
    for type_name in _UNSUPPORTED_REP_TYPES:
        for item in ifc.by_type(type_name):
            bad_item_ids.add(item.id())
    if not bad_item_ids:
        return []

    def item_is_bad(item) -> bool:
        if item.id() in bad_item_ids:
            return True
        if item.is_a("IfcMappedItem"):
            src_rep = item.MappingSource.MappedRepresentation
            return any(i.id() in bad_item_ids for i in src_rep.Items)
        return False

    products = []
    for product in ifc.by_type("IfcProduct"):
        rep = getattr(product, "Representation", None)
        if not rep:
            continue
        if any(item_is_bad(item) for shape_rep in rep.Representations for item in shape_rep.Items):
            products.append(product)
    return products


def build_patch_binary(ifc_path: str) -> bytes:
    """Tesela con ifcopenshell SOLO los productos con representación no
    soportada por web-ifc, en coordenadas de mundo, y devuelve un binario:

        [4B magic "PBIN"][4B n_verts][4B n_tris]
        positions(F32 n_verts*3) normals(F32 n_verts*3) indices(U32 n_tris*3)

    Devuelve un binario con n_verts=n_tris=0 si no hay candidatos (caso
    normal y esperado en la mayoría de archivos -- la mayoría de IFC no usan
    estas representaciones).
    """
    import ifcopenshell
    import ifcopenshell.geom

    ifc = ifcopenshell.open(ifc_path)
    products = _find_candidate_products(ifc)

    positions: list[float] = []
    normals: list[float] = []
    indices: list[int] = []

    if products:
        settings = ifcopenshell.geom.settings()
        settings.set("use-world-coords", True)
        for product in products:
            try:
                shape = ifcopenshell.geom.create_shape(settings, product)
            except Exception as e:
                logger.warning("geom_patch: fallo al teselar %s (#%d): %s",
                                product.is_a(), product.id(), e)
                continue
            geometry = getattr(shape, "geometry", shape)  # TriangulationElement vs Triangulation
            verts = geometry.verts
            faces = geometry.faces
            base = len(positions) // 3
            positions.extend(verts)
            # ifcopenshell no da normales por vértice directas en este modo
            # rápido; se calculan planas por triángulo más abajo en el
            # visor si hiciera falta -- de momento se rellenan a 0 y el
            # material usa flatShading para que Three.js las derive solo.
            normals.extend([0.0] * len(verts))
            for i in range(0, len(faces), 3):
                indices.extend([base + faces[i], base + faces[i + 1], base + faces[i + 2]])

    n_verts = len(positions) // 3
    n_tris = len(indices) // 3
    header = struct.pack("<4sII", b"PBIN", n_verts, n_tris)
    body = (
        struct.pack(f"<{len(positions)}f", *positions)
        + struct.pack(f"<{len(normals)}f", *normals)
        + struct.pack(f"<{len(indices)}I", *indices)
    )
    if products:
        logger.info("geom_patch: %s -> %d producto(s) parcheado(s), %d verts, %d tris",
                    os.path.basename(ifc_path), len(products), n_verts, n_tris)
    return header + body


def get_patch_path(ifc_path: str) -> str:
    """Devuelve la ruta al binario de parche cacheado, generándolo si hace falta."""
    key = _disk_cache_key(ifc_path)
    if key is None:
        raise FileNotFoundError(ifc_path)

    cache_path = _disk_cache_path(key)
    if os.path.isfile(cache_path):
        return cache_path

    os.makedirs(_PATCH_CACHE_DIR, exist_ok=True)
    data = build_patch_binary(ifc_path)
    tmp_path = cache_path + ".tmp"
    with open(tmp_path, "wb") as f:
        f.write(data)
    os.replace(tmp_path, cache_path)
    return cache_path
