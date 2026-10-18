"""IFC Model Checker — parser de plantillas Autodesk Model Checker (XML)
y validador contra archivos IFC con corrección inline.

El XML define una jerarquía Heading > Section > Check, donde cada Check
tiene Filtros que especifican qué categorías Revit (OST_*) y qué
parámetro debe validarse. Mapeamos OST_* → tipos IFC para hacer la misma
validación sobre los IFCs exportados.
"""
import os
import re
import xml.etree.ElementTree as ET
from typing import Any

import ifcopenshell

from services.ifc_sync import (
    _open_cached, _ifc_model_cache, _ifc_cache_mtime,
)


# ── Tipos IFC que son elementos espaciales/de proyecto (nunca objetos físicos) ─
# Se excluyen de los checks de parámetros de objetos para evitar falsos positivos.
_SPATIAL_IFC_TYPES: frozenset[str] = frozenset({
    "IfcProject",
    "IfcSite",
    "IfcBuilding",
    "IfcBuildingStorey",
    "IfcSpace",
    "IfcSpatialZone",
    "IfcExternalSpatialElement",
    "IfcZone",
})


# ── Parser del archivo de parámetros compartidos Revit ───────────────────────

def parse_shared_params_file(path: str) -> dict:
    """Parsea un archivo de parámetros compartidos de Revit (UTF-16 LE con BOM).

    Retorna:
    {
        "groups": {id_str: name_str},
        "params": [{"guid", "name", "datatype", "group_id", "group_name", "description"}],
        "param_names": [str, ...]
    }
    """
    groups: dict[str, str] = {}
    params: list[dict] = []

    with open(path, encoding="utf-16") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or line.startswith("*"):
                continue
            fields = line.split("\t")
            if not fields:
                continue
            record_type = fields[0].upper()
            if record_type == "GROUP" and len(fields) >= 3:
                gid   = fields[1].strip()
                gname = fields[2].strip()
                groups[gid] = gname
            elif record_type == "PARAM" and len(fields) >= 6:
                guid     = fields[1].strip()
                name     = fields[2].strip()
                datatype = fields[3].strip()
                # fields[4] = DATACATEGORY, fields[5] = GROUP_ID
                group_id = fields[5].strip()
                # description is at index 7 if present
                description = fields[7].strip() if len(fields) > 7 else ""
                params.append({
                    "guid":        guid,
                    "name":        name,
                    "datatype":    datatype,
                    "group_id":    group_id,
                    "group_name":  groups.get(group_id, ""),
                    "description": description,
                })

    # Resolve group names now that all groups are loaded
    for p in params:
        if not p["group_name"] and p["group_id"] in groups:
            p["group_name"] = groups[p["group_id"]]

    return {
        "groups":      groups,
        "params":      params,
        "param_names": [p["name"] for p in params],
    }


def _detect_software(model) -> str:
    """Devuelve 'revit', 'civil', o 'unknown' según IfcApplication."""
    apps = model.by_type("IfcApplication")
    if not apps:
        return "unknown"
    name = (getattr(apps[0], "ApplicationFullName", "") or "").lower()
    if "revit" in name:
        return "revit"
    if "civil" in name or "autocad" in name or "infraworks" in name:
        return "civil"
    return "unknown"


def _classify_param_scope(name: str) -> str:
    """Clasifica un parámetro como 'common', 'revit_only', 'civil_only', o 'other'."""
    n = name.strip()
    if n.startswith("ADIF_"):
        return "common"
    if n.startswith("ifcProject_") or n.startswith("ifcFacility_"):
        return "civil_only"
    if n.startswith("Ifc"):
        # IfcXxx (mayúscula) → Revit shared params
        return "revit_only"
    if n.startswith("ifc"):
        # ifcExportAs, ifcName, etc. → Revit shared params (minúscula pero no ifcProject_/ifcFacility_)
        return "revit_only"
    if n.startswith("INGR_"):
        return "revit_only"
    if n in {"ProjectName", "SiteName", "SiteAddress", "BuildingName"}:
        return "revit_only"
    if n in {"Phase", "LongName", "ObjectType", "Description", "Name"}:
        return "civil_only"
    return "other"


def _check_shared_params_presence(model, param_names: list[str]) -> tuple[str, str, list[dict]]:
    """Verifica parámetros en el IFC siendo consciente del software de origen.

    - Detecta si es Revit o Civil 3D desde IfcApplication
    - Solo evalúa parámetros aplicables a ese software
    - Parámetros ADIF_* siempre requeridos
    - Parámetros Ifc*/INGR_* solo si el modelo es Revit
    - Parámetros ifcProject_*/ifcFacility_* solo si el modelo es Civil 3D
    """
    software = _detect_software(model)

    # Clasificar parámetros y filtrar los que aplican a este software
    applicable: list[str] = []
    skipped_scope: list[str] = []
    for pname in param_names:
        scope = _classify_param_scope(pname)
        if scope == "common":
            applicable.append(pname)
        elif scope == "revit_only":
            if software in ("revit", "unknown"):
                applicable.append(pname)
            else:
                skipped_scope.append(pname)
        elif scope == "civil_only":
            if software in ("civil", "unknown"):
                applicable.append(pname)
            else:
                skipped_scope.append(pname)
        else:  # "other" — incluir si software es unknown, sino ignorar
            if software == "unknown":
                applicable.append(pname)

    if not applicable:
        sw_label = {"revit": "Revit", "civil": "Civil 3D"}.get(software, "desconocido")
        return ("skip", f"Sin parámetros aplicables para {sw_label}", [])

    # Recopilar todos los nombres de propiedades en los IfcPropertySet del modelo
    found_params: set[str] = set()
    for pset in model.by_type("IfcPropertySet"):
        for prop in getattr(pset, "HasProperties", []) or []:
            pname_ifc = getattr(prop, "Name", "") or ""
            if pname_ifc:
                found_params.add(pname_ifc)

    missing = [n for n in applicable if n not in found_params]
    present_count = len(applicable) - len(missing)
    total = len(applicable)

    status = "pass" if not missing else "fail"
    sw_label = {"revit": "Revit", "civil": "Civil 3D"}.get(software, software)

    skip_note = f" ({len(skipped_scope)} omitidos por software)" if skipped_scope else ""
    info = f"{present_count}/{total} presentes [{sw_label}]{skip_note}"

    missing_elements = [
        {"step_id": 0, "name": m, "type": "SharedParam", "current_value": "ausente"}
        for m in missing
    ]
    return (status, info, missing_elements)


def _check_fase_creacion(model) -> dict:
    """Verifica que todos los IfcElement tienen 'Fase de creación' asignada
    en el PropertySet 'Proceso por fases' (solo Revit; Civil 3D → skip).

    Fail: elementos que no tienen la propiedad o la tienen vacía.
    """
    software = _detect_software(model)
    if software == "civil":
        return {
            "status": "skip", "total": 0, "passed": 0, "failed": 0,
            "fail_elements": [],
            "info": "Solo aplica a modelos Revit",
        }

    _PHASE_PSET_NAMES: frozenset[str] = frozenset({
        "Proceso por fases", "Phasing", "Phase",
    })
    _PHASE_PROP_NAMES: frozenset[str] = frozenset({
        "Fase de creación", "Fase de creacion",
        "Phase", "CreationPhase", "Creation Phase",
    })

    # Recopilar todos los IfcElement (excluir tipos espaciales)
    all_elements: dict[int, dict] = {}
    for obj in model.by_type("IfcElement"):
        try:
            if obj.is_a() in _SPATIAL_IFC_TYPES:
                continue
            eid  = obj.id()
            name = getattr(obj, "Name", "") or f"Element_{eid}"
            guid = getattr(obj, "GlobalId", "") or str(eid)
            all_elements[eid] = {
                "step_id": guid,
                "name":    name,
                "type":    obj.is_a(),
            }
        except Exception:
            pass

    if not all_elements:
        return {
            "status": "skip", "total": 0, "passed": 0, "failed": 0,
            "fail_elements": [],
            "info": "Sin elementos IfcElement en el modelo",
        }

    # Marcar qué elementos tienen "Fase de creación" con valor
    has_phase: set[int] = set()
    for rel in model.by_type("IfcRelDefinesByProperties"):
        try:
            pdef = getattr(rel, "RelatingPropertyDefinition", None)
            if not pdef or not pdef.is_a("IfcPropertySet"):
                continue
            pset_name = getattr(pdef, "Name", "") or ""
            if pset_name not in _PHASE_PSET_NAMES:
                continue
            props = getattr(pdef, "HasProperties", []) or []
            phase_val = None
            for p in props:
                pname = getattr(p, "Name", "") or ""
                if pname not in _PHASE_PROP_NAMES:
                    continue
                nv  = getattr(p, "NominalValue", None)
                val = str(getattr(nv, "wrappedValue", nv)).strip() if nv else ""
                if val and val not in ("None", ""):
                    phase_val = val
                    break
            if phase_val is None:
                continue
            for obj in getattr(rel, "RelatedObjects", []) or []:
                try:
                    has_phase.add(obj.id())
                except Exception:
                    pass
        except Exception:
            pass

    fail_elements = [
        {
            "step_id":       edata["step_id"],
            "name":          edata["name"],
            "type":          edata["type"],
            "current_value": "sin asignar",
        }
        for eid, edata in all_elements.items()
        if eid not in has_phase
    ]

    total  = len(all_elements)
    passed = total - len(fail_elements)
    status = "pass" if not fail_elements else "fail"
    info   = f"{passed}/{total} elementos con Fase de creación asignada"

    return {
        "status":        status,
        "total":         total,
        "passed":        passed,
        "failed":        len(fail_elements),
        "fail_elements": fail_elements[:300],
        "info":          info,
    }


