"""Detección rápida de elementos geométricamente duplicados en IFC.

Estrategia SIN tessellation (no usa ifcopenshell.geom):
  1. Lee la matriz de placement mundial 4×4 de cada elemento.
     - Columna 3 → traslación (x,y,z).
     - Columnas 0-2 → ejes locales (orientación).  ← NUEVO
  2. Genera una firma de representación DETALLADA con dimensiones reales
     (profundidad de extrusión, dimensiones de perfil, nº de facetas).  ← NUEVO
  3. Hash = tipo_IFC | bx | by | bz | ax,ay,az | rep_sig
     Los ejes se redondean a 2 decimales (insensible a errores de float).

Ventaja: miles de elementos por segundo vs tessellation.
Los GlobalIds obtenidos sirven directamente en BIM Vision / Navisworks.
"""
import hashlib
from collections import defaultdict
from pathlib import Path

try:
    import ifcopenshell
    from ifcopenshell.util.placement import get_local_placement
    _IOS_OK = True
except ImportError:
    _IOS_OK = False

# Tipos IFC con ObjectPlacement relevante
_ELEMENT_TYPES = [
    "IfcWall", "IfcWallStandardCase",
    "IfcSlab", "IfcSlabStandardCase",
    "IfcBeam", "IfcBeamStandardCase",
    "IfcColumn", "IfcColumnStandardCase",
    "IfcDoor", "IfcWindow",
    "IfcStair", "IfcStairFlight",
    "IfcRamp", "IfcRampFlight",
    "IfcRoof", "IfcCovering",
    "IfcFooting", "IfcPile",
    "IfcMember", "IfcPlate",
    "IfcFurnishingElement",
    "IfcFlowSegment", "IfcFlowFitting", "IfcFlowTerminal",
    "IfcFlowStorageDevice",
    "IfcPipeSegment", "IfcPipeFitting",
    "IfcDuctSegment", "IfcDuctFitting",
    "IfcCableSegment", "IfcCableFitting",
    "IfcBuildingElementProxy", "IfcProxy",
    "IfcDistributionElement",
]


# ── Firma de perfil transversal ──────────────────────────────────────────────

def _profile_sig(profile) -> str:
    """Firma del perfil 2D sin tessellation."""
    try:
        ptype = profile.is_a()
        if ptype in ("IfcRectangleProfileDef", "IfcRectangleHollowProfileDef"):
            x = round(float(getattr(profile, "XDim", 0) or 0), 4)
            y = round(float(getattr(profile, "YDim", 0) or 0), 4)
            wt = round(float(getattr(profile, "WallThickness", 0) or 0), 4)
            return f"Rect({x}x{y}t{wt})" if wt else f"Rect({x}x{y})"
        if ptype in ("IfcCircleProfileDef", "IfcCircleHollowProfileDef"):
            r = round(float(getattr(profile, "Radius", 0) or 0), 4)
            wt = round(float(getattr(profile, "WallThickness", 0) or 0), 4)
            return f"Circ({r}t{wt})" if wt else f"Circ({r})"
        if ptype == "IfcIShapeProfileDef":
            w = round(float(getattr(profile, "OverallWidth", 0) or 0), 4)
            h = round(float(getattr(profile, "OverallDepth", 0) or 0), 4)
            return f"I({w}x{h})"
        if ptype == "IfcLShapeProfileDef":
            w = round(float(getattr(profile, "Width", 0) or 0), 4)
            h = round(float(getattr(profile, "Depth", 0) or 0), 4)
            return f"L({w}x{h})"
        if ptype == "IfcTShapeProfileDef":
            w = round(float(getattr(profile, "FlangeWidth", 0) or 0), 4)
            h = round(float(getattr(profile, "Depth", 0) or 0), 4)
            return f"T({w}x{h})"
        if ptype == "IfcUShapeProfileDef":
            w = round(float(getattr(profile, "FlangeWidth", 0) or 0), 4)
            h = round(float(getattr(profile, "Depth", 0) or 0), 4)
            return f"U({w}x{h})"
        if ptype == "IfcArbitraryClosedProfileDef":
            curve = getattr(profile, "OuterCurve", None)
            if curve:
                pts = getattr(curve, "Points", None)
                if pts:
                    try:
                        # Incluir coordenadas reales (cm de precisión) para evitar
                        # que perfiles distintos con mismo nº de puntos se agrupen
                        coords = []
                        for pt in pts:
                            if hasattr(pt, "Coordinates"):
                                c = pt.Coordinates
                                coords.append(
                                    f"{round(float(c[0]),2)},{round(float(c[1]),2)}"
                                )
                        return f"Arb[{';'.join(coords)}]"
                    except Exception:
                        return f"ArbN{len(pts)}"
                return "Arb0"
            return "Arb"
        if ptype == "IfcCompositeProfileDef":
            n = len(getattr(profile, "Profiles", []) or [])
            return f"Comp{n}"
        return ptype
    except Exception:
        return "?"


