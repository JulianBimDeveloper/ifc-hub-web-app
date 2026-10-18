import os, json, asyncio, base64, re
from fastapi import APIRouter, BackgroundTasks, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional
from collections import Counter

from core.config import settings
from core.logging_config import get_logger
from core.model_pool import model_pool
from core.resilience import atomic_write_model, coerce_property_value
from core.ifc_repository import repo, PathNotAllowed

logger = get_logger(__name__)

router = APIRouter()


def _iter_instances_with_prop(ifc, prop_name: str):
    """Yields (entity, value) for every element carrying `prop_name`, wherever
    it lives — never filtered by pset name, since the ADIF/INGR properties
    don't reliably sit in a pset whose NAME matches anything we could pass in
    (some Revit exports mix them into a generic pset like "Propiedades de
    modelo", and PocketBase's own `pset_name` field is a business category,
    not the literal pset name embedded by every exporter). The name of the
    PROPERTY is the only reliable thing to filter by.

    This walks `IfcPropertySet` directly instead of calling
    ifcopenshell.util.element.get_psets() once per IfcProduct — get_psets()
    rebuilds the FULL merged property dict for an entity just to answer "does
    it have this one property", which is ~2.4x slower at scale (measured on a
    9k-element, 118MB model: 6.4s vs 2.7s for the scan phase alone). Only
    instance-level psets (IfcRelDefinesByProperties) are considered — ADIF/
    INGR properties in this project are always written at instance level,
    never on the Type (see CLAUDE.md: Instance↔Type changes are blocked for
    the protected params), so a Type-level fallback isn't needed here.
    """
    for pset in ifc.by_type("IfcPropertySet"):
        prop = None
        for p in pset.HasProperties:
            if p.Name == prop_name:
                prop = p
                break
        if prop is None or not prop.is_a("IfcPropertySingleValue"):
            continue
        nv = prop.NominalValue
        val = nv.wrappedValue if nv is not None else None
        for rel in ifc.get_inverse(pset):
            if rel.is_a("IfcRelDefinesByProperties"):
                for obj in rel.RelatedObjects:
                    yield obj, val


def _guard_path(*paths: str) -> None:
    """Guardia de seguridad: valida que cada ruta esté dentro de las raíces
    permitidas (settings.IFC_ALLOWED_ROOTS). Lanza HTTP 400 si no.

    Diseñado como guardia (no reasigna la ruta): en modo permisivo —cuando no
    hay raíces configuradas— es un no-op y NO altera el comportamiento ni los
    valores de path que el backend devuelve al frontend. Al definir la env var
    IFC_ALLOWED_ROOTS, bloquea path-traversal / escritura arbitraria.
    """
    for p in paths:
        if not p:
            continue
        try:
            repo.safe_path(p)
        except PathNotAllowed as exc:
            raise HTTPException(status_code=400, detail=str(exc))

# ── Shared IfcProduct type set (used by _extract_ifc_info + fast STEP parsers) ─

_IFC_PRODUCT_TYPES = {
    "IFCSITE","IFCBUILDING","IFCBUILDINGSTOREY","IFCSPACE","IFCZONE","IFCEXTERNALSPATIALELEMENT",
    "IFCWALL","IFCWALLSTANDARDCASE","IFCCURTAINWALL","IFCSLAB","IFCCOLUMN","IFCBEAM","IFCROOF","IFCSTAIR",
    "IFCSTAIRFLIGHT","IFCRAMP","IFCRAMPFLIGHT","IFCRAILING","IFCPLATE","IFCMEMBER","IFCPILE",
    "IFCFOOTING","IFCCOVERING","IFCSHADINGDEVICE","IFCDOOR","IFCWINDOW","IFCFASTENER","IFCCOURSE",
    "IFCFLOWSEGMENT","IFCPIPESEGMENT","IFCDUCTSEGMENT","IFCCABLESEGMENT","IFCCABLECARRIERSEGMENT","IFCFLOWFITTING",
    "IFCPIPEFITTING","IFCDUCTFITTING","IFCCABLEFITTING","IFCCABLECARRIERFITTING","IFCFLOWTERMINAL","IFCFLOWMOVINGDEVICE",
    "IFCFLOWSTORAGEDEVICE","IFCDISTRIBUTIONELEMENT","IFCDISTRIBUTIONFLOWSEGMENT","IFCDISTRIBUTIONPORT",
    "IFCDISTRIBUTIONCHAMBERELEMENT","IFCDISTRIBUTIONCONTROLELEMENT","IFCLIGHTFIXTURE","IFCVALVE",
    "IFCJUNCTIONBOX","IFCOUTLET","IFCSANITARYTERMINAL","IFCAUDIOVISUALAPPLIANCE","IFCCOMMUNICATIONSAPPLIANCE",
    "IFCENERGYCONVERSIONDEVICE","IFCFLOWCONTROLLER",
    "IFCBUILDINGELEMENTPROXY","IFCELEMENTASSEMBLY","IFCPROXY","IFCFURNISHINGELEMENT",
    "IFCFURNITURE","IFCEQUIPMENTELEMENT","IFCTRANSPORTELEMENT","IFCVIRTUALELEMENT",
    "IFCREINFORCINGBAR","IFCREINFORCINGMESH","IFCTENDON","IFCTENDONANCHOR",
    "IFCALIGNMENT","IFCRAILWAY","IFCRAILWAYPART","IFCROAD","IFCBRIDGE","IFCTUNNEL","IFCFACILITY",
    "IFCFACILITYPART","IFCKERB","IFCPAVEMENT","IFCSIGNAL","IFCSIGNVIEWER","IFCTRACKELEMENT",
    "IFCVEHICLE","IFCGEOGRAPHICELEMENT","IFCCIVILELEMENT","IFCBUILTELEMENT",
    "IFCOPENINGELEMENT","IFCVOIDINGFEATURE","IFCPROJECTIONELEMENT",
}

# Pure spatial-structure containers (IfcProduct subtypes but never carry their own
# geometry — Civil3D/Revit exports routinely leave their Representation empty).
# Included in _IFC_PRODUCT_TYPES above because they're legitimate classification/
# property targets, but excluded from "how many elements does this model have"
# display counts, since counting them there overstates what a user would call an
# element (e.g. a bare IfcSite with no shape inflates the count by one).
_IFC_SPATIAL_CONTAINER_TYPES = {"IFCPROJECT", "IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY"}

# ── In-memory result cache: (path, mtime, scan_type) → result dict ─────────────
# Simple bounded cache — cleared when > 500 entries. Survives uvicorn --reload
# because reload preserves module-level state.
_SCAN_CACHE: dict = {}

def _cache_get(key: tuple):
    return _SCAN_CACHE.get(key)

def _cache_set(key: tuple, value: dict):
    if len(_SCAN_CACHE) > 500:
        _SCAN_CACHE.clear()
    _SCAN_CACHE[key] = value

# ── Per-file write locks — prevent concurrent rename/sync on same IFC file ──
_file_write_locks: dict[str, asyncio.Lock] = {}

def _get_file_lock(path: str) -> asyncio.Lock:
    """Retorna (y crea si no existe) el asyncio.Lock asociado al path absoluto."""
    lock = _file_write_locks.get(path)
    if lock is None:
        lock = asyncio.Lock()
        _file_write_locks[path] = lock
    return lock

def _cache_key(ifc_path: str, scan_type: str) -> tuple:
    try:
        mtime = os.stat(ifc_path).st_mtime
    except OSError:
        mtime = 0.0
    return (ifc_path, mtime, scan_type)


# ── Persistent per-file property index (SQLite, survives restarts) ──────────
# Every property/value search (Sets, Value Search...) used to pay the SAME
# cost on every single query: open the raw IFC (parsing a 100+MB STEP file
# can take 10-14s on its own) and walk every element — like re-scanning a
# whole spreadsheet cell by cell on every search, forever, because the
# in-memory caches (_SCAN_CACHE below, model_pool) are all RAM-only: gone on
# every backend restart, bounded to a handful of entries under real usage.
#
# A real search engine (or Google Maps) never re-scans its source data per
# query — it builds an index ONCE when the data changes, then every query is
# just an indexed lookup against that. This does the same, the first time a
# file is touched (or its mtime changes): walk it ONCE and write every
# element + every (pset, property, value) into a small SQLite database on
# disk (one .sqlite per IFC file), keyed by path+mtime+size+version — same
# invalidation convention as services/ifc_sync.py's _MATERIAL_CACHE_DIR and
# services/viewer_geometry.py's _GEOM_CACHE_DIR (a changed file just misses
# the cache, nothing to explicitly invalidate). Every later query becomes an
# indexed SQL lookup — milliseconds regardless of file size — instead of an
# ifcopenshell walk or, before this, loading a multi-MB JSON blob per file
# just to look up one key.
#
# Why SQLite and not PocketBase (which already IS SQLite under its REST
# API): this data is disposable, regenerable from the IFC at any time, and
# gets inserted at a scale (700k+ property rows for a single 9k-element
# file, measured) where going through an HTTP/JSON layer per row would be
# orders of magnitude slower than a direct `executemany()` into a local
# file — and PocketBase's filter API has no GROUP BY-style aggregation,
# which every one of these queries needs. A local file, opened directly by
# this process, is the right tool for a local, throwaway index.
#
# Deliberately lives OUTSIDE backend/ (under the user's home dir): uvicorn
# --reload watches the backend/ tree, so writing cache files inside it would
# trigger a reload storm on every search — the exact gotcha already noted in
# viewer_geometry.py.
import hashlib as _hashlib_propidx
import sqlite3

_PROPERTY_INDEX_CACHE_DIR = os.environ.get(
    "IFC_HUB_PROPERTY_INDEX_CACHE",
    os.path.join(os.path.expanduser("~"), ".ifc-hub-v2", "property_index_cache"),
)

# Bump this whenever `_build_property_index_db` changes what it computes /
# the schema it writes — otherwise a stale index built with old logic (or an
# old schema) keeps being served forever for a file whose mtime never
# changes (same lesson as _MATERIAL_CACHE_VERSION in services/ifc_sync.py).
# v2: switched from a JSON blob per file to an indexed SQLite database.
_PROPERTY_INDEX_VERSION = 2


def _property_index_cache_key(ifc_path: str) -> Optional[str]:
    try:
        st = os.stat(ifc_path)
    except OSError:
        return None
    raw = f"v{_PROPERTY_INDEX_VERSION}|{os.path.abspath(ifc_path)}|{int(st.st_mtime)}|{st.st_size}"
    return _hashlib_propidx.sha1(raw.encode("utf-8")).hexdigest()


def _property_index_db_path(ifc_path: str) -> Optional[str]:
    key = _property_index_cache_key(ifc_path)
    if not key:
        return None
    return os.path.join(_PROPERTY_INDEX_CACHE_DIR, f"{key}.sqlite")


def _build_property_index_db(ifc_path: str, ifc) -> Optional[str]:
    """Walks the model ONCE and writes an indexed SQLite database:
      - `elements`: one row per IfcProduct (step_id, global_id, ifc_class, name)
      - `properties`: one row per (element, pset, property) with a value
        (step_id, pset_name, prop_name, value), indexed on prop_name (what
        property/value search needs), step_id (per-element lookups) and
        pset_name (Value Search's pset filter).

    Walks IfcRelDefinesByProperties directly (pset + RelatedObjects) rather
    than ifc.by_type("IfcPropertySet") + ifc.get_inverse(pset) per pset —
    measured on a real 9k-element/118MB file: get_inverse() per pset made
    this SLOWER (21.8s) than even IfcOpenShell's own reference tool for this
    exact task (ifcpatch's ExtractPropertiesToSQLite, get_psets-based,
    11.0s). get_inverse() turns out to be the expensive call, not reading
    the property itself — going through the relationship forward instead
    (no inverse lookup at all) builds the same index in 9.1s.
    """
    db_path = _property_index_db_path(ifc_path)
    if db_path is None:
        return None
    os.makedirs(_PROPERTY_INDEX_CACHE_DIR, exist_ok=True)
    tmp_path = db_path + ".tmp"
    try:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
    except OSError:
        pass

    conn = sqlite3.connect(tmp_path)
    try:
        conn.executescript("""
            CREATE TABLE elements (
                step_id INTEGER PRIMARY KEY,
                global_id TEXT,
                ifc_class TEXT,
                name TEXT
            );
            CREATE TABLE properties (
                step_id INTEGER NOT NULL,
                pset_name TEXT,
                prop_name TEXT,
                value TEXT
            );
        """)

        conn.executemany(
            "INSERT INTO elements VALUES (?, ?, ?, ?)",
            (
                (entity.id(), getattr(entity, "GlobalId", "") or "", entity.is_a(), getattr(entity, "Name", "") or "")
                for entity in ifc.by_type("IfcProduct")
            ),
        )

        def _prop_rows():
            for rel in ifc.by_type("IfcRelDefinesByProperties"):
                pset = rel.RelatingPropertyDefinition
                if pset is None or not pset.is_a("IfcPropertySet"):
                    continue
                related_ids = [obj.id() for obj in rel.RelatedObjects]
                if not related_ids:
                    continue
                pset_name = pset.Name or ""
                for prop in pset.HasProperties:
                    if not prop.is_a("IfcPropertySingleValue"):
                        continue
                    nv = prop.NominalValue
                    val = str(nv.wrappedValue) if nv is not None else ""
                    prop_name = prop.Name
                    for step_id in related_ids:
                        yield (step_id, pset_name, prop_name, val)

        conn.executemany("INSERT INTO properties VALUES (?, ?, ?, ?)", _prop_rows())

        conn.execute("CREATE INDEX idx_properties_prop_name ON properties(prop_name)")
        conn.execute("CREATE INDEX idx_properties_step_id ON properties(step_id)")
        conn.execute("CREATE INDEX idx_properties_pset_name ON properties(pset_name)")
        conn.commit()
    finally:
        conn.close()

    os.replace(tmp_path, db_path)  # escritura atómica
    return db_path


def _get_property_index_db(ifc_path: str) -> Optional[str]:
    """Read-through: returns the path to a ready SQLite index for this exact
    file version, building it once (via the shared model_pool, so a cache
    MISS still benefits from an already-open model) if missing or stale."""
    db_path = _property_index_db_path(ifc_path)
    if db_path is None:
        return None
    if os.path.isfile(db_path):
        return db_path
    try:
        ifc = model_pool.get(ifc_path)
    except Exception:
        return None
    return _build_property_index_db(ifc_path, ifc)


# ── Native folder/file picker (aislado en subproceso) ────────────────────────
# tkinter NO es thread-safe: crear/destruir tk.Tk() en un hilo del threadpool
# de FastAPI (run_in_executor, no el hilo principal) puede corromper el
# proceso entero — crash nativo sin traceback de Python, visto repetidamente
# en producción justo después de "/folder-picker". Aislar el diálogo en un
# subprocess.run() separado garantiza que un fallo de Tk mate solo a ese
# subproceso desechable, nunca al servidor API.
import subprocess
import sys

def _run_dialog_subprocess(script: str, timeout_s: int = 300) -> str:
    try:
        proc = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True, text=True, timeout=timeout_s,
        )
        return proc.stdout
    except subprocess.TimeoutExpired:
        return ""


_FOLDER_DIALOG_SCRIPT = """
import tkinter as tk
from tkinter import filedialog
root = tk.Tk()
root.withdraw()
root.wm_attributes('-topmost', 1)
folder = filedialog.askdirectory(title='Seleccionar carpeta con archivos IFC')
root.destroy()
print(folder or '')
"""

_FILE_DIALOG_SCRIPT = """
import tkinter as tk
from tkinter import filedialog
root = tk.Tk()
root.withdraw()
root.wm_attributes('-topmost', 1)
paths = filedialog.askopenfilenames(
    title='Seleccionar archivos IFC',
    filetypes=[('IFC files', '*.ifc *.IFC'), ('All files', '*.*')],
)
root.destroy()
for p in paths:
    print(p)
"""


@router.get("/folder-picker")
async def folder_picker():
    """Open a native Windows folder-picker dialog and return the selected path."""
    loop = asyncio.get_event_loop()
    try:
        out = await loop.run_in_executor(None, _run_dialog_subprocess, _FOLDER_DIALOG_SCRIPT)
        return {"path": out.strip()}
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/file-picker")
async def file_picker():
    """Open a native Windows multi-file picker for .ifc files."""
    loop = asyncio.get_event_loop()
    try:
        out = await loop.run_in_executor(None, _run_dialog_subprocess, _FILE_DIALOG_SCRIPT)
        paths = [line for line in out.splitlines() if line.strip()]
        files = [
            {"filename": os.path.basename(p), "path": p}
            for p in paths if p.lower().endswith(".ifc")
        ]
        return {"files": files, "cancelled": len(paths) == 0}
    except Exception as e:
        raise HTTPException(500, str(e))


# ── File utilities ──────────────────────────────────────────────────────────

@router.get("/files/list")
async def list_ifc_files(folder: str):
    """List .ifc files in a folder (non-recursive by default)."""
    if not os.path.isdir(folder):
        raise HTTPException(404, f"Folder not found: {folder}")
    files = [f for f in os.listdir(folder) if f.lower().endswith(".ifc")]
    return {"files": files, "folder": folder}


@router.get("/files/list-recursive")
async def list_ifc_files_recursive(folder: str):
    """Recursively list all .ifc files in a folder tree."""
    if not os.path.isdir(folder):
        raise HTTPException(404, f"Folder not found: {folder}")
    files = []
    for root, dirs, fnames in os.walk(folder):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for f in sorted(fnames):
            if f.lower().endswith(".ifc"):
                files.append({
                    "filename": f,
                    "path": os.path.join(root, f),
                    "selected": True,
                })
    return {"files": files, "folder": folder, "total": len(files)}


# ── Export Control — date-aware "most recent wins" scan ──────────────────────
# Reglas (acordadas con el usuario):
#   1. Por cada carpeta seleccionada se buscan SUBCARPETAS con nomenclatura de
#      fecha "AAMMDD <tag>"  (ej: "260603 DWG"). La fecha sale del NOMBRE.
#   2. Si un mismo IFC aparece en varias subcarpetas, gana la de fecha de NOMBRE
#      más reciente. Empate de fecha -> desempata por mtime real del fichero.
#   3. Si una carpeta seleccionada NO contiene ninguna subcarpeta con esa
#      estructura -> modo "flat": se cogen los .ifc directamente dentro de ella
#      y se ordenan/deduplican por la fecha de modificación del propio fichero.
#   4. El tag (RVT/DWG/…) es SOLO informativo; el emparejamiento es por nombre
#      de fichero exacto.

# "AAMMDD" + separador opcional + tag.  Ej: "260603 DWG", "260521_RVT", "260512".
_FOLDER_DATE_RE = re.compile(r"^(\d{2})(\d{2})(\d{2})[ _\-]*(.*)$")


