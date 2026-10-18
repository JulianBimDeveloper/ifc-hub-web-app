"""FastAPI router for PEB generator."""
from __future__ import annotations
import os
from pathlib import Path
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from services.peb_models import PEBFormData
from services.peb_builder import build_peb, OUTPUT_DIR

router = APIRouter()


@router.post("/peb/generate")
async def generate_peb(data: PEBFormData):
    """Generate a complete PEB document from form data.

    Returns job_id, download URLs for DOCX and PDF, and document metadata.
    """
    try:
        result = build_peb(data)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Error generando PEB: {exc}") from exc

    job_id = result["job_id"]
    response = {
        "job_id":   job_id,
        "doc_code": result["doc_code"],
        "tables":   result["tables"],
        "figures":  result["figures"],
        "docx_url": f"/api/peb/download/{job_id}/docx",
        "pdf_url":  f"/api/peb/download/{job_id}/pdf" if result["pdf_path"] else None,
    }
    return response


@router.get("/peb/download/{job_id}/{fmt}")
async def download_peb(job_id: str, fmt: str):
    """Download a generated PEB file by job_id and format (docx | pdf)."""
    if fmt not in ("docx", "pdf"):
        raise HTTPException(status_code=400, detail="Formato debe ser docx o pdf")

    # Find the file
    matches = list(OUTPUT_DIR.glob(f"PEB_*_{job_id}.{fmt}"))
    if not matches:
        raise HTTPException(status_code=404, detail=f"Archivo no encontrado: {job_id}.{fmt}")

    file_path = matches[0]
    media = (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        if fmt == "docx" else "application/pdf"
    )
    return FileResponse(
        path=str(file_path),
        media_type=media,
        filename=file_path.name,
    )


@router.get("/peb/preview-midp")
async def preview_midp(
    expediente_num: str,
    codigo_am: str,
    usa_civil3d: bool = False,
):
    """Return the list of auto-generated document codes for the MIDP preview."""
    from services.peb_models import PEBFormData, PEBPersona
    from services.peb_codes import gen_midp_table

    # Minimal form data to generate MIDP
    stub = PEBFormData(
        nombre_actuacion="—",
        expediente="—",
        expediente_num=expediente_num,
        codigo_actuacion="—",
        codigo_am=codigo_am,
        empresa_am="—",
        direccion="—",
        fecha_inicio="—",
        fecha_peb="—",
        usa_civil3d=usa_civil3d,
        responsable_bim=PEBPersona(nombre="—", empresa="—", email="—"),
        coordinador_bim=PEBPersona(nombre="—", empresa="—", email="—"),
    )
    return gen_midp_table(stub)
