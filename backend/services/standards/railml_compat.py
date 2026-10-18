"""Compatibilidad con railML 3.x.

railML usa XML con conceptos de net (nodos/aristas), tracks con mileage,
y elementos sobre la topología. Estos checks comprueban si la información
mínima del IFC es traducible a un dataset railML coherente.

  ALIGN — IfcAlignment con datos suficientes para <track> railML
  MILE  — Stationing/mileage referenciado (clave para railML <mileageChange>)
  NET   — Topología nodo-arista deducible (IfcReferent + IfcAlignment)
  NAME  — Alineaciones con Name único (ID railML)
"""
from __future__ import annotations

from .common import (
    CheckResult, collect_samples,
    STD_RAILML, SEV_INFO, SEV_WARN,
)


def _safe_by_type(ifc, t: str) -> list:
    try:
        return list(ifc.by_type(t))
    except Exception:
        return []


def _check_alignment_for_track(ifc) -> CheckResult:
    aligns = _safe_by_type(ifc, "IfcAlignment")
    if not aligns:
        return CheckResult(
            standard=STD_RAILML, category="Alignment",
            rule_id="RML.ALIGN.001",
            title="Alineaciones exportables a <track> railML",
            severity=SEV_WARN, passed=False, issue_count=1,
            detail="Sin IfcAlignment — no hay tracks que exportar a railML",
        )
    bad = []
    for a in aligns:
        has_h = False
        for rel in getattr(a, "IsNestedBy", []) or []:
            for child in getattr(rel, "RelatedObjects", []) or []:
                if child.is_a("IfcAlignmentHorizontal"):
                    has_h = True; break
        if not has_h:
            bad.append(a)
    ok = not bad
    return CheckResult(
        standard=STD_RAILML, category="Alignment",
        rule_id="RML.ALIGN.001",
        title="Alineaciones exportables a <track> railML (con horizontal)",
        severity=SEV_WARN if not ok else SEV_INFO,
        passed=ok, issue_count=len(bad),
        sample_ids=collect_samples(bad),
        detail=f"{len(bad)} de {len(aligns)} alineaciones sin geometría horizontal",
    )


def _check_mileage(ifc) -> CheckResult:
    referents = _safe_by_type(ifc, "IfcReferent")
    ok = bool(referents)
    return CheckResult(
        standard=STD_RAILML, category="Mileage",
        rule_id="RML.MILE.001",
        title="Mileage/PKs referenciados (IfcReferent → railML <mileageChange>)",
        severity=SEV_WARN if not ok else SEV_INFO,
        passed=ok, issue_count=0 if ok else 1,
        detail=f"IfcReferent declarados: {len(referents)}",
    )


def _check_alignment_names(ifc) -> CheckResult:
    """Cada alineación con Name único = candidato a `id` railML estable."""
    aligns = _safe_by_type(ifc, "IfcAlignment")
    if not aligns:
        return CheckResult(
            standard=STD_RAILML, category="Identifier",
            rule_id="RML.NAME.001",
            title="Alineaciones con Name único (ID railML estable)",
            severity=SEV_INFO, passed=True, issue_count=0,
            detail="N/A",
        )
    names = {}
    no_name = []
    for a in aligns:
        n = getattr(a, "Name", "") or ""
        if not n:
            no_name.append(a)
        else:
            names.setdefault(n, []).append(a)
    dup_groups = {k: v for k, v in names.items() if len(v) > 1}
    bad = list(no_name)
    for v in dup_groups.values():
        bad.extend(v)
    ok = not bad
    return CheckResult(
        standard=STD_RAILML, category="Identifier",
        rule_id="RML.NAME.001",
        title="Alineaciones con Name único (ID railML estable)",
        severity=SEV_WARN if not ok else SEV_INFO,
        passed=ok, issue_count=len(bad),
        sample_ids=collect_samples(bad),
        detail=f"sin Name: {len(no_name)} · nombres duplicados: {len(dup_groups)}",
    )


def _check_net_topology(ifc) -> CheckResult:
    """railML <net> requiere nodos topológicos: IfcReferent + alineaciones referenciadas."""
    aligns    = _safe_by_type(ifc, "IfcAlignment")
    referents = _safe_by_type(ifc, "IfcReferent")
    if not aligns:
        return CheckResult(
            standard=STD_RAILML, category="NetTopology",
            rule_id="RML.NET.001",
            title="Topología nodo-arista reconstruible para railML <net>",
            severity=SEV_INFO, passed=True, issue_count=0,
            detail="N/A",
        )
    ok = bool(referents) and len(referents) >= 2
    return CheckResult(
        standard=STD_RAILML, category="NetTopology",
        rule_id="RML.NET.001",
        title="Topología nodo-arista reconstruible (≥2 IfcReferent)",
        severity=SEV_WARN if not ok else SEV_INFO,
        passed=ok, issue_count=0 if ok else 1,
        detail=f"{len(aligns)} alineaciones · {len(referents)} referents — railML requiere nodos",
    )


def run(ifc, author: str) -> list[CheckResult]:
    results = [
        _check_alignment_for_track(ifc),
        _check_mileage(ifc),
        _check_alignment_names(ifc),
        _check_net_topology(ifc),
    ]
    for r in results:
        r.source_hint = author
    return results