def _parse_folder_date(name: str):
    """'260603 DWG' -> ('2026-06-03', 'DWG').  Devuelve None si no es fecha válida."""
    import datetime
    m = _FOLDER_DATE_RE.match(name.strip())
    if not m:
        return None
    yy, mm, dd, tag = m.groups()
    try:
        d = datetime.date(2000 + int(yy), int(mm), int(dd))
    except ValueError:
        return None
    return d.isoformat(), (tag.strip() or None)


def _scan_dated_folder(folder: str) -> dict:
    """Escanea UNA carpeta seleccionada. Devuelve estructura con ocurrencias."""
    import datetime
    result = {
        "folder": folder,
        "mode": None,            # "dated" | "flat" | "error"
        "dated_count": 0,
        "ignored_subfolders": [],
        "occurrences": [],       # [{ifc_name, path, folder_name, date, tag, mtime, source}]
        "warning": None,
    }
    if not os.path.isdir(folder):
        result["mode"] = "error"
        result["warning"] = f"Carpeta no encontrada: {folder}"
        return result

    # Subcarpetas inmediatas
    try:
        entries = sorted(os.listdir(folder))
    except OSError as e:
        result["mode"] = "error"
        result["warning"] = str(e)
        return result

    dated_subs = []   # (subpath, subname, date_iso, tag)
    for name in entries:
        sub = os.path.join(folder, name)
        if not os.path.isdir(sub) or name.startswith("."):
            continue
        parsed = _parse_folder_date(name)
        if parsed:
            dated_subs.append((sub, name, parsed[0], parsed[1]))
        else:
            result["ignored_subfolders"].append(name)

    def _add_ifcs(scan_dir: str, folder_name: str, date_iso: str, tag, source: str):
        try:
            files = os.listdir(scan_dir)
        except OSError:
            return
        for f in files:
            if not f.lower().endswith(".ifc"):
                continue
            fp = os.path.join(scan_dir, f)
            try:
                mtime = os.stat(fp).st_mtime
            except OSError:
                mtime = 0.0
            result["occurrences"].append({
                "ifc_name": f,
                "path": fp,
                "folder_name": folder_name,
                "date": date_iso,
                "tag": tag,
                "mtime": mtime,
                "source": source,
            })

    if dated_subs:
        result["mode"] = "dated"
        result["dated_count"] = len(dated_subs)
        for sub, name, date_iso, tag in dated_subs:
            _add_ifcs(sub, name, date_iso, tag, "dated")
    else:
        # Fallback flat: .ifc directos, fecha = mtime del fichero
        result["mode"] = "flat"
        result["warning"] = (
            f"Sin subcarpetas con nomenclatura AAMMDD en '{os.path.basename(folder) or folder}'. "
            "Se usan los IFC directos ordenados por fecha de modificación del fichero."
        )
        try:
            files = os.listdir(folder)
        except OSError:
            files = []
        for f in files:
            if not f.lower().endswith(".ifc"):
                continue
            fp = os.path.join(folder, f)
            try:
                mtime = os.stat(fp).st_mtime
            except OSError:
                mtime = 0.0
            date_iso = datetime.date.fromtimestamp(mtime).isoformat() if mtime else None
            result["occurrences"].append({
                "ifc_name": f,
                "path": fp,
                "folder_name": os.path.basename(folder) or folder,
                "date": date_iso,
                "tag": None,
                "mtime": mtime,
                "source": "flat",
            })
    return result


class ExportScanRequest(BaseModel):
    folders: list[str]


def _run_export_scan(folders: list[str]) -> dict:
    import datetime
    per_folder = []
    all_occ = []
    ignored = []      # [{folder, name}]
    warnings = []

    for folder in folders:
        fres = _scan_dated_folder(folder)
        per_folder.append({
            "folder": folder,
            "mode": fres["mode"],
            "dated_count": fres["dated_count"],
            "ignored_subfolders": fres["ignored_subfolders"],
            "warning": fres["warning"],
        })
        if fres["warning"]:
            warnings.append(fres["warning"])
        for n in fres["ignored_subfolders"]:
            ignored.append({"folder": folder, "name": n})
        all_occ.extend(fres["occurrences"])

    # Dedup gana-la-más-reciente por nombre de fichero (case-insensitive)
    by_name: dict = {}
    for occ in all_occ:
        key = occ["ifc_name"].lower()
        by_name.setdefault(key, []).append(occ)

    files = {}
    for key, occs in by_name.items():
        # Orden: fecha de nombre (desc), luego mtime (desc)
        occs_sorted = sorted(
            occs,
            key=lambda o: (o["date"] or "0000-00-00", o["mtime"]),
            reverse=True,
        )
        winner = occs_sorted[0]
        older = occs_sorted[1:]
        files[key] = {
            "ifc_name": winner["ifc_name"],
            "winner": {
                "folder_name": winner["folder_name"],
                "date": winner["date"],
                "tag": winner["tag"],
                "path": winner["path"],
                "mtime": winner["mtime"],
                "source": winner["source"],
            },
            "older": [
                {"folder_name": o["folder_name"], "date": o["date"], "path": o["path"], "mtime": o["mtime"]}
                for o in older
            ],
            "copies": len(occs_sorted),
        }

    return {
        "files": files,
        "per_folder": per_folder,
        "ignored_folders": ignored,
        "warnings": warnings,
        "total_unique": len(files),
        "total_occurrences": len(all_occ),
        "scanned_at": datetime.datetime.now().isoformat(timespec="seconds"),
    }


@router.get("/projects/list-all")
async def list_all_projects():
    """Modelo VIGENTE (el más reciente) de cada IFC conocido bajo la raíz EXPORT
    configurada (settings.IFC_ALLOWED_ROOTS[0], subcarpetas "AAMMDD XXX"),
    reutilizando la misma resolución "gana la fecha más reciente" de Export
    Control — para no traer duplicados de exports antiguos superados.

    Permite al frontend añadir de golpe todos los proyectos conocidos (un solo
    botón) en vez de que el usuario tenga que abrir el selector nativo de
    carpetas de Windows una vez por proyecto.
    """
    if not settings.IFC_ALLOWED_ROOTS:
        raise HTTPException(
            400,
            "IFC_ALLOWED_ROOTS no está configurado — no hay una carpeta raíz EXPORT "
            "conocida desde la que listar proyectos automáticamente.",
        )
    root = settings.IFC_ALLOWED_ROOTS[0]
    if not os.path.isdir(root):
        raise HTTPException(404, f"Carpeta raíz no encontrada: {root}")

    scan = _run_export_scan([root])
    files = sorted(
        (
            {"filename": info["ifc_name"], "path": info["winner"]["path"]}
            for info in scan["files"].values()
        ),
        key=lambda f: f["filename"],
    )
    return {
        "root": root,
        "files": files,
        "total": len(files),
        "total_occurrences": scan["total_occurrences"],
    }


@router.post("/export-control/scan")
async def export_control_scan(req: ExportScanRequest):
    """
    Escaneo inteligente para Export Control.
    Devuelve, por cada IFC encontrado, la copia MÁS RECIENTE (carpeta + fecha + ruta),
    las copias antiguas, las subcarpetas ignoradas y los avisos de modo flat.
    El emparejamiento contra midp_mapping lo hace el frontend por nombre exacto.
    """
    if not req.folders:
        raise HTTPException(400, "No se indicaron carpetas")
    loop = asyncio.get_event_loop()
    try:
        return await loop.run_in_executor(None, _run_export_scan, req.folders)
    except Exception as e:
        logger.exception("export_control_scan failed")
        raise HTTPException(500, str(e))


# ── IFC File info (for Models page) ─────────────────────────────────────────

@router.get("/info")
async def ifc_file_info(path: str):
    """
    Returns lightweight metadata about a single IFC file without parsing geometry.
    Used by the Models page to populate file cards progressively.
    """
    if not os.path.isfile(path):
        raise HTTPException(404, f"File not found: {path}")
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _extract_ifc_info, path)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _extract_ifc_info(path: str) -> dict:
    """
    Fast IFC metadata extraction by parsing the raw STEP text directly.

    Does NOT call ifcopenshell.open() — reads the STEP header for schema /
    author / org and scans entity lines with a compiled regex for type counts.
    This is ~20–100× faster than loading the full ifcopenshell model for large
    files, making it suitable for the Models page progressive-card loader.
    """
    stat = os.stat(path)

    schema              = ""
    author              = ""
    organization        = ""
    originating_system  = ""
    app_version         = ""
    project_name        = ""
    timestamp           = ""

    type_counts: Counter = Counter()
    in_header   = True

    # Multi-line FILE_NAME accumulation state
    fn_buf    = ""   # accumulated text of FILE_NAME(…);
    fn_active = False

    # ── Compiled patterns ────────────────────────────────────────────────────
    RE_SCHEMA    = re.compile(r"FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'", re.I)
    RE_FILE_NAME = re.compile(r"FILE_NAME\s*\(", re.I)
    RE_DATA_SEC  = re.compile(r"^DATA\s*;")
    RE_ENDSEC    = re.compile(r"^ENDSEC\s*;")
    RE_ENTITY    = re.compile(r"^#\d+\s*=\s*(IFC\w+)\s*\(")
    RE_PROJECT   = re.compile(r"^#\d+\s*=\s*IFCPROJECT\s*\(", re.I)
    RE_APP       = re.compile(r"^#\d+\s*=\s*IFCAPPLICATION\s*\(", re.I)

    # ── IfcProduct subtype names: reuse module-level constant ─────────────────
    IFC_PRODUCTS = _IFC_PRODUCT_TYPES

    def _norm_schema(raw: str) -> str:
        # Return full schema string as-is — "IFC4X3_ADD2" not "IFC4X3"
        return raw.strip()

    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for raw_line in fh:
                line = raw_line.strip()
                if not line:
                    continue

                if in_header:
                    # FILE_SCHEMA(('IFC4X3_ADD2'));
                    m = RE_SCHEMA.search(line)
                    if m:
                        schema = _norm_schema(m.group(1))

                    # ── FILE_NAME — may span multiple lines in Civil 3D / GeometryGym exports
                    # Strategy: start buffering when FILE_NAME( is seen; stop when ';' closes it.
                    if RE_FILE_NAME.search(line):
                        fn_active = True
                        fn_buf    = line
                    elif fn_active:
                        fn_buf += " " + line

                    # Process complete FILE_NAME once we have the closing ';'
                    if fn_active and ";" in fn_buf:
                        fn_active = False
                        strings = re.findall(r"'([^']*)'", fn_buf)
                        # IFC STEP FILE_NAME layout (positions may shift due to $):
                        #   0: file path, 1: timestamp, 2: Author, 3: Organization,
                        #   4: PreprocessorVersion, 5: OriginatingSystem
                        if len(strings) >= 2:
                            timestamp = strings[1]
                        if len(strings) >= 3:
                            author = strings[2]
                        if len(strings) >= 4:
                            organization = strings[3]

                        # OriginatingSystem: search ALL remaining strings for software name.
                        # Priority: explicit "Revit" / "Civil" keywords.
                        # Fallback: any non-empty string at position 5+ that isn't the preprocessor.
                        for s in strings[4:]:
                            sl = s.lower()
                            if "revit" in sl or "civil" in sl or "archicad" in sl or "tekla" in sl:
                                originating_system = s
                                # Extract version (e.g., "2025" from "Autodesk Revit 2025 (ESP)")
                                m = re.search(r'(\d{4})', s)
                                if m:
                                    app_version = m.group(1)
                                break
                        # Fallback: last non-empty string in positions 4+ (GeometryGym puts
                        # originating_system as the 6th token; preprocessor is 5th)
                        if not originating_system and len(strings) >= 6:
                            originating_system = strings[5]
                            m = re.search(r'(\d{4})', originating_system)
                            if m:
                                app_version = m.group(1)

                    if RE_DATA_SEC.match(line):
                        in_header = False

                else:
                    # Count entity type occurrences
                    m = RE_ENTITY.match(line)
                    if m:
                        type_counts[m.group(1)] += 1

                    # Grab project name from first IFCPROJECT line
                    if not project_name and RE_PROJECT.match(line):
                        strings = re.findall(r"'([^']*)'", line)
                        # IFCPROJECT('GlobalId',$,'Name',...) → strings[1] = Name
                        if len(strings) >= 2:
                            project_name = strings[1]
                        elif len(strings) == 1:
                            project_name = strings[0]

                    # Grab app_version from IfcApplication if FILE_NAME didn't yield one
                    # IfcApplication(organization, version, fullName, identifier)
                    # Revit: IFCAPPLICATION(#1,'2025','Autodesk Revit 2025 (ESP)','Revit')
                    if not app_version and RE_APP.match(line):
                        app_strs = re.findall(r"'([^']*)'", line)
                        if len(app_strs) >= 2:
                            m2 = re.search(r'(\d{4})', app_strs[1])
                            if m2:
                                app_version = m2.group(1)

                    if RE_ENDSEC.match(line):
                        break
    except Exception:
        pass  # Return whatever we collected so far

    # ── Element count ─────────────────────────────────────────────────────────
    # Spatial containers (IfcProject/IfcSite/IfcBuilding/IfcBuildingStorey) are
    # excluded — they're organizational, almost never carry their own geometry,
    # and counting them overstates what a user would call "an element".
    element_count = sum(
        cnt for typ, cnt in type_counts.items()
        if typ.upper() in IFC_PRODUCTS and typ.upper() not in _IFC_SPATIAL_CONTAINER_TYPES
    )
    if element_count == 0:
        # Fallback: total entity count (will include geometry + properties)
        element_count = sum(type_counts.values())

    # ── Top types (product subtypes preferred) ───────────────────────────────
    product_items = [
        (t, c) for t, c in type_counts.most_common(10)
        if t.upper() in IFC_PRODUCTS
    ]
    if not product_items:
        product_items = type_counts.most_common(6)
    top_types = [{"type": t, "count": c} for t, c in product_items[:6]]

    return {
        "schema":              schema or "UNKNOWN",
        "element_count":       element_count,
        "file_size_mb":        round(stat.st_size / (1024 * 1024), 2),
        "last_modified":       stat.st_mtime,
        "project_name":        project_name,
        "project_description": "",
        "author":              author,
        "organization":        organization,
        "originating_system":  originating_system,
        "app_version":         app_version,
        "timestamp":           timestamp,
        "top_types":           top_types,
    }


# ── IFC Metadata / Sync ─────────────────────────────────────────────────────

class SyncRequest(BaseModel):
    ifc_path: str
    params: list[dict]  # [{pset_name, prop_name, value}]


@router.post("/sync")
async def sync_ifc(req: SyncRequest):
    try:
        from services.ifc_sync import sync_ifc_to_pb
        result = sync_ifc_to_pb(req.ifc_path, "ifc_params")
        return {"ok": True, "result": result}
    except Exception as e:
        raise HTTPException(500, str(e))


def _resolve_filename_placeholder(filename_base: str):
    """
    Busca en midp_mapping el native_name para un IFC dado su nombre base.
    Retorna native_name si encuentra (con su extensión .rvt o .dwg),
    sino retorna el nombre base original.

    Importante: En PocketBase, ifc_name puede estar guardado CON o SIN la extensión .ifc,
    así que intentamos ambas formas de búsqueda.
    """
    try:
        from pocketbase import PocketBase
        pb = PocketBase(settings.POCKETBASE_URL)

        # Intentar múltiples variantes del nombre para encontrar la fila en midp_mapping
        search_variants = [
            filename_base,                    # Sin extensión: "442_MAM_TOPOGRAFIA"
            f"{filename_base}.ifc",          # Con .ifc: "442_MAM_TOPOGRAFIA.ifc"
            f"{filename_base}.IFC",          # Con .IFC: "442_MAM_TOPOGRAFIA.IFC"
        ]

        mapping = None
        used_variant = None

        for variant in search_variants:
            try:
                results = pb.collection("midp_mapping").get_full_list(
                    query_params={
                        "filter": f'ifc_name="{variant}"&&etapa="{settings.MIDP_ETAPA_ACTIVA}"'
                    }
                )
                if results and len(results) > 0:
                    mapping = results
                    used_variant = variant
                    logger.debug("midp_mapping: encontrado con variante '%s'", variant)
                    break
            except Exception:
                continue

        if mapping and len(mapping) > 0:
            record = mapping[0]
            native_name = None

            # Intento 1: acceso como atributo
            if hasattr(record, "native_name"):
                native_name = getattr(record, "native_name", None)

            # Intento 2: acceso como dict
            if not native_name and isinstance(record, dict) and "native_name" in record:
                native_name = record.get("native_name")

            # Intento 3: acceso directo por índice
            if not native_name:
                try:
                    native_name = record["native_name"]
                except Exception:
                    pass

            # Si existe y no está vacío, devolverlo (con extensión intacta: .rvt, .dwg, etc)
            if native_name and str(native_name).strip():
                result = str(native_name).strip()
                logger.debug("midp_mapping: %s (%s) → %s", filename_base, used_variant, result)
                return result
            else:
                logger.debug("midp_mapping: fila encontrada pero native_name vacío para %s", used_variant)
    except Exception as e:
        logger.warning("Error en _resolve_filename_placeholder(%s): %s", filename_base, e)

    logger.debug("midp_mapping: %s no encontrado, devolviendo original", filename_base)
    return filename_base


@router.get("/defaults-status")
async def defaults_status_endpoint(path: str):
    """Check defaults status using ifcopenshell for accuracy (avoids STEP-parser misses after write)."""
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _check_defaults_status, path)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _check_defaults_status(ifc_path: str) -> dict:
    import os

    info = _extract_ifc_info(ifc_path)
    originating_system = info.get("originating_system", "")
    is_civil3d = "civil" in originating_system.lower()

    # Lectura pura → pool LRU (evita re-parsear el IFC en cada chequeo)
    model = model_pool.get(ifc_path)
    projects = model.by_type("IfcProject")
    if not projects:
        return {
            "is_civil3d": is_civil3d, "originating_system": originating_system,
            "has_project": False, "adif_with_values": 0, "total_project_props": 0,
            "project_name": "", "project_long_name": "",
        }

    project = projects[0]
    adif_count  = 0   # ADIF_ props that have a non-empty value
    total_props = 0   # all props in IfcProject psets

    # Forward scan with explicit ID comparison — avoids entity __eq__ issues
    # and inverse-attribute gaps in Civil 3D IFC files.
    project_id = project.id()
    for rel in model.by_type("IfcRelDefinesByProperties"):
        try:
            related = getattr(rel, "RelatedObjects", None) or ()
            if not any(getattr(r, "id", lambda: -1)() == project_id for r in related):
                continue
            pset = rel.RelatingPropertyDefinition
            if not pset or not pset.is_a("IfcPropertySet"):
                continue
            for prop in getattr(pset, "HasProperties", []):
                total_props += 1
                if prop.Name and "ADIF" in prop.Name:
                    nv = getattr(prop, "NominalValue", None)
                    if nv and str(getattr(nv, "wrappedValue", "") or "").strip():
                        adif_count += 1
        except Exception:
            continue

    # Also check standard IfcProject attributes
    std_filled = sum(
        1 for attr in ("Name", "LongName", "Phase", "ObjectType")
        if getattr(project, attr, None)
    )

    return {
        "is_civil3d":          is_civil3d,
        "originating_system":  originating_system,
        "has_project":         True,
        "adif_with_values":    adif_count,
        "total_project_props": total_props,
        "std_attrs_filled":    std_filled,
        "project_name":        str(project.Name or ""),
        "project_long_name":   str(getattr(project, "LongName", None) or ""),
    }


