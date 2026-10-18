"""
client_review_schema.py — Definición de columnas y reglas de rojo para CLIENT REVIEW.
Replicado exactamente del Excel del cliente "Anexo II. Propiedades Ifc_442_MOI.xlsx".
"""

# Valores que se consideran "vacíos" en modo en vivo
EMPTY_VALUES = {"", "n/a", "-", "<sin valor>", "none", "null", "undefined"}


def _is_empty(v) -> bool:
    if v is None:
        return True
    return str(v).strip().lower() in EMPTY_VALUES


def _rule_non_empty(value) -> tuple[bool, str]:
    """Rojo si vacío o N/A."""
    if _is_empty(value):
        return True, "empty"
    return False, ""


def _rule_lat_spain(value) -> tuple[bool, str]:
    # Empty = no info (not an error); only red when there IS a value outside Spain
    if _is_empty(value):
        return False, ""
    try:
        v = float(str(value).replace(",", "."))
    except (ValueError, TypeError):
        return False, ""
    if not (27.0 <= v <= 44.0):
        return True, "coords_outside_spain"
    return False, ""


def _rule_lon_spain(value) -> tuple[bool, str]:
    # Empty = no info (not an error); only red when there IS a value outside Spain
    if _is_empty(value):
        return False, ""
    try:
        v = float(str(value).replace(",", "."))
    except (ValueError, TypeError):
        return False, ""
    if not (-19.0 <= v <= 5.0):
        return True, "coords_outside_spain"
    return False, ""


def _rule_none(_value) -> tuple[bool, str]:
    """Sin validación — la columna es informativa."""
    return False, ""


# ── Esquema de columnas ───────────────────────────────────────────────────────
# Cada columna: key (nombre canónico), source (cómo extraer), rule (función)
# source:
#   "info.<campo>"           → de _extract_ifc_info()
#   "site.<attr>"            → IfcSite.<attr> (RefLatitude, RefLongitude, etc.)
#   "attr.<attr>"            → IfcProject.<attr> estándar
#   "pset:<PsetName>/<Prop>" → PropertySet named / propiedad

