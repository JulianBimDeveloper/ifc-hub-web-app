"""Automatic code generation for PEB documents and models."""
from __future__ import annotations
from services.peb_models import PEBFormData, PEBDisciplina


def _pad(num: int, width: int = 6) -> str:
    return str(num).zfill(width)


def gen_doc_code(expediente: str, originador: str, tipo: str,
                 especialidad: str, disciplina: str,
                 num_doc: str, descripcion: str) -> str:
    """Generate an ADIF document code.

    Pattern: {expediente}-{originador}-{tipo}-{ET}-{DIS}-{num}-{desc}
    """
    return f"{expediente}-{originador}-{tipo}-{especialidad}-{disciplina}-{num_doc}-{descripcion}"


def gen_midp_table(data: PEBFormData) -> list[dict]:
    """Generate the full MIDP documents table from form data."""
    exp = data.expediente_num
    ori = data.codigo_am
    rows: list[dict] = []

    def row(tipo, et, dis, num, desc_code, descripcion, formato, notas=""):
        code = gen_doc_code(exp, ori, tipo, et, dis, num, desc_code)
        rows.append({
            "codigo": code,
            "descripcion": descripcion,
            "formato": formato,
            "notas": notas,
        })

    # Main documents
    row("PEB", "ME", "BIM", "500000", "PEB", "Plan de Ejecución BIM (PEB)", ".pdf / .docx")
    row("MID", "ME", "BIM", "519001", "MIDP", "Plan General de Desarrollo de la Información (MIDP)", ".xlsx")

    # Annexes
    row("PEB", "ME", "BIM", "508001", "CLASIF_RIH", "Clasificación de elementos RIH", ".xlsx")
    row("MAT", "ME", "BIM", "510001", "VAL_ATRIBUTOS", "Valores permitidos de atributos", ".xlsx")
    row("MAT", "ME", "BIM", "510002", "MAT_ATRIB", "Matriz de atributos", ".xlsx")
    row("PEB", "ME", "BIM", "503001", "PARAM_COMP", "Fichero de parámetros compartidos Revit", ".txt")
    row("PEB", "ME", "BIM", "512001", "CODIF", "Documento de codificación", ".xlsx")
    row("PEB", "ME", "BIM", "509001", "EST_CARP", "Estructura de carpetas", ".xlsx")

    # Export mapping files
    row("EDM", "ME", "BIM", "502001", "RVT_EXPIFC_PSETS", "Mapeo exportación IFC Revit (PSets)", ".txt")
    row("EDM", "ME", "BIM", "502002", "RVT_EXP_IFC_4_DSV", "Mapeo exportación IFC 4 Revit (DSV)", ".json")
    row("EDM", "ME", "BIM", "502003", "RVT_EXP_IFC_2X3_CV2", "Mapeo exportación IFC 2x3 Revit", ".json")

    # Templates
    row("REG", "ME", "BIM", "514001", "PLL_CAL_E_ACTUAL", "Plantilla CC Estado Actual", ".xlsx")
    row("REG", "ME", "BIM", "514002", "PLL_CAL_S_OBRA", "Plantilla CC Seguimiento de Obra", ".xlsx")
    row("REG", "ME", "BIM", "515001", "INTERF_3D", "Plantilla detección de interferencias", ".xlsx")

    # Base models (MCC — Maqueta de Coordinación y Configuración)
    row("MBN", "ME", "BIM", "504001", "MCC_RVT", "Maqueta de prueba Revit (MCC)", ".rvt")
    row("MOP", "ME", "BIM", "504003", "MCC_IFC", "Maqueta de prueba IFC", ".ifc")

    if data.usa_civil3d:
        row("MBN", "ME", "BIM", "504002", "MCC_DWG", "Maqueta de prueba Civil 3D (MCC)", ".dwg")
        row("EDM", "ME", "BIM", "502004", "CV3_EXPIFC_PSETS", "Mapeo exportación IFC Civil 3D (PSets)", ".dwt")
        row("EDM", "ME", "BIM", "502005", "C3D_MAP_CONFIG_IFC4X3", "Config. mapeo IFC 4X3 Civil 3D", ".json")
        row("EDM", "ME", "BIM", "502006", "C3D_MAP_ELEMEN_IFC4X3", "Mapeo elementos IFC 4X3 Civil 3D", ".json")

    # Federated models (MMP)
    row("MFD", "ME", "BIM", "505001", "MMP_FED", "Modelo Master de Proyecto Federado (MMP)", ".nwd")
    row("MBN", "ME", "BIM", "505002", "MMP_RVT", "Modelo Master de Proyecto Nativo Revit", ".rvt")
    row("MOP", "ME", "BIM", "505004", "MMP_IFC", "Modelo Master de Proyecto OpenBIM IFC", ".ifc")
    if data.usa_civil3d:
        row("MBN", "ME", "BIM", "505003", "MMP_C3D", "Modelo Master de Proyecto Nativo Civil 3D", ".dwg")
        row("MOP", "ME", "BIM", "505005", "MMP_C3D_IFC", "Modelo Master de Proyecto OpenBIM Civil 3D", ".ifc")

    return rows


def gen_model_division_table(data: PEBFormData, estado: str = "MEA") -> list[dict]:
    """Generate the model division table for a given project phase.

    estado: "MEA" | "MOI" | "MOM"
    """
    exp = data.expediente_num
    ori = data.codigo_am

    estado_codes = {
        "MEA": ("521100", "MEA"),
        "MOI": ("522100", "MOI"),
        "MOM": ("523100", "MOM"),
    }
    num_base, suffix = estado_codes.get(estado, ("521100", "MEA"))

    rows = []
    for disc in data.disciplinas:
        if not disc.activa:
            continue
        dis = disc.code
        sw = disc.software
        if sw in ("REVIT", "AMBOS"):
            ext = "rvt"
            code = gen_doc_code(exp, ori, "MBN", "ME", dis, num_base, f"{suffix}_{dis}")
            rows.append({
                "nombre": f"{code}.{ext}",
                "disciplina": disc.nombre,
                "empresa": data.empresa_am,
                "software": "Revit",
                "extension": f".{ext}",
            })
        if sw in ("CIVIL3D", "AMBOS"):
            ext = "dwg"
            code = gen_doc_code(exp, ori, "MBN", "ME", dis, num_base, f"{suffix}_{dis}")
            rows.append({
                "nombre": f"{code}.{ext}",
                "disciplina": disc.nombre,
                "empresa": data.empresa_am,
                "software": "Civil 3D",
                "extension": f".{ext}",
            })

    return rows


def gen_federation_table(data: PEBFormData) -> list[dict]:
    """Generate the AM federation models table."""
    exp = data.expediente_num
    ori = data.codigo_am

    estados = [
        ("505001", "MFD", "ME", "BIM", "MMP_FED", "Modelo Master Proyecto Federado (MMP)", ".nwd"),
        ("505002", "MBN", "ME", "BIM", "MMP_RVT", "MMP Nativo Revit", ".rvt"),
        ("505004", "MOP", "ME", "BIM", "MMP_IFC", "MMP OpenBIM IFC", ".ifc"),
    ]
    rows = []
    for num, tipo, et, dis, desc, nombre, ext in estados:
        code = gen_doc_code(exp, ori, tipo, et, dis, num, desc)
        rows.append({
            "nombre": f"{code}{ext}",
            "descripcion": nombre,
            "modelos_incluidos": "Todos los modelos IFC de disciplinas",
        })
    return rows