@router.post("/apply-defaults")
async def apply_defaults(req: SyncRequest):
    """Apply project default parameters to an IFC file with {filename} placeholder resolution."""
    _guard_path(req.ifc_path)
    loop = asyncio.get_event_loop()
    try:
        return await loop.run_in_executor(None, _apply_defaults_sync, req)
    except HTTPException:
        raise
    except Exception as e:
        logger.error("[apply-defaults] EXCEPTION: %s", e)
        raise HTTPException(500, str(e))


def _apply_defaults_sync(req: "SyncRequest") -> dict:
    try:
        import ifcopenshell
        import ifcopenshell.guid
        import os

        ifc = ifcopenshell.open(req.ifc_path)
        project = ifc.by_type("IfcProject")[0]

        # Extract base filename without .ifc extension
        filename_base = os.path.basename(req.ifc_path).replace(".ifc", "").replace(".IFC", "")

        modified = 0
        workflow_log = {
            "file": os.path.basename(req.ifc_path),
            "steps": [
                {"step": "Cargar archivo", "status": "done", "detail": filename_base},
            ],
            "resolved_values": {},
        }

        # ── Step 1: Resolver placeholders {filename} / {currentmonth} ──
        resolved_params = []
        for param in req.params:
            pset_name = param.get("pset_name", "")
            prop_name = param.get("prop_name", "")
            value = param.get("prop_value", param.get("value", ""))

            # Check for {filename} placeholder
            if "{filename}" in str(value):
                native_name = _resolve_filename_placeholder(filename_base)
                value = str(value).replace("{filename}", native_name)
                workflow_log["resolved_values"][prop_name] = {
                    "original": param.get("prop_value", param.get("value", "")),
                    "resolved": value,
                }

            # {currentmonth} → nº natural del mes respecto a enero de 2022 (N=1),
            # calculado en el momento de la sincronización. Mismo cálculo que
            # Auto Info en los add-ins de Revit y Civil 3D.
            if str(value).strip().lower() == "{currentmonth}":
                from datetime import date
                today = date.today()
                value = str((today.year - 2022) * 12 + today.month)
                workflow_log["resolved_values"][prop_name] = {
                    "original": param.get("prop_value", param.get("value", "")),
                    "resolved": value,
                }

            resolved_params.append({
                "pset_name": pset_name,
                "prop_name": prop_name,
                "prop_value": value,
            })

        workflow_log["steps"].append({
            "step": "Resolver placeholders",
            "status": "done",
            "detail": f"{len(workflow_log['resolved_values'])} parámetros resueltos",
        })

        # ── Step 2: Aplicar parámetros ──

        # Pre-index existing psets — explicit ID comparison avoids entity __eq__ issues.
        existing_psets: dict[str, object] = {}
        project_id = project.id()
        for rel in ifc.by_type("IfcRelDefinesByProperties"):
            try:
                related = getattr(rel, "RelatedObjects", None) or ()
                if not any(getattr(r, "id", lambda: -1)() == project_id for r in related):
                    continue
                pd = rel.RelatingPropertyDefinition
                if pd and pd.is_a("IfcPropertySet"):
                    existing_psets[pd.Name] = pd
            except Exception:
                continue

        for param in resolved_params:
            pset_name = param.get("pset_name", "")
            prop_name = param.get("prop_name", "")
            value     = param.get("prop_value", param.get("value", ""))

            if not pset_name or not prop_name:
                continue

            # ── IfcProject standard attributes (Name, LongName, Phase, ObjectType…) ──
            # Sentinel must match ifc_sync.py's "IfcProject (Atributos)" and the
            # frontend's IFC_ATTRS_PSET — this used to be the English "Attributes",
            # which never matched, so these 5 rows silently fell through to the
            # PropertySet branch below and created a bogus custom pset instead of
            # setting the real IfcProject attributes.
            if pset_name == "IfcProject (Atributos)":
                if hasattr(project, prop_name):
                    try:
                        setattr(project, prop_name, value)
                        modified += 1
                    except Exception as ex:
                        logger.warning("[apply-defaults] ATTR %s: %s", prop_name, ex)
                continue

            # ── PropertySet approach ──
            try:
                pset = existing_psets.get(pset_name)

                if pset is None:
                    # Create pset and link it to the project
                    pset = ifc.create_entity(
                        "IfcPropertySet",
                        GlobalId=ifcopenshell.guid.new(),
                        OwnerHistory=None,
                        Name=pset_name,
                        HasProperties=(),   # empty tuple — ifcopenshell native type
                    )
                    ifc.create_entity(
                        "IfcRelDefinesByProperties",
                        GlobalId=ifcopenshell.guid.new(),
                        OwnerHistory=None,
                        RelatedObjects=[project],
                        RelatingPropertyDefinition=pset,
                    )
                    existing_psets[pset_name] = pset

                # ── Find existing property ──
                current_props = list(getattr(pset, "HasProperties", None) or [])
                existing_prop = next((p for p in current_props if p.Name == prop_name), None)

                if existing_prop is not None:
                    # Update in-place: replace wrappedValue if possible
                    try:
                        nv = getattr(existing_prop, "NominalValue", None)
                        if nv is not None:
                            nv.wrappedValue = value
                        else:
                            existing_prop.NominalValue = ifc.create_entity("IfcText", value)
                        modified += 1
                    except Exception:
                        # Fallback: remove old, add new
                        try:
                            ifc.remove(existing_prop)
                            current_props = [p for p in current_props if p.Name != prop_name]
                            new_p = ifc.create_entity(
                                "IfcPropertySingleValue",
                                Name=prop_name,
                                NominalValue=ifc.create_entity("IfcText", value), Unit=None,
                            )
                            current_props.append(new_p)
                            pset.HasProperties = current_props   # assign whole list (ifcopenshell accepts list)
                            modified += 1
                        except Exception as ex2:
                            logger.warning("[apply-defaults] PROP remove/recreate %s: %s", prop_name, ex2)
                else:
                    # Create new property
                    try:
                        new_p = ifc.create_entity(
                            "IfcPropertySingleValue",
                            Name=prop_name,
                            NominalValue=ifc.create_entity("IfcText", value), Unit=None,
                        )
                        # Assign full list back — avoids .append() on tuple
                        pset.HasProperties = current_props + [new_p]
                        modified += 1
                    except Exception as ex:
                        logger.warning("[apply-defaults] CREATE prop %s in %s: %s", prop_name, pset_name, ex)

            except Exception as ex:
                logger.warning("[apply-defaults] PSET %s/%s: %s", pset_name, prop_name, ex)

        workflow_log["steps"].append({
            "step": "Aplicar parámetros",
            "status": "done",
            "detail": f"{modified} propiedades modificadas",
        })

        atomic_write_model(ifc, req.ifc_path)
        logger.info("[apply-defaults] %s: %s props escritas", os.path.basename(req.ifc_path), modified)

        workflow_log["steps"].append({
            "step": "Guardar archivo",
            "status": "done",
            "detail": "Archivo guardado correctamente",
        })

        return {
            "ok": True,
            "modified": modified,
            "message": f"{modified} propiedades aplicadas",
            "workflow": workflow_log,
        }
    except Exception as e:
        logger.error("[apply-defaults] EXCEPTION: %s", e)
        raise HTTPException(500, str(e))


# ── IFC Structure ────────────────────────────────────────────────────────────

@router.get("/structure")
async def get_structure(path: str):
    """Return spatial hierarchy tree of an IFC file."""
    if not os.path.isfile(path):
        raise HTTPException(404, "File not found")
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _extract_structure, path)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _extract_structure(path: str):
    # Lectura pura → pool LRU compartido
    ifc = model_pool.get(path)

    schema = ifc.schema
    # Spatial containers stay in the tree (as nodes) but don't count toward the
    # "Elementos" stat — same reasoning as _extract_ifc_info's element_count.
    elements = [e for e in ifc.by_type("IfcProduct") if e.is_a().upper() not in _IFC_SPATIAL_CONTAINER_TYPES]
    psets = ifc.by_type("IfcPropertySet")

    def node(entity):
        name = getattr(entity, "Name", None) or entity.is_a()
        oid = getattr(entity, "GlobalId", None) or str(entity.id())
        children_rel = getattr(entity, "ContainsElements", []) or getattr(entity, "IsDecomposedBy", [])
        kids = []
        for rel in children_rel:
            related = getattr(rel, "RelatedElements", None) or getattr(rel, "RelatedObjects", None) or []
            for child in related:
                kids.append(node(child))
        return {"id": oid, "name": name, "type": entity.is_a(), "children": kids}

    projects = ifc.by_type("IfcProject")
    tree = [node(p) for p in projects]

    return {
        "schema": schema,
        "element_count": len(elements),
        "pset_count": len(psets),
        "tree": tree,
    }


# ── IFC Tree (lazy, grouped) ──────────────────────────────────────────────────
# Dynamic hierarchy explorer for the "Tree" frontend tool. /structure above
# materializes the FULL tree — one JSON node per element — in a single
# response, which is fine for small files but chokes (multi-second response,
# huge payload) on models with tens of thousands of elements. These two
# endpoints instead only ever return:
#   - the spatial skeleton (Project/Site/Building/Storey/Space…) — always a
#     handful of nodes, safe to return whole with an `element_count` per node
#   - the DIRECT children of ONE spatial node at a time, and only as raw
#     leaves when there are few of them — otherwise grouped by IFC class
#     (counts only), so a storey with 5000 walls never becomes 5000 JSON
#     nodes in one response. Expanding a group paginates through it.

_TREE_GROUP_THRESHOLD = 30   # more direct children than this → grouped by class
_TREE_PAGE_SIZE = 100        # elements returned per page once a group is opened


def _direct_elements(entity):
    """Physical elements attached directly to ONE structural/facility node.

    Two different patterns show up across this project's exports:
      - classic building models: elements hang off IfcRelContainedInSpatial
        Structure (`entity.ContainsElements`) on a Storey/Building.
      - this project's IFC4X3 railway/infra exports instead attach elements
        straight onto an IfcRailwayPart (or similar facility part) via
        IfcRelAggregates (`entity.IsDecomposedBy`) — there's no
        ContainsElements relation on those nodes at all.
    An IsDecomposedBy child only counts here if it's an actual IfcElement;
    anything else reached that way is a further structural node, not a leaf
    (see `_tree_skeleton_node`, which uses the same distinction in reverse).
    """
    contained = []
    for rel in getattr(entity, "ContainsElements", []) or []:
        contained.extend(getattr(rel, "RelatedElements", None) or [])
    if contained:
        return contained
    via_decomposition = []
    for rel in getattr(entity, "IsDecomposedBy", []) or []:
        for child in getattr(rel, "RelatedObjects", []) or []:
            if child.is_a("IfcElement"):
                via_decomposition.append(child)
    return via_decomposition


def _tree_skeleton_node(entity, depth=0):
    name = getattr(entity, "Name", None) or entity.is_a()
    guid = getattr(entity, "GlobalId", None)

    # Not filtered to IfcSite/IfcBuilding/IfcBuildingStorey on purpose: IFC4X3
    # infrastructure exports (this project's railway models included) nest
    # under their own facility types — IfcRailway, IfcRailwayPart, IfcFacility,
    # IfcFacilityPart… — which aren't in _IFC_SPATIAL_CONTAINER_TYPES. That
    # whitelist is only meaningful for the "Elementos" stat elsewhere; here we
    # just follow whatever IsDecomposedBy actually says, same as /structure
    # does — EXCEPT we stop at the first IfcElement instead of recursing into
    # it: in the railway exports elements attach via IsDecomposedBy too (see
    # `_direct_elements`), and without this check every wall/proxy/etc. would
    # become a permanent, eagerly-loaded skeleton node instead of a lazy leaf.
    # A depth cap guards against a pathological/cyclic decomposition chain.
    spatial_children = []
    if depth < 20:
        for rel in getattr(entity, "IsDecomposedBy", []) or []:
            for child in getattr(rel, "RelatedObjects", []) or []:
                if not child.is_a("IfcElement"):
                    spatial_children.append(_tree_skeleton_node(child, depth + 1))

    # Direct (non-recursive) count only — cheap, just relation/list lengths.
    element_count = len(_direct_elements(entity))

    return {
        "id": guid, "name": name, "type": entity.is_a(),
        "element_count": element_count,
        "children": spatial_children,
    }


@router.get("/tree/root")
async def get_tree_root(path: str):
    """Spatial skeleton only (Project→Site→Building→Storey…) — no elements.

    Always small, so it's safe to return in full in one shot. Each node
    carries `element_count` (direct, not recursive) so the frontend knows
    up front whether expanding it will trigger grouping.
    """
    if not os.path.isfile(path):
        raise HTTPException(404, "File not found")
    loop = asyncio.get_event_loop()

    def _build():
        ifc = model_pool.get(path)
        return [_tree_skeleton_node(p) for p in ifc.by_type("IfcProject")]

    try:
        tree = await loop.run_in_executor(None, _build)
        return {"tree": tree}
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/tree/children")
async def get_tree_children(
    path: str, node_id: str, group: Optional[str] = None,
    offset: int = 0, limit: int = _TREE_PAGE_SIZE,
):
    """Direct elements contained in ONE spatial node — grouped or paginated.

    - No `group`: few direct children → returned as leaves. Many → returned
      as class buckets with counts (`{"mode": "groups", ...}`), no elements.
    - `group=<IfcClass>`: paginate the elements of that class within the
      node via `offset`/`limit` — even one huge single-type bucket streams
      in pages instead of arriving as one giant response.
    """
    if not os.path.isfile(path):
        raise HTTPException(404, "File not found")
    loop = asyncio.get_event_loop()

    def _leaf(e):
        return {
            "id": getattr(e, "GlobalId", None),
            "name": getattr(e, "Name", None) or e.is_a(),
            "type": e.is_a(),
        }

    def _build():
        ifc = model_pool.get(path)
        entity = ifc.by_guid(node_id)
        if entity is None:
            raise HTTPException(404, "Node not found")

        contained = _direct_elements(entity)

        if group:
            filtered = [e for e in contained if e.is_a() == group]
            total = len(filtered)
            page = filtered[offset:offset + limit]
            return {
                "mode": "leaves", "items": [_leaf(e) for e in page], "total": total,
                "offset": offset, "limit": limit,
                "has_more": offset + limit < total,
            }

        total = len(contained)
        if total <= _TREE_GROUP_THRESHOLD:
            return {"mode": "leaves", "items": [_leaf(e) for e in contained], "total": total}

        counts = Counter(e.is_a() for e in contained)
        groups = [{"type": t, "count": c} for t, c in counts.most_common()]
        return {"mode": "groups", "groups": groups, "total": total}

    try:
        return await loop.run_in_executor(None, _build)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/element-properties")