def _check_phase_elements(model) -> dict:
    """Enumera los elementos del IFC por fase de creación (solo Revit).

    Busca la propiedad 'Fase de creación' / 'Phase' en IfcPropertySets
    (típicamente en el pset 'Proceso por fases' de los exports Revit).
    Devuelve status 'info' con el recuento por fase, o 'skip' para Civil 3D.
    """
    software = _detect_software(model)
    if software == "civil":
        return {
            "status": "skip", "total": 0, "passed": 0, "failed": 0,
            "fail_elements": [],
            "info": "Solo aplica a modelos Revit",
        }

    _PHASE_PROP_NAMES: frozenset[str] = frozenset({
        "Fase de creación", "Fase de creacion",
        "Phase", "CreationPhase", "Creation Phase",
        "Fase de demolición", "DemolitionPhase", "Demolition Phase",
    })
    _PHASE_PSET_NAMES: frozenset[str] = frozenset({
        "Proceso por fases", "Phasing", "Phase",
    })

    from collections import Counter
    phase_counter: Counter = Counter()
    elements_with_phase: set[int] = set()

    for rel in model.by_type("IfcRelDefinesByProperties"):
        try:
            pdef = getattr(rel, "RelatingPropertyDefinition", None)
            if not pdef or not pdef.is_a("IfcPropertySet"):
                continue
            pset_name = getattr(pdef, "Name", "") or ""
            props = getattr(pdef, "HasProperties", []) or []
            for p in props:
                pname = getattr(p, "Name", "") or ""
                if pname not in _PHASE_PROP_NAMES and pset_name not in _PHASE_PSET_NAMES:
                    continue
                nv = getattr(p, "NominalValue", None)
                val = str(getattr(nv, "wrappedValue", nv)).strip() if nv else ""
                if not val or val in ("None", ""):
                    continue
                phase_counter[val] += 1
                for obj in getattr(rel, "RelatedObjects", []) or []:
                    try:
                        elements_with_phase.add(obj.id())
                    except Exception:
                        pass
        except Exception:
            pass

    total_with_phase = len(elements_with_phase)

    if not phase_counter:
        return {
            "status": "fail", "total": 0, "passed": 0, "failed": 0,
            "fail_elements": [],
            "info": "Sin información de fase en elementos",
        }

    # Info enriquecido: total + desglose por fase
    phase_parts = [f"{phase} ({count})"
                   for phase, count in phase_counter.most_common()]
    info = f"{total_with_phase} elementos  ·  " + "  ·  ".join(phase_parts)

    # Detalle por fase como filas informativas (NO son fallos — failed=0)
    detail_elements = [
        {
            "step_id": idx,
            "name":    phase,
            "type":    "PhaseDetail",
            "current_value": f"#{idx}",
        }
        for idx, (phase, _count) in enumerate(phase_counter.most_common(), 1)
    ]

    return {
        "status": "info",
        "total":  total_with_phase,
        "passed": total_with_phase,
        "failed": 0,          # ← 0 real; detail_elements son informativos, no errores
        "fail_elements": detail_elements,
        "info": info,
    }


def _check_element_identity_data(model) -> dict:
    """Valida presencia de parámetros de identidad en elementos (solo Revit).

    Busca PropertySet con propiedades de identidad (Subproyecto, Tiene asociación, etc.)
    y enumera elementos que no tienen o tienen vacíos estos parámetros.
    Devuelve 'info' con resumen o 'fail' si muchos elementos carecen de identidad.
    """
    software = _detect_software(model)
    if software == "civil":
        return {
            "status": "skip", "total": 0, "passed": 0, "failed": 0,
            "fail_elements": [],
            "info": "Solo aplica a modelos Revit",
        }

    # Psets de identidad y propiedades buscadas
    _IDENTITY_PSET_NAMES: frozenset[str] = frozenset({
        "Datos de identidad", "IdentityData", "Identity",
        "Identity Data", "DatosDeIdentidad",
    })
    _IDENTITY_PROP_NAMES: frozenset[str] = frozenset({
        "Subproyecto", "Sub-proyecto", "SubProject",
        "Tiene asociación", "Tiene asociacion", "HasAssociation",
        "Referencia de asociación", "Referencia de asociacion",
        "Código de asociación", "Codigo de asociacion",
    })

    elements_with_identity: dict[int, dict] = {}  # {obj_id: {step_id, name, has_identity, props}}

    # Recopilar todos los elementos del modelo (excepto tipos espaciales)
    for obj in model.by_type("IfcElement"):
        try:
            eid = obj.id()
            ename = getattr(obj, "Name", "") or f"Element_{eid}"
            step_id = obj.GlobalId if hasattr(obj, "GlobalId") else eid
            elements_with_identity[eid] = {
                "step_id": step_id, "name": ename,
                "has_identity": False, "identity_props": [],
            }
        except Exception:
            pass

    # Buscar PropertySets de identidad
    identity_count = 0
    for rel in model.by_type("IfcRelDefinesByProperties"):
        try:
            pdef = getattr(rel, "RelatingPropertyDefinition", None)
            if not pdef or not pdef.is_a("IfcPropertySet"):
                continue
            pset_name = getattr(pdef, "Name", "") or ""
            if pset_name not in _IDENTITY_PSET_NAMES:
                continue

            props = getattr(pdef, "HasProperties", []) or []
            related_objects = getattr(rel, "RelatedObjects", []) or []

            for obj in related_objects:
                try:
                    oid = obj.id()
                    if oid not in elements_with_identity:
                        continue

                    # Buscar propiedades de identidad en este pset
                    for prop in props:
                        pname = getattr(prop, "Name", "") or ""
                        if pname not in _IDENTITY_PROP_NAMES:
                            continue
                        nv = getattr(prop, "NominalValue", None)
                        val = str(getattr(nv, "wrappedValue", nv)).strip() if nv else ""
                        if val and val not in ("None", ""):
                            elements_with_identity[oid]["has_identity"] = True
                            elements_with_identity[oid]["identity_props"].append(f"{pname}={val}")
                            identity_count += 1
                except Exception:
                    pass
        except Exception:
            pass

    # Elementos sin identidad → fallos
    missing = [
        {
            "step_id": e["step_id"],
            "name": e["name"],
            "type": "ElementIdentity",
            "current_value": ", ".join(e["identity_props"]) if e["identity_props"] else "sin datos",
        }
        for e in elements_with_identity.values()
        if not e["has_identity"]
    ]

    total = len(elements_with_identity)
    with_identity = total - len(missing)
    status = "pass" if not missing else "info" if (with_identity / total > 0.7) else "fail"

    info = f"{with_identity}/{total} elementos con datos de identidad"

    return {
        "status":        status,
        "total":         total,
        "passed":        with_identity,
        "failed":        len(missing),
        "fail_elements": missing[:100],  # limitar a 100 para no saturar
        "info":          info,
    }


def _collect_project_ifc_attrs(model) -> set[str]:
    """Recopila todos los atributos/propiedades presentes en los elementos
    de información de proyecto del IFC: IfcProject, IfcSite, IfcBuilding
    y elementos tipo IfcFacility (para Civil 3D).

    Devuelve un conjunto de nombres "lógicos" que incluye:
    - Atributos directos (Name, LongName, ShortName, Phase, …)
    - Propiedades en PropertySets (ADIF_*, parámetros Revit en español, …)
    - Aliases Revit: parámetros de rvt_project_defaults como "SiteName",
      "BuildingName", "ProjectName", "SiteAddress" que Revit exporta como
      atributos directos de IfcSite/IfcBuilding/IfcProject, no como pset props.
    - Prefijos Civil 3D: "ifcProject_X" e "ifcFacility_X" a partir de atributos.
    """
    found: set[str] = set()

    # Tipos espaciales de nivel proyecto que queremos inspeccionar
    project_types = [
        "IfcProject", "IfcSite", "IfcBuilding",
        # Civil 3D exporta infraestructura como IfcFacility o similares
        "IfcFacility", "IfcFacilityPart", "IfcBridge",
        "IfcRailway", "IfcRoad", "IfcMarineFacility",
    ]
    # Atributos IFC directos relevantes en entidades de proyecto
    _DIRECT_ATTRS = (
        "Name", "LongName", "ShortName", "Description", "Phase",
        "ObjectType", "GlobalId",
    )
    # Prefijos de dwg/ifc_project_defaults que mapean a atributos IfcProject/IfcFacility
    _IFC_PREFIX_MAP = {
        "ifcProject_": "IfcProject",
        "ifcFacility_": "IfcFacility",
    }
    # ── Aliases Revit ──────────────────────────────────────────────────────
    # Revit exporta estos parámetros de rvt_project_defaults como atributos
    # directos de la entidad IFC, NO como propiedades de PropertySet.
    # Formato: { "NombreEnPB": ("TipoIFC", "AtributoIFC") }
    # Si el atributo tiene valor → el nombre de PB se considera presente.
    # ── Aliases Revit ──────────────────────────────────────────────────────
    # Revit exporta estos parámetros de rvt_project_defaults como atributos
    # directos de la entidad IFC, NO como propiedades de PropertySet.
    # Formato: { "NombreEnPB": [("TipoIFC", "AtributoIFC"), ...] }
    # Si CUALQUIER combinación tiene valor → el nombre de PB se considera presente.
    _REVIT_ALIASES: dict[str, list[tuple[str, str]]] = {
        # Revit "Project Name" → IfcProject.LongName
        "ProjectName":  [("IfcProject",  "LongName")],
        # Revit "Project Number" → IfcProject.Name
        "ProjectNumber": [("IfcProject", "Name")],
        # Revit "Site Name" → IfcSite.Name
        "SiteName":     [("IfcSite",     "Name")],
        # Revit "Building Name" → IfcBuilding.Name
        # En modelos de infraestructura sin IfcBuilding también puede estar en
        # IfcRailway, IfcBridge, IfcFacility, IfcRoad (entidad raíz de instalación)
        "BuildingName": [
            ("IfcBuilding",  "Name"),
            ("IfcRailway",   "Name"),
            ("IfcRailway",   "LongName"),
            ("IfcBridge",    "Name"),
            ("IfcFacility",  "Name"),
            ("IfcRoad",      "Name"),
        ],
        # Revit "Site Address" → IfcSite.SiteAddress (IfcPostalAddress)
        "SiteAddress":  [("IfcSite",     "SiteAddress")],
    }

    # Pre-cargar elementos por tipo (evitar N llamadas a by_type)
    _alias_types: set[str] = {t for pairs in _REVIT_ALIASES.values() for t, _ in pairs}
    _type_cache: dict[str, list] = {}
    for ifc_type in set(list(project_types)) | _alias_types:
        try:
            _type_cache[ifc_type] = model.by_type(ifc_type)
        except Exception:
            _type_cache[ifc_type] = []

    # ── 1) Resolver aliases Revit → nombre lógico de PB ───────────────────
    for pb_name, pairs in _REVIT_ALIASES.items():
        for ifc_type, ifc_attr in pairs:
            if pb_name in found:
                break  # ya resuelto
            for element in _type_cache.get(ifc_type, []):
                try:
                    val = getattr(element, ifc_attr, None)
                    # SiteAddress es un IfcPostalAddress (objeto IFC), no string
                    if val is not None:
                        if hasattr(val, "is_a"):
                            found.add(pb_name)
                        elif str(val).strip():
                            found.add(pb_name)
                        if pb_name in found:
                            break
                except Exception:
                    pass

    # ── 2) Atributos directos + prefijos Civil 3D + PropertySets ──────────
    for ifc_type in project_types:
        for element in _type_cache.get(ifc_type, []):
            etype = element.is_a()

            # Atributos directos
            for attr in _DIRECT_ATTRS:
                try:
                    val = getattr(element, attr, None)
                    if val is not None and str(val).strip():
                        found.add(attr)
                        # Prefijos Civil 3D
                        for prefix, mapped_type in _IFC_PREFIX_MAP.items():
                            if etype.startswith(mapped_type):
                                found.add(f"{prefix}{attr}")
                except Exception:
                    pass

            # PropertySets enlazados
            for rel in getattr(element, "IsDefinedBy", []) or []:
                try:
                    if not rel.is_a("IfcRelDefinesByProperties"):
                        continue
                    pdef = getattr(rel, "RelatingPropertyDefinition", None)
                    if pdef is None:
                        continue
                    if pdef.is_a("IfcPropertySet"):
                        for prop in getattr(pdef, "HasProperties", []) or []:
                            pname_ifc = getattr(prop, "Name", "") or ""
                            if pname_ifc:
                                found.add(pname_ifc)
                    elif pdef.is_a("IfcElementQuantity"):
                        for qty in getattr(pdef, "Quantities", []) or []:
                            qname = getattr(qty, "Name", "") or ""
                            if qname:
                                found.add(qname)
                except Exception:
                    pass

    return found


