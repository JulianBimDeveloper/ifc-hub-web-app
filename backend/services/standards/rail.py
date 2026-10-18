"""Auditoría IFC Rail (dominio ferroviario de IFC 4x3).

Checks:
  ENT    — presencia de entidades rail (IfcRailway, IfcRail, IfcTrack…)
  ALIGN  — IfcAlignment con horizontal + vertical (cant opcional)
  TRK    — anchura de vía declarada (track gauge)
  SIG    — señalización: IfcSignal posicionado
  OCS    — electrificación: IfcDistributionSystem para catenaria
  ZONE   — IfcSpatialZone para corredores/plataformas
"""
from __future__ import annotations

from .common import (
    CheckResult, collect_samples,
    STD_RAIL, SEV_INFO, SEV_WARN, SEV_ERROR,
)


_RAIL_ENTITIES = [
    "IfcRailway", "IfcRail", "IfcTrack", "IfcSignal",
    "IfcRailwayPart",
]


def _safe_by_type(ifc, t: str) -> list:
    try:
        return list(ifc.by_type(t))
    except Exception:
        return []


def _check_rail_presence(ifc) -> CheckResult:
    """Hay al menos una entidad de dominio ferroviario."""
    counts = {t: len(_safe_by_type(ifc, t)) for t in _RAIL_ENTITIES}
    total = sum(counts.values())
    ok = total > 0
    detail = " · ".join(f"{t.replace('Ifc',''):<12}={n}" for t, n in counts.items())
    return CheckResult(
        standard=STD_RAIL, category="Entities",
        rule_id="RAIL.ENT.001",
        title="Presencia de entidades de dominio rail",
        severity=SEV_WARN if not ok else SEV_INFO,
        passed=ok, issue_count=0 if ok else 1,
        detail=detail,
    )


def _check_alignment_completeness(ifc) -> CheckResult:
    """Cada IfcAlignment debe tener Horizontal y Vertical (Cant es opcional)."""
    aligns = _safe_by_type(ifc, "IfcAlignment")
    if not aligns:
        return CheckResult(
            standard=STD_RAIL, category="Alignment",
            rule_id="RAIL.ALIGN.001",
            title="IfcAlignment con Horizontal + Vertical",
            severity=SEV_ERROR, passed=False, issue_count=1,
            detail="No hay ningún IfcAlignment en el modelo",
        )
    bad = []
    miss_h = miss_v = miss_c = 0
    for a in aligns:
        has_h = has_v = has_c = False
        try:
            for rel in getattr(a, "IsNestedBy", []) or []:
                for child in getattr(rel, "RelatedObjects", []) or []:
                    if child.is_a("IfcAlignmentHorizontal"): has_h = True
                    if child.is_a("IfcAlignmentVertical"):   has_v = True
                    if child.is_a("IfcAlignmentCant"):       has_c = True
        except Exception:
            pass
        # Fallback: relaciones directas (algunos exporters)
        try:
            if not (has_h and has_v):
                for attr in ("Horizontal", "Vertical", "Cant"):
                    v = getattr(a, attr, None)
                    if v is not None:
                        if attr == "Horizontal": has_h = True
                        if attr == "Vertical":   has_v = True
                        if attr == "Cant":       has_c = True
        except Exception:
            pass
        if not has_h: miss_h += 1
        if not has_v: miss_v += 1
        if not has_c: miss_c += 1
        if not (has_h and has_v):
            bad.append(a)
    ok = not bad
    return CheckResult(
        standard=STD_RAIL, category="Alignment",
        rule_id="RAIL.ALIGN.001",
        title="IfcAlignment con Horizontal + Vertical (Cant opcional)",
        severity=SEV_ERROR if not ok else SEV_INFO,
        passed=ok, issue_count=len(bad),
        sample_ids=collect_samples(bad),
        detail=f"{len(aligns)} alineaciones · sin H={miss_h} · sin V={miss_v} · sin Cant={miss_c}",
    )