async def get_element_properties(path: str, global_id: str):
    """Return all properties for a specific element — 4 sections."""
    if not os.path.isfile(path):
        raise HTTPException(404, "File not found")
    try:
        import ifcopenshell.util.element as elem_util
        # Lectura pura → pool LRU compartido
        ifc = model_pool.get(path)

        # Search in products AND spatial elements
        all_entities = list(ifc.by_type("IfcProduct")) + list(ifc.by_type("IfcSpatialElement"))
        entity = next((e for e in all_entities if getattr(e, "GlobalId", None) == global_id), None)
        if not entity:
            raise HTTPException(404, "Element not found")

        # ── TAB 1: Propiedades ────────────────────────────────────────────────
        psets = elem_util.get_psets(entity)
        attrs = {
            "GlobalId": getattr(entity, "GlobalId", None),
            "Name": getattr(entity, "Name", None),
            "Description": getattr(entity, "Description", None),
            "ObjectType": getattr(entity, "ObjectType", None),
            "Tag": getattr(entity, "Tag", None),
        }

        # ── TAB 2: Localización ───────────────────────────────────────────────
        location_data = _props_get_location(entity)

        # ── TAB 3: Clasificación ──────────────────────────────────────────────
        classification_data = _props_get_classification(entity, ifc)

        # ── TAB 4: Relaciones ─────────────────────────────────────────────────
        relations_data = _props_get_relations(entity, ifc, elem_util)

        return {
            "attributes": attrs,
            "psets": psets,
            "location": location_data,
            "classification": classification_data,
            "relations": relations_data,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


def _unwrap_uri(value):
    """Unwrap IfcURIReference or any simple-type wrapper to plain string."""
    if value is None:
        return None
    if hasattr(value, "wrappedValue"):
        return str(value.wrappedValue) or None
    s = str(value)
    return s if s else None


def _props_get_location(entity):
    """Extract spatial containment and absolute world coordinates."""
    contained_in = None
    try:
        for rel in (getattr(entity, "ContainedInStructure", None) or []):
            parent = rel.RelatingStructure
            contained_in = {
                "type": parent.is_a(),
                "name": getattr(parent, "Name", None) or parent.is_a(),
            }
            break
    except Exception:
        pass

    coords = None
    try:
        placement = getattr(entity, "ObjectPlacement", None)
        if placement:
            import ifcopenshell.util.placement as ifc_pl
            import numpy as np
            matrix = ifc_pl.get_local_placement(placement)
            # matrix is 4x4; column 3 is the translation (world coordinates)
            def fmt(v):
                try:
                    return f"{float(v):.4f} m"
                except Exception:
                    return str(v)
            coords = {
                "x": fmt(matrix[0][3]),
                "y": fmt(matrix[1][3]),
                "z": fmt(matrix[2][3]),
            }
    except Exception:
        # Fallback: read relative placement directly
        try:
            placement = getattr(entity, "ObjectPlacement", None)
            if placement:
                rp = getattr(placement, "RelativePlacement", None)
                if rp:
                    loc = getattr(rp, "Location", None)
                    if loc and hasattr(loc, "Coordinates"):
                        c = loc.Coordinates
                        def fmt(v):
                            try:
                                return f"{float(v):.4f} m"
                            except Exception:
                                return str(v)
                        coords = {
                            "x": fmt(c[0]) if len(c) > 0 and c[0] is not None else "—",
                            "y": fmt(c[1]) if len(c) > 1 and c[1] is not None else "—",
                            "z": fmt(c[2]) if len(c) > 2 and c[2] is not None else "—",
                        }
        except Exception:
            pass

    return {"contained_in": contained_in, "coordinates": coords}


def _props_get_classification(entity, ifc):
    """Extract IfcClassificationReference data."""
    result = {}
    try:
        for rel in ifc.by_type("IfcRelAssociatesClassification"):
            related = getattr(rel, "RelatedObjects", []) or []
            if entity not in related:
                continue
            ref = rel.RelatingClassification
            if ref is None:
                continue

            if ref.is_a("IfcClassificationReference"):
                src = getattr(ref, "ReferencedSource", None)
                cls_name = fuente = edicion = fecha_ed = cls_loc = None
                if src and src.is_a("IfcClassification"):
                    cls_name = getattr(src, "Name", None)
                    fuente = getattr(src, "Source", None)
                    edicion = getattr(src, "Edition", None)
                    ed_date = getattr(src, "EditionDate", None)
                    if ed_date:
                        try:
                            cls_edition_date = str(ed_date)
                        except Exception:
                            cls_edition_date = None
                        fecha_ed = cls_edition_date
                    cls_loc = _unwrap_uri(getattr(src, "Location", None)) or _unwrap_uri(getattr(src, "Description", None))

                key = cls_name or ref.is_a()
                result[key] = {
                    "nombre": cls_name,
                    "fuente": fuente,
                    "edicion": edicion,
                    "fecha_edicion": fecha_ed,
                    "localizacion": cls_loc,
                    "referencia": {
                        "clasificacion": (
                            getattr(ref, "Identification", None)
                            or getattr(ref, "ItemReference", None)
                        ),
                        "nombre": getattr(ref, "Name", None),
                        "localizacion": _unwrap_uri(
                            getattr(ref, "Location", None)
                            or getattr(ref, "Description", None)
                        ),
                    },
                }
            elif ref.is_a("IfcClassification"):
                cls_name = getattr(ref, "Name", None) or ref.is_a()
                result[cls_name] = {
                    "nombre": cls_name,
                    "fuente": getattr(ref, "Source", None),
                    "edicion": getattr(ref, "Edition", None),
                    "fecha_edicion": None,
                    "localizacion": getattr(ref, "Location", None),
                    "referencia": None,
                }
    except Exception:
        pass
    return result


def _props_get_relations(entity, ifc, elem_util):
    """Extract type object, material, related psets, classifications, spatial structure."""
    type_obj = None
    try:
        for rel in ifc.by_type("IfcRelDefinesByType"):
            related = getattr(rel, "RelatedObjects", []) or []
            if entity in related:
                t = rel.RelatingType
                if t:
                    type_psets = []
                    try:
                        type_psets = list(elem_util.get_psets(t).keys())
                    except Exception:
                        pass
                    type_obj = {
                        "identity": t.is_a(),
                        "nombre": getattr(t, "Name", None),
                        "guid": getattr(t, "GlobalId", None),
                        "psets": type_psets,
                    }
                break
    except Exception:
        pass

    mat_name = None
    try:
        mats = elem_util.get_materials(entity)
        if mats:
            mat_name = getattr(mats[0], "Name", None) or str(mats[0])
    except Exception:
        pass

    cls_names = []
    try:
        for rel in ifc.by_type("IfcRelAssociatesClassification"):
            related = getattr(rel, "RelatedObjects", []) or []
            if entity in related:
                ref = rel.RelatingClassification
                if ref:
                    if ref.is_a("IfcClassificationReference"):
                        src = getattr(ref, "ReferencedSource", None)
                        name = getattr(src, "Name", None) if src else getattr(ref, "Name", None)
                    else:
                        name = getattr(ref, "Name", None)
                    if name:
                        cls_names.append(name)
    except Exception:
        pass

    spatial = None
    try:
        for rel in (getattr(entity, "ContainedInStructure", None) or []):
            parent = rel.RelatingStructure
            spatial = {
                "type": parent.is_a(),
                "name": getattr(parent, "Name", None) or parent.is_a(),
            }
            break
    except Exception:
        pass

    return {
        "type_object": type_obj,
        "material": mat_name,
        "classifications": cls_names,
        "spatial_structure": spatial,
    }


# ── Update property (inline edit) ─────────────────────────────────────────────

class UpdatePropertyRequest(BaseModel):
    path: str
    global_id: str
    pset_name: str   # "__attr__" → base attribute; otherwise pset name
    prop_name: str
    value: str


@router.post("/update-property")
async def update_property(req: UpdatePropertyRequest):
    """Update a single property value and write back the IFC file."""
    _guard_path(req.path)
    if not os.path.isfile(req.path):
        raise HTTPException(404, "File not found")
    try:
        import ifcopenshell
        import ifcopenshell.util.element as elem_util
        ifc = ifcopenshell.open(req.path)

        all_entities = list(ifc.by_type("IfcProduct")) + list(ifc.by_type("IfcSpatialElement"))
        entity = next((e for e in all_entities if getattr(e, "GlobalId", None) == req.global_id), None)
        if not entity:
            raise HTTPException(404, "Element not found")

        if req.pset_name == "__attr__":
            editable = {"Name", "Description", "ObjectType", "Tag"}
            if req.prop_name not in editable:
                raise HTTPException(400, f"Attribute '{req.prop_name}' is not editable")
            setattr(entity, req.prop_name, req.value or None)
        else:
            updated = False
            for rel in ifc.by_type("IfcRelDefinesByProperties"):
                related = getattr(rel, "RelatedObjects", []) or []
                if entity not in related:
                    continue
                pset = rel.RelatingPropertyDefinition
                if getattr(pset, "Name", None) != req.pset_name:
                    continue
                for prop in (getattr(pset, "HasProperties", []) or []):
                    if getattr(prop, "Name", None) != req.prop_name:
                        continue
                    nv = getattr(prop, "NominalValue", None)
                    if nv is not None:
                        # Coerción al tipo actual con degradación a string
                        nv.wrappedValue = coerce_property_value(prop, req.value)
                    else:
                        prop.NominalValue = ifc.create_entity("IfcLabel", req.value)
                    updated = True
                    break
                if updated:
                    break
            if not updated:
                raise HTTPException(404, f"Property '{req.prop_name}' not found in pset '{req.pset_name}'")

        atomic_write_model(ifc, req.path)
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


# ── Value Search ─────────────────────────────────────────────────────────────

@router.get("/value-search")
async def value_search(path: str, query: str = "", pset: str = ""):
    """Search for elements matching a value across property sets."""
    if not os.path.isfile(path):
        raise HTTPException(404, "File not found")
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _do_value_search, path, query, pset)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _do_value_search(path: str, query: str, pset_filter: str):
    """Same persistent SQLite property index as Sets — a substring search
    over already-extracted flat rows, instead of opening the IFC and calling
    get_psets() per element."""
    db_path = _get_property_index_db(path)
    if not db_path:
        return {"results": [], "total": 0}

    q = f"%{query.lower()}%"
    pset_q = f"%{pset_filter.lower()}%"

    conn = sqlite3.connect(db_path)
    try:
        sql = """
            SELECT e.global_id, e.name, e.ifc_class, p.pset_name, p.prop_name, p.value
            FROM properties p JOIN elements e ON e.step_id = p.step_id
            WHERE (? = '' OR lower(p.pset_name) LIKE ?)
              AND (? = '' OR lower(p.prop_name) LIKE ? OR lower(p.value) LIKE ?)
        """
        params = [pset_filter, pset_q, query, q, q]
        all_rows = conn.execute(sql, params).fetchall()
    finally:
        conn.close()

    rows = [
        {
            "global_id": global_id,
            "element_name": name or ifc_class,
            "element_type": ifc_class,
            "pset": pset_name,
            "prop_name": prop_name,
            "value": value,
        }
        for global_id, name, ifc_class, pset_name, prop_name, value in all_rows
    ]
    return {"results": rows[:500], "total": len(rows)}


# ── Add property to PSet (multi-file) ────────────────────────────────────────

class AddPropertyToPsetRequest(BaseModel):
    paths: list[str]
    pset_name: str
    prop_name: str
    default_value: str = ""


@router.post("/add-property-to-pset")
async def add_property_to_pset(req: AddPropertyToPsetRequest):
    """Add a new IfcPropertySingleValue to every instance of a PSet across files."""
    _guard_path(*req.paths)
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            None, _add_property_to_pset, req.paths, req.pset_name, req.prop_name, req.default_value
        )
        _invalidate_caches(req.paths)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _add_property_to_pset(paths: list[str], pset_name: str, prop_name: str, default_value: str):
    """Añade una propiedad a un Pset en cada archivo.

    Aislamiento de lote (H3): un archivo que falle (IFC bloqueado, corrupto,
    disco lleno) NO aborta el resto; su error se acumula y se devuelve. Cada
    archivo se procesa bajo el lock transaccional del pool (H1): mutate+write
    atómico sin que ningún lector vea el modelo a medio mutar.
    """
    added_total = 0
    processed: list[str] = []
    errors: list[dict] = []
    for path in paths:
        if not os.path.isfile(path):
            errors.append({"path": path, "error": "archivo no encontrado"})
            continue
        try:
            with repo.transaction(path) as ifc:
                added = 0
                for pset in ifc.by_type("IfcPropertySet"):
                    if getattr(pset, "Name", None) != pset_name:
                        continue
                    existing = {p.Name for p in (getattr(pset, "HasProperties", None) or [])}
                    if prop_name in existing:
                        continue
                    new_prop = ifc.create_entity(
                        "IfcPropertySingleValue",
                        Name=prop_name,
                        NominalValue=ifc.create_entity("IfcLabel", default_value or ""),
                    )
                    pset.HasProperties = list(getattr(pset, "HasProperties", None) or []) + [new_prop]
                    added += 1
                if added > 0:
                    repo.write(ifc, path)
                added_total += added
                processed.append(path)
        except Exception as exc:
            logger.warning("add_property_to_pset falló en %s: %s", path, exc)
            errors.append({"path": path, "error": str(exc)[:200]})
    return {"added": added_total, "ok": True, "processed": processed, "errors": errors}


# ── Assign value to empty elements (multi-file) ───────────────────────────────

class AssignEmptyValueRequest(BaseModel):
    paths: list[str]
    pset_name: str
    prop_name: str
    new_value: str


@router.post("/assign-empty-value")
async def assign_empty_value(req: AssignEmptyValueRequest):
    """Set new_value on all elements where the property currently has an empty/null value."""
    _guard_path(*req.paths)
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            None, _assign_empty_value, req.paths, req.pset_name, req.prop_name, req.new_value
        )
        _invalidate_caches(req.paths)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _assign_empty_value(paths: list[str], pset_name: str, prop_name: str, new_value: str):
    """Asigna un valor a las propiedades vacías en cada archivo.

    Aislamiento de lote (H3) + transacción por archivo (H1): un archivo que
    falle no aborta el resto; sus errores se devuelven en ``errors``.
    """
    updated_total = 0
    processed: list[str] = []
    errors: list[dict] = []
    for path in paths:
        if not os.path.isfile(path):
            errors.append({"path": path, "error": "archivo no encontrado"})
            continue
        try:
            with repo.transaction(path) as ifc:
                updated = 0
                for rel in ifc.by_type("IfcRelDefinesByProperties"):
                    pset = rel.RelatingPropertyDefinition
                    if getattr(pset, "Name", None) != pset_name:
                        continue
                    for prop in (getattr(pset, "HasProperties", None) or []):
                        if getattr(prop, "Name", None) != prop_name:
                            continue
                        nv = getattr(prop, "NominalValue", None)
                        current = ""
                        if nv is not None:
                            current = str(nv.wrappedValue) if hasattr(nv, "wrappedValue") else str(nv)
                        if current.strip():
                            continue  # skip non-empty
                        if nv is not None:
                            nv.wrappedValue = coerce_property_value(prop, new_value)
                        else:
                            prop.NominalValue = ifc.create_entity("IfcLabel", new_value)
                        updated += 1
                if updated > 0:
                    repo.write(ifc, path)
                updated_total += updated
                processed.append(path)
        except Exception as exc:
            logger.warning("assign_empty_value falló en %s: %s", path, exc)
            errors.append({"path": path, "error": str(exc)[:200]})
    return {"updated": updated_total, "ok": True, "processed": processed, "errors": errors}


# ── Cache invalidation helper ────────────────────────────────────────────────

def _invalidate_caches(paths: list[str]):
    """Called after writes. No-op by design: the persistent property index
    (see _get_property_index_db) keys itself by mtime+size, and this always runs
    AFTER the write already changed those — so by the time this runs, the
    file's CURRENT mtime/size point at an entry that doesn't exist yet, not
    the stale one. Same convention already used by services/ifc_sync.py's
    material cache: a changed file just misses the cache next read, nothing
    to proactively delete. Kept as a named call site (rather than removing it
    from the 3 call sites below) so a future cache that isn't naturally
    self-invalidating has one obvious place to hook into."""
    pass


# ── PSets index (multi-file) ─────────────────────────────────────────────────

@router.get("/psets-index")
async def psets_index(paths: list[str] = Query(...)):
    """Return all psets across multiple IFC files with element and prop counts."""
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _build_psets_index, paths)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _build_psets_index(paths: list[str]):
    """Merges the persistent per-file SQLite property index (see
    _get_property_index_db above) across every selected file — a handful of
    small indexed SQL queries, instead of opening and walking every
    IfcProduct on every single call (that used to be the actual cost: it
    fires on every checkbox change)."""
    pset_data: dict = {}
    for path in paths:
        if not os.path.isfile(path):
            continue
        db_path = _get_property_index_db(path)
        if not db_path:
            continue
        conn = sqlite3.connect(db_path)
        try:
            for pset_name, elem_count in conn.execute(
                "SELECT pset_name, COUNT(DISTINCT step_id) FROM properties GROUP BY pset_name"
            ):
                pset_data.setdefault(pset_name, {"props": set(), "element_count": 0})["element_count"] += elem_count
            for pset_name, prop_name in conn.execute(
                "SELECT DISTINCT pset_name, prop_name FROM properties"
            ):
                pset_data.setdefault(pset_name, {"props": set(), "element_count": 0})["props"].add(prop_name)
        finally:
            conn.close()

    result = []
    for name, data in sorted(pset_data.items()):
        result.append({
            "name": name,
            "prop_count": len(data["props"]),
            "element_count": data["element_count"],
            "props": sorted(data["props"]),
        })

    return {"psets": result}


# ── Property values (multi-file) ─────────────────────────────────────────────

@router.get("/property-values")
async def property_values(
    paths: list[str] = Query(...),
    pset: str = "",
    prop: str = "",
):
    """Return unique values with element counts for a specific property across files."""
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _get_property_values, paths, pset, prop)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _get_property_values(paths: list[str], pset_name: str, prop_name: str):
    """Merges an indexed SQL query across every selected file's persistent
    property index — matched purely by property name (see
    _iter_instances_with_prop's docstring for why `pset_name` is accepted but
    never used to filter). No IFC is opened at all unless its index is
    missing or stale."""
    value_counts: dict = {}
    for path in paths:
        if not os.path.isfile(path):
            continue
        db_path = _get_property_index_db(path)
        if not db_path:
            continue
        conn = sqlite3.connect(db_path)
        try:
            for sval, count in conn.execute(
                "SELECT value, COUNT(*) FROM properties WHERE prop_name = ? GROUP BY value", (prop_name,)
            ):
                value_counts[sval] = value_counts.get(sval, 0) + count
        finally:
            conn.close()

    # Sort by frequency — keep ALL values
    values = sorted(
        [{"value": v, "count": c} for v, c in value_counts.items()],
        key=lambda x: -x["count"],
    )

    return {
        "values": values,
        "total_elements": sum(value_counts.values()),
        "unique_count": len(value_counts),
    }


@router.get("/elements-by-value")
async def elements_by_value(
    paths: list[str] = Query(...),
    pset: str = "",
    prop: str = "",
    value: str = "",
):
    """Devuelve los elementos que tienen pset+prop=value. Usado por VALUE SEARCH panel 4."""
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _get_elements_by_value, paths, pset, prop, value)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _get_elements_by_value(paths: list[str], pset_name: str, prop_name: str, value: str):
    import ifcopenshell
    import ifcopenshell.util.element as eu
    rows = []
    for path in paths:
        if not os.path.isfile(path):
            continue
        filename = os.path.basename(path)
        try:
            ifc = ifcopenshell.open(path)
            for entity in ifc.by_type("IfcProduct"):
                try:
                    psets = eu.get_psets(entity)
                    if pset_name not in psets:
                        continue
                    props = psets[pset_name]
                    if prop_name not in props:
                        continue
                    val = props[prop_name]
                    sval = str(val) if val is not None else ""
                    if sval != value:
                        continue
                    rows.append({
                        "name": getattr(entity, "Name", None) or entity.is_a(),
                        "entity_type": entity.is_a(),
                        "global_id": getattr(entity, "GlobalId", ""),
                        "filename": filename,
                        "path": path,
                        "step_id": entity.id(),
                    })
                except Exception:
                    continue
        except Exception:
            continue
    rows.sort(key=lambda r: (r["filename"], r["entity_type"], r["name"]))
    return {"elements": rows, "total": len(rows)}


class EditElementPropertyRequest(BaseModel):
    path: str
    step_id: int
    pset_name: str
    prop_name: str
    new_value: str


@router.post("/edit-element-property")
async def edit_element_property(req: EditElementPropertyRequest):
    """Edita la propiedad de un único elemento (por step_id) en su Pset."""
    _guard_path(req.path)
    if not os.path.isfile(req.path):
        raise HTTPException(404, "File not found")
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            None, _edit_element_property, req.path, req.step_id, req.pset_name, req.prop_name, req.new_value
        )
        # No cache to clear — see _invalidate_caches' docstring: the persistent
        # property index self-invalidates on the edited file's new mtime.
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _edit_element_property(path: str, step_id: int, pset_name: str, prop_name: str, new_value: str):
    import ifcopenshell
    import ifcopenshell.util.element as eu
    ifc = ifcopenshell.open(path)
    try:
        entity = ifc.by_id(step_id)
    except Exception:
        return {"ok": False, "error": "Element not found"}
    if entity is None:
        return {"ok": False, "error": "Element not found"}
    psets = eu.get_psets(entity, verbose=True)
    if pset_name not in psets:
        return {"ok": False, "error": f"PSet '{pset_name}' not found on element"}
    pset_data = psets[pset_name]
    # verbose=True returns {prop_name: {"id": entity_id, "value": val, ...}}
    prop_info = pset_data.get(prop_name)
    if prop_info is None:
        return {"ok": False, "error": f"Property '{prop_name}' not found in PSet"}
    try:
        prop_entity = ifc.by_id(prop_info["id"])
        coerced = coerce_property_value(prop_entity, new_value)
        if isinstance(coerced, str):
            prop_entity.NominalValue = ifc.create_entity("IfcLabel", wrappedValue=coerced)
        else:
            # Conservar el tipo del wrappedValue existente (int/float/bool)
            prop_entity.NominalValue.wrappedValue = coerced
    except Exception as e:
        return {"ok": False, "error": str(e)}
    atomic_write_model(ifc, path)
    return {"ok": True}


