"""Auditoría IFC 4x3 / ISO 16739-1.

Checks de base del schema y de la información mínima exigida por buildingSMART:
  SCH   — versión de schema
  HIER  — jerarquía IfcProject → IfcSite → IfcFacility/IfcBuilding
  OWN   — IfcOwnerHistory completo
  UNIT  — IfcUnitAssignment con LENGTH/PLANEANGLE
  GEO   — IfcMapConversion / georreferenciación
  GID   — GlobalIds válidos (22 chars) y únicos
  PSET  — Pset_*Common presente por tipo de elemento (warn si falta)
  CLASS — IfcClassificationReference asignada al menos al proyecto
  MAT   — elementos constructivos con material asignado
"""
from __future__ import annotations

import re
from collections import defaultdict
from typing import Iterable

from .common import (
    CheckResult, collect_samples,
    STD_IFC4X3, SEV_INFO, SEV_WARN, SEV_ERROR,
)


_GUID_RE = re.compile(r"^[A-Za-z0-9_$]{22}$")

# Pset *Common esperado por tipo IFC (subconjunto razonable)
_REQUIRED_PSET = {
    "IfcWall":           "Pset_WallCommon",
    "IfcWallStandardCase":"Pset_WallCommon",
    "IfcSlab":           "Pset_SlabCommon",
    "IfcColumn":         "Pset_ColumnCommon",
    "IfcBeam":           "Pset_BeamCommon",
    "IfcDoor":           "Pset_DoorCommon",
    "IfcWindow":         "Pset_WindowCommon",
    "IfcRoof":           "Pset_RoofCommon",
    "IfcStair":          "Pset_StairCommon",
    "IfcRailing":        "Pset_RailingCommon",
    "IfcCovering":       "Pset_CoveringCommon",
    "IfcFooting":        "Pset_FootingCommon",
}

# Elementos constructivos que deberían tener material
_NEEDS_MATERIAL = {
    "IfcWall", "IfcWallStandardCase", "IfcSlab", "IfcColumn", "IfcBeam",
    "IfcRoof", "IfcStair", "IfcFooting", "IfcPile", "IfcMember", "IfcPlate",
    "IfcCovering",
}


def _psets_of(element) -> set[str]:
    """Nombres de Psets directamente asociados a un elemento."""
    names = set()
    try:
        for rel in getattr(element, "IsDefinedBy", []) or []:
            if rel.is_a("IfcRelDefinesByProperties"):
                ps = getattr(rel, "RelatingPropertyDefinition", None)
                if ps and ps.is_a("IfcPropertySet"):
                    n = getattr(ps, "Name", "") or ""
                    if n:
                        names.add(n)
    except Exception:
        pass
    return names


def _has_material(element) -> bool:
    try:
        for rel in getattr(element, "HasAssociations", []) or []:
            if rel.is_a("IfcRelAssociatesMaterial"):
                if getattr(rel, "RelatingMaterial", None):
                    return True
    except Exception:
        pass
    return False


def _check_schema(ifc) -> CheckResult:
    schema = getattr(ifc, "schema", "") or ""
    ok = schema.upper().startswith("IFC4X3")
    return CheckResult(
        standard=STD_IFC4X3, category="Schema",
        rule_id="IFC4X3.SCH.001",
        title="Schema declarado debe ser IFC4X3",
        severity=SEV_ERROR if not ok else SEV_INFO,
        passed=ok,
        issue_count=0 if ok else 1,
        detail=f"Schema detectado: {schema or '(desconocido)'}",
    )


def _check_hierarchy(ifc) -> CheckResult:
    projects = ifc.by_type("IfcProject")
    sites    = ifc.by_type("IfcSite")
    # En 4x3 IfcFacility reemplaza a IfcBuilding en muchos casos
    facilities = []
    try:
        facilities = ifc.by_type("IfcFacility")
    except Exception:
        facilities = []
    buildings = ifc.by_type("IfcBuilding")

    missing = []
    if len(projects) != 1: missing.append(f"IfcProject ({len(projects)})")
    if not sites:          missing.append("IfcSite")
    if not facilities and not buildings: missing.append("IfcFacility/IfcBuilding")

    ok = not missing
    return CheckResult(
        standard=STD_IFC4X3, category="Hierarchy",
        rule_id="IFC4X3.HIER.001",
        title="Jerarquía espacial mínima IfcProject → IfcSite → IfcFacility/IfcBuilding",
        severity=SEV_ERROR if missing else SEV_INFO,
        passed=ok,
        issue_count=len(missing),
        detail="; ".join(missing) if missing else "Estructura espacial correcta",
    )


