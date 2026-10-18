"""Tipos y utilidades comunes para los módulos de auditoría de estándares.

Diseñado para ser ligero (sin dependencias fuera de ifcopenshell) y agnóstico
del transporte: cada `run()` devuelve `list[CheckResult]` que el runner
serializa a dicts para Reflex.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Optional


# ── Códigos de norma ─────────────────────────────────────────────────────────
STD_IFC4X3   = "IFC4X3"
STD_RAIL     = "IFC_RAIL"
STD_LR       = "ISO_19148"
STD_RAILML   = "RAILML"
STD_EN17632  = "EN_17632"

STANDARDS = [STD_IFC4X3, STD_RAIL, STD_LR, STD_RAILML, STD_EN17632]

STANDARD_LABELS = {
    STD_IFC4X3:  "IFC 4x3 / ISO 16739-1",
    STD_RAIL:    "IFC Rail",
    STD_LR:      "ISO 19148 (Linear Ref.)",
    STD_RAILML:  "railML 3.x compat.",
    STD_EN17632: "EN 17632 / CEN TC 442",
}

# Colores por norma (alineados con theme.py)
STANDARD_COLORS = {
    STD_IFC4X3:  "#00f0ff",   # CYAN
    STD_RAIL:    "#aa88ff",   # VIOLET
    STD_LR:      "#ff9900",   # ORANGE
    STD_RAILML:  "#39ff14",   # GREEN
    STD_EN17632: "#ffff00",   # YELLOW
}

# ── Severidades ──────────────────────────────────────────────────────────────
SEV_INFO  = "info"
SEV_WARN  = "warn"
SEV_ERROR = "error"
SEVERITIES = [SEV_INFO, SEV_WARN, SEV_ERROR]

SEVERITY_WEIGHTS = {SEV_INFO: 1, SEV_WARN: 3, SEV_ERROR: 10}

# ── Origen / autor ───────────────────────────────────────────────────────────
AUTHOR_REVIT   = "REVIT"
AUTHOR_CIVIL3D = "CIVIL3D"
AUTHOR_GENERIC = "GENERIC"


# ── Modelo de resultado ──────────────────────────────────────────────────────

@dataclass
class CheckResult:
    """Resultado de un check individual sobre un archivo IFC."""
    standard:       str
    category:       str
    rule_id:        str
    title:          str
    severity:       str
    passed:         bool
    issue_count:    int = 0
    sample_ids:     list[str] = field(default_factory=list)
    detail:         str = ""
    recommendation: str = ""
    source_hint:    str = AUTHOR_GENERIC

    def to_dict(self) -> dict:
        d = asdict(self)
        # Limitar samples a 10 (cap definido en el plan)
        d["sample_ids"] = list(self.sample_ids)[:10]
        return d

    @property
    def impact(self) -> int:
        """Peso = severidad × nº issues (para priorización)."""
        if self.passed:
            return 0
        return SEVERITY_WEIGHTS.get(self.severity, 1) * max(1, self.issue_count)


# ── Detección de autor del IFC ───────────────────────────────────────────────

def detect_app_info(ifc) -> dict:
    """Detecta autor y año de versión (ej. '2025') del IFC.
    Devuelve {'author': str, 'version': str}. No lanza nunca."""
    import re as _re
    author = AUTHOR_GENERIC
    version = ""
    try:
        apps = ifc.by_type("IfcApplication")
        for app in apps:
            name = (getattr(app, "ApplicationFullName", "") or "") + " " + \
                   (getattr(app, "ApplicationIdentifier", "") or "")
            ver_raw = (getattr(app, "Version", "") or "")
            low = name.lower()
            if "revit" in low:
                author = AUTHOR_REVIT
            elif "civil 3d" in low or "civil3d" in low or "autocad" in low:
                author = AUTHOR_CIVIL3D
            m = _re.search(r'20[2-3]\d', ver_raw + " " + name)
            if m:
                version = m.group(0)
            if author != AUTHOR_GENERIC:
                break
    except Exception:
        pass
    return {"author": author, "version": version}


def detect_author(ifc) -> str:
    """Detecta si el IFC fue exportado desde Revit, Civil 3D u otro.

    Lee IfcOwnerHistory.OwningApplication.ApplicationFullName (o variantes).
    No lanza nunca: ante cualquier error devuelve AUTHOR_GENERIC.
    """
    return detect_app_info(ifc)["author"]


# ── Helpers compartidos ──────────────────────────────────────────────────────

def safe_globalid(entity) -> str:
    try:
        return getattr(entity, "GlobalId", "") or ""
    except Exception:
        return ""


def collect_samples(entities, cap: int = 10) -> list[str]:
    """Devuelve los primeros `cap` GlobalIds de una iterable de entidades."""
    out = []
    for e in entities:
        gid = safe_globalid(e)
        if gid:
            out.append(gid)
            if len(out) >= cap:
                break
    return out


def score_from_results(results: list[CheckResult]) -> int:
    """Score 0–100 a partir de una lista de CheckResult.

    Fórmula: 100 menos peso normalizado de severidad por check fallado.
    Cada check tiene el mismo peso base; severidad escala penalización.
    """
    if not results:
        return 100
    total = 0
    penalty = 0
    for r in results:
        weight = SEVERITY_WEIGHTS.get(r.severity, 1)
        total += weight
        if not r.passed:
            penalty += weight
    if total == 0:
        return 100
    return max(0, round(100 * (1 - penalty / total)))