# ── Firma de un item de representación ──────────────────────────────────────

def _item_sig(item, depth: int = 0) -> str:
    """Firma recursiva de un item de representación con parámetros geométricos."""
    if depth > 3:
        return item.is_a() if hasattr(item, "is_a") else "?"
    try:
        itype = item.is_a()

        # ExtrudedAreaSolid → Depth + perfil
        if itype in ("IfcExtrudedAreaSolid", "IfcExtrudedAreaSolidTapered"):
            d = getattr(item, "Depth", None)
            d_str = f"d{round(float(d), 4)}" if d is not None else ""
            swept = getattr(item, "SweptArea", None)
            prof = _profile_sig(swept) if swept else ""
            return f"Ext({prof},{d_str})"

        # RevolvedAreaSolid → perfil
        if itype == "IfcRevolvedAreaSolid":
            swept = getattr(item, "SweptArea", None)
            prof = _profile_sig(swept) if swept else ""
            return f"Rev({prof})"

        # SweptDiskSolid (tuberías) → radius + length
        if itype == "IfcSweptDiskSolid":
            r = round(float(getattr(item, "Radius", 0) or 0), 4)
            ri = round(float(getattr(item, "InnerRadius", 0) or 0), 4)
            return f"Disk(r{r}ri{ri})"

        # FacetedBrep → contar facetas
        if itype == "IfcFacetedBrep":
            outer = getattr(item, "Outer", None)
            n = len(getattr(outer, "CfsFaces", []) or []) if outer else 0
            return f"Brep(f{n})"

        # BooleanResult / BooleanClippingResult → firma del primer operando
        if itype in ("IfcBooleanClippingResult", "IfcBooleanResult"):
            first = getattr(item, "FirstOperand", None)
            sig = _item_sig(first, depth + 1) if first else "?"
            return f"Bool({sig})"

        # MappedItem → firma de la geometría del tipo
        if itype == "IfcMappedItem":
            src = getattr(item, "MappingSource", None)
            if src:
                mapped = getattr(src, "MappedRepresentation", None)
                if mapped:
                    sub = getattr(mapped, "Items", []) or []
                    sigs = sorted(_item_sig(s, depth + 1) for s in sub)
                    return f"Map[{','.join(sigs)}]"
            return "Map"

        # Polyline / Polygon / PolyLoop → nº de puntos
        if itype in ("IfcPolyline", "IfcIndexedPolyCurve"):
            pts = getattr(item, "Points", None)
            n = len(pts) if pts else 0
            return f"Poly({n})"

        # Fallback: solo el tipo
        return itype

    except Exception:
        return item.is_a() if hasattr(item, "is_a") else "?"


# ── Firma de representación completa ────────────────────────────────────────

def _rep_signature(element) -> str:
    """Firma detallada de la representación: tipos + dimensiones reales."""
    try:
        rep = getattr(element, "Representation", None)
        if not rep:
            return "none"
        parts = []
        for r in rep.Representations:
            ident = getattr(r, "RepresentationIdentifier", None) or "?"
            items = getattr(r, "Items", []) or []
            item_sigs = sorted(_item_sig(it) for it in items)
            parts.append(f"{ident}:[{','.join(item_sigs)}]")
        return "|".join(sorted(parts))
    except Exception:
        return "none"


# ── Detección de elemento en origen local ────────────────────────────────────

def _local_origin_warning(op) -> str:
    """
    Detecta si el elemento está en el origen local de su contenedor (X~0, Y~0).
    Esto suele indicar un error de modelado Revit: el elemento 'cayó' al
    punto base del proyecto sin coordenadas propias.

    Retorna "" (sin warning) o "ORIGIN" (está en (0,0,z) local).
    """
    try:
        if not op.is_a("IfcLocalPlacement"):
            return ""
        loc = getattr(op, "RelativePlacement", None)
        if not loc or not loc.is_a("IfcAxis2Placement3D"):
            return ""
        pt = getattr(loc, "Location", None)
        if not pt:
            return ""
        coords = pt.Coordinates
        lx = float(coords[0])
        ly = float(coords[1])
        # Considera "en origen" si X e Y locales son < 1mm
        if abs(lx) < 0.001 and abs(ly) < 0.001:
            return "ORIGIN"
        return ""
    except Exception:
        return ""


# ── Info completa de un elemento ────────────────────────────────────────────

