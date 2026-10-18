"""Auditoría ISO 19148 — Linear Referencing aplicado a IfcAlignment.

Checks:
  CONT — continuidad: IfcAlignment con ≥1 segmento horizontal y vertical
  STAT — stationing monotónico (StartDistAlong creciente)
  SEG  — gaps entre segmentos (StartDistAlong[n+1] == StartDistAlong[n]+SegmentLength[n])
  LRS  — declaración de sistema de referencia lineal
"""
from __future__ import annotations

from .common import (
    CheckResult, collect_samples,
    STD_LR, SEV_INFO, SEV_WARN, SEV_ERROR,
)

_TOL_M = 0.001   # 1 mm — tolerancia para continuidad de stations


def _safe_by_type(ifc, t: str) -> list:
    try:
        return list(ifc.by_type(t))
    except Exception:
        return []


def _get_segments(parent, kind: str) -> list:
    """Devuelve los IfcAlignmentSegment hijos del padre dado (Horizontal/Vertical/Cant)."""
    out = []
    try:
        for rel in getattr(parent, "IsNestedBy", []) or []:
            for child in getattr(rel, "RelatedObjects", []) or []:
                if child.is_a("IfcAlignmentSegment"):
                    out.append(child)
    except Exception:
        pass
    return out


def _seg_props(seg):
    """Extrae StartDistAlong y SegmentLength de un IfcAlignmentSegment."""
    try:
        ds = getattr(seg, "DesignParameters", None)
        if ds is None:
            return None, None
        sd = getattr(ds, "StartDistAlong", None)
        sl = getattr(ds, "SegmentLength", None)
        return (float(sd) if sd is not None else None,
                float(sl) if sl is not None else None)
    except Exception:
        return None, None


def _check_continuity(ifc) -> CheckResult:
    """Cada alineación tiene segmentos no vacíos en horizontal+vertical."""
    aligns = _safe_by_type(ifc, "IfcAlignment")
    if not aligns:
        return CheckResult(
            standard=STD_LR, category="Continuity",
            rule_id="LR.CONT.001",
            title="Alineaciones con segmentos en Horizontal y Vertical",
            severity=SEV_INFO, passed=True, issue_count=0,
            detail="Sin IfcAlignment — check no aplica",
        )
    bad = []
    for a in aligns:
        h = v = None
        for rel in getattr(a, "IsNestedBy", []) or []:
            for child in getattr(rel, "RelatedObjects", []) or []:
                if child.is_a("IfcAlignmentHorizontal"): h = child
                if child.is_a("IfcAlignmentVertical"):   v = child
        h_segs = _get_segments(h, "H") if h else []
        v_segs = _get_segments(v, "V") if v else []
        if not h_segs or not v_segs:
            bad.append(a)
    ok = not bad
    return CheckResult(
        standard=STD_LR, category="Continuity",
        rule_id="LR.CONT.001",
        title="Alineaciones con segmentos en Horizontal y Vertical",
        severity=SEV_ERROR if not ok else SEV_INFO,
        passed=ok, issue_count=len(bad),
        sample_ids=collect_samples(bad),
        detail=f"{len(bad)} de {len(aligns)} alineaciones sin segmentos H/V",
    )


def _check_stationing(ifc) -> CheckResult:
    """StartDistAlong monotónico creciente en horizontal."""
    aligns = _safe_by_type(ifc, "IfcAlignment")
    bad = []
    total_aligns_checked = 0
    for a in aligns:
        h = None
        for rel in getattr(a, "IsNestedBy", []) or []:
            for child in getattr(rel, "RelatedObjects", []) or []:
                if child.is_a("IfcAlignmentHorizontal"):
                    h = child; break
        if not h:
            continue
        segs = _get_segments(h, "H")
        if len(segs) < 2:
            continue
        total_aligns_checked += 1
        prev_start = None
        non_monotonic = False
        for s in segs:
            sd, _ = _seg_props(s)
            if sd is None:
                continue
            if prev_start is not None and sd < prev_start - _TOL_M:
                non_monotonic = True
                break
            prev_start = sd
        if non_monotonic:
            bad.append(a)
    ok = not bad
    if total_aligns_checked == 0:
        return CheckResult(
            standard=STD_LR, category="Stationing",
            rule_id="LR.STAT.001",
            title="Stationing monotónico creciente",
            severity=SEV_INFO, passed=True, issue_count=0,
            detail="Sin alineaciones con ≥2 segmentos horizontales — N/A",
        )
    return CheckResult(
        standard=STD_LR, category="Stationing",
        rule_id="LR.STAT.001",
        title="Stationing monotónico creciente en horizontal",
        severity=SEV_ERROR if not ok else SEV_INFO,
        passed=ok, issue_count=len(bad),
        sample_ids=collect_samples(bad),
        detail=f"{len(bad)} de {total_aligns_checked} alineaciones con stations no monotónicos",
    )