def _check_project_information(model, project_defaults: dict) -> dict:
    """Verifica que los parámetros de información de proyecto de PocketBase
    están presentes en el IFC (IfcProject / IfcSite / IfcBuilding / IfcFacility).

    project_defaults: {"revit": [{"name": ..., "value": ...}, ...],
                       "civil": [{"name": ..., "value": ...}, ...]}

    Reglas clave:
    - Si PB property_value está vacío o es "N/A" → parámetro no requerido, se omite.
    - Aliases: BuildingName ↔ "Nombre del edificio"; SiteAddress ↔ "Dirección de proyecto"
    - ifcProject_*/ifcFacility_* → mapean a atributos IFC directos via _collect_project_ifc_attrs
    - ADIF_* / INGR_* / parámetros en español → buscados en PropertySets

    Devuelve el dict completo de resultado (status, total, passed, failed, …).
    """
    if not project_defaults:
        return {
            "status": "skip", "total": 0, "passed": 0, "failed": 0,
            "fail_elements": [],
            "info": "Sin datos de PocketBase para validación de proyecto",
        }

    software = _detect_software(model)

    # Seleccionar lista de registros según software
    if software == "revit":
        raw_records: list[dict] = list(project_defaults.get("revit", []))
        sw_label = "Revit"
    elif software == "civil":
        raw_records = list(project_defaults.get("civil", []))
        sw_label = "Civil 3D"
    else:
        # Desconocido: unión de ambas, eliminar duplicados por nombre
        seen_names: set[str] = set()
        raw_records = []
        for rec in (list(project_defaults.get("revit", [])) +
                    list(project_defaults.get("civil", []))):
            n = rec.get("name", "") if isinstance(rec, dict) else str(rec)
            if n and n not in seen_names:
                seen_names.add(n)
                raw_records.append(rec)
        sw_label = "desconocido"

    # ── Normalizar: admitir tanto strings (legado) como dicts {name, value} ──
    normalized: list[dict] = []
    for rec in raw_records:
        if isinstance(rec, dict):
            normalized.append({"name": rec.get("name",""), "value": rec.get("value","")})
        else:
            normalized.append({"name": str(rec), "value": ""})

    # ── Filtrar: si PB no tiene valor asignado → el parámetro no es requerido ─
    # Un valor vacío o "N/A" significa que no se configuró → Revit no lo exportará.
    def _pb_value_is_empty(v: str) -> bool:
        return not v or v.strip() == "" or v.strip().upper() == "N/A"

    skipped_empty: list[str] = []
    active_records: list[dict] = []
    for rec in normalized:
        if _pb_value_is_empty(rec["value"]):
            skipped_empty.append(rec["name"])
        else:
            active_records.append(rec)

    if not active_records:
        return {
            "status": "skip", "total": 0, "passed": 0, "failed": 0,
            "fail_elements": [],
            "info": f"Sin valores configurados en PocketBase para {sw_label}",
        }

    # ── Filtrar por scope de software ─────────────────────────────────────
    applicable: list[str] = []
    skipped_scope: list[str] = []
    for rec in active_records:
        pname = rec["name"]
        scope = _classify_param_scope(pname)
        if scope == "common":
            applicable.append(pname)
        elif scope == "revit_only":
            if software in ("revit", "unknown"):
                applicable.append(pname)
            else:
                skipped_scope.append(pname)
        elif scope == "civil_only":
            if software in ("civil", "unknown"):
                applicable.append(pname)
            else:
                skipped_scope.append(pname)
        else:  # "other" — siempre aplicable
            applicable.append(pname)

    if not applicable:
        return {
            "status": "skip", "total": 0, "passed": 0, "failed": 0,
            "fail_elements": [],
            "info": f"Sin parámetros de proyecto aplicables para {sw_label}",
        }

    # ── Recopilar atributos/propiedades presentes en el IFC ───────────────
    found_params = _collect_project_ifc_attrs(model)

    # ── Aliases entre nombres PB y nombres IFC (mismas propiedades con  ───
    # distinto nombre en PB vs en el IFC exportado por Revit)
    # Si cualquiera de los aliases está en found_params → el PB param se considera presente
    _PARAM_ALIASES: dict[str, list[str]] = {
        # BuildingName en PB ↔ "Nombre del edificio" en pset IFC
        # (también puede estar como IfcRailway.Name, ya cubierto via _REVIT_ALIASES)
        "BuildingName": ["Nombre del edificio", "Nombre de edificio"],
        # SiteAddress en PB ↔ "Dirección de proyecto" en pset IFC
        # (mismo valor, doble nomenclatura en PB)
        "SiteAddress":  ["Dirección de proyecto", "Direccion de proyecto",
                         "Dirección de proyecto"],
    }

    def _is_present(pname: str) -> bool:
        if pname in found_params:
            return True
        for alias in _PARAM_ALIASES.get(pname, []):
            if alias in found_params:
                return True
        return False

    missing = [n for n in applicable if not _is_present(n)]
    present_count = len(applicable) - len(missing)
    total = len(applicable)
    status = "pass" if not missing else "fail"

    notes: list[str] = []
    if skipped_scope:
        notes.append(f"{len(skipped_scope)} omitidos por software")
    if skipped_empty:
        notes.append(f"{len(skipped_empty)} sin valor en PB")
    note_str = f" ({', '.join(notes)})" if notes else ""
    info = f"{present_count}/{total} parámetros de proyecto [{sw_label}]{note_str}"

    missing_elements = [
        {"step_id": 0, "name": m, "type": "ProjectParam", "current_value": "ausente"}
        for m in missing
    ]
    return {
        "status":        status,
        "total":         total,
        "passed":        present_count,
        "failed":        len(missing),
        "fail_elements": missing_elements,
        "info":          info,
    }


# ── Mapeo categorías Revit → tipos IFC ────────────────────────────────────────

