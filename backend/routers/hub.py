"""BIMRail Hub — puente de lectura entre Fractal IFC y BIMRail Hub (Speckle).

No habla con Speckle directamente: lee la colección `speckle_links` que los
add-ins de Revit/Civil3D escriben en cada push (ver
ADDINS/shared/BIMRail.Core/SpeckleService.cs). Agrupa por proyecto y agrega
la URL del visor de Speckle para cada modelo (disciplina) y para el proyecto
completo (federado — todas las disciplinas juntas).
"""

from fastapi import APIRouter

from core.config import settings
from core.resilience import pb_client

router = APIRouter()


def _viewer_url(project_id: str, model_id: str | None = None, version_id: str | None = None) -> str:
    base = f"{settings.SPECKLE_URL}/projects/{project_id}"
    if model_id and version_id:
        return f"{base}/models/{model_id}@{version_id}"
    return base


@router.get("/hub/projects")
def list_hub_projects():
    """Un registro por proyecto ADIF, con la última versión conocida de cada
    Model de Speckle que se haya enviado al Hub.

    Un mismo "disciplina" (revit/civil3d) puede tener VARIOS Models a la vez
    — en Revit, uno por vista activa al momento del push ("Revit - IFC Export
    A demoler", "Revit - IFC Export Proyectado", ...); en Civil3D, uno por
    etiqueta elegida al enviar. Por eso se deduplica por
    (disciplina, speckle_model_id), NUNCA solo por disciplina — si no,
    solo se vería el último push y el resto de vistas/etiquetas desaparecerían
    de la lista aunque sí sigan en Speckle.
    """
    rows = pb_client.get_records("speckle_links", {"sort": "-pushed_at"})

    by_project: dict[str, dict] = {}
    for r in rows:
        proyecto = r.get("proyecto") or "Sin proyecto"
        disciplina = r.get("disciplina") or "?"
        model_id = r.get("speckle_model_id") or ""
        project_id = r.get("speckle_project_id") or ""
        if not project_id or not model_id:
            continue

        proj = by_project.setdefault(proyecto, {
            "proyecto": proyecto,
            "speckle_project_id": project_id,
            "federated_url": _viewer_url(project_id),
            "modelos": {},
        })

        # rows vienen ordenadas por pushed_at desc: la primera vez que se ve
        # un speckle_model_id ya es su versión más reciente.
        if model_id in proj["modelos"]:
            continue
        proj["modelos"][model_id] = {
            "disciplina": disciplina,
            "nombre": r.get("speckle_model_name") or disciplina,
            "speckle_model_id": model_id,
            "speckle_version_id": r.get("speckle_version_id") or "",
            "pushed_by": r.get("pushed_by") or "",
            "pushed_at": r.get("pushed_at") or "",
            "viewer_url": _viewer_url(project_id, model_id, r.get("speckle_version_id")),
        }

    out = []
    for proj in by_project.values():
        proj["modelos"] = list(proj["modelos"].values())
        out.append(proj)
    out.sort(key=lambda p: p["proyecto"])
    return {"speckle_url": settings.SPECKLE_URL, "proyectos": out}