def _check_owner_history(ifc) -> CheckResult:
    histories = ifc.by_type("IfcOwnerHistory")
    missing_fields: list[str] = []
    if not histories:
        return CheckResult(
            standard=STD_IFC4X3, category="OwnerHistory",
            rule_id="IFC4X3.OWN.001",
            title="IfcOwnerHistory presente y completo",
            severity=SEV_ERROR, passed=False, issue_count=1,
            detail="No existe ningún IfcOwnerHistory en el archivo",
        )
    h = histories[0]
    if not getattr(h, "OwningUser", None):        missing_fields.append("OwningUser")
    if not getattr(h, "OwningApplication", None): missing_fields.append("OwningApplication")
    if not getattr(h, "CreationDate", None):      missing_fields.append("CreationDate")
    ok = not missing_fields
    return CheckResult(
        standard=STD_IFC4X3, category="OwnerHistory",
        rule_id="IFC4X3.OWN.001",
        title="IfcOwnerHistory presente y completo",
        severity=SEV_WARN if not ok else SEV_INFO,
        passed=ok, issue_count=len(missing_fields),
        detail=("Campos faltantes: " + ", ".join(missing_fields)) if missing_fields
               else "OwnerHistory completo",
    )


def _check_units(ifc) -> CheckResult:
    projects = ifc.by_type("IfcProject")
    if not projects:
        return CheckResult(
            standard=STD_IFC4X3, category="Units",
            rule_id="IFC4X3.UNIT.001",
            title="IfcUnitAssignment con LENGTHUNIT y PLANEANGLEUNIT",
            severity=SEV_ERROR, passed=False, issue_count=1,
            detail="No hay IfcProject",
        )
    ua = getattr(projects[0], "UnitsInContext", None)
    if not ua:
        return CheckResult(
            standard=STD_IFC4X3, category="Units",
            rule_id="IFC4X3.UNIT.001",
            title="IfcUnitAssignment con LENGTHUNIT y PLANEANGLEUNIT",
            severity=SEV_ERROR, passed=False, issue_count=1,
            detail="IfcProject sin UnitsInContext",
        )
    have = set()
    try:
        for u in (ua.Units or []):
            t = getattr(u, "UnitType", "") or ""
            if t:
                have.add(t)
    except Exception:
        pass
    missing = []
    if "LENGTHUNIT" not in have:     missing.append("LENGTHUNIT")
    if "PLANEANGLEUNIT" not in have: missing.append("PLANEANGLEUNIT")
    ok = not missing
    return CheckResult(
        standard=STD_IFC4X3, category="Units",
        rule_id="IFC4X3.UNIT.001",
        title="IfcUnitAssignment con LENGTHUNIT y PLANEANGLEUNIT",
        severity=SEV_WARN if not ok else SEV_INFO,
        passed=ok, issue_count=len(missing),
        detail=("Unidades faltantes: " + ", ".join(missing)) if missing
               else f"Unidades declaradas: {', '.join(sorted(have))}",
    )


def _check_georef(ifc) -> CheckResult:
    """IfcMapConversion + IfcProjectedCRS (georeferenciación 4x3)."""
    try:
        mc = ifc.by_type("IfcMapConversion")
        crs = ifc.by_type("IfcProjectedCRS")
    except Exception:
        mc, crs = [], []
    ok = bool(mc) and bool(crs)
    detail_parts = []
    if not mc:  detail_parts.append("Sin IfcMapConversion (mapeo coords. locales→mundo)")
    if not crs: detail_parts.append("Sin IfcProjectedCRS (EPSG/CRS declarado)")
    if crs:
        n = getattr(crs[0], "Name", "") or "(sin nombre)"
        detail_parts.append(f"CRS: {n}")
    return CheckResult(
        standard=STD_IFC4X3, category="Georeferencing",
        rule_id="IFC4X3.GEO.001",
        title="Georreferenciación: IfcMapConversion + IfcProjectedCRS",
        severity=SEV_WARN if not ok else SEV_INFO,
        passed=ok, issue_count=0 if ok else (2 - int(bool(mc)) - int(bool(crs))),
        detail="; ".join(detail_parts),
    )


def _check_globalids(ifc) -> CheckResult:
    """GlobalIds válidos (22 chars IFC) y únicos."""
    seen: dict[str, int] = defaultdict(int)
    invalid: list[str] = []
    invalid_entities = []
    duplicates_entities = []
    total = 0
    try:
        for root in ifc.by_type("IfcRoot"):
            gid = getattr(root, "GlobalId", "") or ""
            total += 1
            if not _GUID_RE.match(gid):
                invalid.append(gid)
                invalid_entities.append(root)
            else:
                seen[gid] += 1
    except Exception:
        pass
    dup_count = 0
    for gid, n in seen.items():
        if n > 1:
            dup_count += n - 1
    # Recolectar entidades duplicadas (sólo para muestrear)
    if dup_count:
        try:
            counts = defaultdict(list)
            for root in ifc.by_type("IfcRoot"):
                gid = getattr(root, "GlobalId", "") or ""
                if seen.get(gid, 0) > 1:
                    counts[gid].append(root)
            for lst in counts.values():
                duplicates_entities.extend(lst[1:])  # excepto el primero
        except Exception:
            pass

    issues = len(invalid) + dup_count
    ok = issues == 0
    return CheckResult(
        standard=STD_IFC4X3, category="GlobalId",
        rule_id="IFC4X3.GID.001",
        title="GlobalIds válidos (22 chars) y únicos",
        severity=SEV_ERROR if not ok else SEV_INFO,
        passed=ok, issue_count=issues,
        sample_ids=collect_samples(invalid_entities + duplicates_entities),
        detail=f"Total IfcRoot: {total} · inválidos: {len(invalid)} · duplicados: {dup_count}",
    )


