"""Motor de recomendaciones — rellena `CheckResult.recommendation` con texto
accionable adaptado al origen del modelo (Revit, Civil 3D o genérico).

Diccionario `RULE_TIPS[rule_id][author] = "texto"`. Si no hay match
específico, se usa la clave `GENERIC`.
"""
from __future__ import annotations

from .common import (
    CheckResult,
    AUTHOR_REVIT, AUTHOR_CIVIL3D, AUTHOR_GENERIC,
)


# ── Catálogo de recomendaciones ──────────────────────────────────────────────
# Estructura: rule_id → { AUTHOR_*: texto }
RULE_TIPS: dict[str, dict[str, str]] = {

    # ── IFC 4x3 / ISO 16739-1 ───────────────────────────────────────────────
    "IFC4X3.SCH.001": {
        AUTHOR_REVIT:   "En el diálogo 'Exportar IFC' selecciona la versión IFC4X3 (Revit 2024+). "
                        "Si no aparece, actualiza el IFC Exporter desde el App Store de Autodesk.",
        AUTHOR_CIVIL3D: "Usa el comando IFCEXPORT con la opción 'Schema = IFC4x3'. "
                        "Verifica que el Civil 3D 2024+ tenga el extension de IFC4x3 activo.",
        AUTHOR_GENERIC: "Re-exporta el modelo declarando IFC4X3 (no IFC2X3 ni IFC4).",
    },
    "IFC4X3.HIER.001": {
        AUTHOR_REVIT:   "Asegúrate de tener Project Information, Site, y Building completos antes de exportar. "
                        "Revisa 'Manage → Project Information' y 'Site' en el modelo.",
        AUTHOR_CIVIL3D: "Antes del export, define la 'IFC Site' y 'IFC Facility' en el panel de configuración "
                        "IFC. Civil 3D suele omitirlas en exports rápidos.",
        AUTHOR_GENERIC: "Añade las entidades faltantes en la jerarquía espacial (IfcProject/IfcSite/IfcFacility).",
    },
    "IFC4X3.HIER.002": {
        AUTHOR_REVIT:   "Los huérfanos suelen venir de elementos sueltos o 'in-place families' sin host. "
                        "Asocia cada elemento a un nivel/host antes de exportar.",
        AUTHOR_CIVIL3D: "Asegúrate de que cada objeto AECC esté asignado a un Site o a un Subassembly contenedor.",
        AUTHOR_GENERIC: "Asocia cada IfcElement a un IfcSpatialStructureElement mediante IfcRelContainedInSpatialStructure.",
    },
    "IFC4X3.OWN.001": {
        AUTHOR_REVIT:   "En 'Modify → Manage IFC Exporter' verifica que el usuario y la aplicación estén configurados. "
                        "Reinstala el IFC Exporter si OwningApplication queda vacío.",
        AUTHOR_CIVIL3D: "Civil 3D rellena OwnerHistory automáticamente; si falta, re-exporta con un perfil "
                        "configurado en Civil 3D IFC Settings → Author.",
        AUTHOR_GENERIC: "Completa los campos OwningUser, OwningApplication y CreationDate en IfcOwnerHistory.",
    },
    "IFC4X3.UNIT.001": {
        AUTHOR_REVIT:   "Revisa 'Manage → Project Units' y asegúrate de que Length y Angle estén configurados "
                        "antes de exportar IFC.",
        AUTHOR_CIVIL3D: "Define las unidades del DWG en MM o M (sistema métrico). 'Drawing Settings → Units'.",
        AUTHOR_GENERIC: "Añade IfcSIUnit para LENGTHUNIT y PLANEANGLEUNIT al IfcUnitAssignment del proyecto.",
    },
    "IFC4X3.GEO.001": {
        AUTHOR_REVIT:   "En 'Manage → Coordinates → Specify Coordinates at Point' fija las coordenadas reales "
                        "del proyecto. Configura el IFC Exporter con 'Coordinate base = Project Base Point' y "
                        "marca 'Use shared coordinates for IFC Project Coordinate System'.",
        AUTHOR_CIVIL3D: "Civil 3D ya trabaja en coords UTM/locales. En el export IFC marca 'Include Map Conversion' "
                        "y declara el EPSG en 'Drawing Settings → Coordinate System'.",
        AUTHOR_GENERIC: "Añade IfcMapConversion + IfcProjectedCRS con código EPSG válido (ej. EPSG:25830).",
    },
    "IFC4X3.GID.001": {
        AUTHOR_REVIT:   "Los GUIDs inválidos suelen aparecer al copiar/pegar elementos entre proyectos. "
                        "Usa el Audit del modelo Revit y re-exporta. No edites manualmente los GUIDs.",
        AUTHOR_CIVIL3D: "Civil 3D regenera GUIDs en cada export. Si hay duplicados, verifica que no haya XREFs "
                        "duplicadas o subassemblies clonados.",
        AUTHOR_GENERIC: "Regenera GlobalIds con ifcopenshell.guid.new() para entidades inválidas/duplicadas.",
    },
    "IFC4X3.PSET.001": {
        AUTHOR_REVIT:   "Activa 'Export IFC common property sets' en las opciones del IFC Exporter. "
                        "Si sigues sin Pset_*Common, mapea los parámetros vía un IFC Mapping Template.",
        AUTHOR_CIVIL3D: "En 'IFC Property Set Definitions' incluye los Psets _Common por categoría AECC. "
                        "Civil 3D los omite por defecto.",
        AUTHOR_GENERIC: "Crea IfcPropertySet con Name='Pset_<Type>Common' y enlázalo con IfcRelDefinesByProperties.",
    },
    "IFC4X3.CLASS.001": {
        AUTHOR_REVIT:   "Usa el plugin 'Classification Manager for Autodesk Revit' o asigna Uniclass/ADIF "
                        "vía un parámetro compartido mapeado a IfcClassificationReference.",
        AUTHOR_CIVIL3D: "Mapea los parámetros AECC al Pset 'Pset_ClassificationReference' y declara la tabla "
                        "(ej. ADIF, Uniclass) en el bloque IFC Settings.",
        AUTHOR_GENERIC: "Añade IfcClassification + IfcClassificationReference y enlaza con IfcRelAssociatesClassification.",
    },
    "IFC4X3.MAT.001": {
        AUTHOR_REVIT:   "Asegúrate de que cada tipo de elemento tenga un Material asignado en 'Material Browser'. "
                        "Para muros multicapa usa 'Structure → Edit Assembly' con materiales en cada capa.",
        AUTHOR_CIVIL3D: "Asigna materiales vía 'Object Style' o desde la tabla AECC_Material asociada al subassembly.",
        AUTHOR_GENERIC: "Asocia un IfcMaterial / IfcMaterialLayerSet a cada elemento con IfcRelAssociatesMaterial.",
    },

    # ── IFC Rail ────────────────────────────────────────────────────────────
    "RAIL.ENT.001": {
        AUTHOR_REVIT:   "Revit no tiene entidades rail nativas. Usa el plugin 'IFC Rail for Revit' o exporta "
                        "los corredores desde Civil 3D y federa en el IFC final.",
        AUTHOR_CIVIL3D: "Civil 3D 2024+ exporta IfcRailway/IfcTrack si configuras el Profile 'Rail Infrastructure'. "
                        "Verifica que estás usando el IFC4x3 RC2+ profile.",
        AUTHOR_GENERIC: "Reemplaza IfcBuildingElementProxy por entidades de dominio rail (IfcRailway, IfcTrack…) en el export.",
    },
    "RAIL.ALIGN.001": {
        AUTHOR_REVIT:   "Las alineaciones deben venir de Civil 3D. Si modelaste vía in-place geometry, exporta "
                        "el corredor desde Civil 3D y enlaza por federación.",
        AUTHOR_CIVIL3D: "Asegúrate de exportar la alineación con su Profile (vertical) asociado. En 'Export to IFC' "
                        "marca 'Include Profiles' y 'Include Cant Diagram' si aplica.",
        AUTHOR_GENERIC: "Cada IfcAlignment debe tener IfcAlignmentHorizontal + IfcAlignmentVertical anidados por IfcRelNests.",
    },
    "RAIL.TRK.001": {
        AUTHOR_REVIT:   "Crea un parámetro compartido 'Gauge' tipo Length y mapéalo a Pset_TrackCommon.Gauge en el "
                        "IFC Mapping. El estándar ADIF es 1668 mm (ibérico) o 1435 mm (UIC).",
        AUTHOR_CIVIL3D: "Añade Gauge al Pset_TrackCommon en el subassembly de vía y asegura que se exporta como "
                        "propiedad IFC (no como atributo AECC).",
        AUTHOR_GENERIC: "Crea Pset_TrackCommon con propiedad 'Gauge' (IfcPositiveLengthMeasure) y vincula a cada IfcTrack.",
    },
    "RAIL.SIG.001": {
        AUTHOR_REVIT:   "Las señales en Revit deben ser familias con un Reference Point. Asegura que tienen "
                        "ubicación y orientación válidas antes de exportar.",
        AUTHOR_CIVIL3D: "Posiciona las señales como AECC Points referenciados a la alineación + station. El export "
                        "IFC los convierte en IfcSignal con ObjectPlacement.",
        AUTHOR_GENERIC: "Asigna IfcLocalPlacement a cada IfcSignal, idealmente referenciado a la alineación correspondiente.",
    },
    "RAIL.OCS.001": {
        AUTHOR_REVIT:   "Modela la catenaria como sistema MEP con categoría 'Electrical Equipment'. Configura el "
                        "IFC Mapping para que ese sistema exporte como IfcDistributionSystem PredefinedType=ELECTRICAL.",
        AUTHOR_CIVIL3D: "Usa los componentes Rail Electrification del paquete 'Rail Infrastructure' y exporta "
                        "como sistema eléctrico.",
        AUTHOR_GENERIC: "Crea IfcDistributionSystem con PredefinedType=ELECTRICAL y Name='OCS_Catenaria'.",
    },
    "RAIL.ZONE.001": {
        AUTHOR_REVIT:   "Modela corredores como 'Areas' en plantas y mapéalas a IfcSpatialZone en el IFC Exporter.",
        AUTHOR_CIVIL3D: "Define corredores ADIF como 'Site' o 'Corridor Region' y mapéalos a IfcSpatialZone.",
        AUTHOR_GENERIC: "Crea IfcSpatialZone para cada corredor/plataforma y enlaza los elementos con IfcRelReferencedInSpatialStructure.",
    },

    # ── ISO 19148 ────────────────────────────────────────────────────────────
    "LR.CONT.001": {
        AUTHOR_CIVIL3D: "Verifica que la alineación tiene tanto 'Horizontal Alignment' como 'Profile' (perfil "
                        "vertical) asociados antes del export.",
        AUTHOR_REVIT:   "Importa las alineaciones desde Civil 3D — Revit no genera horizontal+vertical de forma nativa.",
        AUTHOR_GENERIC: "Anida IfcAlignmentHorizontal y IfcAlignmentVertical bajo el IfcAlignment con IfcRelNests.",
    },
    "LR.STAT.001": {
        AUTHOR_CIVIL3D: "Stations no monotónicos suelen indicar 'Station Equations' o reversión. Audita el "
                        "Alignment en Civil 3D y elimina equations al exportar si no son intencionales.",
        AUTHOR_REVIT:   "N/A en Revit — re-exporta desde Civil 3D.",
        AUTHOR_GENERIC: "Reordena IfcAlignmentSegment según StartDistAlong creciente.",
    },
    "LR.SEG.001": {
        AUTHOR_CIVIL3D: "Gaps entre segmentos = SegmentLength incorrecto o discontinuidad geométrica. Revisa los "
                        "PI/PVI de la alineación y vuelve a calcular.",
        AUTHOR_REVIT:   "N/A en Revit.",
        AUTHOR_GENERIC: "Ajusta SegmentLength para que StartDistAlong[n+1] = StartDistAlong[n] + SegmentLength[n].",
    },
    "LR.LRS.001": {
        AUTHOR_CIVIL3D: "Inserta IfcReferent en los PKs principales (ej. cada 100 m o en puntos kilométricos ADIF) "
                        "para establecer un LRS de referencia.",
        AUTHOR_REVIT:   "N/A en Revit — modela los PKs en Civil 3D.",
        AUTHOR_GENERIC: "Crea IfcReferent por PK con stationing declarado para conformar un LRS completo.",
    },

    # ── railML 3.x ───────────────────────────────────────────────────────────
    "RML.ALIGN.001": {
        AUTHOR_CIVIL3D: "Cada Alignment de Civil 3D debe exportar al menos su geometría horizontal para mapear "
                        "a railML <track>. Verifica el export profile 'Rail Infrastructure'.",
        AUTHOR_REVIT:   "Las alineaciones deben venir desde Civil 3D para ser exportables a railML.",
        AUTHOR_GENERIC: "Cada IfcAlignment debe tener al menos un IfcAlignmentHorizontal anidado.",
    },
    "RML.MILE.001": {
        AUTHOR_CIVIL3D: "Inserta puntos kilométricos como IfcReferent. railML requiere mileage para topología.",
        AUTHOR_REVIT:   "N/A — usa Civil 3D para definir PKs.",
        AUTHOR_GENERIC: "Añade IfcReferent referenciados a las alineaciones para representar mileage.",
    },
    "RML.NAME.001": {
        AUTHOR_CIVIL3D: "Asigna Name único a cada Alignment en Civil 3D antes de exportar.",
        AUTHOR_REVIT:   "Renombra alineaciones con nomenclatura ADIF en el modelo origen (Civil 3D).",
        AUTHOR_GENERIC: "Asigna IfcAlignment.Name único y no vacío (ej. 'AL_VIA1', 'AL_VIA2').",
    },
    "RML.NET.001": {
        AUTHOR_CIVIL3D: "Inserta al menos 2 IfcReferent (origen y fin) en cada alineación para que railML pueda "
                        "construir la topología nodo-arista.",
        AUTHOR_REVIT:   "N/A.",
        AUTHOR_GENERIC: "Crea ≥2 IfcReferent referenciados a IfcAlignment para topología.",
    },

    # ── EN 17632 ─────────────────────────────────────────────────────────────
    "EN.PRJ.001": {
        AUTHOR_REVIT:   "Completa 'Project Information': Name, LongName y Phase (rellena 'Project Phase' como "
                        "parámetro del proyecto si no existe nativamente).",
        AUTHOR_CIVIL3D: "En el panel IFC Export → 'Project Info' añade Name, LongName y Phase del proyecto.",
        AUTHOR_GENERIC: "Rellena IfcProject.Name, IfcProject.LongName e IfcProject.Phase.",
    },
    "EN.IDS.001": {
        AUTHOR_REVIT:   "Usa la herramienta 'Name Type+ID' del IFC HUB para autogenerar nombres normalizados.",
        AUTHOR_CIVIL3D: "Asigna Name a cada elemento AECC desde Object Style → Naming Template.",
        AUTHOR_GENERIC: "Asigna IfcRoot.Name no vacío a cada elemento significativo.",
    },
    "EN.BSDD.001": {
        AUTHOR_REVIT:   "Usa el plugin 'bSDD for Revit' o mapea parámetros compartidos a IfcExternalReference "
                        "con Location apuntando a https://search.bsdd.buildingsmart.org",
        AUTHOR_CIVIL3D: "Mapea atributos AECC al Pset_ClassificationReference apuntando al diccionario bSDD/ADIF.",
        AUTHOR_GENERIC: "Crea IfcExternalReference con Location de bSDD u otro diccionario público.",
    },
    "EN.DOC.001": {
        AUTHOR_REVIT:   "Vincula documentación PDF/DWG vía 'Manage Links' y exporta como IfcDocumentReference.",
        AUTHOR_CIVIL3D: "Adjunta documentos al Project Information y exporta vía IfcDocumentInformation.",
        AUTHOR_GENERIC: "Añade IfcDocumentInformation por cada documento del proyecto y enlaza con IfcRelAssociatesDocument.",
    },
}


