"""IFC Standards Audit — sub-paquete con un módulo por norma.

Cada módulo expone `run(ifc, author) -> list[CheckResult]`.
El orquestador `runner.scan_single_file(path, options)` los compone.
"""
from .common import (
    CheckResult, detect_author,
    STANDARDS, SEVERITIES, STANDARD_LABELS, STANDARD_COLORS,
    SEV_INFO, SEV_WARN, SEV_ERROR,
    AUTHOR_REVIT, AUTHOR_CIVIL3D, AUTHOR_GENERIC,
)

__all__ = [
    "CheckResult", "detect_author",
    "STANDARDS", "SEVERITIES", "STANDARD_LABELS", "STANDARD_COLORS",
    "SEV_INFO", "SEV_WARN", "SEV_ERROR",
    "AUTHOR_REVIT", "AUTHOR_CIVIL3D", "AUTHOR_GENERIC",
]