def _check_psets(ifc) -> CheckResult:
    """Pset_*Common requerido por tipo (warn por elemento sin él)."""
    missing_entities = []
    total = 0
    for etype, pset_name in _REQUIRED_PSET.items():
        try:
            for el in ifc.by_type(etype):
                total += 1
                if pset_name not in _psets_of(el):
                    missing_entities.append(el)
        except Exception:
            continue
    ok = not missing_entities
    return CheckResult(
        standard=STD_IFC4X3, category="PropertySets",
        rule_id="IFC4X3.PSET.001",
        title="Pset_*Common asignado por tipo (Wall→Pset_WallCommon, etc.)",
        severity=SEV_WARN if not ok else SEV_INFO,
        passed=ok, issue_count=len(missing_entities),
        sample_ids=collect_samples(missing_entities),
        detail=f"{len(missing_entities)} de {total} elementos sin Pset_*Common esperado",
    )


def _check_classification(ifc) -> CheckResult:
    """Al menos una IfcClassification + IfcClassificationReference."""
    try:
        cls  = ifc.by_type("IfcClassification")
        refs = ifc.by_type("IfcClassificationReference")
    except Exception:
        cls, refs = [], []
    ok = bool(cls) and bool(refs)
    return CheckResult(
        standard=STD_IFC4X3, category="Classification",
        rule_id="IFC4X3.CLASS.001",
        title="Sistema de clasificación declarado (Uniclass/OmniClass/ADIF)",
        severity=SEV_WARN if not ok else SEV_INFO,
        passed=ok, issue_count=0 if ok else 1,
        detail=f"IfcClassification: {len(cls)} · References: {len(refs)}",
    )


def _check_materials(ifc) -> CheckResult:
    missing = []
    total = 0
    for etype in _NEEDS_MATERIAL:
        try:
            for el in ifc.by_type(etype):
                total += 1
                if not _has_material(el):
                    missing.append(el)
        except Exception:
            continue
    ok = not missing
    return CheckResult(
        standard=STD_IFC4X3, category="Material",
        rule_id="IFC4X3.MAT.001",
        title="Elementos constructivos con material asignado",
        severity=SEV_WARN if not ok else SEV_INFO,
        passed=ok, issue_count=len(missing),
        sample_ids=collect_samples(missing),
        detail=f"{len(missing)} de {total} elementos sin material",
    )


def _check_spatial_containment(ifc) -> CheckResult:
    """Todo IfcElement debe estar en la estructura espacial."""
    orphans = []
    try:
        contained = set()
        for rel in ifc.by_type("IfcRelContainedInSpatialStructure"):
            for e in getattr(rel, "RelatedElements", []) or []:
                contained.add(e.id())
        # Agregaciones (composiciones) también cuentan
        for rel in ifc.by_type("IfcRelAggregates"):
            for e in getattr(rel, "RelatedObjects", []) or []:
                contained.add(e.id())
        for el in ifc.by_type("IfcElement"):
            if el.id() not in contained:
                orphans.append(el)
    except Exception:
        pass
    ok = not orphans
    return CheckResult(
        standard=STD_IFC4X3, category="Hierarchy",
        rule_id="IFC4X3.HIER.002",
        title="Sin elementos huérfanos (todos contenidos en estructura espacial)",
        severity=SEV_WARN if orphans else SEV_INFO,
        passed=ok, issue_count=len(orphans),
        sample_ids=collect_samples(orphans),
        detail=f"{len(orphans)} elementos sin contenedor espacial",
    )


# ── Entrada principal ────────────────────────────────────────────────────────

def run(ifc, author: str) -> list[CheckResult]:
    """Ejecuta todos los checks IFC 4x3 / ISO 16739-1 sobre el modelo abierto."""
    results = [
        _check_schema(ifc),
        _check_hierarchy(ifc),
        _check_spatial_containment(ifc),
        _check_owner_history(ifc),
        _check_units(ifc),
        _check_georef(ifc),
        _check_globalids(ifc),
        _check_psets(ifc),
        _check_classification(ifc),
        _check_materials(ifc),
    ]
    for r in results:
        r.source_hint = author
    return results