OST_TO_IFC: dict[str, list[str]] = {
    # Arquitectura
    "OST_Walls":               ["IfcWall", "IfcWallStandardCase", "IfcWallElementedCase"],
    "OST_Floors":              ["IfcSlab"],
    "OST_Ceilings":            ["IfcCovering"],
    "OST_Doors":               ["IfcDoor", "IfcDoorStandardCase"],
    "OST_Windows":             ["IfcWindow", "IfcWindowStandardCase"],
    "OST_Columns":             ["IfcColumn"],
    "OST_Roofs":               ["IfcRoof"],
    "OST_Stairs":              ["IfcStair", "IfcStairFlight"],
    "OST_StairsRailing":       ["IfcRailing"],
    "OST_Ramps":               ["IfcRamp", "IfcRampFlight"],
    "OST_Furniture":           ["IfcFurnishingElement", "IfcFurniture"],
    "OST_FurnitureSystems":    ["IfcFurnishingElement", "IfcSystemFurnitureElement"],
    "OST_Casework":            ["IfcFurniture", "IfcFurnishingElement"],
    "OST_CurtainWallPanels":   ["IfcPlate"],
    "OST_CurtainWallMullions": ["IfcMember"],
    "OST_CurtaSystem":         ["IfcCurtainWall"],
    "OST_GenericModel":        ["IfcBuildingElementProxy"],
    "OST_Mass":                ["IfcBuildingElementProxy", "IfcSpatialZone"],
    "OST_Parts":               ["IfcBuildingElementPart", "IfcElementAssembly"],
    "OST_SpecialityEquipment": ["IfcFurnishingElement", "IfcBuildingElementProxy"],

    # Estructura
    "OST_StructuralColumns":      ["IfcColumn"],
    "OST_StructuralFraming":      ["IfcBeam", "IfcMember"],
    "OST_StructuralFramingSystem": ["IfcBeam", "IfcMember"],
    "OST_StructuralFoundation":   ["IfcFooting"],
    "OST_StructuralStiffener":    ["IfcMember", "IfcPlate"],
    "OST_StructuralTruss":        ["IfcMember"],
    "OST_StructConnections":      ["IfcDiscreteAccessory", "IfcMechanicalFastener"],
    "OST_Coupler":                ["IfcDiscreteAccessory"],
    "OST_Rebar":                  ["IfcReinforcingBar"],
    "OST_AreaRein":               ["IfcReinforcingMesh"],
    "OST_PathRein":               ["IfcReinforcingMesh"],
    "OST_FabricAreas":            ["IfcReinforcingMesh"],

    # MEP — Aire
    "OST_DuctAccessory":     ["IfcDuctFitting", "IfcFlowController"],
    "OST_DuctCurves":        ["IfcDuctSegment"],
    "OST_FlexDuctCurves":    ["IfcDuctSegment"],
    "OST_DuctFitting":       ["IfcDuctFitting"],
    "OST_DuctTerminal":      ["IfcAirTerminal"],
    "OST_DuctSystem":        ["IfcDistributionSystem"],
    "OST_DuctInsulations":   ["IfcCovering"],
    "OST_DuctLinings":       ["IfcCovering"],
    "OST_MechanicalEquipment":              ["IfcUnitaryEquipment", "IfcDistributionElement"],
    "OST_MechanicalEquipmentSet":           ["IfcSystem"],
    "OST_MechanicalEquipmentSetBoundaryLines": ["IfcVirtualElement"],

    # MEP — Tubería
    "OST_PipeAccessory":    ["IfcPipeFitting", "IfcFlowController"],
    "OST_PipeCurves":       ["IfcPipeSegment"],
    "OST_FlexPipeCurves":   ["IfcPipeSegment"],
    "OST_PipeFitting":      ["IfcPipeFitting"],
    "OST_PipeInsulations":  ["IfcCovering"],
    "OST_Sprinklers":       ["IfcFireSuppressionTerminal"],
    "OST_PlumbingFixtures": ["IfcSanitaryTerminal"],

    # MEP — Eléctrico
    "OST_ElectricalFixtures":    ["IfcElectricAppliance", "IfcDistributionElement"],
    "OST_ElectricalEquipment":   ["IfcElectricDistributionBoard", "IfcDistributionElement"],
    "OST_LightingFixtures":      ["IfcLightFixture"],
    "OST_LightingDevices":       ["IfcLightFixture"],
    "OST_FireAlarmDevices":      ["IfcAlarm", "IfcSensor"],
    "OST_SecurityDevices":       ["IfcAlarm", "IfcSensor"],
    "OST_CommunicationDevices":  ["IfcCommunicationsAppliance"],
    "OST_DataDevices":           ["IfcCommunicationsAppliance"],
    "OST_TelephoneDevices":      ["IfcCommunicationsAppliance"],
    "OST_NurseCallDevices":      ["IfcAlarm"],
    "OST_Wire":                  ["IfcCableSegment"],
    "OST_Conduit":               ["IfcCableCarrierSegment"],
    "OST_ConduitRun":            ["IfcCableCarrierSegment"],
    "OST_CableTray":             ["IfcCableCarrierSegment"],
    "OST_CableTrayFitting":      ["IfcCableCarrierFitting"],
    "OST_ConduitFitting":        ["IfcCableCarrierFitting"],
    "OST_FabricationContainment": ["IfcCableCarrierSegment"],
    "OST_ElectricalCircuit":     ["IfcDistributionCircuit"],

    # Site / Civil
    "OST_Site":           ["IfcSite"],
    "OST_Topography":     ["IfcGeographicElement", "IfcSite"],
    "OST_Entourage":      ["IfcGeographicElement", "IfcBuildingElementProxy"],
    "OST_Planting":       ["IfcGeographicElement"],
    "OST_Roads":          ["IfcCivilElement", "IfcBuildingElementProxy"],
    "OST_Parking":        ["IfcTransportElement", "IfcBuildingElementProxy"],

    # Bridge — todos se mapean a IfcBuildingElementProxy salvo IFC 4.3 con tipos específicos
    "OST_BridgeArches":      ["IfcBuildingElementProxy", "IfcCivilElement"],
    "OST_BridgeBearings":    ["IfcBuildingElementProxy", "IfcCivilElement"],
    "OST_BridgeCables":      ["IfcBuildingElementProxy", "IfcCivilElement"],
    "OST_BridgeAbutments":   ["IfcBuildingElementProxy", "IfcCivilElement"],
    "OST_BridgeDecks":       ["IfcBuildingElementProxy", "IfcCivilElement"],
    "OST_BridgeFoundations": ["IfcBuildingElementProxy", "IfcCivilElement"],
    "OST_BridgeGirders":     ["IfcBuildingElementProxy", "IfcCivilElement"],
    "OST_BridgePiers":       ["IfcBuildingElementProxy", "IfcCivilElement"],
    "OST_BridgeTowers":      ["IfcBuildingElementProxy", "IfcCivilElement"],

    # Especiales
    "OST_ProjectInformation": ["IfcProject"],
    "OST_SharedBasePoint":    ["IfcSite"],
    "OST_PlaceHolderDucts":   [],   # placeholder Revit, no se exporta a IFC
    "OST_PlaceHolderPipes":   [],
}


# ── Parser del XML del Model Checker ─────────────────────────────────────────

# Heading "<--Unused-->" se ignora por convención del Model Checker
_UNUSED_RE = re.compile(r"unused", re.IGNORECASE)


def parse_check_xml(xml_path: str) -> dict:
    """Parsea el XML del plugin Autodesk Model Checker.

    Retorna:
    {
        "name":        "...",
        "description": "...",
        "headings": [
            {
                "id": "...",
                "title": "1. Datos generales",
                "description": "...",
                "sections": [
                    {
                        "id": "...",
                        "name": "1.1. Información de Revit",
                        "checks": [
                            {
                                "id": "...",
                                "name": "Versión Revit",
                                "description": "...",
                                "failure_message": "...",
                                "check_type": "Custom" | "FileName" | ...,
                                "is_required": True,
                                "result_condition": "FailMatchingElements" | "FailNoElements" | "CountOnly",
                                "param":       "ADIF_00_Codigo_Producto",  # Si Custom→HasNoValue
                                "categories":  ["OST_Walls", ...],         # Si Custom
                                "filename_pattern": "^\\d{12}-...",         # Si FileName
                                "options": {...},                           # PrebuiltOptions
                            },
                            ...
                        ],
                    },
                    ...
                ],
            },
            ...
        ],
    }
    """
    tree = ET.parse(xml_path)
    root = tree.getroot()

    result: dict = {
        "name":        root.attrib.get("Name", ""),
        "description": root.attrib.get("Description", ""),
        "headings":    [],
    }

    for h in root.findall("Heading"):
        h_text = h.attrib.get("HeadingText", "")
        if _UNUSED_RE.search(h_text):
            continue
        heading = {
            "id":          h.attrib.get("ID", ""),
            "title":       h_text,
            "description": h.attrib.get("Description", ""),
            "sections":    [],
        }
        for s in h.findall("Section"):
            s_name = s.attrib.get("SectionName", "")
            if _UNUSED_RE.search(s_name):
                continue
            section = {
                "id":     s.attrib.get("ID", ""),
                "name":   s_name,
                "checks": [],
            }
            for c in s.findall("Check"):
                section["checks"].append(_parse_check(c))
            heading["sections"].append(section)
        result["headings"].append(heading)

    return result


def _parse_check(c: ET.Element) -> dict:
    """Extrae los datos relevantes de un <Check> incluyendo filtros."""
    check_type = c.attrib.get("CheckType", "")
    check: dict = {
        "id":               c.attrib.get("ID", ""),
        "name":             c.attrib.get("CheckName", "").strip(),
        "description":      c.attrib.get("Description", ""),
        "failure_message":  c.attrib.get("FailureMessage", ""),
        "check_type":       check_type,
        "is_required":      c.attrib.get("IsRequired", "False") == "True",
        "result_condition": c.attrib.get("ResultCondition", ""),
        "param":            "",
        "param_unit":       "",
        "param_value":      "",
        "param_condition":  "",
        "categories":       [],
        "filename_pattern": "",
        "options":          {},
    }

    # PrebuiltOptions (FileName, Worksets, etc.)
    pb = c.find("PrebuiltOptions")
    if pb is not None:
        check["options"] = dict(pb.attrib)
        if "FileNamePattern" in pb.attrib:
            check["filename_pattern"] = pb.attrib["FileNamePattern"]

    # Filtros
    for f in c.findall("Filter"):
        cat = f.attrib.get("Category", "")
        prop = f.attrib.get("Property", "")
        cond = f.attrib.get("Condition", "")
        val  = f.attrib.get("Value", "")
        unit = f.attrib.get("Unit", "")
        if cat == "Category" and cond == "Included" and prop.startswith("OST_"):
            check["categories"].append(prop)
        elif cat == "Parameter":
            check["param"]           = prop
            check["param_condition"] = cond
            check["param_value"]     = val
            check["param_unit"]      = unit
        # Category=TypeOrInstance & otros se ignoran: no aplican en IFC

    return check


# ── Validación de IFC contra un Check ────────────────────────────────────────

def _ifc_types_for_categories(categories: list[str]) -> set[str]:
    """Resuelve OST_* → conjunto de IFC types."""
    types: set[str] = set()
    for cat in categories:
        types.update(OST_TO_IFC.get(cat, []))
    return types