# ── Precalculate all values for a PSet (multi-file) ────────────────────────────
# Structural optimization: load all values for a pset at once, then cache them

@router.get("/precalculate-pset-values")
async def precalculate_pset_values(
    paths: list[str] = Query(...),
    pset: str = "",
):
    """Pre-calculate ALL property values for a PSet. Returns a map {prop: {values, counts}}."""
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _precalc_pset_values, paths, pset)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _precalc_pset_values(paths: list[str], pset_name: str):
    """Same persistent SQLite index as _build_psets_index/_get_property_values,
    just returning every property of ONE literal pset name at once (used by
    the frontend's background pre-cache hook to warm up a whole pset in one
    call — and, as a side effect, to trigger the index BUILD in the
    background before the user ever opens a search panel)."""
    all_props: dict = {}  # {prop_name: {value: count}}

    for path in paths:
        if not os.path.isfile(path):
            continue
        db_path = _get_property_index_db(path)
        if not db_path:
            continue
        conn = sqlite3.connect(db_path)
        try:
            for prop_name, sval, count in conn.execute(
                "SELECT prop_name, value, COUNT(*) FROM properties WHERE pset_name = ? "
                "GROUP BY prop_name, value",
                (pset_name,),
            ):
                bucket = all_props.setdefault(prop_name, {})
                bucket[sval] = bucket.get(sval, 0) + count
        finally:
            conn.close()

    result_props = {}
    for prop_name, value_counts in all_props.items():
        values = sorted(
            [{"value": v, "count": c} for v, c in value_counts.items()],
            key=lambda x: -x["count"],
        )
        result_props[prop_name] = {
            "values": values,
            "total_elements": sum(value_counts.values()),
            "unique_count": len(value_counts),
        }

    return {
        "pset": pset_name,
        "properties": result_props,
    }


# ── Bulk-edit property (multi-file) ──────────────────────────────────────────

class BulkEditPropertyRequest(BaseModel):
    paths: list[str]
    pset_name: str
    prop_name: str
    old_value: str
    new_value: str


@router.post("/bulk-edit-property")
async def bulk_edit_property(req: BulkEditPropertyRequest):
    """Replace old_value with new_value for a property across all matching elements in given files."""
    _guard_path(*req.paths)
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            None, _do_bulk_edit, req.paths, req.pset_name, req.prop_name, req.old_value, req.new_value
        )
        # Invalidate backend caches after write
        _invalidate_caches(req.paths)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _do_bulk_edit(paths: list[str], pset_name: str, prop_name: str, old_value: str, new_value: str):
    import ifcopenshell
    import ifcopenshell.util.element as eu
    updated_total = 0
    for path in paths:
        if not os.path.isfile(path):
            continue
        ifc = ifcopenshell.open(path)
        updated = 0
        for rel in ifc.by_type("IfcRelDefinesByProperties"):
            pset = rel.RelatingPropertyDefinition
            if getattr(pset, "Name", None) != pset_name:
                continue
            for prop in (getattr(pset, "HasProperties", []) or []):
                if getattr(prop, "Name", None) != prop_name:
                    continue
                nv = getattr(prop, "NominalValue", None)
                if nv is None:
                    continue
                current = str(nv.wrappedValue) if hasattr(nv, "wrappedValue") else str(nv)
                if current != old_value:
                    continue
                nv.wrappedValue = coerce_property_value(prop, new_value)
                updated += 1
        if updated > 0:
            atomic_write_model(ifc, path)
        updated_total += updated
    return {"updated": updated_total, "ok": True}


# ── Materials ────────────────────────────────────────────────────────────────

@router.get("/materials")
async def get_materials(path: str):
    """Extract material assignments from IFC file."""
    if not os.path.isfile(path):
        raise HTTPException(404, "File not found")
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _extract_materials, path)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _extract_materials(path: str):
    import ifcopenshell.util.element as elem_util
    # Lectura pura → pool LRU compartido
    ifc = model_pool.get(path)
    rows = []
    for entity in ifc.by_type("IfcProduct"):
        mats = elem_util.get_materials(entity)
        mat_names = [m.Name for m in mats if hasattr(m, "Name") and m.Name]
        if not mat_names:
            mat_names = ["—"]
        rows.append({
            "global_id": getattr(entity, "GlobalId", ""),
            "name": getattr(entity, "Name", "") or entity.is_a(),
            "type": entity.is_a(),
            "materials": mat_names,
        })
    # group by material
    mat_groups: dict = {}
    for r in rows:
        for m in r["materials"]:
            if m not in mat_groups:
                mat_groups[m] = {"material": m, "count": 0, "elements": []}
            mat_groups[m]["count"] += 1
            mat_groups[m]["elements"].append({"name": r["name"], "type": r["type"]})
    return {
        "rows": rows[:300],
        "groups": list(mat_groups.values()),
        "total": len(rows),
    }


# ── Material tool (cascada: tipos → elementos → materiales) ──────────────────

class MaterialPathsRequest(BaseModel):
    paths: list[str]


@router.post("/material/file-mtimes")
async def material_file_mtimes(req: MaterialPathsRequest):
    """Retorna {path: mtime} para cada archivo. Solo usa os.stat (sin abrir modelos IFC).
    Llamada ultrarrápida: permite al frontend validar su caché sessionStorage antes
    de decidir si necesita disparar una petición /entity-types costosa."""
    result: dict[str, float] = {}
    for p in req.paths:
        try:
            if os.path.isfile(p):
                result[p] = os.path.getmtime(p)
        except Exception:
            pass
    return {"file_mtimes": result}


@router.post("/material/warm")
async def material_warm(req: MaterialPathsRequest, background_tasks: BackgroundTasks):
    """Pre-carga modelos IFC en pool LRU + entity-type cache (fire-and-forget).
    Llamar desde el sidebar cuando el usuario selecciona archivos, ANTES de navegar a IFC Material.
    Retorna inmediatamente; el trabajo real ocurre en background."""
    from services.ifc_sync import get_entity_type_rows
    loop = asyncio.get_event_loop()
    valid_paths = [p for p in req.paths if os.path.isfile(p)]

    async def _warm_all():
        await asyncio.gather(
            *[loop.run_in_executor(None, get_entity_type_rows, p) for p in valid_paths],
            return_exceptions=True,
        )

    background_tasks.add_task(_warm_all)
    return {"ok": True, "warming": len(valid_paths)}


@router.post("/material/entity-types")
async def material_entity_types(req: MaterialPathsRequest):
    """Tipos de entidad con asignación de material, agregados de todos los archivos.
    Retorna {rows: [{entity_type, element_count}], file_mtimes: {path: mtime}} ordenado por count desc."""
    from services.ifc_sync import get_entity_type_rows
    loop = asyncio.get_event_loop()
    valid_paths = [p for p in req.paths if os.path.isfile(p)]

    async def _fetch(path: str):
        try:
            rows = await loop.run_in_executor(None, get_entity_type_rows, path)
            mtime = os.path.getmtime(path)
            return path, rows, mtime
        except Exception:
            return path, [], 0.0

    results = await asyncio.gather(*[_fetch(p) for p in valid_paths])
    merged: dict[str, int] = {}
    file_mtimes: dict[str, float] = {}
    for path, rows, mtime in results:
        file_mtimes[path] = mtime
        for r in rows:
            merged[r["entity_type"]] = merged.get(r["entity_type"], 0) + r["element_count"]
    result = [{"entity_type": k, "element_count": v} for k, v in merged.items()]
    result.sort(key=lambda x: -x["element_count"])
    return {"rows": result, "file_mtimes": file_mtimes}


class MaterialElementsRequest(BaseModel):
    paths: list[str]
    entity_types: list[str]


@router.post("/material/elements")
async def material_elements(req: MaterialElementsRequest):
    """Elementos con material, filtrados por tipo de entidad.
    Retorna [{uid, name, step_id, entity_type, material_name, mat_color, path, filename}]."""
    from services.ifc_sync import get_elements_for_types
    if not req.entity_types:
        return {"rows": []}
    loop = asyncio.get_event_loop()
    valid_paths = [p for p in req.paths if os.path.isfile(p)]

    async def _fetch(path: str):
        fname = os.path.basename(path)
        try:
            elems = await loop.run_in_executor(None, get_elements_for_types, path, req.entity_types)
            return [{"uid": f"{path}::{e['step_id']}", "path": path, "filename": fname, **e} for e in elems]
        except Exception:
            return []

    results = await asyncio.gather(*[_fetch(p) for p in valid_paths])
    all_rows = [row for file_rows in results for row in file_rows]
    all_rows.sort(key=lambda x: (x["entity_type"], x["name"].lower()))
    return {"rows": all_rows}


class MaterialGroupsRequest(BaseModel):
    # {path: [step_ids]}
    elements_by_path: dict[str, list[int]]


@router.post("/material/materials")
async def material_groups(req: MaterialGroupsRequest):
    """Materiales agregados de los elementos seleccionados (por step_id).
    Retorna [{name, element_count, color, file_count, multi_file}]."""
    from services.ifc_sync import get_materials_for_elements
    loop = asyncio.get_event_loop()
    merged: dict[str, dict] = {}
    for path, step_ids in req.elements_by_path.items():
        if not os.path.isfile(path) or not step_ids:
            continue
        try:
            mats = await loop.run_in_executor(None, get_materials_for_elements, path, step_ids)
            for m in mats:
                g = merged.get(m["name"])
                if not g:
                    g = {"name": m["name"], "element_count": 0, "color": m["color"], "_files": set()}
                    merged[m["name"]] = g
                g["element_count"] += m["element_count"]
                g["_files"].add(path)
        except Exception:
            pass
    result = []
    for g in merged.values():
        fc = len(g.pop("_files"))
        result.append({**g, "file_count": fc, "multi_file": fc > 1})
    result.sort(key=lambda x: -x["element_count"])
    return {"rows": result}


class MaterialRenameOp(BaseModel):
    path: str
    old_material: str
    new_material: str
    step_ids: list[int]


class MaterialRenameRequest(BaseModel):
    ops: list[MaterialRenameOp]


@router.post("/material/rename")
async def material_rename(req: MaterialRenameRequest):
    """Renombra material para los elementos indicados.

    Agrupa las ops por archivo y aplica TODAS las de un mismo archivo en una
    sola transacción (rename_material_ops_for_path): una única escritura a
    disco por archivo sin importar cuántos materiales distintos se renombren
    en la misma request. Antes se escribía el IFC completo una vez POR
    operación — con archivos de cientos de MB eso multiplicaba minutos de
    espera por cada material adicional que el usuario cambiara de una vez.
    Retorna total de elementos modificados."""
    from services.ifc_sync import rename_material_ops_for_path
    loop = asyncio.get_event_loop()
    total = 0
    errors: list[str] = []

    by_path: dict[str, list[tuple[str, str, list[int]]]] = {}
    for op in req.ops:
        if not os.path.isfile(op.path):
            continue
        by_path.setdefault(op.path, []).append((op.old_material, op.new_material, op.step_ids))

    for path, ops in by_path.items():
        try:
            async with _get_file_lock(path):
                ok, msg, changed = await loop.run_in_executor(
                    None, rename_material_ops_for_path, path, ops,
                )
            total += changed
            # Se reporta CUALQUIER fallo, incluido "no encontrado": antes ese
            # caso se descartaba aquí y el usuario recibía un banner en VERDE
            # de "0 elemento(s) guardados" como si hubiera ido bien, cuando en
            # realidad el material no se tocó. Un 0 silencioso es peor que un
            # error, porque parece éxito.
            if not ok and msg:
                errors.append(f"{os.path.basename(path)}: {msg}")
        except Exception as e:
            errors.append(f"{os.path.basename(path)}: {e}")
    return {"ok": True, "total_changed": total, "errors": errors}


class MaterialExportRequest(BaseModel):
    element_rows: list[dict]          # filas tal como las tiene el frontend
    filter_material: Optional[str] = None


@router.post("/material/export-excel")
async def material_export_excel(req: MaterialExportRequest):
    """Genera un Excel con las filas de elementos. Retorna xlsx en base64."""
    from services.ifc_sync import export_materials_excel
    loop = asyncio.get_event_loop()
    try:
        data = await loop.run_in_executor(
            None, export_materials_excel, req.element_rows, req.filter_material,
        )
        return {"ok": True, "filename": "materiales_ifc.xlsx",
                "base64": base64.b64encode(data).decode("ascii")}
    except Exception as e:
        raise HTTPException(500, str(e))


@router.post("/material/import-excel-preview")
async def material_import_excel_preview(file: UploadFile = File(...), folder: str = Form("")):
    """Lee un Excel y detecta cambios de material vs los IFC en disco.
    Retorna preview: [{uid, ifc_file, path, step_id, element_name, entity_type, old_material, new_material}]."""
    from services.ifc_sync import parse_excel_material_changes
    content = await file.read()
    loop = asyncio.get_event_loop()
    try:
        changes = await loop.run_in_executor(None, parse_excel_material_changes, content, folder)
        return {"ok": True, "changes": changes}
    except Exception as e:
        raise HTTPException(500, str(e))


class MaterialImportApplyRequest(BaseModel):
    # cambios del preview: [{path, step_id, old_material, new_material}]
    changes: list[dict]


@router.post("/material/import-excel-apply")
async def material_import_excel_apply(req: MaterialImportApplyRequest):
    """Aplica los cambios detectados desde Excel. Agrupa por path (una sola
    escritura a disco por archivo, aunque el Excel traiga varios materiales
    distintos para el mismo IFC)."""
    from collections import defaultdict
    from services.ifc_sync import rename_material_ops_for_path
    by_path: dict = defaultdict(lambda: defaultdict(list))
    for c in req.changes:
        by_path[c["path"]][(c["old_material"], c["new_material"])].append(int(c["step_id"]))
    loop = asyncio.get_event_loop()
    total = 0
    for path, groups in by_path.items():
        if not os.path.isfile(path):
            continue
        ops = [(old, new, step_ids) for (old, new), step_ids in groups.items()]
        try:
            async with _get_file_lock(path):
                ok, msg, changed = await loop.run_in_executor(
                    None, rename_material_ops_for_path, path, ops,
                )
            total += changed
        except Exception:
            pass
    return {"ok": True, "total_changed": total}


@router.post("/material/sync-all-to-psets")
async def material_sync_all_to_psets(req: MaterialPathsRequest):
    """Sincroniza TODOS los IfcMaterial con la propiedad texto 'Material' en Psets.
    Procesa todos los archivos indicados y retorna totales."""
    from services.ifc_sync import sync_all_materials_to_psets
    loop = asyncio.get_event_loop()
    total_elements = 0
    total_psets = 0
    errors = []
    processed = []
    for path in req.paths:
        if not os.path.isfile(path):
            errors.append(f"No encontrado: {path}")
            continue
        try:
            async with _get_file_lock(path):
                elems, psets = await loop.run_in_executor(None, sync_all_materials_to_psets, path)
            total_elements += elems
            total_psets += psets
            processed.append(path)
        except Exception as e:
            errors.append(f"{os.path.basename(path)}: {e}")
    # No cache to clear — see _invalidate_caches' docstring: the persistent
    # property index self-invalidates on each synced file's new mtime.
    return {
        "ok": True,
        "total_elements": total_elements,
        "total_psets_updated": total_psets,
        "errors": errors,
    }


# ── Name-Type-ID Audit ───────────────────────────────────────────────────────

@router.get("/name-type-id")
async def name_type_id_audit(path: str):
    """Audit Name / ObjectType / GlobalId consistency."""
    if not os.path.isfile(path):
        raise HTTPException(404, "File not found")
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _audit_name_type_id, path)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _audit_name_type_id(path: str):
    import ifcopenshell
    ifc = ifcopenshell.open(path)
    rows = []
    seen_guids: set = set()
    for entity in ifc.by_type("IfcProduct"):
        gid = getattr(entity, "GlobalId", None) or ""
        name = getattr(entity, "Name", None) or ""
        obj_type = getattr(entity, "ObjectType", None) or ""
        issues = []
        if not name:
            issues.append("missing_name")
        if not obj_type:
            issues.append("missing_type")
        if gid in seen_guids:
            issues.append("duplicate_guid")
        seen_guids.add(gid)
        rows.append({
            "global_id": gid,
            "name": name,
            "object_type": obj_type,
            "ifc_class": entity.is_a(),
            "issues": issues,
            "status": "error" if issues else "ok",
        })
    missing_name  = sum(1 for r in rows if "missing_name" in r["issues"])
    missing_type  = sum(1 for r in rows if "missing_type" in r["issues"])
    dup_guid      = sum(1 for r in rows if "duplicate_guid" in r["issues"])
    errors        = sum(1 for r in rows if r["status"] == "error")
    return {
        "rows": rows[:500], "total": len(rows),
        "errors": errors, "ok": len(rows) - errors,
        "missing_name": missing_name,
        "missing_object_type": missing_type,
        "missing_guid": dup_guid,
    }


# ── Name + ID Objeto (combina Name con ADIF_00_Id_Objeto) ────────────────────

class NameIdElementsRequest(BaseModel):
    paths: list[str]


@router.post("/name-id-elements")
async def name_id_elements(req: NameIdElementsRequest):
    """
    Lee todos los IfcProduct de los archivos dados con su ADIF_00_Id_Objeto.
    Propone renombrar como NombreActual_IdObjeto.
    Retorna filas con {step_id, entity_type, current_name, id_objeto,
                       new_name, has_change, applied, path, filename}.
    """
    from services.ifc_sync import get_elements_with_adif_id
    loop = asyncio.get_event_loop()
    all_rows: list[dict] = []
    errors: list[str] = []
    for path in req.paths:
        if not os.path.isfile(path):
            errors.append(f"No encontrado: {os.path.basename(path)}")
            continue
        fname = os.path.basename(path)
        try:
            elems = await loop.run_in_executor(None, get_elements_with_adif_id, path)
            for e in elems:
                all_rows.append({**e, "path": path, "filename": fname})
        except Exception as e:
            errors.append(f"{fname}: {e}")
    return {"rows": all_rows, "total": len(all_rows), "errors": errors}


class NameIdApplyRequest(BaseModel):
    # changes agrupados por archivo: {path: [{step_id, new_name}]}
    changes: dict[str, list[dict]]


