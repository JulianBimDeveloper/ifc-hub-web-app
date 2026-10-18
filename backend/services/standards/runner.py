"""Orquestador del audit — abre el IFC una vez y ejecuta los módulos habilitados.

API principal:
    scan_single_file(path, options) -> dict
    aggregate_report(per_file_results) -> dict
"""
from __future__ import annotations

from pathlib import Path

try:
    import ifcopenshell
    _IOS_OK = True
except ImportError:
    _IOS_OK = False

from . import (
    schema_ifc4x3, rail, linear_referencing, railml_compat, cen_17632,
    recommendations,
)
from .common import (
    CheckResult, detect_author, detect_app_info, score_from_results,
    STD_IFC4X3, STD_RAIL, STD_LR, STD_RAILML, STD_EN17632,
    STANDARDS, STANDARD_LABELS,
    SEV_INFO, SEV_WARN, SEV_ERROR,
)


_MODULES = {
    STD_IFC4X3:  schema_ifc4x3,
    STD_RAIL:    rail,
    STD_LR:      linear_referencing,
    STD_RAILML:  railml_compat,
    STD_EN17632: cen_17632,
}


def _default_options() -> dict:
    return {std: True for std in STANDARDS}


def scan_single_file(ifc_path: str, options: dict | None = None) -> dict:
    """Ejecuta los checks habilitados sobre un IFC. Nunca lanza."""
    fname = Path(ifc_path).name
    opts = options or _default_options()
    report: dict = {
        "file":            fname,
        "path":            ifc_path,
        "author":          "GENERIC",
        "app_version":     "",
        "schema":          "",
        "results":         [],          # list[dict] (CheckResult.to_dict)
        "improvement_plan":[],
        "score_global":    0,
        "score_by_standard": {},
        "issues_by_severity": {SEV_INFO: 0, SEV_WARN: 0, SEV_ERROR: 0},
        "error":           "",
    }
    if not _IOS_OK:
        report["error"] = "ifcopenshell no disponible"
        return report
    try:
        ifc = ifcopenshell.open(ifc_path)
    except Exception as e:
        report["error"] = f"No se pudo abrir el IFC: {str(e)[:160]}"
        return report

    app_info = detect_app_info(ifc)
    author = app_info["author"]
    app_version = app_info["version"]
    report["author"] = author
    report["app_version"] = app_version
    report["schema"] = getattr(ifc, "schema", "") or ""

    all_results: list[CheckResult] = []
    score_by_std: dict[str, int] = {}

    for std in STANDARDS:
        if not opts.get(std, True):
            continue
        mod = _MODULES[std]
        try:
            res = mod.run(ifc, author) or []
        except Exception as e:
            res = [CheckResult(
                standard=std, category="Runner",
                rule_id=f"{std}.RUN.000",
                title=f"Fallo interno al ejecutar checks de {STANDARD_LABELS[std]}",
                severity=SEV_ERROR, passed=False, issue_count=1,
                detail=f"{type(e).__name__}: {str(e)[:160]}",
                source_hint=author,
            )]
        all_results.extend(res)
        score_by_std[std] = score_from_results(res)

    recommendations.enrich(all_results, app_version=app_version)

    # Conteo por severidad (sólo de checks que fallan)
    sev_counts = {SEV_INFO: 0, SEV_WARN: 0, SEV_ERROR: 0}
    for r in all_results:
        if not r.passed:
            sev_counts[r.severity] = sev_counts.get(r.severity, 0) + 1

    report["results"]            = [r.to_dict() for r in all_results]
    report["improvement_plan"]   = recommendations.build_improvement_plan(all_results, top_n=10)
    report["score_global"]       = score_from_results(all_results)
    report["score_by_standard"]  = score_by_std
    report["issues_by_severity"] = sev_counts
    return report


def aggregate_report(per_file: list[dict]) -> dict:
    """Combina los reportes por archivo en un agregado global para KPIs."""
    if not per_file:
        return {
            "files": 0,
            "score_global": 0,
            "score_by_standard": {s: 0 for s in STANDARDS},
            "issues_by_severity": {SEV_INFO: 0, SEV_WARN: 0, SEV_ERROR: 0},
            "improvement_plan": [],
        }
    n = len(per_file)
    score_global = round(sum(p.get("score_global", 0) for p in per_file) / n)
    score_by_std: dict[str, int] = {}
    for s in STANDARDS:
        vals = [p["score_by_standard"].get(s) for p in per_file if s in p.get("score_by_standard", {})]
        score_by_std[s] = round(sum(vals) / len(vals)) if vals else 0
    sev_counts = {SEV_INFO: 0, SEV_WARN: 0, SEV_ERROR: 0}
    for p in per_file:
        for k, v in p.get("issues_by_severity", {}).items():
            sev_counts[k] = sev_counts.get(k, 0) + v
    # Plan global: combinar todos los improvement_plan y reordenar por impacto
    flat_plan = []
    for p in per_file:
        for it in p.get("improvement_plan", []):
            flat_plan.append({**it, "file": p["file"]})
    flat_plan.sort(key=lambda x: x.get("impact", 0), reverse=True)
    return {
        "files": n,
        "score_global": score_global,
        "score_by_standard": score_by_std,
        "issues_by_severity": sev_counts,
        "improvement_plan": flat_plan[:20],
    }