def _read_param_value(element, param_name: str) -> tuple[bool, str]:
    """Busca un parámetro en cualquier PropertySet del elemento.

    Retorna (existe_con_valor, valor_str).
    'existe_con_valor' = True si está y NO está vacío.
    """
    if not hasattr(element, "IsDefinedBy"):
        return (False, "")
    for rel in (element.IsDefinedBy or []):
        if not rel.is_a("IfcRelDefinesByProperties"):
            continue
        pdef = getattr(rel, "RelatingPropertyDefinition", None)
        if not pdef or not pdef.is_a("IfcPropertySet"):
            continue
        for prop in (pdef.HasProperties or []):
            if getattr(prop, "Name", None) != param_name:
                continue
            if prop.is_a("IfcPropertySingleValue"):
                nv = prop.NominalValue
                if nv is None:
                    return (False, "")
                wrapped = getattr(nv, "wrappedValue", nv)
                val = "" if wrapped is None else str(wrapped).strip()
                return (bool(val), val)
            # Otros tipos de propiedad: lo consideramos definido si existe
            return (True, "")
    return (False, "")


def _read_param_value_or_inproject(model, param_name: str) -> tuple[bool, str]:
    """Versión especial para parámetros de proyecto: los busca también en IfcProject."""
    for proj in model.by_type("IfcProject"):
        ok, val = _read_param_value(proj, param_name)
        if ok:
            return (ok, val)
    return (False, "")


def _check_filename(filename: str, pattern: str) -> bool:
    if not pattern:
        return True
    try:
        return re.search(pattern, filename) is not None
    except re.error:
        return False


def _check_application_version(model, required_year: str = "2025") -> tuple[str, str]:
    """Extrae la versión de la aplicación del IFC (IfcApplication) y valida el año.
    Funciona con cualquier software (Revit, Civil 3D, etc.)."""
    apps = model.by_type("IfcApplication")
    if not apps:
        return ("fail", "Sin información de aplicación en el IFC")
    app = apps[0]
    full_name = getattr(app, "ApplicationFullName", "") or ""
    version   = getattr(app, "Version", "") or ""
    combined  = f"{full_name} {version}".strip()
    ok = required_year in combined
    return ("pass" if ok else "fail", combined or "Desconocido")


def _check_file_size(ifc_path: str, max_mb: float = 300.0) -> tuple[str, str]:
    """Valida que el archivo IFC no supere max_mb MB."""
    try:
        size_bytes = os.path.getsize(ifc_path)
        size_mb    = size_bytes / (1024 * 1024)
        ok         = size_mb <= max_mb
        if ok:
            info = f"{size_mb:.2f} MB  ✓  (límite: {max_mb:.0f} MB)"
        else:
            info = f"{size_mb:.2f} MB  ✗  (excede el límite de {max_mb:.0f} MB)"
        return ("pass" if ok else "fail", info)
    except Exception as e:
        return ("skip", f"No se pudo leer el tamaño: {e}")


def _get_site_geo_data(model) -> dict:
    """Extrae todos los datos de georeferenciación del IFC en un solo paso.
    Fuentes (en orden de prioridad):
    1. IfcMapConversion (IFC4 — Eastings, Northings, OrthogonalHeight + escala/rotación)
    2. ObjectPlacement del IfcSite (posición del sitio en coordenadas del modelo)
    3. RefLatitude/RefLongitude/RefElevation del IfcSite (geográficos)
    4. IfcCoordinateOperation / IfcProjectedCRS (IFC4x3)
    """
    result = {
        "x": None, "y": None, "z": None,
        "lat": None, "lon": None, "elev": None,
        "crs": None, "scale": None,
        "source": "none",
    }

    sites = model.by_type("IfcSite")
    if not sites:
        return result
    site = sites[0]

    # ── 1) IfcMapConversion (IFC4 estándar — coordenadas cartesianas UTM) ─
    try:
        for mc in model.by_type("IfcMapConversion"):
            e = getattr(mc, "Eastings",  None)
            n = getattr(mc, "Northings", None)
            h = getattr(mc, "OrthogonalHeight", None)
            if e is not None or n is not None:
                result["x"]      = e
                result["y"]      = n
                result["z"]      = h
                result["scale"]  = getattr(mc, "Scale", None)
                # SourceCRS o TargetCRS pueden tener nombre del SRS
                crs = getattr(mc, "TargetCRS", None) or getattr(mc, "SourceCRS", None)
                if crs:
                    result["crs"] = getattr(crs, "Name", None) or getattr(crs, "Description", None)
                result["source"] = "IfcMapConversion"
                break
    except Exception:
        pass

    # ── 2) ObjectPlacement del IfcSite ────────────────────────────────────
    if result["x"] is None:
        try:
            placement = getattr(site, "ObjectPlacement", None)
            if placement and placement.is_a("IfcLocalPlacement"):
                rel_pl = getattr(placement, "RelativePlacement", None)
                if rel_pl and rel_pl.is_a("IfcAxis2Placement3D"):
                    loc = getattr(rel_pl, "Location", None)
                    if loc and hasattr(loc, "Coordinates"):
                        c = loc.Coordinates
                        x = c[0] if len(c) > 0 else 0.0
                        y = c[1] if len(c) > 1 else 0.0
                        z = c[2] if len(c) > 2 else 0.0
                        # Solo si las coordenadas no son (0,0,0)
                        if abs(x) > 1.0 or abs(y) > 1.0:
                            result["x"] = x
                            result["y"] = y
                            result["z"] = z
                            result["source"] = "IfcSite.ObjectPlacement"
                elif rel_pl and rel_pl.is_a("IfcAxis2Placement2D"):
                    loc = getattr(rel_pl, "Location", None)
                    if loc and hasattr(loc, "Coordinates"):
                        c = loc.Coordinates
                        x = c[0] if len(c) > 0 else 0.0
                        y = c[1] if len(c) > 1 else 0.0
                        if abs(x) > 1.0 or abs(y) > 1.0:
                            result["x"] = x
                            result["y"] = y
                            result["source"] = "IfcSite.ObjectPlacement(2D)"
        except Exception:
            pass

    # ── 3) RefLatitude / RefLongitude / RefElevation del IfcSite ──────────
    try:
        lat = getattr(site, "RefLatitude",  None)
        lon = getattr(site, "RefLongitude", None)
        elv = getattr(site, "RefElevation", None)
        if lat:
            # RefLatitude es una lista/tupla (D,M,S,milliseconds) en IFC2x3
            if hasattr(lat, "__iter__"):
                parts = list(lat)
                deg = parts[0] + parts[1]/60.0 + (parts[2] + (parts[3]/1e6 if len(parts) > 3 else 0))/3600.0
                result["lat"] = round(deg, 8)
            else:
                result["lat"] = float(lat)
        if lon:
            if hasattr(lon, "__iter__"):
                parts = list(lon)
                deg = parts[0] + parts[1]/60.0 + (parts[2] + (parts[3]/1e6 if len(parts) > 3 else 0))/3600.0
                result["lon"] = round(deg, 8)
            else:
                result["lon"] = float(lon)
        if elv is not None:
            result["elev"] = float(elv)
        if result["source"] == "none" and (lat or lon or elv is not None):
            result["source"] = "IfcSite.RefLatLonElev"
    except Exception:
        pass

    # ── 4) IfcCoordinateOperation (IFC4x3) ────────────────────────────────
    if result["x"] is None:
        try:
            for op in model.by_type("IfcCoordinateOperation"):
                e = getattr(op, "Eastings",  None)
                n = getattr(op, "Northings", None)
                if e is not None or n is not None:
                    result["x"] = e
                    result["y"] = n
                    result["z"] = getattr(op, "OrthogonalHeight", None)
                    result["source"] = "IfcCoordinateOperation"
                    break
        except Exception:
            pass

    return result


def _check_georeferencing(model, kind: str) -> tuple[bool, str]:
    """Validación de georeferenciación. Lee datos del sitio IFC una sola vez.
    kind: "northsouth" | "eastwest" | "elevation" | "latitude" | "longitude" | "coords"
    Devuelve (ok, texto_informativo)."""

    geo = _get_site_geo_data(model)

    def _fmt(v) -> str:
        if v is None:
            return "N/D"
        try:
            f = float(v)
            # Si el número es muy grande (coordenadas UTM > 10000), no decimales extra
            if abs(f) > 10000:
                return f"{f:,.3f}"
            return f"{f:.6f}"
        except Exception:
            return str(v)

    if kind == "northsouth":
        if geo["y"] is not None:
            return (True, f"Y (Norte) = {_fmt(geo['y'])}  [{geo['source']}]")
        if geo["lat"] is not None:
            return (True, f"Lat = {_fmt(geo['lat'])}°  [{geo['source']}]")
        return (False, "Sin coordenada Norte/Sur en IfcSite")

    if kind == "eastwest":
        if geo["x"] is not None:
            return (True, f"X (Este) = {_fmt(geo['x'])}  [{geo['source']}]")
        if geo["lon"] is not None:
            return (True, f"Lon = {_fmt(geo['lon'])}°  [{geo['source']}]")
        return (False, "Sin coordenada Este/Oeste en IfcSite")

    if kind == "elevation":
        if geo["z"] is not None:
            return (True, f"Z (Elev.) = {_fmt(geo['z'])} m  [{geo['source']}]")
        if geo["elev"] is not None:
            return (True, f"RefElevation = {_fmt(geo['elev'])} m  [{geo['source']}]")
        return (False, "Sin elevación en IfcSite")

    if kind == "latitude":
        if geo["lat"] is not None:
            return (True, f"Lat = {_fmt(geo['lat'])}°  [{geo['source']}]")
        if geo["y"] is not None:
            return (True, f"Y (Norte UTM) = {_fmt(geo['y'])}  [{geo['source']}]")
        return (False, "Sin latitud en IfcSite")

    if kind == "longitude":
        if geo["lon"] is not None:
            return (True, f"Lon = {_fmt(geo['lon'])}°  [{geo['source']}]")
        if geo["x"] is not None:
            return (True, f"X (Este UTM) = {_fmt(geo['x'])}  [{geo['source']}]")
        return (False, "Sin longitud en IfcSite")

    if kind == "coords":
        parts: list[str] = []
        if geo["x"] is not None:
            parts.append(f"X={_fmt(geo['x'])}")
        if geo["y"] is not None:
            parts.append(f"Y={_fmt(geo['y'])}")
        if geo["z"] is not None:
            parts.append(f"Z={_fmt(geo['z'])}")
        if geo["lat"] is not None:
            parts.append(f"Lat={_fmt(geo['lat'])}°")
        if geo["lon"] is not None:
            parts.append(f"Lon={_fmt(geo['lon'])}°")
        if geo["elev"] is not None:
            parts.append(f"Elev={_fmt(geo['elev'])}m")
        if geo["crs"]:
            parts.append(f"CRS:{geo['crs']}")
        if parts:
            return (True, "  ".join(parts) + f"  [{geo['source']}]")
        return (False, "Sin datos de georeferenciación en IfcSite")

    return (False, "Tipo desconocido")