@router.post("/name-id-apply")
async def name_id_apply(req: NameIdApplyRequest):
    """
    Aplica el renombrado Name+ID a los archivos IFC.
    changes = { "C:/path/file.ifc": [{step_id, new_name}, ...], ... }
    Retorna total de elementos renombrados y por archivo.
    """
    from services.ifc_sync import apply_name_id_renames_single
    loop = asyncio.get_event_loop()
    total_changed = 0
    per_file: dict = {}
    for path, items in req.changes.items():
        if not os.path.isfile(path):
            continue
        try:
            changed = await loop.run_in_executor(None, apply_name_id_renames_single, path, items)
            total_changed += changed
            per_file[os.path.basename(path)] = changed
        except Exception as e:
            raise HTTPException(500, f"Error en {os.path.basename(path)}: {e}")
    return {"ok": True, "total_changed": total_changed, "per_file": per_file}


# ── Nomenclature ─────────────────────────────────────────────────────────────

@router.get("/nomenclature")
async def nomenclature(path: str):
    """Group elements by naming prefix and detect variants."""
    if not os.path.isfile(path):
        raise HTTPException(404, "File not found")
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _analyze_nomenclature, path)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _analyze_nomenclature(path: str):
    import ifcopenshell, re
    ifc = ifcopenshell.open(path)
    elements = []
    for entity in ifc.by_type("IfcProduct"):
        name = getattr(entity, "Name", None) or ""
        if not name:
            continue
        # Strip trailing numeric suffix to get prefix
        prefix = re.sub(r"[\s_\-]*\d+$", "", name).strip()
        elements.append({
            "global_id": getattr(entity, "GlobalId", ""),
            "name": name,
            "prefix": prefix,
            "ifc_class": entity.is_a(),
        })
    # Group by prefix
    groups: dict = {}
    for e in elements:
        p = e["prefix"]
        if p not in groups:
            groups[p] = {"prefix": p, "ifc_class": e["ifc_class"], "count": 0, "variants": set()}
        groups[p]["count"] += 1
        groups[p]["variants"].add(e["name"])
    result_groups = [
        {"prefix": g["prefix"], "ifc_class": g["ifc_class"],
         "count": g["count"], "variant_count": len(g["variants"])}
        for g in groups.values()
    ]
    return {"elements": elements[:500], "groups": result_groups, "total": len(elements)}


# ── Model Checker ────────────────────────────────────────────────────────────

class CheckRequest(BaseModel):
    ifc_path: str
    template: dict


def _run_checks(ifc_path: str, template: dict) -> list:
    """Simple template-based IFC checker (independent of v1 model_checker)."""
    import ifcopenshell
    import ifcopenshell.util.element as eu

    ifc = ifcopenshell.open(ifc_path)
    results = []

    for chk in template.get("checks", []):
        rule_id   = chk.get("rule_id", "")
        title     = chk.get("title", rule_id)
        severity  = chk.get("severity", "warn")
        target    = chk.get("target")          # IFC type, e.g. "IfcProject"
        min_count = chk.get("min_count", 1)
        check_fn  = chk.get("check")           # built-in check name

        passed = True
        detail = ""
        recommendation = ""
        samples: list[str] = []

        try:
            if target:
                items = ifc.by_type(target)
                count = len(items)
                passed = count >= min_count
                detail = f"{count} instancia(s)"
                recommendation = f"Se requieren mínimo {min_count} {target}"

            elif check_fn == "guid_not_empty":
                products = ifc.by_type("IfcProduct")
                bad = [p for p in products if not getattr(p, "GlobalId", None)]
                passed = len(bad) == 0
                detail = f"{len(bad)} elemento(s) sin GlobalId de {len(products)} totales"
                samples = [str(b) for b in bad[:5]]

            elif check_fn == "name_not_empty":
                products = ifc.by_type("IfcProduct")
                bad = [p for p in products if not getattr(p, "Name", None)]
                passed = len(bad) == 0
                detail = f"{len(bad)} elemento(s) sin Name de {len(products)} totales"
                samples = [str(b) for b in bad[:5]]

            elif check_fn == "schema_ok":
                schema = ifc.schema
                passed = schema is not None
                detail = f"Schema: {schema}"

        except Exception as ex:
            passed = False
            detail = str(ex)

        results.append({
            "rule_id": rule_id, "title": title, "severity": severity,
            "passed": passed, "detail": detail,
            "recommendation": recommendation, "samples": samples,
        })

    return results


@router.post("/check")
async def check_model(req: CheckRequest):
    try:
        results = _run_checks(req.ifc_path, req.template)
        return {"ok": True, "results": results}
    except Exception as e:
        raise HTTPException(500, str(e))


# ── IDS Validator (buildingSMART Information Delivery Specification) ────────
# Valida un IFC contra un fichero .ids real con IfcTester (parte de ifcopenshell),
# en vez del checker casero de arriba (`_run_checks`, solo 4 funciones fijas).
# Mismo shape de resultado que `/check` (rule_id/title/severity/passed/detail/
# samples) para poder reutilizar la UI existente sin reescribirla — una
# especificación IDS = una fila. Patrón calcado del "drag an .ids in, it becomes
# a ruleset" de Solibri: el .ids manda, este endpoint solo lo ejecuta.

_DEFAULT_IDS_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "DOCS", "ids", "BIMRail_ADIF.ids")
)


class IdsValidateRequest(BaseModel):
    ifc_path: str
    ids_path: Optional[str] = None  # por defecto, el .ids canónico BIMRail_ADIF.ids


def _severity_for_spec(spec) -> str:
    # IDS no tiene un campo de severidad nativo — se deriva así: si alguno de los
    # requirements de la especificación es cardinality="required" (p.ej. los 6
    # códigos ADIF), un fallo es bloqueante -> error. Si no hay requirements (solo
    # applicability, p.ej. "debe existir un IfcProject"), se usa la cardinalidad de
    # la propia applicability como proxy -> error si minOccurs>=1, si no warn.
    if spec.requirements:
        if any(getattr(r, "cardinality", "required") == "required" for r in spec.requirements):
            return "error"
        return "warn"
    return "error" if (getattr(spec, "minOccurs", 0) or 0) >= 1 else "warn"


def _run_ids_validation(ifc_path: str, ids_path: Optional[str]) -> dict:
    from ifctester import ids as ids_module

    resolved_ids_path = ids_path or _DEFAULT_IDS_PATH
    if not os.path.isfile(resolved_ids_path):
        raise FileNotFoundError(f"No se encontró el fichero .ids: {resolved_ids_path}")

    specs = ids_module.open(resolved_ids_path)
    ifc = model_pool.get(ifc_path)
    specs.validate(ifc)

    results = []
    for spec in specs.specifications:
        applicable = len(spec.applicable_entities)
        failing_elements = []
        for requirement in spec.requirements:
            if requirement.status is False:
                failing_elements.extend(f["element"] for f in requirement.failures)
        failing_elements = list({e.id(): e for e in failing_elements}.values())

        results.append({
            "rule_id": spec.identifier or spec.name,
            "title": spec.name,
            "severity": _severity_for_spec(spec),
            "passed": bool(spec.status),
            "detail": f"{applicable - len(failing_elements)}/{applicable} elemento(s) conformes"
            if applicable else "Sin elementos aplicables en el modelo",
            "recommendation": spec.description or "",
            "samples": [
                (e.Name or e.GlobalId or str(e.id())) for e in failing_elements[:5]
            ],
        })

    return {
        "ids_path": resolved_ids_path,
        "ids_title": specs.info.get("title") if isinstance(specs.info, dict) else None,
        "results": results,
    }


@router.post("/ids-validate")
async def ids_validate(req: IdsValidateRequest):
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _run_ids_validation, req.ifc_path, req.ids_path)
        return {"ok": True, **result}
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))


# ── Duplicates ───────────────────────────────────────────────────────────────

class DuplicatesRequest(BaseModel):
    folder: str
    tolerance_cm: float = 5.0
    files: Optional[list[str]] = None


@router.post("/duplicates")
async def find_duplicates(req: DuplicatesRequest):
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _find_duplicates, req.folder, req.tolerance_cm, req.files)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _find_duplicates(folder: str, tolerance_cm: float, files_filter=None):
    from services.ifc_duplicates import scan_single_file, group_duplicates
    ifc_files = []
    for root, _, fnames in os.walk(folder):
        for f in fnames:
            if f.lower().endswith(".ifc"):
                if not files_filter or f in files_filter:
                    ifc_files.append(os.path.join(root, f))

    tolerance = tolerance_cm / 100.0
    all_elements = []
    for fp in ifc_files:
        try:
            result = scan_single_file(fp, tolerance)
            elements = result.get("elements", result) if isinstance(result, dict) else result
            for e in elements:
                e["ifc_file"] = os.path.basename(fp)
            all_elements.extend(elements)
        except Exception as ex:
            pass

    groups = group_duplicates(all_elements)
    # groups is list of {group_id, geo_hash, element_type, count, elements:[...]}
    return {
        "total_elements": len(all_elements),
        "duplicate_groups": len(groups),
        "duplicate_elements": sum(g["count"] for g in groups),
        "groups": groups,
    }


# ── Standards Audit ──────────────────────────────────────────────────────────

class StandardsRequest(BaseModel):
    folder: str
    standards: list[str] = ["ifc4x3"]
    files: Optional[list[str]] = None


@router.post("/standards")
async def standards_audit(req: StandardsRequest):
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _run_standards, req.folder, req.standards, req.files)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _run_standards(folder: str, standards: list, files_filter=None):
    try:
        from services.standards.runner import scan_single_file, aggregate_report
    except ImportError:
        return {"error": "Standards service not available", "results": []}

    ifc_files = []
    for root, _, fnames in os.walk(folder):
        for f in fnames:
            if f.lower().endswith(".ifc"):
                if not files_filter or f in files_filter:
                    ifc_files.append(os.path.join(root, f))

    per_file = []
    for fp in ifc_files:
        try:
            report = scan_single_file(fp, standards)
            report["file"] = os.path.basename(fp)
            per_file.append(report)
        except Exception as ex:
            per_file.append({"file": os.path.basename(fp), "error": str(ex)})

    try:
        agg = aggregate_report(per_file)
    except Exception:
        agg = {}

    return {"per_file": per_file, "aggregate": agg}


# ── Fast STEP parsers (no ifcopenshell — 10–100× faster) ────────────────────

def _iter_step_entities(ifc_path: str):
    """
    Generator: yields complete STEP entity strings from the DATA section.
    Handles multi-line entities by buffering until ';' closes them.
    """
    in_data = False
    buf = ""
    try:
        with open(ifc_path, "r", encoding="utf-8", errors="replace") as fh:
            for raw in fh:
                s = raw.rstrip("\n\r").strip()
                if not s:
                    continue
                if not in_data:
                    if s.upper().startswith("DATA"):
                        in_data = True
                    continue
                if s.upper().startswith("ENDSEC"):
                    if buf.strip():
                        yield buf.strip()
                    return
                buf += s
                if buf.endswith(";"):
                    yield buf
                    buf = ""
    except Exception:
        pass


_RE_ENT_HEADER = re.compile(r"^#(\d+)\s*=\s*(IFC\w+)\s*\(", re.I)
_RE_ALL_REFS   = re.compile(r"#(\d+)")
_RE_STRINGS    = re.compile(r"'([^']*)'")
_RE_ELEM_TUPLE = re.compile(r"\(\s*((?:#\d+\s*,?\s*)+)\)\s*,\s*#(\d+)\s*\)\s*;")


def _check_classify_status_fast(ifc_path: str) -> dict:
    """
    STEP text-parser replacement for _check_classify_status + _get_classify_detail.
    Single O(n) pass — no ifcopenshell.open(). Returns status + full detail breakdown.
    Cached by (path, mtime).
    """
    ck = _cache_key(ifc_path, "classify")
    cached = _cache_get(ck)
    if cached is not None:
        return cached

    info = _extract_ifc_info(ifc_path)
    originating_system = info.get("originating_system", "")
    is_civil3d = "civil" in originating_system.lower()

    # Collections built during the single pass
    adif_prop_ids: set  = set()   # IDs of IfcPropertySingleValue('ADIF_00_Codigo_Producto',...)
    psets: dict         = {}      # pset_id → frozenset of prop_ids
    rel_defines: list   = []      # [(elem_ids: set, pset_id: int)]
    classified_ids: set = set()   # element IDs with IfcRelAssociatesClassification
    elem_cls_ref: dict  = {}      # element_id → cls_ref_entity_id
    cls_ref_labels: dict= {}      # cls_ref_id → display string
    element_types: dict = {}      # element_id → IFC type string

    for entity_str in _iter_step_entities(ifc_path):
        m = _RE_ENT_HEADER.match(entity_str)
        if not m:
            continue
        eid   = int(m.group(1))
        etype = m.group(2).upper()
        body  = entity_str[m.end():]  # everything after "ENTITY_TYPE("

        if etype == "IFCPROPERTYSINGLEVALUE":
            # Check if name == 'ADIF_00_Codigo_Producto'
            sm = _RE_STRINGS.match(body.lstrip())
            if sm and sm.group(1).upper() == "ADIF_00_CODIGO_PRODUCTO":
                adif_prop_ids.add(eid)

        elif etype == "IFCPROPERTYSET":
            # All #refs in body → prop IDs (OwnerHistory first ref is harmless; see design notes)
            refs = [int(x) for x in _RE_ALL_REFS.findall(body)]
            if refs:
                psets[eid] = set(refs)

        elif etype == "IFCRELDEFINESBYPROPERTIES":
            # Extract RelatedObjects tuple + RelatingPropertyDefinition (last ref)
            em = _RE_ELEM_TUPLE.search(entity_str)
            if em:
                elem_ids = {int(x) for x in _RE_ALL_REFS.findall(em.group(1))}
                pset_id  = int(em.group(2))
                if elem_ids:
                    rel_defines.append((elem_ids, pset_id))

        elif etype == "IFCRELASSOCIATESCLASSIFICATION":
            em = _RE_ELEM_TUPLE.search(entity_str)
            if em:
                elem_ids  = {int(x) for x in _RE_ALL_REFS.findall(em.group(1))}
                cls_ref_id = int(em.group(2))
                classified_ids.update(elem_ids)
                for e in elem_ids:
                    elem_cls_ref[e] = cls_ref_id

        elif etype == "IFCCLASSIFICATIONREFERENCE":
            strings = _RE_STRINGS.findall(body)
            # Typical: ('location','Identification','Name',...)
            ident = strings[1] if len(strings) > 1 else ""
            name  = strings[2] if len(strings) > 2 else ""
            label = f"{ident} — {name}".strip(" —") or "sin-ref"
            cls_ref_labels[eid] = label

        elif etype in _IFC_PRODUCT_TYPES:
            element_types[eid] = etype

    # ── Cross-reference ───────────────────────────────────────────────────────
    psets_with_adif = {pid for pid, props in psets.items() if props & adif_prop_ids}

    elements_with_code_raw: set = set()
    for elem_ids, pset_id in rel_defines:
        if pset_id in psets_with_adif:
            elements_with_code_raw.update(elem_ids)

    # Filter to known IfcProduct types (removes OwnerHistory refs, etc.)
    elements_with_code = elements_with_code_raw & element_types.keys()

    already_classified = elements_with_code & classified_ids
    pending_elements   = elements_with_code - classified_ids

    # ── Detail breakdown ──────────────────────────────────────────────────────
    pending_by_type:   Counter = Counter()
    classified_by_ref: Counter = Counter()

    for eid in pending_elements:
        pending_by_type[element_types.get(eid, "IfcProduct")] += 1

    for eid in already_classified:
        ref_id = elem_cls_ref.get(eid)
        label  = cls_ref_labels.get(ref_id, "sin-ref") if ref_id else "sin-ref"
        classified_by_ref[label] += 1

    result = {
        "is_civil3d":         is_civil3d,
        "originating_system": originating_system,
        "elements_with_code": len(elements_with_code),
        "already_classified": len(already_classified),
        "pending":            len(pending_elements),
        "pending_by_type":    [{"type": t, "count": c} for t, c in pending_by_type.most_common(10)],
        "classified_by_ref":  [{"ref": r, "count": c} for r, c in classified_by_ref.most_common(10)],
    }
    _cache_set(ck, result)
    return result


def _check_defaults_status_fast(ifc_path: str) -> dict:
    """
    STEP text-parser for project defaults status.
    Only needs IfcProject + linked psets — single pass, no ifcopenshell. Cached.
    """
    ck = _cache_key(ifc_path, "defaults")
    cached = _cache_get(ck)
    if cached is not None:
        return cached

    info = _extract_ifc_info(ifc_path)
    originating_system = info.get("originating_system", "")
    is_civil3d         = "civil" in originating_system.lower()
    project_name_from_info = info.get("project_name", "")

    project_id: list     = [None]     # mutable container for nonlocal-like mutation
    rel_defines: list    = []         # [(elem_ids: set, pset_id: int)]
    psets: dict          = {}         # pset_id → (name: str, prop_ids: list)
    prop_data: dict      = {}         # prop_id → (name: str, value: str)

    for entity_str in _iter_step_entities(ifc_path):
        m = _RE_ENT_HEADER.match(entity_str)
        if not m:
            continue
        eid   = int(m.group(1))
        etype = m.group(2).upper()
        body  = entity_str[m.end():]

        if etype == "IFCPROJECT":
            project_id[0] = eid

        elif etype == "IFCPROPERTYSET":
            strings = _RE_STRINGS.findall(body)
            # name is typically the 3rd string (index 2): ('GlobalId',$,'PsetName',...)
            # but findall skips $, so it could be index 1 or 2
            pset_name = ""
            for s in strings[1:3]:  # check positions 1 and 2
                if s and not s.startswith("Ifc"):
                    pset_name = s
                    break
            refs = [int(x) for x in _RE_ALL_REFS.findall(body)]
            psets[eid] = (pset_name, refs)

        elif etype == "IFCRELDEFINESBYPROPERTIES":
            em = _RE_ELEM_TUPLE.search(entity_str)
            if em:
                elem_ids = {int(x) for x in _RE_ALL_REFS.findall(em.group(1))}
                pset_id  = int(em.group(2))
                if elem_ids:
                    rel_defines.append((elem_ids, pset_id))

        elif etype == "IFCPROPERTYSINGLEVALUE":
            strings = _RE_STRINGS.findall(body)
            prop_name  = strings[0] if strings else ""
            # Value: look for IFC*('value') or plain number
            val_m = re.search(r"IFC\w+\s*\(\s*'([^']*)'\s*\)", body, re.I)
            if not val_m:
                val_m = re.search(r"IFC\w+\s*\(\s*([^,)]+)\s*\)", body, re.I)
            prop_value = val_m.group(1).strip() if val_m else ""
            if prop_name:
                prop_data[eid] = (prop_name, prop_value)

    # ── Compute ────────────────────────────────────────────────────────────────
    pid = project_id[0]
    if pid is None:
        result = {
            "is_civil3d": is_civil3d, "originating_system": originating_system,
            "has_project": False, "adif_with_values": 0,
            "total_project_props": 0, "std_attrs_filled": 0,
            "project_name": project_name_from_info, "project_long_name": "",
        }
        _cache_set(ck, result)
        return result

    # Psets linked to the project
    project_pset_ids = {
        pset_id for (elem_ids, pset_id) in rel_defines if pid in elem_ids
    }

    adif_count  = 0
    total_props = 0
    for pset_id in project_pset_ids:
        if pset_id not in psets:
            continue
        _, prop_ids = psets[pset_id]
        for prop_id in prop_ids:
            if prop_id not in prop_data:
                continue
            pname, pval = prop_data[prop_id]
            total_props += 1
            if "ADIF" in pname.upper() and pval.strip():
                adif_count += 1

    # Standard attrs: estimate from _extract_ifc_info project_name presence
    std_filled = 1 if project_name_from_info else 0
    if info.get("project_name"):
        std_filled = 3  # name + at least description/objecttype typically set together

    result = {
        "is_civil3d":          is_civil3d,
        "originating_system":  originating_system,
        "has_project":         True,
        "adif_with_values":    adif_count,
        "total_project_props": total_props,
        "std_attrs_filled":    std_filled,
        "project_name":        project_name_from_info,
        "project_long_name":   "",
    }
    _cache_set(ck, result)
    return result


