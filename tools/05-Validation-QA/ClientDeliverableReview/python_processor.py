"""
client_review.py — Router FastAPI para la herramienta CLIENT REVIEW.
Prefijo: /api/ifc/client-review
"""

import os
import uuid
import asyncio

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from pydantic import BaseModel
from typing import Optional

router = APIRouter()


# ── POST /scan — escaneo en vivo, un archivo ─────────────────────────────────

class ScanRequest(BaseModel):
    path: str
    levels: list[str] = ["file", "project", "element"]
    force: bool = False


@router.post("/scan")
async def scan(req: ScanRequest):
    """Escanea un IFC y devuelve la matriz de revisión (file_row, project_row, elements[])."""
    if not os.path.isfile(req.path):
        raise HTTPException(404, f"File not found: {req.path}")
    loop = asyncio.get_event_loop()
    try:
        from services.client_review import scan_file, invalidate_cache
        if req.force:
            invalidate_cache([req.path])
        result = await loop.run_in_executor(None, scan_file, req.path, req.levels)
        if "error" in result:
            raise HTTPException(500, result["error"])
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@router.delete("/cache")
async def clear_cache():
    """Borra toda la caché de escaneo en disco y memoria."""
    from services.client_review import _CACHE_DIR, _MEM_CACHE
    import shutil
    _MEM_CACHE.clear()
    try:
        shutil.rmtree(_CACHE_DIR, ignore_errors=True)
    except Exception:
        pass
    return {"ok": True}


# ── POST /import-excel — parsear xlsx/CSV del cliente ────────────────────────

@router.post("/import-excel")
async def import_excel(file: UploadFile = File(...)):
    """
    Sube el xlsx del cliente (o CSV) y devuelve:
    - review_id (persistido en disco para /compare)
    - stats por hoja (filas, celdas rojas, columnas)
    - lista de archivos IFC mencionados
    """
    content = await file.read()
    fname = file.filename or "review.xlsx"
    review_id = str(uuid.uuid4())

    loop = asyncio.get_event_loop()
    try:
        from services.client_review import import_excel as svc_import
        result = await loop.run_in_executor(None, svc_import, content, fname, review_id)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


# ── POST /compare — comparar xlsx vs IFC en disco, un archivo ────────────────

class CompareRequest(BaseModel):
    review_id: str
    path: str


@router.post("/compare")
async def compare(req: CompareRequest):
    """
    Compara un IFC en disco contra el review importado.
    Devuelve misma estructura que /scan pero con status por celda:
    client_red_still_empty | client_red_fixed | client_red_has_value | ok | new_empty | not_in_excel
    """
    if not os.path.isfile(req.path):
        raise HTTPException(404, f"File not found: {req.path}")
    loop = asyncio.get_event_loop()
    try:
        from services.client_review import compare_file
        result = await loop.run_in_executor(None, compare_file, req.path, req.review_id)
        if "error" in result:
            raise HTTPException(404 if "not found" in result["error"].lower() else 500, result["error"])
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


# ── POST /bulk-fill — relleno masivo (abre cada IFC una vez) ─────────────────

class BulkFillTarget(BaseModel):
    pset_name: str          # "__attr__" para atributos estándar Name/Description/ObjectType/Tag
    prop_name: str
    value: str
    only_if_empty: bool = True
    create_if_missing: bool = True


class BulkFillRequest(BaseModel):
    targets_by_file: dict[str, list[str]]   # {path: [guid,...]} — usar "__all__" para todos
    fills: list[BulkFillTarget]
    ifc_class: Optional[str] = None          # filtro por clase IFC (e.g. "IfcWall")
    name_base: Optional[str] = None          # filtro por nombre base sin sufijo _\d+


@router.post("/bulk-fill")
async def bulk_fill(req: BulkFillRequest):
    """
    Aplica N cambios a M elementos en K archivos.
    Un solo open() por archivo — eficiente para 20k elementos.
    Agrupaciones soportadas:
      - Por archivo: targets_by_file={path: ["__all__"]}
      - Por clase IFC: ifc_class="IfcWall"
      - Por nombre-tipo: name_base="ARQ_MAM_Mampara_5cm"
      - Por pset+param vacío: only_if_empty=true (por defecto)
      - Manual: lista explícita de GUIDs
    """
    if not req.fills:
        raise HTTPException(400, "No fills specified")
    if not req.targets_by_file:
        raise HTTPException(400, "No target files specified")

    loop = asyncio.get_event_loop()
    try:
        from services.client_review import bulk_fill as svc_fill
        from routers.ifc import _invalidate_caches

        fills_dicts = [f.model_dump() for f in req.fills]
        result = await loop.run_in_executor(
            None,
            svc_fill,
            req.targets_by_file,
            fills_dicts,
            req.ifc_class,
            req.name_base,
        )
        # Invalidar también el caché del router principal de IFC
        try:
            _invalidate_caches(list(req.targets_by_file.keys()))
        except Exception:
            pass

        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