_GEO_CHECK_MAP = {
    "indicar la posición norte/sur del proyecto": "northsouth",
    "indicar la posición este/oeste del proyecto": "eastwest",
    "indicar la elevación del proyecto":           "elevation",
    "indicar la latitud del proyecto":             "latitude",
    "indicar la longitud del proyecto":            "longitude",
    "coordenadas del proyecto":                    "coords",
}


def _check_id_objeto(model, ifc_types: set[str]) -> dict:
    """Validación completa de ADIF_00_Id_Objeto en todos los elementos del IFC.

    Reglas:
    1. Presencia: cada elemento debe tener el parámetro con valor no vacío.
    2. Unicidad:  ningún valor puede repetirse entre elementos (es un ID único).

    Falla si:
    - El elemento no tiene el parámetro o está vacío  → current_value = "(ausente)"
    - El valor existe pero está duplicado en otro elemento
      → current_value = "⚠ DUPLICADO: <valor>"  (se marca TODOS los que lo repiten)
    """
    PARAM = "ADIF_00_Id_Objeto"

    # Recoger todos los elementos (deduplicados por step_id)
    elements = []
    for t in ifc_types:
        try:
            elements.extend(model.by_type(t))
        except Exception:
            pass
    seen_ids: set[int] = set()
    unique: list = []
    for e in elements:
        try:
            sid = e.id()
        except Exception:
            continue
        if sid in seen_ids:
            continue
        seen_ids.add(sid)
        unique.append(e)

    if not unique:
        return {"status": "skip", "total": 0, "passed": 0, "failed": 0,
                "fail_elements": [], "info": "No hay elementos de esas categorías en el IFC"}

    # Paso 1: leer todos los valores
    from collections import Counter
    value_map: dict[int, tuple[bool, str]] = {}   # step_id → (ok, val)
    for e in unique:
        ok, val = _read_param_value(e, PARAM)
        value_map[e.id()] = (ok, val)

    # Paso 2: detectar duplicados (solo entre valores no vacíos)
    non_empty_vals = [val for (ok, val) in value_map.values() if ok and val]
    dup_counts = Counter(non_empty_vals)
    duplicates: set[str] = {v for v, cnt in dup_counts.items() if cnt > 1}

    # Paso 3: clasificar cada elemento
    fail_list: list[dict] = []
    passed = 0
    missing_count = 0
    dup_count = 0
    type_summary: dict[str, dict] = {}

    for e in unique:
        ok, val = value_map[e.id()]
        name  = getattr(e, "Name", "") or ""
        etype = e.is_a()
        if etype not in type_summary:
            type_summary[etype] = {"total": 0, "failed": 0}
        type_summary[etype]["total"] += 1

        if not ok or not val:
            missing_count += 1
            type_summary[etype]["failed"] += 1
            fail_list.append({
                "step_id": e.id(), "name": name,
                "type": etype, "current_value": "(ausente)",
            })
        elif val in duplicates:
            dup_count += 1
            type_summary[etype]["failed"] += 1
            fail_list.append({
                "step_id": e.id(), "name": name,
                "type": etype, "current_value": f"⚠ DUPLICADO: {val}",
            })
        else:
            passed += 1

    failed = len(fail_list)
    status = "pass" if failed == 0 else "fail"

    if status == "pass":
        info = f"{len(unique)} IDs únicos verificados  ✓"
    else:
        parts: list[str] = []
        if missing_count:
            parts.append(f"{missing_count} sin ID")
        if dup_count:
            parts.append(f"{dup_count} con ID duplicado ({len(duplicates)} valor(es) repetido(s))")
        info = "  ·  ".join(parts)

    return {
        "status": status, "total": len(unique),
        "passed": passed, "failed": failed,
        "fail_elements": fail_list,
        "info": info,
        "type_summary": type_summary,
    }


def _check_param_at_project_level(model, param_name: str) -> dict:
    """Verifica que `param_name` existe y tiene valor en la entidad de proyecto
    (IfcSite → IfcProject → IfcFacility / IfcRailway / IfcBuilding).

    Se usa para parámetros cuyo target en revit_shared_parameters es
    'Información de proyecto' — solo hay 1 resultado (el proyecto completo).
    """
    _PROJECT_TYPES = [
        "IfcSite", "IfcProject", "IfcBuilding",
        "IfcFacility", "IfcRailway", "IfcBridge", "IfcRoad",
    ]
    found_val: str | None = None
    found_type: str = "IfcSite"
    found_id: int = 0
    for ifc_type in _PROJECT_TYPES:
        try:
            for entity in model.by_type(ifc_type):
                ok, val = _read_param_value(entity, param_name)
                if ok:
                    found_val = val.strip() if val else ""
                    found_type = entity.is_a()
                    found_id = entity.id()
                    break
        except Exception:
            continue
        if found_val is not None:
            break

    has_value = found_val is not None and found_val != ""
    if found_val is None:
        # No encontrado en ninguna entidad de proyecto
        return {
            "status": "fail", "total": 1, "passed": 0, "failed": 1,
            "fail_elements": [{
                "step_id": 0, "name": "Proyecto",
                "type": "IfcSite", "current_value": "(ausente)",
            }],
            "info": "Parámetro no encontrado en entidades de proyecto",
        }

    return {
        "status": "pass" if has_value else "fail",
        "total": 1,
        "passed": 1 if has_value else 0,
        "failed": 0 if has_value else 1,
        "fail_elements": [] if has_value else [{
            "step_id": found_id, "name": "Proyecto",
            "type": found_type, "current_value": "(vacío)",
        }],
        "info": (f"{found_val}  ✓" if has_value else "Parámetro presente pero sin valor"),
    }


def _check_codigo_archivo(model, filename: str, midp_mapping: dict) -> dict:
    """Verifica que ADIF_00_Codigo_Archivo en la entidad de proyecto (IfcSite /
    IfcProject / IfcFacility / IfcRailway) coincide con el native_name de
    midp_mapping de PocketBase.

    Este parámetro es de PROYECTO, no de elemento individual.
    midp_mapping: {ifc_name.lower(): native_name_con_extension}
    """
    expected = midp_mapping.get(filename.lower())

    if expected is None:
        return {
            "status": "skip", "total": 0, "passed": 0, "failed": 0,
            "fail_elements": [],
            "info": f"'{filename}' no encontrado en midp_mapping (PocketBase)",
        }

    PARAM = "ADIF_00_Codigo_Archivo"

    # Buscar el parámetro en entidades de proyecto (por orden de prioridad)
    _PROJECT_TYPES = [
        "IfcSite", "IfcProject", "IfcBuilding",
        "IfcFacility", "IfcRailway", "IfcBridge", "IfcRoad",
    ]
    found_val: str | None = None
    found_type: str = "IfcSite"
    for ifc_type in _PROJECT_TYPES:
        try:
            for entity in model.by_type(ifc_type):
                ok, val = _read_param_value(entity, PARAM)
                if ok and val:
                    found_val = val.strip()
                    found_type = entity.is_a()
                    break
        except Exception:
            continue
        if found_val is not None:
            break

    if found_val is None:
        return {
            "status": "fail", "total": 1, "passed": 0, "failed": 1,
            "fail_elements": [{
                "step_id": 0, "name": "Proyecto",
                "type": found_type, "current_value": "(ausente)",
            }],
            "info": f"Parámetro ausente\nEsperado: {expected}",
        }

    # Normalizar para comparación: strip agresivo + case-insensitive
    def _norm(s: str) -> str:
        return s.strip().strip(" ﻿\r\n\t").lower()

    ok     = _norm(found_val) == _norm(expected)
    status = "pass" if ok else "fail"
    info   = (f"{found_val}  ✓" if ok
              else f"Actual:   {found_val}\nEsperado: {expected}")

    return {
        "status": status,
        "total":  1,
        "passed": 1 if ok else 0,
        "failed": 0 if ok else 1,
        "fail_elements": [] if ok else [{
            "step_id": 0, "name": "ADIF_00_Codigo_Archivo",
            "type": found_type, "current_value": found_val,
        }],
        "info": info,
    }