SCHEMA: dict[str, list[dict]] = {

    # ── Nivel archivo (IfcFile) — cabeceras "Grupo\nSubcabecera" calcadas del
    # Excel real del cliente (Anexo II. Propiedades Ifc_442_MOI.xlsx, hoja IfcFile).
    "file": [
        {"key": "Archivo",               "label": "Elemento\nNombre",                "source": "info.filename",           "rule": _rule_none},
        {"key": "Unidad",                "label": "Elemento\nUnidad",                 "source": "info.unidad",             "rule": _rule_none},
        {"key": "Esquema de IFC",        "label": "IFC Properties\nIFC Schema",       "source": "info.schema",             "rule": _rule_non_empty},
        {"key": "Sello horario de IFC",  "label": "IFC Properties\nIFC Time Stamp",   "source": "info.timestamp",          "rule": _rule_non_empty},
        {"key": "Nombre de la aplicación de IFC", "label": "Project\nIfcApplicationName",    "source": "info.originating_system", "rule": _rule_non_empty},
        {"key": "Versión de la aplicación de IFC", "label": "Project\nIfcApplicationVersion", "source": "info.app_version", "rule": _rule_none},
        {"key": "Organización de IFC",   "label": "Project\nIfcOrganization",          "source": "info.organization",       "rule": _rule_non_empty},
        {"key": "Latitude",              "label": "Location\nLatitude",                "source": "site.RefLatitude",        "rule": _rule_lat_spain},
        {"key": "Longitude",             "label": "Location\nLongitude",               "source": "site.RefLongitude",       "rule": _rule_lon_spain},
        {"key": "Elevation",             "label": "Location\nElevation",               "source": "site.RefElevation",       "rule": _rule_none},
        {"key": "Traslacion_X",          "label": "Elemento\nTraslación.X",            "source": "site.coords_x",           "rule": _rule_none},
        {"key": "Traslacion_Y",          "label": "Elemento\nTraslación.Y",            "source": "site.coords_y",           "rule": _rule_none},
        {"key": "Traslacion_Z",          "label": "Elemento\nTraslación.Z",            "source": "site.coords_z",           "rule": _rule_none},
    ],

    # ── Nivel proyecto (IfcProject) — cabeceras calcadas del Excel del cliente ──
    "project": [
        {"key": "GUID",                        "label": "Element\nIfcGUID",                                           "source": "attr.GlobalId",                                            "rule": _rule_none},
        {"key": "Nombre",                      "label": "Elemento\nNombre",                                           "source": "attr.Name",                                                "rule": _rule_non_empty},
        {"key": "LongName",                    "label": "Element\nLongName",                                          "source": "attr.LongName",                                            "rule": _rule_non_empty},
        {"key": "FileSize",                    "label": "ElementOriginal IFC File Size",                              "source": "info.file_size_bytes",                                     "rule": _rule_none},
        {"key": "ADIF_00_Codigo_Archivo",      "label": "ADIF_00_Generales\nADIF_00_Codigo_Archivo",                  "source": "pset:ADIF_00_Generales/ADIF_00_Codigo_Archivo",            "rule": _rule_non_empty},
        {"key": "ADIF_02_Codigo_Actuacion",    "label": "ADIF_02_Localizacion\nADIF_02_Codigo_Actuacion",             "source": "pset:ADIF_02_Localizacion/ADIF_02_Codigo_Actuacion",       "rule": _rule_non_empty},
        {"key": "ADIF_02_Direccion_Ubicacion", "label": "ADIF_02_Localizacion\nADIF_02_Direccion_Ubicacion",          "source": "pset:ADIF_02_Localizacion/ADIF_02_Direccion_Ubicacion",    "rule": _rule_non_empty},
        {"key": "ADIF_02_Entorno_Actuacion",   "label": "ADIF_02_Localizacion\nADIF_02_Entorno_Actuacion",            "source": "pset:ADIF_02_Localizacion/ADIF_02_Entorno_Actuacion",      "rule": _rule_non_empty},
        {"key": "ADIF_02_Expediente_Actuacion","label": "ADIF_02_Localizacion\nADIF_02_Expediente_Actuacion",         "source": "pset:ADIF_02_Localizacion/ADIF_02_Expediente_Actuacion",   "rule": _rule_non_empty},
        {"key": "ADIF_02_Nombre_Actuacion",    "label": "ADIF_02_Localizacion\nADIF_02_Nombre_Actuacion",             "source": "pset:ADIF_02_Localizacion/ADIF_02_Nombre_Actuacion",       "rule": _rule_non_empty},
        {"key": "ADIF_02_Nombre_Global",       "label": "ADIF_02_Localizacion\nADIF_02_Nombre_Global",                "source": "pset:ADIF_02_Localizacion/ADIF_02_Nombre_Global",          "rule": _rule_non_empty},
        {"key": "ADIF_02_Sistema_Coordenadas", "label": "ADIF_02_Localizacion\nADIF_02_Sistema_Coordenadas",          "source": "pset:ADIF_02_Localizacion/ADIF_02_Sistema_Coordenadas",    "rule": _rule_non_empty},
        {"key": "ADIF_04_Inicio_Actuacion",    "label": "ADIF_04_4D\nADIF_04_Inicio_Actuacion",                       "source": "pset:ADIF_04_4D/ADIF_04_Inicio_Actuacion",                 "rule": _rule_non_empty},
        {"key": "ADIF_04_Fin_Actuacion",       "label": "ADIF_04_4D\nADIF_04_Fin_Actuacion",                          "source": "pset:ADIF_04_4D/ADIF_04_Fin_Actuacion",                    "rule": _rule_non_empty},
        {"key": "Archivo",                     "label": "Elemento\nArchivo de origen",                                "source": "info.filename",                                            "rule": _rule_none},
    ],

    # ── Nivel elemento (IfcElement) — cabeceras calcadas del Excel del cliente ──
    "element": [
        {"key": "IfcGUID",                  "label": "Componente\nIfcGUID",                                          "source": "attr.GlobalId",                                              "rule": _rule_none},
        {"key": "IfcName",                  "label": "Componente\nIfcName",                                          "source": "attr.Name",                                                  "rule": _rule_non_empty},
        {"key": "IfcClass",                 "label": "Componente\nIfcClass",                                         "source": "attr.ifc_class",                                             "rule": _rule_non_empty},
        {"key": "PredefinedType",           "label": "Componente\nIfcExportPredefinedtype",                          "source": "attr.PredefinedType",                                        "rule": _rule_none},
        {"key": "ObjectType",               "label": "Componente\nObjectTypeOverride",                               "source": "attr.ObjectType",                                            "rule": _rule_none},
        {"key": "SpatialContainer",         "label": "Componente\nIfcSpatialContainer",                              "source": "attr.spatial_container",                                     "rule": _rule_none},
        {"key": "Tag",                      "label": "Componente\nIfcTag",                                           "source": "attr.Tag",                                                   "rule": _rule_none},
        {"key": "IfcMaterial",              "label": "Componente\nIfcMaterial",                                     "source": "material",                                                   "rule": _rule_non_empty},
        # Clasificación SCFClass_Funciones
        {"key": "SCFClass_Clasificacion",   "label": "Clasificación: SCFClass_Funciones\nClasificación",             "source": "classification.system",                                      "rule": _rule_non_empty},
        {"key": "SCFClass_Referencia",      "label": "Clasificación: SCFClass_Funciones\nReferencia",                "source": "classification.reference",                                   "rule": _rule_non_empty},
        {"key": "SCFClass_Nombre",          "label": "Clasificación: SCFClass_Funciones\nNombre",                    "source": "classification.name",                                        "rule": _rule_non_empty},
        # ADIF_00
        {"key": "ADIF_00_Codigo_Producto",  "label": "ADIF_00_Generales\nADIF_00_Codigo_Producto",                   "source": "pset:ADIF_00_Generales/ADIF_00_Codigo_Producto",             "rule": _rule_non_empty},
        {"key": "ADIF_00_Descripcion",      "label": "ADIF_00_Generales\nADIF_00_Descripcion_Producto",              "source": "pset:ADIF_00_Generales/ADIF_00_Descripcion_Producto",        "rule": _rule_non_empty},
        {"key": "ADIF_00_Disciplina",       "label": "ADIF_00_Generales\nADIF_00_Disciplina",                        "source": "pset:ADIF_00_Generales/ADIF_00_Disciplina",                  "rule": _rule_non_empty},
        {"key": "ADIF_00_Subdisciplina",    "label": "ADIF_00_Generales\nADIF_00_Subdisciplina",                     "source": "pset:ADIF_00_Generales/ADIF_00_Subdisciplina",               "rule": _rule_none},
        {"key": "ADIF_00_Id_Objeto",        "label": "ADIF_00_Generales\nADIF_00_Id_Objeto",                         "source": "pset:ADIF_00_Generales/ADIF_00_Id_Objeto",                   "rule": _rule_non_empty},
        # ADIF_02
        {"key": "ADIF_02_Km_Inicio",        "label": "ADIF_02_Localizacion\nADIF_02_Km_Inicio",                      "source": "pset:ADIF_02_Localizacion/ADIF_02_Km_Inicio",                "rule": _rule_none},
        {"key": "ADIF_02_Km_Fin",           "label": "ADIF_02_Localizacion\nADIF_02_Km_Fin",                         "source": "pset:ADIF_02_Localizacion/ADIF_02_Km_Fin",                   "rule": _rule_none},
        {"key": "ADIF_02_Zonificacion",     "label": "ADIF_02_Localizacion\nADIF_02_Zonificacion",                   "source": "pset:ADIF_02_Localizacion/ADIF_02_Zonificacion",              "rule": _rule_non_empty},
        # ADIF_03
        {"key": "ADIF_03_Codigo_Estado",           "label": "ADIF_03_Coordinacion3D\nADIF_03_Codigo_Estado",               "source": "pset:ADIF_03_Coordinacion3D/ADIF_03_Codigo_Estado",           "rule": _rule_non_empty},
        {"key": "ADIF_03_Descripcion_Estado",      "label": "ADIF_03_Coordinacion3D\nADIF_03_Descripcion_Estado",          "source": "pset:ADIF_03_Coordinacion3D/ADIF_03_Descripcion_Estado",      "rule": _rule_non_empty},
        {"key": "ADIF_03_Visibilidad_Temporal",    "label": "ADIF_03_Coordinacion3D\nADIF_03_Visibilidad_Temporal",        "source": "pset:ADIF_03_Coordinacion3D/ADIF_03_Visibilidad_Temporal",    "rule": _rule_none},
        {"key": "ADIF_03_Codigo_Estudio",          "label": "ADIF_03_Coordinacion3D\nADIF_03_Codigo_Estudio",              "source": "pset:ADIF_03_Coordinacion3D/ADIF_03_Codigo_Estudio",          "rule": _rule_non_empty},
        {"key": "ADIF_03_Fuente_Definicion",       "label": "ADIF_03_Coordinacion3D\nADIF_03_Fuente_Definicion",           "source": "pset:ADIF_03_Coordinacion3D/ADIF_03_Fuente_Definicion",       "rule": _rule_non_empty},
        {"key": "ADIF_03_Fuente_Comentario",       "label": "ADIF_03_Coordinacion3D\nADIF_03_Fuente_Comentario",           "source": "pset:ADIF_03_Coordinacion3D/ADIF_03_Fuente_Comentario",       "rule": _rule_none},
        # ADIF_04
        {"key": "ADIF_04_Codigo_Actividad", "label": "ADIF_04_4D\nADIF_04_Codigo_Actividad",                          "source": "pset:ADIF_04_4D/ADIF_04_Codigo_Actividad",                   "rule": _rule_none},
        {"key": "ADIF_04_Fase",             "label": "ADIF_04_4D\nADIF_04_Fase",                                     "source": "pset:ADIF_04_4D/ADIF_04_Fase",                               "rule": _rule_none},
        {"key": "ADIF_04_Inicio_Actividad", "label": "ADIF_04_4D\nADIF_04_Inicio_Actividad",                         "source": "pset:ADIF_04_4D/ADIF_04_Inicio_Actividad",                   "rule": _rule_none},
        {"key": "ADIF_04_Fin_Actividad",    "label": "ADIF_04_4D\nADIF_04_Fin_Actividad",                            "source": "pset:ADIF_04_4D/ADIF_04_Fin_Actividad",                      "rule": _rule_none},
        # ADIF_08
        {"key": "ADIF_08_Doc1",             "label": "ADIF_08_DocVinculada\nADIF_08_Doc1",                           "source": "pset:ADIF_08_DocVinculada/ADIF_08_Doc1",                     "rule": _rule_none},
        {"key": "ADIF_08_Doc2",             "label": "ADIF_08_DocVinculada\nADIF_08_Doc2",                           "source": "pset:ADIF_08_DocVinculada/ADIF_08_Doc2",                     "rule": _rule_none},
        {"key": "Archivo",                  "label": "Elemento\nArchivo de origen",                                  "source": "info.filename",                                              "rule": _rule_none},
    ],
}


def get_schema() -> dict[str, list[dict]]:
    """Devuelve el esquema completo. Punto de extensión para migrar a PocketBase."""
    return SCHEMA


def get_columns(level: str) -> list[str]:
    """Devuelve lista de keys (nombres de columna) para un nivel."""
    return [col["key"] for col in SCHEMA.get(level, [])]


def get_pset_columns(level: str) -> list[dict]:
    """Devuelve solo las columnas que provienen de un pset (para bulk-fill UI)."""
    return [
        col for col in SCHEMA.get(level, [])
        if col["source"].startswith("pset:")
    ]