def _check_segment_continuity(ifc) -> CheckResult:
    """Sin gaps: StartDistAlong[n+1] == StartDistAlong[n] + SegmentLength[n]."""
    aligns = _safe_by_type(ifc, "IfcAlignment")
    bad = []
    gap_count = 0
    total_aligns_checked = 0
    for a in aligns:
        h = None
        for rel in getattr(a, "IsNestedBy", []) or []:
            for child in getattr(rel, "RelatedObjects", []) or []:
                if child.is_a("IfcAlignmentHorizontal"):
                    h = child; break
        if not h:
            continue
        segs = _get_segments(h, "H")
        if len(segs) < 2:
            continue
        total_aligns_checked += 1
        align_has_gap = False
        for i in range(len(segs) - 1):
            s1, l1 = _seg_props(segs[i])
            s2, _  = _seg_props(segs[i + 1])
            if s1 is None or l1 is None or s2 is None:
                continue
            expected = s1 + l1
            if abs(expected - s2) > _TOL_M:
                gap_count += 1
                align_has_gap = True
        if align_has_gap:
            bad.append(a)
    ok = not bad
    if total_aligns_checked == 0:
        return CheckResult(
            standard=STD_LR, category="SegmentContinuity",
            rule_id="LR.SEG.001",
            title="Continuidad geométrica entre segmentos (sin gaps)",
            severity=SEV_INFO, passed=True, issue_count=0,
            detail="N/A — no hay alineaciones con ≥2 segmentos",
        )
    return CheckResult(
        standard=STD_LR, category="SegmentContinuity",
        rule_id="LR.SEG.001",
        title="Continuidad geométrica entre segmentos (sin gaps)",
        severity=SEV_ERROR if not ok else SEV_INFO,
        passed=ok, issue_count=gap_count,
        sample_ids=collect_samples(bad),
        detail=f"{gap_count} gaps detectados en {len(bad)} alineaciones (tol 1 mm)",
    )


def _check_lrs_declared(ifc) -> CheckResult:
    """LRS — IfcReferent o stationing inicial declarado."""
    referents = _safe_by_type(ifc, "IfcReferent")
    aligns = _safe_by_type(ifc, "IfcAlignment")
    if not aligns:
        return CheckResult(
            standard=STD_LR, category="LRS",
            rule_id="LR.LRS.001",
            title="Sistema de referencia lineal declarado (IfcReferent / PKs)",
            severity=SEV_INFO, passed=True, issue_count=0,
            detail="Sin alineaciones — N/A",
        )
    ok = bool(referents)
    return CheckResult(
        standard=STD_LR, category="LRS",
        rule_id="LR.LRS.001",
        title="Sistema de referencia lineal declarado (IfcReferent / PKs)",
        severity=SEV_WARN if not ok else SEV_INFO,
        passed=ok, issue_count=0 if ok else 1,
        detail=f"IfcReferent: {len(referents)} · IfcAlignment: {len(aligns)}",
    )


def run(ifc, author: str) -> list[CheckResult]:
    results = [
        _check_continuity(ifc),
        _check_stationing(ifc),
        _check_segment_continuity(ifc),
        _check_lrs_declared(ifc),
    ]
    for r in results:
        r.source_hint = author
    return results