def validate_ifc_against_check(model, check: dict, filename: str, ifc_path: str = "") -> dict:
    """Ejecuta un Check contra un modelo IFC.

    Retorna:
    {
        "status":        "pass" | "fail" | "info" | "skip",
        "total":         int,    # elementos evaluados
        "passed":        int,
        "failed":        int,
        "fail_elements": [{step_id, name, type, current_value}, ...],   # solo los que fallan
        "info":          "..."   # mensaje opcional
    }
    """
    ctype = check["check_type"]
    name_l = check["name"].strip().lower()

    # ── FileName check ────────────────────────────────────────────────────
    if ctype == "FileName":
        ok = _check_filename(filename, check["filename_pattern"])
        return {
            "status": "pass" if ok else "fail",
            "total": 1, "passed": 1 if ok else 0, "failed": 0 if ok else 1,
            "fail_elements": [] if ok else [{
                "step_id": 0, "name": filename, "type": "File",
                "current_value": filename,
            }],
            "info": "" if ok else f"No cumple el patrón: {check['filename_pattern']}",
        }

    # ── ApplicationVersion / RevitVersion (agnóstica de software) ────────────
    # Soporta "RevitVersion" (legado) y "ApplicationVersion" (nuevo, genérico)
    if ctype in ("ApplicationVersion", "RevitVersion"):
        required_year = check.get("options", {}).get("RequiredYear", "2025")
        status, val = _check_application_version(model, required_year)
        ok = status == "pass"
        return {
            "status": status, "total": 1,
            "passed": 1 if ok else 0, "failed": 0 if ok else 1,
            "fail_elements": [] if ok else [{
                "step_id": 0, "name": val, "type": ctype,
                "current_value": val,
            }],
            "info": val,
        }

    # ── FileSize ──────────────────────────────────────────────────────────
    if ctype == "FileSize":
        max_mb = float(check.get("options", {}).get("MaxFileSizeMB", 300))
        status, val = _check_file_size(ifc_path, max_mb)
        ok = status == "pass"
        return {
            "status": status, "total": 1,
            "passed": 1 if ok else 0, "failed": 0 if ok else 1,
            "fail_elements": [] if ok else [{
                "step_id": 0, "name": val, "type": "FileSize",
                "current_value": val,
            }],
            "info": val,
        }

    # ── SharedParametersFile — verifica presencia en IFC ─────────────────
    if ctype == "SharedParametersFile":
        shared_params = check.get("_shared_params", [])
        if not shared_params:
            return {
                "status": "skip", "total": 0, "passed": 0, "failed": 0,
                "fail_elements": [], "info": "Sin archivo de parámetros cargado",
            }
        status, info, missing = _check_shared_params_presence(model, shared_params)
        return {
            "status":        status,
            "total":         len(shared_params),
            "passed":        len(shared_params) - len(missing),
            "failed":        len(missing),
            "fail_elements": missing,
            "info":          info,
        }

    # ── Otros tipos Revit-only / específicos ─────────────────────────────
    if ctype in ("ProjectInformation", "PhaseElements", "ElementIdentityData",
                 "LinkMethod", "Worksets", "ProjectCoordinates",
                 "WarningCount", "PinnedLinks"):
        if ctype == "PhaseElements":
            # Solo Revit: enumera elementos por fase de creación
            return _check_phase_elements(model)
        if ctype == "ElementIdentityData":
            # Solo Revit: valida datos de identidad en elementos
            return _check_element_identity_data(model)
        if ctype == "ProjectCoordinates":
            # Determinar qué tipo de coordenada buscar según el nombre del check
            kind = _GEO_CHECK_MAP.get(name_l, "coords")
            ok, val = _check_georeferencing(model, kind)
            return {
                "status": "info" if ok else "fail",
                "total":  1,
                "passed": 1 if ok else 0,
                "failed": 0 if ok else 1,
                "fail_elements": [] if ok else [{
                    "step_id": 0, "name": check.get("name", ctype),
                    "type": "Georef", "current_value": val,
                }],
                "info": val if ok else val,
            }
        if ctype == "ProjectInformation":
            # Valida info de proyecto contra PocketBase (dwg/rvt_project_defaults)
            return _check_project_information(
                model, check.get("_project_defaults", {})
            )
        if ctype == "Worksets":
            # En IFC verificamos que "Fase de creación" esté asignada en cada elemento
            return _check_fase_creacion(model)
        return {
            "status": "skip", "total": 0, "passed": 0, "failed": 0,
            "fail_elements": [],
            "info": f"Tipo de chequeo no aplica en IFC ({ctype})",
        }

    # ── Custom check ──────────────────────────────────────────────────────
    if ctype == "Custom":
        # Caso especial: georeferenciación (filtra OST_SharedBasePoint)
        if "OST_SharedBasePoint" in check["categories"] or name_l in _GEO_CHECK_MAP:
            kind = _GEO_CHECK_MAP.get(name_l, "coords")
            ok, val = _check_georeferencing(model, kind)
            return {
                "status": "pass" if ok else "fail",
                "total": 1, "passed": 1 if ok else 0, "failed": 0 if ok else 1,
                "fail_elements": [] if ok else [{
                    "step_id": 0, "name": "IfcSite / Context",
                    "type": "Georef", "current_value": val,
                }],
                "info": val if ok else "Coordenadas no definidas en el IFC",
            }

        param = check["param"]
        if not param:
            return {"status": "info", "total": 0, "passed": 0, "failed": 0,
                    "fail_elements": [], "info": "Check sin parámetro definido"}

        # Caso especial: ADIF_00_Codigo_Archivo → verificar contra midp_mapping (PB)
        if param == "ADIF_00_Codigo_Archivo" and check.get("_midp_mapping"):
            return _check_codigo_archivo(model, filename, check["_midp_mapping"])

        # Routing por target de revit_shared_parameters (PocketBase):
        #   "project" → parámetro de información de proyecto (IfcSite/IfcProject)
        #   "element" → parámetro de objeto (comportamiento por defecto)
        _pt: dict = check.get("_param_targets", {})
        if _pt.get(param.lower()) == "project":
            return _check_param_at_project_level(model, param)

        # Caso especial: ADIF_00_Id_Objeto → presencia + unicidad
        if param == "ADIF_00_Id_Objeto":
            _ifc_t = _ifc_types_for_categories(check["categories"]) - _SPATIAL_IFC_TYPES
            if not _ifc_t:
                _ifc_t = {"IfcElement"}   # fallback: todos los elementos físicos
            return _check_id_objeto(model, _ifc_t)

        # Caso especial: parámetro a nivel de proyecto
        if "OST_ProjectInformation" in check["categories"]:
            ok, val = _read_param_value_or_inproject(model, param)
            return {
                "status": "pass" if ok else "fail",
                "total": 1, "passed": 1 if ok else 0, "failed": 0 if ok else 1,
                "fail_elements": [] if ok else [{
                    "step_id": model.by_type("IfcProject")[0].id() if model.by_type("IfcProject") else 0,
                    "name": "ProjectInformation", "type": "IfcProject",
                    "current_value": val,
                }],
                "info": (f"{val}  ✓" if ok and val
                         else "1/1 verificado  ✓" if ok
                         else "Parámetro ausente o vacío"),
            }

        # Caso general: parámetro en elementos de categorías OST_*
        ifc_types = _ifc_types_for_categories(check["categories"])
        # Excluir tipos espaciales/proyecto: no son objetos físicos con parámetros ADIF
        ifc_types -= _SPATIAL_IFC_TYPES
        if not ifc_types:
            return {"status": "skip", "total": 0, "passed": 0, "failed": 0,
                    "fail_elements": [],
                    "info": "Categorías sin mapeo a IFC"}

        elements = []
        for t in ifc_types:
            try:
                elements.extend(model.by_type(t))
            except Exception:
                pass
        # Deduplicar por step_id
        seen: set[int] = set()
        unique = []
        for e in elements:
            try:
                sid = e.id()
            except Exception:
                continue
            if sid in seen:
                continue
            seen.add(sid)
            unique.append(e)

        if not unique:
            return {"status": "skip", "total": 0, "passed": 0, "failed": 0,
                    "fail_elements": [],
                    "info": "No hay elementos de esas categorías en el IFC"}

        fail_list: list[dict] = []
        passed = 0
        type_summary: dict[str, dict] = {}   # {IfcType: {total, failed}}
        for e in unique:
            et = e.is_a()
            if et not in type_summary:
                type_summary[et] = {"total": 0, "failed": 0}
            type_summary[et]["total"] += 1
            ok, val = _read_param_value(e, param)
            if ok:
                passed += 1
            else:
                type_summary[et]["failed"] += 1
                fail_list.append({
                    "step_id":       e.id(),
                    "name":          getattr(e, "Name", "") or "",
                    "type":          et,
                    "current_value": val,
                })
        failed = len(fail_list)
        status = "pass" if failed == 0 else "fail"
        info_str = (f"{passed}/{len(unique)} elementos verificados  ✓"
                    if failed == 0
                    else f"{passed}/{len(unique)} OK  ·  {failed} sin valor")
        return {
            "status": status, "total": len(unique),
            "passed": passed, "failed": failed,
            "fail_elements": fail_list,
            "info": info_str,
            "type_summary": type_summary,
        }

    # Tipo desconocido
    return {"status": "skip", "total": 0, "passed": 0, "failed": 0,
            "fail_elements": [],
            "info": f"Tipo de chequeo no soportado: {ctype}"}


def validate_ifc_file(ifc_path: str, ruleset: dict,
                      shared_param_names: list[str] | None = None,
                      project_defaults: dict | None = None,
                      midp_mapping: dict | None = None,
                      param_targets: dict | None = None) -> dict:
    """Valida un IFC completo contra todos los Checks del ruleset.

    shared_param_names: lista de nombres de parámetros compartidos.
    project_defaults: {"revit": [...], "civil": [...]} de PocketBase.
    midp_mapping: {ifc_name.lower(): native_name_con_ext} de midp_mapping PB.
    param_targets: {param_name.lower(): "project"|"element"} de
                   revit_shared_parameters PB (columna target).

    Retorna jerarquía paralela al ruleset con resultados por check.
    """
    filename = os.path.basename(ifc_path)
    try:
        model = _open_cached(ifc_path)
    except Exception as e:
        return {"error": str(e), "headings": []}

    _sp   = shared_param_names or []
    _pd   = project_defaults or {}
    _midp = midp_mapping or {}
    _pt   = param_targets or {}
    out: dict = {"headings": [], "filename": filename, "error": ""}
    for h in ruleset["headings"]:
        h_out = {"id": h["id"], "title": h["title"], "sections": []}
        for s in h["sections"]:
            s_out = {"id": s["id"], "name": s["name"], "checks": []}
            for c in s["checks"]:
                # Inject shared params into SharedParametersFile checks
                if c.get("check_type") == "SharedParametersFile" and _sp:
                    c = {**c, "_shared_params": _sp}
                # Inject project defaults into ProjectInformation checks
                if c.get("check_type") == "ProjectInformation" and _pd:
                    c = {**c, "_project_defaults": _pd}
                # Inject midp_mapping into Custom ADIF_00_Codigo_Archivo checks
                if (c.get("check_type") == "Custom"
                        and c.get("param") == "ADIF_00_Codigo_Archivo"
                        and _midp):
                    c = {**c, "_midp_mapping": _midp}
                # Inject param_targets into all Custom checks
                if c.get("check_type") == "Custom" and _pt:
                    c = {**c, "_param_targets": _pt}
                result = validate_ifc_against_check(model, c, filename, ifc_path)
                s_out["checks"].append({**c, "result": result})
            h_out["sections"].append(s_out)
        out["headings"].append(h_out)
    return out