_V2025_TIPS: dict[str, dict[str, str]] = {
    "IFC4X3.SCH.001": {
        AUTHOR_REVIT:   "Revit 2025 incluye exportador IFC 4x3 nativo (sin plugin adicional). Ve a File → Export → IFC y selecciona el preset 'IFC 4.3'.",
        AUTHOR_CIVIL3D: "Civil 3D 2025 incluye el perfil 'IFC 4x3 Rail' mejorado. En el cuadro IFCEXPORT selecciona ese perfil.",
    },
    "IFC4X3.GEO.001": {
        AUTHOR_REVIT:   "Revit 2025: en Export IFC Settings activa 'Export shared coordinates' y el código EPSG se escribe en el campo 'Coordinate Reference System Name'.",
        AUTHOR_CIVIL3D: "Civil 3D 2025: en Drawing Settings → Units and Zone escribe el código EPSG y marca 'Include Map Conversion in IFC export'.",
    },
    "RAIL.ENT.001": {
        AUTHOR_REVIT:   "Revit 2025 añade soporte preliminar de IFC Rail: activa la categoría 'Rail' en el IFC Class Mapping y asigna IfcRailway a los elementos de infraestructura.",
        AUTHOR_CIVIL3D: "Civil 3D 2025 exporta IfcRailway/IfcTrack de forma automática con el perfil 'Rail Infrastructure IFC 4x3'. Asegúrate de asignar los corridors al 'IFC Rail' object type.",
    },
    "RAIL.ALIGN.001": {
        AUTHOR_CIVIL3D: "Civil 3D 2025: en el cuadro IFCEXPORT activa 'Include Alignments', 'Include Profiles' y 'Include Cant Diagrams'. El cant sólo se exporta si has definido el diagrama de peralte en el corridor.",
    },
    "LR.CONT.001": {
        AUTHOR_CIVIL3D: "Civil 3D 2025 exporta IfcAlignmentSegment automáticamente si el perfil tiene 'PVI-based' desactivado (usa 'Entity-based'). Revisa en Alignment Properties → Design Criteria.",
    },
    "LR.LRS.001": {
        AUTHOR_CIVIL3D: "Civil 3D 2025: usa el comando ALIGNMENTSTATIONING y configura los PKs como 'Alignment Stations' antes de exportar. Se convierten a IfcReferent.",
    },
    "IFC4X3.PSET.001": {
        AUTHOR_REVIT:   "Revit 2025 mapea automáticamente los Shared Parameters a Psets si el nombre sigue el patrón 'Pset_<IfcType>'. Revisa el IFC Parameter Mapping en el cuadro de export.",
        AUTHOR_CIVIL3D: "Civil 3D 2025: en 'IFC Property Set Definitions' activa la opción 'Include Standard IFC Property Sets' para volcar automáticamente los Psets comunes.",
    },
    "IFC4X3.MAT.001": {
        AUTHOR_REVIT:   "Revit 2025 exporta materiales multicapa correctamente si en el IFC Export Settings activas 'Export layers of multi-layer elements as separate materials'.",
    },
}