# ── GET /schema — devuelve el esquema de columnas para el frontend ────────────

@router.get("/schema")
async def get_schema():
    """Devuelve la definición de columnas por nivel (sin las funciones de regla)."""
    from services.client_review_schema import SCHEMA
    result = {}
    for level, cols in SCHEMA.items():
        result[level] = [{"key": c["key"], "label": c.get("label", c["key"]), "source": c["source"]} for c in cols]
    return result


# ── GET /reviews — lista de reviews importados disponibles en disco ───────────

@router.get("/reviews")
async def list_reviews():
    """Lista los review_ids persistidos en disco."""
    import json
    import os as _os
    from services.client_review import _REVIEWS_DIR
    reviews = []
    try:
        for fname in _os.listdir(_REVIEWS_DIR):
            if not fname.endswith(".json"):
                continue
            fp = _os.path.join(_REVIEWS_DIR, fname)
            try:
                with open(fp, "r", encoding="utf-8") as fh:
                    meta = json.load(fh)
                reviews.append({
                    "review_id":       meta.get("review_id"),
                    "source_filename": meta.get("source_filename"),
                    "sheets":          meta.get("sheets", {}),
                    "files_in_excel":  meta.get("files_in_excel", []),
                })
            except Exception:
                pass
    except FileNotFoundError:
        pass
    return {"reviews": reviews}


# ── DELETE /reviews/{review_id} — eliminar un review ─────────────────────────

@router.delete("/reviews/{review_id}")
async def delete_review(review_id: str):
    import os as _os
    from services.client_review import _REVIEWS_DIR
    fp = _os.path.join(_REVIEWS_DIR, f"{review_id}.json")
    try:
        _os.remove(fp)
        return {"ok": True}
    except FileNotFoundError:
        raise HTTPException(404, "Review not found")
    except OSError as e:
        raise HTTPException(500, str(e))


# ── POST /export-excel — generar xlsx descargable ────────────────────────────

class ExportExcelRequest(BaseModel):
    data: dict  # {sheetName: {columns: [...], rows: [[...]]}}


@router.post("/export-excel")
async def export_excel_endpoint(req: ExportExcelRequest):
    """
    Recibe los datos de la tabla (ya preparados por el frontend) y devuelve
    un xlsx limpio (sin colores) con una hoja por cada entrada en data.
    """
    from fastapi.responses import Response
    loop = asyncio.get_event_loop()
    try:
        from services.client_review import export_to_excel
        xlsx_bytes = await loop.run_in_executor(None, export_to_excel, req.data)
        return Response(
            content=xlsx_bytes,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": 'attachment; filename="client_review.xlsx"'},
        )
    except Exception as e:
        raise HTTPException(500, str(e))


# ── POST /import-edits — escribir valores editados de vuelta a los IFCs ───────

@router.post("/import-edits")
async def import_edits_endpoint(
    file: UploadFile = File(...),
    paths_json: str = Form(...),
):
    """
    Recibe un xlsx editado + mapa {filename: full_path}.
    Escribe los valores de pset editables de vuelta a los IFCs en disco.
    Solo aplica IfcElement y IfcProject (IfcFile es solo lectura).
    Devuelve: {filename: {updated, skipped, errors}}
    """
    import json
    content = await file.read()
    try:
        paths_by_filename: dict[str, str] = json.loads(paths_json)
    except Exception:
        raise HTTPException(400, "paths_json inválido")

    loop = asyncio.get_event_loop()
    try:
        from services.client_review import apply_excel_edits
        from routers.ifc import _invalidate_caches
        result = await loop.run_in_executor(None, apply_excel_edits, content, paths_by_filename)
        try:
            _invalidate_caches(list(paths_by_filename.values()))
        except Exception:
            pass
        return {"ok": True, "per_file": result}
    except Exception as e:
        raise HTTPException(500, str(e))