def _check_track_gauge(ifc) -> CheckResult:
    """IfcTrack/IfcRail con Pset_TrackCommon.Gauge."""
    tracks = _safe_by_type(ifc, "IfcTrack") + _safe_by_type(ifc, "IfcRail")
    if not tracks:
        return CheckResult(
            standard=STD_RAIL, category="Track",
            rule_id="RAIL.TRK.001",
            title="Track gauge declarado (Pset_TrackCommon.Gauge)",
            severity=SEV_INFO, passed=True, issue_count=0,
            detail="Sin IfcTrack/IfcRail — check no aplica",
        )
    missing = []
    for t in tracks:
        found = False
        try:
            for rel in getattr(t, "IsDefinedBy", []) or []:
                if rel.is_a("IfcRelDefinesByProperties"):
                    ps = getattr(rel, "RelatingPropertyDefinition", None)
                    if ps and ps.is_a("IfcPropertySet"):
                        if (getattr(ps, "Name", "") or "") in ("Pset_TrackCommon", "Pset_RailCommon"):
                            for p in getattr(ps, "HasProperties", []) or []:
                                if (getattr(p, "Name", "") or "").lower() == "gauge":
                                    found = True
                                    break
                if found: break
        except Exception:
            pass
        if not found:
            missing.append(t)
    ok = not missing
    return CheckResult(
        standard=STD_RAIL, category="Track",
        rule_id="RAIL.TRK.001",
        title="Track gauge declarado en Pset_TrackCommon/Pset_RailCommon",
        severity=SEV_WARN if not ok else SEV_INFO,
        passed=ok, issue_count=len(missing),
        sample_ids=collect_samples(missing),
        detail=f"{len(missing)} de {len(tracks)} vías sin Gauge declarado",
    )


def _check_signals(ifc) -> CheckResult:
    """IfcSignal con ObjectPlacement (referenciado a alineación)."""
    signals = _safe_by_type(ifc, "IfcSignal")
    if not signals:
        return CheckResult(
            standard=STD_RAIL, category="Signalling",
            rule_id="RAIL.SIG.001",
            title="IfcSignal con posición declarada",
            severity=SEV_INFO, passed=True, issue_count=0,
            detail="Sin IfcSignal — check no aplica",
        )
    unplaced = [s for s in signals if not getattr(s, "ObjectPlacement", None)]
    ok = not unplaced
    return CheckResult(
        standard=STD_RAIL, category="Signalling",
        rule_id="RAIL.SIG.001",
        title="IfcSignal con ObjectPlacement",
        severity=SEV_WARN if not ok else SEV_INFO,
        passed=ok, issue_count=len(unplaced),
        sample_ids=collect_samples(unplaced),
        detail=f"{len(unplaced)} de {len(signals)} señales sin posicionamiento",
    )


def _check_ocs(ifc) -> CheckResult:
    """Sistema de electrificación (catenaria) declarado."""
    systems = _safe_by_type(ifc, "IfcDistributionSystem")
    has_ocs = False
    for s in systems:
        ptype = getattr(s, "PredefinedType", "") or ""
        name  = (getattr(s, "Name", "") or "").lower()
        if "ELECTRICAL" in str(ptype).upper() or "catenaria" in name or "ocs" in name or "traccion" in name:
            has_ocs = True
            break
    # Si no hay ninguna distribución, no penalizamos (puede ser modelo no-eléctrico)
    if not systems:
        return CheckResult(
            standard=STD_RAIL, category="Electrification",
            rule_id="RAIL.OCS.001",
            title="Sistema de electrificación (OCS) declarado si aplica",
            severity=SEV_INFO, passed=True, issue_count=0,
            detail="Sin IfcDistributionSystem — check informativo",
        )
    return CheckResult(
        standard=STD_RAIL, category="Electrification",
        rule_id="RAIL.OCS.001",
        title="Sistema de electrificación (OCS) declarado",
        severity=SEV_INFO if has_ocs else SEV_WARN,
        passed=has_ocs, issue_count=0 if has_ocs else 1,
        detail=f"{len(systems)} IfcDistributionSystem · OCS detectado={has_ocs}",
    )


def _check_spatial_zone(ifc) -> CheckResult:
    """IfcSpatialZone usado para corredores/plataformas."""
    zones = _safe_by_type(ifc, "IfcSpatialZone")
    return CheckResult(
        standard=STD_RAIL, category="SpatialZone",
        rule_id="RAIL.ZONE.001",
        title="IfcSpatialZone para corredores/plataformas/zonas funcionales",
        severity=SEV_INFO,
        passed=bool(zones),
        issue_count=0 if zones else 1,
        detail=f"{len(zones)} IfcSpatialZone declaradas"
               + ("" if zones else " — recomendable para zonificación ADIF"),
    )


def run(ifc, author: str) -> list[CheckResult]:
    results = [
        _check_rail_presence(ifc),
        _check_alignment_completeness(ifc),
        _check_track_gauge(ifc),
        _check_signals(ifc),
        _check_ocs(ifc),
        _check_spatial_zone(ifc),
    ]
    for r in results:
        r.source_hint = author
    return results