# ── Classify Status Check ────────────────────────────────────────────────────

class BatchScanRequest(BaseModel):
    paths: list[str]

@router.post("/classify-batch")
async def classify_batch(req: BatchScanRequest):
    """Process multiple IFC files in parallel. Returns {path: status+detail}. Fast STEP parser + cache."""
    loop = asyncio.get_event_loop()
    tasks = [loop.run_in_executor(None, _check_classify_status_fast, p) for p in req.paths]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    return {
        p: r if not isinstance(r, Exception) else {"error": str(r), "elements_with_code": 0, "already_classified": 0, "pending": 0}
        for p, r in zip(req.paths, results)
    }

@router.post("/defaults-batch")
async def defaults_batch(req: BatchScanRequest):
    """Process multiple IFC files in parallel for defaults status. Uses ifcopenshell for accuracy."""
    loop = asyncio.get_event_loop()
    tasks = [loop.run_in_executor(None, _check_defaults_status, p) for p in req.paths]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    return {
        p: r if not isinstance(r, Exception) else {"error": str(r), "has_project": False, "adif_with_values": 0}
        for p, r in zip(req.paths, results)
    }


# ── Mandatory params status (RELATION PARAMS resumen gerencial) ──────────────
# Los 6 códigos "obligatorios" ADIF (ver CLAUDE.md sección 3): los 4 primeros
# los valida MasterSync/Auto Params, los 2 últimos (Actividad/Partida) los
# rellena a mano el modelador y los usan Auto Planning/Auto Cost. Resumen
# rápido — no lista elementos, solo cuenta OK/MAL — para que cargue al
# instante incluso con modelos grandes.

_MANDATORY_PARAM_NAMES = [
    "ADIF_00_Codigo_Producto",
    "ADIF_02_Zonificacion",
    "ADIF_03_Codigo_Estado",
    "ADIF_03_Fuente_Definicion",
    "ADIF_04_Codigo_Actividad",
    "ADIF_05_Codigo_Partida",
]


def _mandatory_value_is_empty(v) -> bool:
    if v is None:
        return True
    s = str(v).strip()
    return s == "" or s.upper() == "N/A"


def _check_mandatory_params_status(path: str) -> dict:
    import ifcopenshell.util.element as eu

    # Lectura pura → pool LRU compartido (ya parseado si el modelo está en caché)
    ifc = model_pool.get(path)
    elements = [e for e in ifc.by_type("IfcProduct") if e.is_a().upper() not in _IFC_SPATIAL_CONTAINER_TYPES]
    total = len(elements)

    ok_counts = {name: 0 for name in _MANDATORY_PARAM_NAMES}
    for e in elements:
        try:
            psets = eu.get_psets(e)
        except Exception:
            continue
        # Une todas las propiedades de todos los psets del elemento — se busca
        # por NOMBRE de propiedad, nunca por nombre de pset (puede variar).
        flat: dict = {}
        for props in psets.values():
            if isinstance(props, dict):
                flat.update(props)
        for name in _MANDATORY_PARAM_NAMES:
            if name in flat and not _mandatory_value_is_empty(flat[name]):
                ok_counts[name] += 1

    return {
        "total_elements": total,
        "params": {
            name: {"ok": ok_counts[name], "bad": total - ok_counts[name]}
            for name in _MANDATORY_PARAM_NAMES
        },
    }


@router.post("/mandatory-params-status")
async def mandatory_params_status(req: BatchScanRequest):
    """Resumen gerencial por modelo: cuántos elementos tienen cada uno de los
    6 parámetros obligatorios ADIF bien rellenados vs mal/ausentes. Sin listar
    elementos individuales — solo conteos — para máxima velocidad."""
    loop = asyncio.get_event_loop()
    tasks = [loop.run_in_executor(None, _check_mandatory_params_status, p) for p in req.paths]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    return {
        p: r if not isinstance(r, Exception) else {"error": str(r), "total_elements": 0, "params": {}}
        for p, r in zip(req.paths, results)
    }


@router.get("/classify-status")
async def classify_status_endpoint(path: str):
    """Check classification status of a single IFC file. Now uses fast STEP parser."""
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _check_classify_status_fast, path)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _check_classify_status(ifc_path: str) -> dict:
    """
    Abre un IFC y devuelve:
    - is_civil3d: True si el originating_system contiene 'civil'
    - originating_system: string del encabezado STEP
    - elements_with_code: nº de IfcProduct con ADIF_00_Codigo_Producto
    - already_classified: nº de esos elementos que ya tienen IfcClassificationReference
    - pending: elements_with_code - already_classified
    """
    import ifcopenshell

    info = _extract_ifc_info(ifc_path)
    originating_system = info.get("originating_system", "")
    is_civil3d = "civil" in originating_system.lower()

    model = ifcopenshell.open(ifc_path)

    def _get_prop(element, pset_name: str, prop_name: str):
        if not hasattr(element, "IsDefinedBy"):
            return None
        for rel in element.IsDefinedBy:
            if not rel.is_a("IfcRelDefinesByProperties"):
                continue
            pset = rel.RelatingPropertyDefinition
            if not pset.is_a("IfcPropertySet") or pset.Name != pset_name:
                continue
            for prop in pset.HasProperties:
                if prop.Name == prop_name:
                    try:
                        return prop.NominalValue.wrappedValue
                    except Exception:
                        return None
        return None

    def _has_cls_ref(element) -> bool:
        if not hasattr(element, "HasAssociations"):
            return False
        for assoc in element.HasAssociations:
            if assoc.is_a("IfcRelAssociatesClassification"):
                ref = assoc.RelatingClassification
                if ref and ref.is_a("IfcClassificationReference"):
                    return True
        return False

    elements_with_code = 0
    already_classified = 0

    for element in model.by_type("IfcProduct"):
        codigo = _get_prop(element, "ADIF_00_Generales", "ADIF_00_Codigo_Producto")
        if not codigo:
            continue
        elements_with_code += 1
        if _has_cls_ref(element):
            already_classified += 1

    return {
        "is_civil3d": is_civil3d,
        "originating_system": originating_system,
        "elements_with_code": elements_with_code,
        "already_classified": already_classified,
        "pending": elements_with_code - already_classified,
    }


# ── Classify Detail (element-level breakdown for partial cards) ───────────────

@router.get("/classify-detail")
async def classify_detail_endpoint(path: str):
    """Return element-level breakdown. Now reuses the cached fast-scan result (no second file open)."""
    loop = asyncio.get_event_loop()
    try:
        # Fast parser returns status + detail in one shot; just extract detail fields
        result = await loop.run_in_executor(None, _check_classify_status_fast, path)
        return {
            "pending_by_type":    result.get("pending_by_type", []),
            "classified_by_type": [],
            "classified_by_ref":  result.get("classified_by_ref", []),
        }
    except Exception as e:
        raise HTTPException(500, str(e))


def _get_classify_detail(ifc_path: str) -> dict:
    import ifcopenshell
    from collections import Counter

    model = ifcopenshell.open(ifc_path)

    def _get_prop(element, pset_name: str, prop_name: str):
        if not hasattr(element, "IsDefinedBy"):
            return None
        for rel in element.IsDefinedBy:
            if not rel.is_a("IfcRelDefinesByProperties"):
                continue
            pset = rel.RelatingPropertyDefinition
            if not pset.is_a("IfcPropertySet") or pset.Name != pset_name:
                continue
            for prop in pset.HasProperties:
                if prop.Name == prop_name:
                    try:
                        return prop.NominalValue.wrappedValue
                    except Exception:
                        return None
        return None

    def _get_cls_ref(element):
        if not hasattr(element, "HasAssociations"):
            return None
        for assoc in element.HasAssociations:
            if assoc.is_a("IfcRelAssociatesClassification"):
                ref = assoc.RelatingClassification
                if ref and ref.is_a("IfcClassificationReference"):
                    ident = (
                        getattr(ref, "Identification", None)
                        or getattr(ref, "ItemReference", None)
                        or ""
                    )
                    name = getattr(ref, "Name", None) or ""
                    return f"{ident} — {name}".strip(" —") if (ident or name) else "sin-ref"
        return None

    pending_by_type:   Counter = Counter()
    classified_by_ref: Counter = Counter()
    classified_by_type: Counter = Counter()

    for element in model.by_type("IfcProduct"):
        codigo = _get_prop(element, "ADIF_00_Generales", "ADIF_00_Codigo_Producto")
        if not codigo:
            continue

        etype = element.is_a()
        cls_ref = _get_cls_ref(element)

        if cls_ref is not None:
            classified_by_type[etype] += 1
            classified_by_ref[cls_ref] += 1
        else:
            pending_by_type[etype] += 1

    return {
        "pending_by_type":    [{"type": t, "count": c} for t, c in pending_by_type.most_common(10)],
        "classified_by_type": [{"type": t, "count": c} for t, c in classified_by_type.most_common(10)],
        "classified_by_ref":  [{"ref": r,  "count": c} for r, c in classified_by_ref.most_common(10)],
    }


# ── Classify ─────────────────────────────────────────────────────────────────

class ClassifyRequest(BaseModel):
    ifc_path: str
    config: list[dict]  # [{property_name, property_value}]


@router.post("/classify")
async def classify_ifc(req: ClassifyRequest):
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _apply_classification, req.ifc_path, req.config)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _apply_classification(ifc_path: str, config: list):
    """
    Aplica SCFClass_Funciones a todos los IfcProduct con ADIF_00_Codigo_Producto.

    Comportamiento idéntico a v1 (ifc_sync.classify_ifc) más fix de actualización:
    - Siempre actualiza los atributos del IfcClassification existente (name/edition/source…).
      Esto garantiza que si el usuario cambia 'edition' en PocketBase y reclasifica,
      los datos se propagan aunque los elementos ya tuvieran clasificación.
    - Si el elemento ya tiene exactamente 1 clasificación → se omite (pero la entidad
      IfcClassification ya fue actualizada arriba).
    - Si tiene duplicados → se eliminan y se reclasifica.
    - Si no tiene ninguna → se aplica nueva clasificación.
    """
    import ifcopenshell
    import ifcopenshell.guid

    # Convertir lista [{property_name, property_value}] → dict
    cfg = {r["property_name"]: r["property_value"] for r in config}

    model = ifcopenshell.open(ifc_path)
    schema = model.schema.upper()
    # En IFC4X3 el atributo URL se llama "Specification"; en IFC4 "Location"
    url_attr = "Specification" if "IFC4X3" in schema else "Location"

    cls_name     = cfg.get("name",    "SCFClass_Funciones")
    cls_source   = cfg.get("source",  "Railway Innovation Hub")
    cls_edition  = cfg.get("edition", "V02 2022")
    edition_date = cfg.get("edition_date", "")
    location     = cfg.get("location", "")
    ref_location = cfg.get("reference_location", "")

    # ── 1. Actualizar o crear la entidad IfcClassification ───────────────────
    # Buscar si ya existe una con ese nombre y actualizar sus atributos.
    # Esto es el fix clave: cuando el usuario cambia 'edition' en PB y vuelve
    # a clasificar, aunque todos los elementos ya tengan referencia, la entidad
    # IfcClassification queda actualizada y BIM Vision lo refleja.
    existing_cls = None
    for c in model.by_type("IfcClassification"):
        if c.Name == cls_name:
            existing_cls = c
            break

    if existing_cls is not None:
        try:
            existing_cls.Source  = cls_source
            existing_cls.Edition = cls_edition
            if edition_date:
                existing_cls.EditionDate = edition_date
            if location:
                setattr(existing_cls, url_attr, location)
        except Exception:
            pass
        _classification = existing_cls
    else:
        _classification = None  # se creará lazy al clasificar el primer elemento

    def get_classification():
        nonlocal _classification
        if _classification is None:
            kw: dict = {
                "Name":    cls_name,
                "Source":  cls_source,
                "Edition": cls_edition,
            }
            if edition_date:
                kw["EditionDate"] = edition_date
            if location:
                kw[url_attr] = location
            _classification = model.create_entity("IfcClassification", **kw)
        return _classification

    # ── Helpers ──────────────────────────────────────────────────────────────

    def get_prop(element, pset_name: str, prop_name: str):
        """Devuelve el wrappedValue de una propiedad dentro de un PropertySet."""
        if not hasattr(element, "IsDefinedBy"):
            return None
        for rel in element.IsDefinedBy:
            if not rel.is_a("IfcRelDefinesByProperties"):
                continue
            pset = rel.RelatingPropertyDefinition
            if not pset.is_a("IfcPropertySet") or pset.Name != pset_name:
                continue
            for prop in pset.HasProperties:
                if prop.Name == prop_name:
                    try:
                        return prop.NominalValue.wrappedValue
                    except Exception:
                        return None
        return None

    def get_existing_cls_rels(element):
        """Devuelve lista de IfcRelAssociatesClassification vinculadas a cls_name."""
        rels = []
        if not hasattr(element, "HasAssociations"):
            return rels
        for assoc in element.HasAssociations:
            if not assoc.is_a("IfcRelAssociatesClassification"):
                continue
            relating = assoc.RelatingClassification
            if relating.is_a("IfcClassification") and relating.Name == cls_name:
                rels.append(assoc)
            elif relating.is_a("IfcClassificationReference"):
                src = relating.ReferencedSource
                if src and src.is_a("IfcClassification") and src.Name == cls_name:
                    rels.append(assoc)
        return rels

    # ── 2. Procesar elementos ─────────────────────────────────────────────────
    count_new       = 0
    count_skipped   = 0
    count_corrected = 0

    for element in model.by_type("IfcProduct"):
        codigo = get_prop(element, "ADIF_00_Generales", "ADIF_00_Codigo_Producto")
        if not codigo:
            continue

        existing = get_existing_cls_rels(element)

        if len(existing) == 1:
            # Ya clasificado correctamente → la entidad IfcClassification ya
            # fue actualizada en el paso 1, así que no hace falta tocar el elemento.
            count_skipped += 1
            continue

        if len(existing) > 1:
            # Duplicados → eliminar todos y reclasificar
            for rel in existing:
                ref_entity = rel.RelatingClassification
                model.remove(rel)
                try:
                    model.remove(ref_entity)
                except Exception:
                    pass
            count_corrected += 1
        else:
            count_new += 1

        # Crear nueva referencia de clasificación
        desc = get_prop(element, "ADIF_00_Generales", "ADIF_00_Descripcion_Producto")
        try:
            ref_kw: dict = {
                "Identification": str(codigo),
                "Name":           str(desc) if desc else str(codigo),
                "ReferencedSource": get_classification(),
            }
            if ref_location:
                ref_kw["Location"] = ref_location
            ref = model.create_entity("IfcClassificationReference", **ref_kw)
            model.create_entity(
                "IfcRelAssociatesClassification",
                GlobalId=ifcopenshell.guid.new(),
                RelatedObjects=[element],
                RelatingClassification=ref,
            )
        except Exception:
            if len(existing) > 1:
                count_corrected -= 1
            else:
                count_new -= 1

    atomic_write_model(model, ifc_path)

    parts = []
    if count_new       > 0: parts.append(f"{count_new} nuevos")
    if count_corrected > 0: parts.append(f"{count_corrected} duplicados corregidos")
    if count_skipped   > 0: parts.append(f"{count_skipped} ya clasificados")
    msg   = " | ".join(parts) if parts else "Sin elementos con ADIF_00_Codigo_Producto"
    total = count_new + count_corrected + (1 if existing_cls is not None else 0)
    return {
        "ok":      True,
        "modified": count_new + count_corrected,
        "skipped":  count_skipped,
        "message":  msg,
        "updated_classification": existing_cls is not None,
    }


@router.get("/classify-model-info")
async def classify_model_info(path: str, name: str = ""):
    """Return the IfcClassification entity attributes already present in the model,
    for comparing against the PocketBase config template (En modelo vs Aplicar).
    `name` is the config's expected classification name (e.g. SCFClass_Funciones) —
    without it, a file with multiple classification systems (Revit's default
    "Uniformat" export alongside the ADIF one) has no reliable way to tell which
    one the config is actually meant to compare against."""
    if not os.path.isfile(path):
        raise HTTPException(404, "File not found")

    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _extract_classification_info, path, name)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _extract_classification_info(path: str, expected_name: str = "") -> dict:
    """Extract IfcClassification attributes + a sample reference Location from an
    existing model, mirroring the fields of ifc_classification_config."""
    import ifcopenshell

    try:
        model = ifcopenshell.open(path)
        schema = model.schema.upper()
        url_attr = "Specification" if "IFC4X3" in schema else "Location"

        classifications = model.by_type("IfcClassification")
        if not classifications:
            return {"attributes": {}, "found": False}

        if expected_name:
            # Exact match against the config's own classification name — a file
            # can have several classification systems (e.g. Revit's own
            # "Uniformat" export next to the ADIF one), so matching by name is
            # the only way to compare against the right one.
            classification = next((c for c in classifications if c.Name == expected_name), None)
            if classification is None:
                return {"attributes": {}, "found": False}
        else:
            # No expected name given — best-effort: prefer whichever
            # classification is actually referenced by elements, else the
            # first one in the file.
            referenced_names = set()
            for ref in model.by_type("IfcClassificationReference"):
                src = ref.ReferencedSource
                if src and src.is_a("IfcClassification"):
                    referenced_names.add(src.Name)
            classification = next((c for c in classifications if c.Name in referenced_names), classifications[0])

        attributes = {
            "name":         str(classification.Name or "—"),
            "source":       str(getattr(classification, "Source", None) or "—"),
            "edition":      str(getattr(classification, "Edition", None) or "—"),
            "edition_date": str(getattr(classification, "EditionDate", None) or "—"),
            "location":     str(getattr(classification, url_attr, None) or "—"),
        }

        # Compare by STEP id, not `is` — ifcopenshell hands back a fresh Python
        # wrapper on every attribute access, so `ref.ReferencedSource is
        # classification` silently never matches even for the same entity.
        classification_id = classification.id()
        ref_location = "—"
        for ref in model.by_type("IfcClassificationReference"):
            src = ref.ReferencedSource
            if src and src.is_a("IfcClassification") and src.id() == classification_id:
                loc = getattr(ref, "Location", None)
                if loc:
                    ref_location = str(loc)
                    break
        attributes["reference_location"] = ref_location

        return {"attributes": attributes, "found": True}

    except Exception as e:
        return {"attributes": {}, "found": False, "error": str(e)}


