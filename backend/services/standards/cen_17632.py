"""Auditoría EN 17632-1 (CEN/TC 442) — BIM Information Delivery Specifications.

Checks de alto nivel sobre completitud de información de proyecto y trazabilidad
de propiedades hacia plantillas de datos (PDT) y bSDD.

  PRJ  — IfcProject con Name, LongName, Phase
  IDS  — IfcRoot.Name no vacío en elementos significativos
  BSDD — referencias externas (IfcExternalReference) hacia diccionarios de datos
  DOC  — IfcDocumentReference / IfcDocumentInformation presentes
"""
from __future__ import annotations

from .common import (
    CheckResult, collect_samples,
    STD_EN17632, SEV_INFO, SEV_WARN,
)


def _safe_by_type(ifc, t: str) -> list:
    try:
        return list(ifc.by_type(t))
    except Exception:
        return []


def _check_project_info(ifc) -> CheckResult:
    projects = _safe_by_type(ifc, "IfcProject")
    if not projects:
        return CheckResult(
            standard=STD_EN17632, category="ProjectInfo",
            rule_id="EN.PRJ.001",
            title="IfcProject con Name, LongName y Phase",
            severity=SEV_WARN, passed=False, issue_count=1,
            detail="Sin IfcProject",
        )
    p = projects[0]
    miss = []
    if not (getattr(p, "Name", "") or "").strip():     miss.append("Name")
    if not (getattr(p, "LongName", "") or "").strip(): miss.append("LongName")
    if not (getattr(p, "Phase", "") or "").strip():    miss.append("Phase")
    ok = not miss
    return CheckResult(
        standard=STD_EN17632, category="ProjectInfo",
        rule_id="EN.PRJ.001",
        title="IfcProject con Name, LongName y Phase",
        severity=SEV_WARN if not ok else SEV_INFO,
        passed=ok, issue_count=len(miss),
        detail=("Faltan: " + ", ".join(miss)) if miss else "Project info completo",
    )


def _check_element_names(ifc) -> CheckResult:
    """Elementos relevantes con Name no vacío (trazabilidad PDT)."""
    relevant = []
    for t in ("IfcWall", "IfcSlab", "IfcColumn", "IfcBeam", "IfcDoor",
              "IfcWindow", "IfcRoof", "IfcFooting", "IfcCovering",
              "IfcAlignment", "IfcRailway", "IfcTrack", "IfcSignal"):
        relevant.extend(_safe_by_type(ifc, t))
    if not relevant:
        return CheckResult(
            standard=STD_EN17632, category="Naming",
            rule_id="EN.IDS.001",
            title="Elementos relevantes con Name no vacío",
            severity=SEV_INFO, passed=True, issue_count=0,
            detail="N/A",
        )
    no_name = [e for e in relevant if not (getattr(e, "Name", "") or "").strip()]
    ok = not no_name
    return CheckResult(
        standard=STD_EN17632, category="Naming",
        rule_id="EN.IDS.001",
        title="Elementos relevantes con Name no vacío (trazabilidad PDT)",
        severity=SEV_WARN if not ok else SEV_INFO,
        passed=ok, issue_count=len(no_name),
        sample_ids=collect_samples(no_name),
        detail=f"{len(no_name)} de {len(relevant)} elementos sin Name",
    )


def _check_bsdd_refs(ifc) -> CheckResult:
    """Referencias externas a diccionarios de datos (bSDD u otros)."""
    refs = _safe_by_type(ifc, "IfcExternalReference")
    libs = _safe_by_type(ifc, "IfcLibraryReference")
    bsdd_hint = False
    for r in refs + libs:
        loc = (getattr(r, "Location", "") or "").lower()
        if "bsdd" in loc or "buildingsmart" in loc or "ifcclass" in loc:
            bsdd_hint = True; break
    if not refs and not libs:
        return CheckResult(
            standard=STD_EN17632, category="DataDictionary",
            rule_id="EN.BSDD.001",
            title="Referencias a diccionario de datos (bSDD u otro)",
            severity=SEV_WARN, passed=False, issue_count=1,
            detail="Sin IfcExternalReference / IfcLibraryReference",
        )
    return CheckResult(
        standard=STD_EN17632, category="DataDictionary",
        rule_id="EN.BSDD.001",
        title="Referencias a diccionario de datos (bSDD recomendable)",
        severity=SEV_INFO if bsdd_hint else SEV_WARN,
        passed=bsdd_hint,
        issue_count=0 if bsdd_hint else 1,
        detail=f"ExtRef={len(refs)} · LibRef={len(libs)} · bSDD detectado={bsdd_hint}",
    )


def _check_documents(ifc) -> CheckResult:
    docs = _safe_by_type(ifc, "IfcDocumentInformation") + \
           _safe_by_type(ifc, "IfcDocumentReference")
    ok = bool(docs)
    return CheckResult(
        standard=STD_EN17632, category="Documents",
        rule_id="EN.DOC.001",
        title="IfcDocumentReference/Information para trazabilidad documental",
        severity=SEV_INFO if ok else SEV_WARN,
        passed=ok, issue_count=0 if ok else 1,
        detail=f"Documentos referenciados: {len(docs)}",
    )


def run(ifc, author: str) -> list[CheckResult]:
    results = [
        _check_project_info(ifc),
        _check_element_names(ifc),
        _check_bsdd_refs(ifc),
        _check_documents(ifc),
    ]
    for r in results:
        r.source_hint = author
    return results