def _fast_info(element, fname: str, tol: float) -> dict | None:
    """
    Extrae info y fingerprint de un elemento SIN tessellation.

    El hash incluye:
      - Tipo IFC
      - Posición mundial en buckets (x, y, z)
      - Eje X local redondeado a 2 dec (distingue orientación)
      - Firma de representación con dimensiones reales

    Añade campo 'warning' = "ORIGIN" si el elemento está en el
    origen local del proyecto (posible error de modelado Revit).
    """
    try:
        op = getattr(element, "ObjectPlacement", None)
        if op is None:
            return None

        m = get_local_placement(op)   # 4×4 array, columna 3 = traslación

        # Traslación mundial
        x = float(m[0][3])
        y = float(m[1][3])
        z = float(m[2][3])

        # Eje X local (columna 0 de la matriz de rotación)
        # Redondeo a 2 dec → insensible a errores de float, sensible a dirección
        ax = round(float(m[0][0]), 2)
        ay = round(float(m[1][0]), 2)
        az = round(float(m[2][0]), 2)

        el_type  = element.is_a()
        # ObjectType = tipo Revit (familia). Dos elementos del mismo tipo IFC
        # pero distinto tipo Revit (ej. "Armado" vs "MuroHA") NO son duplicados.
        obj_type = getattr(element, "ObjectType", "") or ""
        rep_sig  = _rep_signature(element)
        warning  = _local_origin_warning(op)

        bx = round(x / tol)
        by = round(y / tol)
        bz = round(z / tol)

        geo_hash = hashlib.md5(
            f"{el_type}|{obj_type}|{bx}|{by}|{bz}|{ax},{ay},{az}|{rep_sig}".encode()
        ).hexdigest()[:16]

        return {
            "global_id":    element.GlobalId,
            "name":         getattr(element, "Name", "") or "",
            "description":  getattr(element, "Description", "") or "",
            "type":         el_type,
            "obj_type":     obj_type,   # tipo Revit (familia)
            "ifc_file":     fname,
            "geo_hash":     geo_hash,
            "x":            round(x, 3),
            "y":            round(y, 3),
            "z":            round(z, 3),
            "rep_sig":      rep_sig,
            "dim_str":      f"X:{round(x,2)} Y:{round(y,2)} Z:{round(z,2)} m",
            "vol_str":      rep_sig,
            "centroid_str": f"({round(x,2)}, {round(y,2)}, {round(z,2)})",
            "warning":      warning,   # "ORIGIN" → elemento en punto base del proyecto
        }
    except Exception:
        return None


# ── Escaneo por archivo ──────────────────────────────────────────────────────

def scan_single_file(ifc_path: str, tol: float) -> dict:
    """
    Escanea UN archivo IFC. Retorna {elements, errors, count}.
    Llamar por archivo para poder actualizar progreso entre archivos.
    """
    fname = Path(ifc_path).name
    elements: list[dict] = []
    errors: list[str] = []
    count = 0

    try:
        ifc = ifcopenshell.open(ifc_path)
        for etype in _ELEMENT_TYPES:
            try:
                for el in ifc.by_type(etype):
                    count += 1
                    info = _fast_info(el, fname, tol)
                    if info:
                        elements.append(info)
            except Exception:
                pass
    except Exception as e:
        errors.append(f"{fname}: {str(e)[:120]}")

    return {"elements": elements, "errors": errors, "count": count}


# ── Agrupación de duplicados ─────────────────────────────────────────────────

def group_duplicates(all_elements: list[dict]) -> list[dict]:
    """Agrupa elementos por geo_hash. Retorna sólo grupos con 2+ elementos."""
    buckets: dict[str, list[dict]] = defaultdict(list)
    for el in all_elements:
        buckets[el["geo_hash"]].append(el)

    groups = []
    for idx, (geo_hash, elems) in enumerate(buckets.items()):
        if len(elems) < 2:
            continue
        groups.append({
            "group_id":     f"G{idx + 1:04d}",
            "geo_hash":     geo_hash,
            "element_type": elems[0]["type"],
            "count":        len(elems),
            "elements":     elems,
        })
    groups.sort(key=lambda g: g["count"], reverse=True)
    return groups


# ── Eliminación de elementos ─────────────────────────────────────────────────

def remove_elements_from_ifc(
    ifc_path: str,
    global_ids_to_remove: list[str],
    backup: bool = True,
) -> dict:
    """Elimina elementos del IFC por GlobalId con backup automático."""
    if not _IOS_OK:
        return {"ok": False, "removed": 0, "backup_path": "",
                "error": "ifcopenshell no disponible"}
    try:
        p = Path(ifc_path)
        ifc = ifcopenshell.open(ifc_path)

        backup_path = ""
        if backup:
            backup_path = str(p.with_stem(p.stem + "_backup"))
            ifc.write(backup_path)

        removed = 0
        for gid in set(global_ids_to_remove):
            try:
                el = ifc.by_guid(gid)
                if el:
                    ifc.remove(el)
                    removed += 1
            except Exception:
                pass

        # Escritura atómica: nunca dejar el IFC original corrupto a medias
        from core.resilience import atomic_write_model
        atomic_write_model(ifc, ifc_path)
        return {"ok": True, "removed": removed,
                "backup_path": backup_path, "error": ""}
    except Exception as e:
        return {"ok": False, "removed": 0, "backup_path": "",
                "error": str(e)[:200]}