# ── IFC Groups / Sets ("Conjuntos" en Navisworks) ─────────────────────────────
# IfcGroup + IfcRelAssignsToGroup es el mecanismo nativo de IFC que Navisworks
# lee para construir sus "Colecciones de IFC" — Civil3D ya emite esto para
# IfcDistributionSystem (subtipo de IfcGroup). Esto permite hacer lo mismo para
# cualquier propiedad ADIF/INGR: un grupo por cada valor distinto.

@router.get("/groups")
async def list_groups(path: str):
    """List existing IfcGroup entities (and subtypes like IfcSystem/IfcDistributionSystem)."""
    if not os.path.isfile(path):
        raise HTTPException(404, "File not found")
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _list_groups, path)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _list_groups(path: str) -> dict:
    try:
        ifc = model_pool.get(path)  # solo lectura → pool compartido
        groups = []
        covered_ids: set = set()
        for g in ifc.by_type("IfcGroup"):
            members = []
            for rel in (getattr(g, "IsGroupedBy", None) or []):
                members.extend(rel.RelatedObjects or [])
            for m in members:
                covered_ids.add(m.id())
            groups.append({
                "global_id": g.GlobalId,
                "name": g.Name or "(sin nombre)",
                "type": g.is_a(),
                "member_count": len(members),
            })
        groups.sort(key=lambda x: x["name"].lower())

        # Coverage for the card semaphore: how many of the model's addressable
        # elements (real products, not bare spatial containers) already belong
        # to at least one set.
        total_elements = sum(
            1 for e in ifc.by_type("IfcProduct")
            if e.is_a().upper() not in _IFC_SPATIAL_CONTAINER_TYPES
        )
        return {
            "groups": groups,
            "total_element_count": total_elements,
            "grouped_element_count": len(covered_ids),
        }
    except Exception as e:
        return {"groups": [], "error": str(e)}


class RenameGroupRequest(BaseModel):
    path: str
    global_id: str
    name: str


@router.post("/groups/rename")
async def rename_group(req: RenameGroupRequest):
    _guard_path(req.path)
    if not os.path.isfile(req.path):
        raise HTTPException(404, "File not found")
    try:
        import ifcopenshell
        ifc = ifcopenshell.open(req.path)
        group = next((g for g in ifc.by_type("IfcGroup") if g.GlobalId == req.global_id), None)
        if group is None:
            raise HTTPException(404, "Group not found")
        group.Name = req.name
        atomic_write_model(ifc, req.path)
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


class DeleteGroupRequest(BaseModel):
    path: str
    global_id: str


@router.post("/groups/delete")
async def delete_group(req: DeleteGroupRequest):
    _guard_path(req.path)
    if not os.path.isfile(req.path):
        raise HTTPException(404, "File not found")
    try:
        import ifcopenshell
        ifc = ifcopenshell.open(req.path)
        group = next((g for g in ifc.by_type("IfcGroup") if g.GlobalId == req.global_id), None)
        if group is None:
            raise HTTPException(404, "Group not found")
        for rel in list(getattr(group, "IsGroupedBy", None) or []):
            ifc.remove(rel)
        ifc.remove(group)
        atomic_write_model(ifc, req.path)
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


class DeleteAllGroupsRequest(BaseModel):
    path: str


@router.post("/groups/delete-all")
async def delete_all_groups(req: DeleteAllGroupsRequest):
    """Delete all IfcGroup entities from the model."""
    _guard_path(req.path)
    if not os.path.isfile(req.path):
        raise HTTPException(404, "File not found")
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _delete_all_groups, req.path)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _delete_all_groups(path: str) -> dict:
    import ifcopenshell
    ifc = ifcopenshell.open(path)
    groups = list(ifc.by_type("IfcGroup"))
    deleted_count = 0
    for group in groups:
        try:
            for rel in list(getattr(group, "IsGroupedBy", None) or []):
                ifc.remove(rel)
            ifc.remove(group)
            deleted_count += 1
        except Exception:
            continue
    atomic_write_model(ifc, path)
    return {"ok": True, "deleted": deleted_count}


class RenameAllGroupsRequest(BaseModel):
    path: str
    new_name_template: str  # Template like "Sanitario_{n}" where {n} is replaced with 1, 2, 3...


@router.post("/groups/rename-all")
async def rename_all_groups(req: RenameAllGroupsRequest):
    """Rename all IfcGroup entities using a template: Sanitario_{n}, Drenaje_{n}, etc."""
    _guard_path(req.path)
    if not os.path.isfile(req.path):
        raise HTTPException(404, "File not found")
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _rename_all_groups, req.path, req.new_name_template)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _rename_all_groups(path: str, template: str) -> dict:
    import ifcopenshell
    ifc = ifcopenshell.open(path)
    groups = list(ifc.by_type("IfcGroup"))
    groups.sort(key=lambda g: (g.Name or "").lower())
    renamed_count = 0
    for idx, group in enumerate(groups, start=1):
        try:
            group.Name = template.replace("{n}", str(idx))
            renamed_count += 1
        except Exception:
            continue
    atomic_write_model(ifc, path)
    return {"ok": True, "renamed": renamed_count}


class CreateGroupsRequest(BaseModel):
    path: str
    pset_name: str
    prop_name: str
    name_prefix: str = ""              # optional prefix prepended to each group's name
    name_suffix: str = ""              # optional suffix appended to each group's name
    values: Optional[list[str]] = None  # restrict to these distinct values only; None = all


@router.post("/groups/create")
async def create_groups(req: CreateGroupsRequest):
    """Create one IfcGroup per distinct value of pset_name.prop_name (or only for
    the given `values` subset), with all matching elements assigned to it via
    IfcRelAssignsToGroup — Navisworks then shows these as ready-made sets the
    moment the model is opened."""
    _guard_path(req.path)
    if not os.path.isfile(req.path):
        raise HTTPException(404, "File not found")
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            None, _create_groups_by_value, req.path, req.pset_name, req.prop_name, req.name_prefix, req.name_suffix, req.values
        )
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _create_groups_by_value(path: str, pset_name: str, prop_name: str, name_prefix: str, name_suffix: str, only_values: Optional[list[str]] = None) -> dict:
    import ifcopenshell
    import ifcopenshell.guid

    ifc = ifcopenshell.open(path)

    buckets: dict = {}
    for entity, val in _iter_instances_with_prop(ifc, prop_name):
        if entity.is_a().upper() in _IFC_SPATIAL_CONTAINER_TYPES:
            continue
        if val is None or val == "":
            continue
        sval = str(val)
        if only_values is not None and sval not in only_values:
            continue
        buckets.setdefault(sval, []).append(entity)

    if not buckets:
        return {"ok": True, "created": 0, "groups": [],
                "message": "Ningún elemento tiene esa propiedad con valor"}

    created = []
    for value, entities in sorted(buckets.items()):
        # IfcSystem, not the bare IfcGroup — Navisworks' IFC importer only
        # surfaces IfcSystem (and its subtypes, like Civil3D's own
        # IfcDistributionSystem) under "Colecciones de IFC"; a plain IfcGroup
        # is schema-valid but never shown as a Set there.
        # Name includes the pset and property it came from, not just the raw
        # value — with several of these built from different criteria over
        # time (possibly on the same model), a bare "1.3.3" stops being
        # identifiable; "ADIF_04_4D - ADIF_04_Codigo_Actividad - 1.3.3" isn't.
        group = ifc.create_entity(
            "IfcSystem",
            GlobalId=ifcopenshell.guid.new(),
            Name=f"{name_prefix}{pset_name} - {prop_name} - {value}{name_suffix}",
        )
        ifc.create_entity(
            "IfcRelAssignsToGroup",
            GlobalId=ifcopenshell.guid.new(),
            RelatedObjects=entities,
            RelatingGroup=group,
        )
        created.append({"name": group.Name, "count": len(entities)})

    atomic_write_model(ifc, path)
    return {"ok": True, "created": len(created), "groups": created}


class NamedGroupItem(BaseModel):
    name: str          # full IfcSystem name to use, e.g. "1.4.2.9.5 - Electrificación: ..."
    values: list[str]  # raw property values to match into this one group — usually a single
                        # value (e.g. Planning Sets: one codigo_actividad per set), but can be
                        # several (e.g. Cost Sets: every codigo_partida under one capítulo
                        # merges into a single "capítulo" IfcSystem)


class CreateNamedGroupsRequest(BaseModel):
    path: str
    pset_name: str
    prop_name: str
    items: list[NamedGroupItem]


@router.post("/groups/create-named")
async def create_named_groups(req: CreateNamedGroupsRequest):
    """Like /groups/create, but each group gets an explicit, caller-supplied
    name and set of matching values instead of one fixed-pattern group per
    distinct value — used by Planning Sets ("{codigo} - {descripcion_actividad}",
    1 value each) and Cost Sets ("{codigo_capitulo} - {capitulo}", N values each,
    since several codigo_partida share one capítulo)."""
    _guard_path(req.path)
    if not os.path.isfile(req.path):
        raise HTTPException(404, "File not found")
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            None, _create_named_groups_by_value, req.path, req.pset_name, req.prop_name,
            [(i.name, i.values) for i in req.items],
        )
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _create_named_groups_by_value(path: str, pset_name: str, prop_name: str, groups: list) -> dict:
    import ifcopenshell
    import ifcopenshell.guid

    ifc = ifcopenshell.open(path)

    value_to_name: dict = {}
    for name, values in groups:
        for v in values:
            value_to_name[v] = name

    buckets: dict = {}
    for entity, val in _iter_instances_with_prop(ifc, prop_name):
        if entity.is_a().upper() in _IFC_SPATIAL_CONTAINER_TYPES:
            continue
        if val is None or val == "":
            continue
        sval = str(val)
        name = value_to_name.get(sval)
        if name is None:
            continue
        buckets.setdefault(name, []).append(entity)

    if not buckets:
        return {"ok": True, "created": 0, "groups": [],
                "message": "Ningún elemento tiene esa propiedad con valor"}

    created = []
    for name, entities in sorted(buckets.items()):
        group = ifc.create_entity(
            "IfcSystem",
            GlobalId=ifcopenshell.guid.new(),
            Name=name,
        )
        ifc.create_entity(
            "IfcRelAssignsToGroup",
            GlobalId=ifcopenshell.guid.new(),
            RelatedObjects=entities,
            RelatingGroup=group,
        )
        created.append({"name": group.Name, "count": len(entities)})

    atomic_write_model(ifc, path)
    return {"ok": True, "created": len(created), "groups": created}


# ── File Management ──────────────────────────────────────────────────────────

@router.delete("/delete")
async def delete_file(path: str):
    """Delete an IFC file from disk."""
    _guard_path(path)
    if not path or not os.path.isfile(path):
        raise HTTPException(404, "Archivo no encontrado")

    try:
        os.remove(path)
        return {"ok": True, "message": f"Archivo eliminado: {os.path.basename(path)}"}
    except Exception as e:
        raise HTTPException(500, f"Error al eliminar: {str(e)}")


@router.post("/open-folder")
async def open_folder(path: str):
    """Open folder in Windows Explorer."""
    if not path or not os.path.isdir(path):
        # Try to get parent directory if path is a file
        if os.path.isfile(path):
            path = os.path.dirname(path)
        else:
            raise HTTPException(404, "Carpeta no encontrada")

    try:
        import subprocess
        subprocess.Popen(f'explorer "{os.path.abspath(path)}"')
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, f"Error al abrir carpeta: {str(e)}")


# ── C3D Export Setup — Deploy de JSON de infraexportselect ───────────────────────

_C3D_TEMPLATES_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "templates", "c3d_export")
)
_C3D_TEMPLATE_FILES = [
    "IfcInfraConfiguration.json",
    "IfcInfraExportMapping.json",
    "IfcInfraExportPropertyMapping.json",
]

class C3DExportOverrides(BaseModel):
    AuthorAttributes:   Optional[dict] = None
    ProjectAttributes:  Optional[dict] = None
    FacilityAttributes: Optional[dict] = None

class C3DExportPreviewRequest(BaseModel):
    folders: list[str]

class C3DExportDeployRequest(BaseModel):
    folders:             list[str]
    project_overrides:   Optional[C3DExportOverrides] = None
    overwrite_conflicts: bool = False


@router.post("/c3d-export/preview")
async def c3d_export_preview(req: C3DExportPreviewRequest):
    """
    Para cada carpeta de destino devuelve:
      - dwg_files: archivos .dwg encontrados
      - conflicts: JSON de plantilla ya existentes
      - writable: si se puede escribir en la carpeta
    """
    results = []
    for folder in req.folders:
        folder = folder.strip()
        if not os.path.isdir(folder):
            results.append({
                "folder":    folder,
                "error":     "Carpeta no encontrada",
                "dwg_files": [],
                "conflicts": [],
                "writable":  False,
            })
            continue

        try:
            all_files = os.listdir(folder)
        except PermissionError:
            results.append({
                "folder":    folder,
                "error":     "Sin permiso de lectura",
                "dwg_files": [],
                "conflicts": [],
                "writable":  False,
            })
            continue

        dwg_files = sorted(f for f in all_files if f.lower().endswith(".dwg"))
        conflicts  = [f for f in _C3D_TEMPLATE_FILES if f in all_files]

        # Verificar escritura
        writable = False
        test_path = os.path.join(folder, ".c3d_write_test")
        try:
            with open(test_path, "w") as fh:
                fh.write("")
            os.remove(test_path)
            writable = True
        except OSError:
            pass

        results.append({
            "folder":       folder,
            "error":        None,
            "dwg_files":    dwg_files,
            "dwg_count":    len(dwg_files),
            "conflicts":    conflicts,
            "has_conflicts": len(conflicts) > 0,
            "writable":     writable,
        })

    return {"folders": results}


@router.post("/c3d-export/deploy")
async def c3d_export_deploy(req: C3DExportDeployRequest):
    """
    Escribe los 3 JSON de plantilla en cada carpeta de destino.
    Aplica project_overrides sobre IfcInfraConfiguration.json antes de escribir.
    """
    if not os.path.isdir(_C3D_TEMPLATES_DIR):
        raise HTTPException(500, f"Directorio de plantillas no encontrado: {_C3D_TEMPLATES_DIR}")

    folder_results = []

    for folder in req.folders:
        folder = folder.strip()
        if not os.path.isdir(folder):
            folder_results.append({
                "folder":   folder,
                "deployed": [],
                "skipped":  [],
                "errors":   [{"file": "*", "error": "Carpeta no encontrada"}],
                "ok":       False,
            })
            continue

        deployed, skipped, errors = [], [], []

        for filename in _C3D_TEMPLATE_FILES:
            template_path = os.path.join(_C3D_TEMPLATES_DIR, filename)
            target_path   = os.path.join(folder, filename)

            # Conflicto: ya existe y no se quiere sobrescribir
            if not req.overwrite_conflicts and os.path.exists(target_path):
                skipped.append(filename)
                continue

            try:
                with open(template_path, "r", encoding="utf-8") as fh:
                    data = json.load(fh)

                # Aplicar overrides solo al archivo de configuración principal
                if filename == "IfcInfraConfiguration.json" and req.project_overrides:
                    ovr = req.project_overrides
                    export_section = data.get("Export", {})

                    if ovr.AuthorAttributes:
                        auth = export_section.setdefault("AuthorAttributes", {})
                        auth.update({k: v for k, v in ovr.AuthorAttributes.items() if v is not None})

                    if ovr.ProjectAttributes:
                        proj = export_section.setdefault("ProjectAttributes", {})
                        proj.update({k: v for k, v in ovr.ProjectAttributes.items() if v is not None})

                    if ovr.FacilityAttributes:
                        fac = export_section.setdefault("FacilityAttributes", {})
                        fac.update({k: v for k, v in ovr.FacilityAttributes.items() if v is not None})

                    data["Export"] = export_section

                with open(target_path, "w", encoding="utf-8") as fh:
                    json.dump(data, fh, ensure_ascii=False, indent=2)

                deployed.append(filename)

            except Exception as e:
                errors.append({"file": filename, "error": str(e)})

        folder_results.append({
            "folder":   folder,
            "deployed": deployed,
            "skipped":  skipped,
            "errors":   errors,
            "ok":       len(errors) == 0,
        })

    overall_ok = all(r["ok"] for r in folder_results)
    return {"ok": overall_ok, "results": folder_results}


# ── Get IFC Project Properties (for modal display) ────────────────────────────

@router.get("/ifc-project-properties")
async def ifc_project_properties(path: str):
    """Return all properties and attributes of the IfcProject entity."""
    if not os.path.isfile(path):
        raise HTTPException(404, "File not found")

    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _extract_ifc_project_properties, path)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


def _extract_ifc_project_properties(path: str) -> dict:
    """Extract all properties from IfcProject using ifcopenshell."""
    import ifcopenshell
    import ifcopenshell.util.element as elem_util

    try:
        ifc = ifcopenshell.open(path)
        projects = ifc.by_type("IfcProject")
        if not projects:
            return {"attributes": {}, "psets": {}}

        project = projects[0]

        # Get attributes
        attributes = {
            "GlobalId": str(project.GlobalId or "—"),
            "Name": str(project.Name or "—"),
            "Description": str(project.Description or "—"),
            "ObjectType": str(getattr(project, "ObjectType", None) or "—"),
            "LongName": str(getattr(project, "LongName", None) or "—"),
            "Phase": str(getattr(project, "Phase", None) or "—"),
        }

        # Get all property sets. Civil3D exports attach ADIF/INGR psets to
        # IfcProject, but some Revit exports attach them to IfcSite instead —
        # merge both, with IfcProject values taking priority, so nothing tied
        # to the project's own site (e.g. INGR_Mes_Actual) goes missing.
        psets: dict = {}

        def _merge_psets(entity):
            try:
                all_psets = elem_util.get_psets(entity)
            except Exception:
                return
            if not all_psets:
                return
            for pset_name, props in all_psets.items():
                bucket = psets.setdefault(pset_name, {})
                for prop_name, prop_val in props.items():
                    bucket.setdefault(prop_name, str(prop_val if prop_val is not None else "—"))

        _merge_psets(project)
        for site in ifc.by_type("IfcSite"):
            _merge_psets(site)

        return {"attributes": attributes, "psets": psets}

    except Exception as e:
        return {"attributes": {}, "psets": {}, "error": str(e)}