def validate_ifcs_aggregate(ifc_paths: list[str], ruleset: dict) -> dict:
    """Valida varios IFCs y agrega los resultados por check.

    Cada check acumula passed/failed/total y fail_elements (con el ifc origen).
    """
    aggregated: dict = {"headings": [], "files": [os.path.basename(p) for p in ifc_paths]}

    # Inicializar estructura vacía paralela al ruleset
    for h in ruleset["headings"]:
        h_out = {"id": h["id"], "title": h["title"], "sections": []}
        for s in h["sections"]:
            s_out = {"id": s["id"], "name": s["name"], "checks": []}
            for c in s["checks"]:
                s_out["checks"].append({
                    **c,
                    "result": {
                        "status": "skip", "total": 0,
                        "passed": 0, "failed": 0,
                        "fail_elements": [], "info": "",
                    },
                })
            h_out["sections"].append(s_out)
        aggregated["headings"].append(h_out)

    # Validar cada IFC y acumular
    for path in ifc_paths:
        try:
            file_result = validate_ifc_file(path, ruleset)
        except Exception as e:
            import sys
            print(f"[ModelChecker] error validando {os.path.basename(path)}: {e}", file=sys.stderr)
            continue
        fname = os.path.basename(path)
        for h_idx, h in enumerate(file_result.get("headings", [])):
            for s_idx, s in enumerate(h["sections"]):
                for c_idx, c in enumerate(s["checks"]):
                    r       = c["result"]
                    agg     = aggregated["headings"][h_idx]["sections"][s_idx]["checks"][c_idx]
                    agg_r   = agg["result"]
                    agg_r["total"]   += r["total"]
                    agg_r["passed"]  += r["passed"]
                    agg_r["failed"]  += r["failed"]
                    # Etiquetar elementos con el archivo de origen
                    for fe in r["fail_elements"]:
                        agg_r["fail_elements"].append({**fe, "ifc_file": fname, "ifc_path": path})
                    # Estado agregado: si algún IFC dio "fail" → fail
                    if r["status"] == "fail":
                        agg_r["status"] = "fail"
                    elif r["status"] == "pass" and agg_r["status"] != "fail":
                        agg_r["status"] = "pass"
                    elif r["status"] == "info" and agg_r["status"] == "skip":
                        agg_r["status"] = "info"

    return aggregated


# ── Corrección inline: setear un valor en un elemento ────────────────────────

def apply_param_fix(ifc_path: str, step_id: int, param_name: str,
                    new_value: str, pset_name: str = "Pset_Common") -> tuple[bool, str]:
    """Setea el parámetro en cualquier PropertySet existente que ya lo contenga.
    Si no existe, lo añade a `pset_name` (o crea el pset si tampoco existe).

    Retorna (ok, mensaje).
    """
    try:
        model = ifcopenshell.open(ifc_path)
        try:
            element = model.by_id(int(step_id))
        except Exception:
            return (False, f"step_id {step_id} no encontrado")
        if not element:
            return (False, f"step_id {step_id} no encontrado")

        # 1) Buscar pset existente con la propiedad
        target_pset = None
        target_prop = None
        target_pset_name = pset_name
        for rel in (element.IsDefinedBy or []):
            if not rel.is_a("IfcRelDefinesByProperties"):
                continue
            pdef = rel.RelatingPropertyDefinition
            if not pdef or not pdef.is_a("IfcPropertySet"):
                continue
            for prop in (pdef.HasProperties or []):
                if getattr(prop, "Name", None) == param_name:
                    target_pset = pdef
                    target_prop = prop
                    target_pset_name = pdef.Name
                    break
            if target_prop:
                break

        # 2) Si la propiedad ya existe → actualizar NominalValue
        if target_prop is not None and target_prop.is_a("IfcPropertySingleValue"):
            existing_nv = target_prop.NominalValue
            type_class = existing_nv.is_a() if existing_nv else "IfcText"
            target_prop.NominalValue = model.create_entity(type_class, new_value)
        elif target_prop is not None:
            # Tipo no soportado para edición rápida
            return (False, f"Tipo de propiedad no editable: {target_prop.is_a()}")
        else:
            # 3) No existe → añadir a un Pset existente con `pset_name`, o crear uno nuevo
            existing_pset = None
            for rel in (element.IsDefinedBy or []):
                if rel.is_a("IfcRelDefinesByProperties"):
                    pdef = rel.RelatingPropertyDefinition
                    if pdef and pdef.is_a("IfcPropertySet") and pdef.Name == pset_name:
                        existing_pset = pdef
                        break
            new_prop = model.create_entity(
                "IfcPropertySingleValue",
                Name=param_name,
                NominalValue=model.create_entity("IfcText", new_value),
            )
            if existing_pset is not None:
                existing_pset.HasProperties = list(existing_pset.HasProperties or []) + [new_prop]
            else:
                # Crear nuevo PropertySet + relación
                owner = element.OwnerHistory
                new_pset = model.create_entity(
                    "IfcPropertySet",
                    GlobalId=ifcopenshell.guid.new(),
                    OwnerHistory=owner, Name=pset_name,
                    HasProperties=[new_prop],
                )
                model.create_entity(
                    "IfcRelDefinesByProperties",
                    GlobalId=ifcopenshell.guid.new(),
                    OwnerHistory=owner,
                    RelatedObjects=[element],
                    RelatingPropertyDefinition=new_pset,
                )

        model.write(ifc_path)
        # Invalidar cache
        _ifc_model_cache.pop(ifc_path, None)
        _ifc_cache_mtime.pop(ifc_path, None)
        return (True, f"Parámetro {param_name} actualizado en {target_pset_name}")
    except Exception as e:
        return (False, str(e))


def apply_param_fix_bulk(items: list[dict], param_name: str, new_value: str,
                         pset_name: str = "Pset_Common") -> tuple[int, int, list[str]]:
    """Aplica el mismo valor a varios elementos agrupados por IFC.
    items: [{ifc_path, step_id}, ...]

    Retorna (ok_count, fail_count, error_messages_list).
    """
    from collections import defaultdict
    by_path: dict = defaultdict(list)
    for it in items:
        by_path[it["ifc_path"]].append(int(it["step_id"]))

    ok_total = 0
    fail_total = 0
    errors: list[str] = []
    for ifc_path, step_ids in by_path.items():
        try:
            model = ifcopenshell.open(ifc_path)
            changed_in_file = 0
            for sid in step_ids:
                try:
                    element = model.by_id(sid)
                except Exception:
                    fail_total += 1
                    continue
                if not element:
                    fail_total += 1
                    continue
                # Reutilizar la lógica de apply_param_fix pero sin re-leer el archivo
                ok, _ = _set_param_on_element(model, element, param_name, new_value, pset_name)
                if ok:
                    ok_total += 1
                    changed_in_file += 1
                else:
                    fail_total += 1
            if changed_in_file:
                model.write(ifc_path)
                _ifc_model_cache.pop(ifc_path, None)
                _ifc_cache_mtime.pop(ifc_path, None)
        except Exception as e:
            errors.append(f"{os.path.basename(ifc_path)}: {e}")
            fail_total += len(step_ids)
    return (ok_total, fail_total, errors)


def _set_param_on_element(model, element, param_name: str, new_value: str,
                          pset_name: str) -> tuple[bool, str]:
    """Helper interno: setea el parámetro sin escribir el archivo (lo hace el caller)."""
    try:
        target_prop = None
        target_pset = None
        for rel in (element.IsDefinedBy or []):
            if not rel.is_a("IfcRelDefinesByProperties"):
                continue
            pdef = rel.RelatingPropertyDefinition
            if not pdef or not pdef.is_a("IfcPropertySet"):
                continue
            for prop in (pdef.HasProperties or []):
                if getattr(prop, "Name", None) == param_name:
                    target_prop = prop
                    target_pset = pdef
                    break
            if target_prop:
                break

        if target_prop is not None and target_prop.is_a("IfcPropertySingleValue"):
            existing_nv = target_prop.NominalValue
            type_class = existing_nv.is_a() if existing_nv else "IfcText"
            target_prop.NominalValue = model.create_entity(type_class, new_value)
            return (True, "")

        # Crear nueva propiedad
        existing_pset = None
        for rel in (element.IsDefinedBy or []):
            if rel.is_a("IfcRelDefinesByProperties"):
                pdef = rel.RelatingPropertyDefinition
                if pdef and pdef.is_a("IfcPropertySet") and pdef.Name == pset_name:
                    existing_pset = pdef
                    break
        new_prop = model.create_entity(
            "IfcPropertySingleValue",
            Name=param_name,
            NominalValue=model.create_entity("IfcText", new_value),
        )
        if existing_pset is not None:
            existing_pset.HasProperties = list(existing_pset.HasProperties or []) + [new_prop]
        else:
            owner = element.OwnerHistory
            new_pset = model.create_entity(
                "IfcPropertySet",
                GlobalId=ifcopenshell.guid.new(),
                OwnerHistory=owner, Name=pset_name,
                HasProperties=[new_prop],
            )
            model.create_entity(
                "IfcRelDefinesByProperties",
                GlobalId=ifcopenshell.guid.new(),
                OwnerHistory=owner,
                RelatedObjects=[element],
                RelatingPropertyDefinition=new_pset,
            )
        return (True, "")
    except Exception as e:
        return (False, str(e))