def get_tip(rule_id: str, author: str, version: str = "") -> str:
    """Devuelve el texto de recomendación para la regla + autor, con fallback a GENERIC."""
    tips = RULE_TIPS.get(rule_id)
    if not tips:
        return ""
    base = tips.get(author) or tips.get(AUTHOR_GENERIC) or ""
    if version >= "2025":
        v25 = _V2025_TIPS.get(rule_id, {})
        note = v25.get(author) or v25.get(AUTHOR_GENERIC) or ""
        if note:
            return f"{base} ▸ [v{version}] {note}"
    return base


def enrich(results: list[CheckResult], app_version: str = "") -> list[CheckResult]:
    """Rellena la recomendación de cada CheckResult fallado in-place y la devuelve."""
    for r in results:
        if r.passed:
            r.recommendation = ""
            continue
        r.recommendation = get_tip(r.rule_id, r.source_hint, app_version)
    return results


def build_improvement_plan(results: list[CheckResult], top_n: int = 10) -> list[dict]:
    """Top-N issues priorizados por impacto (severidad × count).

    Devuelve dicts listos para mostrar en UI / Excel / PDF.
    """
    failed = [r for r in results if not r.passed]
    failed.sort(key=lambda r: r.impact, reverse=True)
    plan = []
    for i, r in enumerate(failed[:top_n], 1):
        plan.append({
            "rank":           i,
            "standard":       r.standard,
            "rule_id":        r.rule_id,
            "title":          r.title,
            "severity":       r.severity,
            "count":          r.issue_count,
            "impact":         r.impact,
            "source_hint":    r.source_hint,
            "recommendation": r.recommendation,
        })
    return plan
