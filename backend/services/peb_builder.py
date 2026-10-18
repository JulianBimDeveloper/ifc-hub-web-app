"""Build the complete PEB DOCX document."""
from __future__ import annotations
import io
import uuid
from pathlib import Path
from docx import Document
from docx.shared import Pt, Cm, RGBColor, Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_ALIGN_VERTICAL
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

from services.peb_models import PEBFormData
from services.peb_static import (
    BIM_OBJECTIVES, BIM_USES,
    EQUIPO_ADIF, EQUIPO_ATC,
    HARDWARE_REQUIREMENTS, EXCHANGE_FORMATS, REFERENCE_STANDARDS,
    ADIF_PARAMS, CDE_STATES, NAMING_DOC_FIELDS, NAMING_OBJ_FIELDS,
    NAMING_TIPOL_FIELDS, UNITS_TABLE, SCALES_TABLE, ROLE_DESCRIPTIONS,
    REFERENCIAS_ADIF,
)
from services.peb_codes import gen_midp_table, gen_model_division_table, gen_federation_table
from services.peb_diagrams import (
    generate_organigram, generate_lod_diagram,
    generate_model_states_diagram, generate_cde_flow_diagram,
)

# ── Paths ──────────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).parent.parent
TEMPLATE_PATH = BASE_DIR / "templates" / "peb_template_raw.docx"
OUTPUT_DIR = BASE_DIR / "generated_peb"
OUTPUT_DIR.mkdir(exist_ok=True)

# ── ADIF colors ────────────────────────────────────────────────────────────────
ADIF_DARK  = RGBColor(0x1F, 0x38, 0x64)
ADIF_MID   = RGBColor(0x2E, 0x74, 0xB5)
ADIF_LIGHT = RGBColor(0xD9, 0xE2, 0xF3)
WHITE      = RGBColor(0xFF, 0xFF, 0xFF)
BLACK      = RGBColor(0x00, 0x00, 0x00)


# ─────────────────────────────────────────────────────────────────────────────
# LOW-LEVEL HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _set_cell_shading(cell, hex_color: str):
    """Set background shading for a table cell."""
    tc = cell._tc
    tcPr = tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_color.lstrip("#"))
    tcPr.append(shd)


def _set_cell_borders(table, style: str = "single", size: int = 4):
    """Add borders to all cells in a table."""
    tbl = table._tbl
    tblPr = tbl.tblPr
    if tblPr is None:
        tblPr = OxmlElement("w:tblPr")
        tbl.insert(0, tblPr)
    borders = OxmlElement("w:tblBorders")
    for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement(f"w:{side}")
        el.set(qn("w:val"), style)
        el.set(qn("w:sz"), str(size))
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), "1F3864")
        borders.append(el)
    tblPr.append(borders)


def _set_table_width(table, width_pct: int = 100):
    tbl = table._tbl
    tblPr = tbl.tblPr
    if tblPr is None:
        tblPr = OxmlElement("w:tblPr")
        tbl.insert(0, tblPr)
    tblW = OxmlElement("w:tblW")
    tblW.set(qn("w:w"), str(width_pct * 50))
    tblW.set(qn("w:type"), "pct")
    tblPr.append(tblW)


def _para(doc, text: str, style: str = "Normal", bold=False, italic=False,
          align=WD_ALIGN_PARAGRAPH.LEFT, color: RGBColor | None = None,
          size: int | None = None, space_before: int = 0, space_after: int = 3):
    p = doc.add_paragraph(style=style)
    p.paragraph_format.space_before = Pt(space_before)
    p.paragraph_format.space_after = Pt(space_after)
    p.alignment = align
    run = p.add_run(text)
    run.bold = bold
    run.italic = italic
    if color:
        run.font.color.rgb = color
    if size:
        run.font.size = Pt(size)
    return p


def _heading(doc, text: str, level: int):
    """Add a heading using python-docx built-in levels."""
    h = doc.add_heading(text, level=level)
    h.paragraph_format.space_before = Pt(12 if level <= 2 else 6)
    h.paragraph_format.space_after = Pt(4)
    # Ensure heading color matches ADIF dark blue
    for run in h.runs:
        run.font.color.rgb = ADIF_DARK
    return h


def _bullet(doc, text: str):
    p = doc.add_paragraph(style="List Bullet")
    p.paragraph_format.space_after = Pt(2)
    p.add_run(text)
    return p


def _add_page_break(doc):
    doc.add_page_break()


def _table_header_row(table, headers: list[str], col_widths: list[float] | None = None):
    """Add a styled header row to a table."""
    row = table.rows[0]
    for i, (cell, hdr) in enumerate(zip(row.cells, headers)):
        _set_cell_shading(cell, "1F3864")
        cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_before = Pt(2)
        p.paragraph_format.space_after = Pt(2)
        run = p.add_run(hdr)
        run.bold = True
        run.font.color.rgb = WHITE
        run.font.size = Pt(8)
        if col_widths:
            cell.width = Cm(col_widths[i])


def _add_table_row(table, values: list[str], bold_first=False, shade_alt=False, row_idx=0):
    row = table.add_row()
    for j, (cell, val) in enumerate(zip(row.cells, values)):
        p = cell.paragraphs[0]
        p.paragraph_format.space_before = Pt(1)
        p.paragraph_format.space_after = Pt(1)
        run = p.add_run(str(val))
        run.font.size = Pt(8)
        if j == 0 and bold_first:
            run.bold = True
        if shade_alt and row_idx % 2 == 0:
            _set_cell_shading(cell, "EBF3FB")
    return row


def _make_table(doc, headers: list[str], rows: list[list[str]],
                col_widths: list[float] | None = None, bold_first=False, alt_shade=False):
    """Create a complete styled table."""
    table = doc.add_table(rows=1, cols=len(headers))
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    _set_table_width(table)
    _set_cell_borders(table)
    _table_header_row(table, headers, col_widths)
    for i, row in enumerate(rows):
        _add_table_row(table, row, bold_first=bold_first, shade_alt=alt_shade, row_idx=i)
    return table


def _image_to_inline(doc, image_bytes: bytes, width_cm: float = 14.0):
    buf = io.BytesIO(image_bytes)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run()
    run.add_picture(buf, width=Cm(width_cm))
    return p


def _add_caption(doc, text: str, number: int, caption_type: str = "Tabla"):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(2)
    p.paragraph_format.space_after = Pt(6)
    run = p.add_run(f"{caption_type} {number}. {text}")
    run.italic = True
    run.font.size = Pt(8)
    run.font.color.rgb = RGBColor(0x60, 0x60, 0x60)


# ─────────────────────────────────────────────────────────────────────────────
# COVER PAGE
# ─────────────────────────────────────────────────────────────────────────────

def _add_cover_page(doc: Document, data: PEBFormData, doc_code: str):
    # Top separator line
    p = _para(doc, "", space_after=0)
    p.paragraph_format.space_before = Pt(20)

    # Main title
    p = _para(doc, "PLAN DE EJECUCIÓN BIM (PEB)", bold=True, size=22,
              align=WD_ALIGN_PARAGRAPH.CENTER, color=ADIF_DARK, space_before=40)

    # Subtitle — project name
    p = _para(doc, data.nombre_actuacion, bold=True, size=14,
              align=WD_ALIGN_PARAGRAPH.CENTER, color=ADIF_MID, space_before=10)

    # Spacer
    _para(doc, "", space_after=20)

    # Identification box (small table)
    cover_table = doc.add_table(rows=5, cols=2)
    cover_table.alignment = WD_TABLE_ALIGNMENT.CENTER
    _set_table_width(cover_table, 80)
    _set_cell_borders(cover_table)

    cover_data = [
        ("CÓDIGO DEL DOCUMENTO", doc_code),
        ("RESPONSABLE", data.codigo_am + " — " + data.empresa_am),
        ("REVISIÓN", f"Rev.{data.revision_actual}"),
        ("FECHA", data.fecha_peb),
        ("ESTADO", data.revision_estado),
    ]
    for row, (label, value) in zip(cover_table.rows, cover_data):
        _set_cell_shading(row.cells[0], "1F3864")
        p0 = row.cells[0].paragraphs[0]
        r0 = p0.add_run(label)
        r0.bold = True
        r0.font.color.rgb = WHITE
        r0.font.size = Pt(8)
        p1 = row.cells[1].paragraphs[0]
        r1 = p1.add_run(value)
        r1.font.size = Pt(9)
        r1.font.color.rgb = ADIF_DARK

    _para(doc, "", space_after=30)


# ─────────────────────────────────────────────────────────────────────────────
# SECTION BUILDERS
# ─────────────────────────────────────────────────────────────────────────────

_table_counter = [0]
_fig_counter   = [0]


def _tc() -> int:
    _table_counter[0] += 1
    return _table_counter[0]


def _fc() -> int:
    _fig_counter[0] += 1
    return _fig_counter[0]


def _add_section_0_prefacio(doc: Document, data: PEBFormData):
    _heading(doc, "0. Prefacio", 1)
    _para(doc, (
        "El presente Plan de Ejecución BIM (PEB) establece el marco metodológico y los procedimientos "
        "para la implementación de la metodología BIM en el contrato de "
        f"{data.nombre_actuacion}. "
        "Este documento ha sido redactado conforme a los requisitos del marco documental BIM de Adif y Adif-AV, "
        "en cumplimiento de las cláusulas BIM del contrato y de los estándares nacionales e internacionales "
        "de referencia aplicables."
    ))
    _para(doc, (
        "El PEB es un documento vivo que será actualizado a lo largo de la ejecución del contrato para "
        "reflejar los cambios en el alcance, el equipo, los recursos y los procedimientos BIM. "
        "Todas las actualizaciones significativas deberán ser comunicadas a Adif y validadas por el "
        "Responsable BIM de Adif y/o la Asistencia Técnica de Coordinación (ATC)."
    ))


def _add_section_1(doc: Document, data: PEBFormData):
    _heading(doc, "1. Introducción", 1)
    _heading(doc, "1.1. Objeto", 2)
    _heading(doc, "1.1.1. Objetivos del PEB", 3)
    _para(doc, (
        "El presente Plan de Ejecución BIM tiene por objeto definir los procedimientos, estándares, "
        "responsabilidades y recursos necesarios para el correcto desarrollo de la metodología BIM "
        "en el marco del contrato de "
        f"{data.nombre_actuacion}."
    ))
    _para(doc, "Los objetivos específicos del PEB son:")
    bullets = [
        "Establecer el alcance y los objetivos BIM del contrato.",
        "Definir la estructura de modelos, la estrategia de federación y los niveles de información requeridos.",
        "Determinar los roles y responsabilidades del equipo BIM.",
        "Establecer los flujos de trabajo y los procedimientos de intercambio de información.",
        "Definir los entregables BIM y los plazos de entrega.",
        "Garantizar la coherencia entre los modelos BIM y la documentación del contrato.",
        "Facilitar la integración de la información BIM con los sistemas de gestión de activos de Adif.",
    ]
    for b in bullets:
        _bullet(doc, b)

    _heading(doc, "1.1.2. Actualización del plan de ejecución BIM", 3)
    _para(doc, (
        "El PEB es un documento vivo. El equipo BIM del AM es responsable de mantenerlo actualizado "
        "a lo largo de la vigencia del contrato, prestando especial atención a los cambios de fase, "
        "alcance y composición del equipo. Los cambios significativos deberán ser comunicados a Adif "
        "y a la ATC para su aprobación."
    ))

    _heading(doc, "1.2. Alcance", 2)
    alcance = data.alcance_descripcion if data.alcance_descripcion else (
        f"La actuación {data.nombre_actuacion} comprende la ejecución de los trabajos descritos en el contrato "
        f"con expediente {data.expediente}. "
        "El alcance BIM cubre las fases de construcción hasta la entrega del modelo As-Built final, "
        "incluyendo la generación del Modelo de Estado Actual (MEA), el Modelo de Inicio de Obra (MOI), "
        "el Modelo de Obra en Marcha (MOM) con actualizaciones mensuales, y el modelo As-Built."
    )
    _para(doc, alcance)

    # Tabla 1 — Identificación
    t_num = _tc()
    _para(doc, "")
    headers = ["Identificación", "Datos"]
    rows = [
        ["Nombre de la actuación", data.nombre_actuacion],
        ["Expediente", data.expediente],
        ["Código de actuación", data.codigo_actuacion],
        ["Dirección", data.direccion],
        ["Fecha de comienzo", data.fecha_inicio],
        ["Fecha de final", data.fecha_fin],
        ["Descripción de la actuación", data.descripcion_actuacion],
    ]
    _make_table(doc, headers, rows, col_widths=[5.5, 11.0], bold_first=True)
    _add_caption(doc, "Identificación de la actuación", t_num)

    _heading(doc, "1.2.1. Hitos relevantes de la actuación", 3)
    _para(doc, (
        "Los principales hitos de entrega BIM del contrato se recogen en la siguiente tabla. "
        "Las fechas pueden ser actualizadas en revisiones sucesivas del PEB conforme avance la ejecución."
    ))
    t_num = _tc()
    headers = ["Hito de entrega", "Fecha", "Descripción"]
    rows = [[h.hito, h.fecha, h.descripcion] for h in data.hitos]
    if not rows:
        rows = [["PEB Rev.01", "—", "Primera entrega del Plan de Ejecución BIM"],
                ["MEA", "—", "Modelo de Estado Actual"],
                ["MOI", "—", "Modelo de Inicio de Obra"]]
    _make_table(doc, headers, rows, col_widths=[5.0, 3.5, 8.0])
    _add_caption(doc, "Hitos relevantes de la actuación", t_num)

    _heading(doc, "1.3. Términos", 2)
    _para(doc, (
        "Los términos y definiciones BIM empleados en este documento son los establecidos en el "
        "Glosario de términos BIM de Adif (ACM-GEN-GA-1043). "
        "A continuación se recogen los acrónimos más relevantes empleados en este PEB:"
    ))
    t_num = _tc()
    headers = ["Término", "Descripción", "Origen"]
    rows = [
        ["AM",   "Adjudicatario del Modelo — empresa responsable de la generación de los modelos BIM", "ADIF"],
        ["ATC",  "Asistencia Técnica de Coordinación — equipo que coordina todos los AMs del proyecto global", "ADIF"],
        ["CDE",  "Common Data Environment — Entorno Común de Datos", "ISO 19650"],
        ["LOD",  "Level of Detail — Nivel de Detalle gráfico de los objetos BIM", "AEC UK"],
        ["LOI",  "Level of Information — Nivel de Información no gráfica de los objetos BIM", "ISO 19650"],
        ["MEA",  "Modelo de Estado Actual — modelo que refleja las condiciones previas a la obra", data.codigo_am],
        ["MIDP", "Master Information Delivery Plan — Plan General de Desarrollo de la Información", "ISO 19650"],
        ["MOI",  "Modelo de Inicio de Obra — modelo base al comienzo de los trabajos", data.codigo_am],
        ["MOM",  "Modelo de Obra en Marcha — modelo actualizado mensualmente durante la obra", data.codigo_am],
        ["PEB",  "Plan de Ejecución BIM — este documento", "ADIF"],
        ["RIH",  "Rail Innovation Hub — sistema de clasificación de elementos de Adif", "ADIF"],
        ["UTE",  "Unión Temporal de Empresas — forma jurídica de la empresa adjudicataria", data.codigo_am],
    ]
    _make_table(doc, headers, rows, col_widths=[2.5, 11.5, 2.5])
    _add_caption(doc, "Nuevos términos y definiciones", t_num)

    _heading(doc, "1.4. Responsabilidad de Uso", 2)
    _para(doc, "El uso de los modelos BIM generados en el marco de este contrato se rige por los siguientes compromisos:")
    commitments = [
        "Los modelos BIM son documentos técnicos de trabajo y su uso está restringido a las partes del contrato.",
        "Los modelos no deberán ser utilizados para fines distintos a los establecidos en el contrato sin autorización previa de Adif.",
        "La información contenida en los modelos es de carácter confidencial y no podrá ser divulgada a terceros.",
        "Adif y sus delegados podrán utilizar los modelos entregados para la gestión del activo a lo largo de su ciclo de vida.",
        "Los modelos As-Built serán entregados a Adif en los formatos establecidos y pasarán a ser propiedad de Adif.",
        "El AM es responsable de la exactitud de la información contenida en sus modelos y documentos BIM.",
        "El uso de los modelos para generación de documentación vinculante (planos, mediciones) requiere que estén en estado Publicado en el CDE.",
        "Cualquier discrepancia entre el modelo BIM y los documentos de obra deberá ser comunicada al Responsable BIM de Adif.",
    ]
    for c in commitments:
        _bullet(doc, c)

    t_num = _tc()
    headers = ["Responsable", "Representación", "Rol"]
    rows = [
        ["Redactado por:", data.coordinador_bim.nombre + " — " + data.coordinador_bim.empresa, "Coordinador BIM " + data.codigo_am],
        ["Revisado por:", data.responsable_bim.nombre + " — " + data.responsable_bim.empresa, "Responsable BIM " + data.codigo_am],
        ["Aprobado por:", "David Ibáñez Núñez — ADIF DACGP", "Responsable BIM ADIF"],
    ]
    _make_table(doc, headers, rows, col_widths=[3.5, 9.0, 4.0])
    _add_caption(doc, "Responsabilidades de uso", t_num)

    _heading(doc, "1.5. Estándares de referencia", 2)
    _para(doc, (
        "La redacción del presente PEB y el desarrollo de los trabajos BIM del contrato se han realizado "
        "en conformidad con los estándares nacionales e internacionales que se relacionan a continuación:"
    ))
    t_num = _tc()
    headers = ["Documento de referencia"]
    rows = [[std] for std in REFERENCE_STANDARDS]
    _make_table(doc, headers, rows)
    _add_caption(doc, "Estándares de referencia", t_num)


def _add_section_2(doc: Document, data: PEBFormData):
    _heading(doc, "2. Objetivos BIM y Usos de Modelo", 1)
    _heading(doc, "2.1. Objetivos BIM", 2)
    _para(doc, (
        "Los objetivos BIM del contrato, en alineación con los requisitos del pliego y el marco documental "
        "BIM de Adif, son los que se recogen en la siguiente tabla:"
    ))
    t_num = _tc()
    headers = ["Objetivo BIM", "Descripción"]
    rows = list(BIM_OBJECTIVES)
    _make_table(doc, headers, rows, col_widths=[5.0, 11.5], alt_shade=True)
    _add_caption(doc, "Objetivos BIM del contrato", t_num)

    _heading(doc, "2.2. Usos de modelo", 2)
    _para(doc, (
        "Los usos de modelo previstos para el presente contrato, indicados con (*) cuando son requeridos "
        "por la ATC, son los siguientes:"
    ))
    t_num = _tc()
    headers = ["Código", "Uso de modelo", "Descripción y metodología"]
    rows = []
    for codigo in data.usos_activos:
        if codigo in BIM_USES:
            nombre, desc, meto = BIM_USES[codigo]
            rows.append([codigo, nombre, f"{desc}\n\nMetodología: {meto}"])
    if not rows:
        # Default uses from template
        defaults = ["GE013", "CO011", "CO022", "CO043", "CO053", "AN023", "AN034", "RE013", "AN089"]
        for c in defaults:
            if c in BIM_USES:
                nombre, desc, meto = BIM_USES[c]
                rows.append([c, nombre, f"{desc}\n\nMetodología: {meto}"])
    _make_table(doc, headers, rows, col_widths=[1.5, 4.5, 10.5])
    _add_caption(doc, "Usos de modelo previstos", t_num)

    _heading(doc, "2.3. Justificación de usos de modelo excluidos", 2)
    _para(doc, (
        "Los siguientes usos de modelo previstos en el marco documental BIM de Adif no son de aplicación "
        "en el presente contrato, con la justificación que se indica:"
    ))
    t_num = _tc()
    headers = ["Código", "Uso de modelo excluido", "Justificación"]
    if data.usos_excluidos:
        rows = [[u.codigo, u.uso, u.justificacion] for u in data.usos_excluidos]
    else:
        rows = [
            ["AN053", "Cálculos de ingeniería y análisis", "No requerido por el pliego para este tipo de contrato. Los cálculos se realizan fuera del entorno BIM con herramientas específicas."],
            ["AN066", "Sostenibilidad con BIM", "No contemplado en el alcance del contrato."],
            ["EM017", "Logística, gestión de acopios y mantenimiento de vía con IFC", "No aplica al alcance del presente contrato."],
            ["EM027", "Mantenimiento y conservación de activos con soporte BIM", "Corresponde a la fase de explotación, fuera del alcance de este contrato."],
            ["EM037", "Gestión de activos con soporte BIM", "Corresponde a la fase de explotación, fuera del alcance de este contrato."],
        ]
    _make_table(doc, headers, rows, col_widths=[1.5, 4.5, 10.5])
    _add_caption(doc, "Usos de modelo excluidos", t_num)


def _add_section_3(doc: Document, data: PEBFormData):
    _heading(doc, "3. Estructura del PEB", 1)
    _para(doc, (
        "El presente PEB se compone del documento principal y los anejos indicados en la tabla siguiente. "
        "La lista completa de entregables BIM del contrato, con sus fechas y responsables, se recoge "
        "en el Plan General de Desarrollo de la Información (MIDP)."
    ))
    midp_rows = gen_midp_table(data)
    t_num = _tc()
    headers = ["Código del documento", "Descripción", "Formato"]
    rows = [[r["codigo"], r["descripcion"], r["formato"]] for r in midp_rows]
    _make_table(doc, headers, rows, col_widths=[6.5, 8.0, 2.0])
    _add_caption(doc, "Anejos del PEB y estructura documental", t_num)


def _add_section_4(doc: Document, data: PEBFormData):
    _heading(doc, "4. Recursos", 1)
    _heading(doc, "4.1. Recursos Humanos", 2)
    _heading(doc, "4.1.1. Organigrama de agentes BIM", 3)
    _para(doc, (
        "La estructura organizativa del equipo BIM del contrato, según los niveles definidos "
        "por Adif, es la que se muestra a continuación:"
    ))

    modeladores_nombres = [m.nombre for m in data.modeladores] if data.modeladores else ["Modelador BIM"]
    org_bytes = generate_organigram(
        data.empresa_am,
        data.responsable_bim.nombre,
        data.coordinador_bim.nombre,
        modeladores_nombres,
    )
    _image_to_inline(doc, org_bytes, width_cm=15.5)
    _add_caption(doc, "Organigrama de agentes BIM", _fc(), "Ilustración")

    _heading(doc, "4.1.2. Roles y responsabilidades", 3)
    _para(doc, "Las responsabilidades de cada rol BIM se definen a continuación:")
    t_num = _tc()
    headers = ["Rol BIM", "Responsabilidades principales"]
    rows = [[rol, desc] for rol, desc in ROLE_DESCRIPTIONS.items()]
    _make_table(doc, headers, rows, col_widths=[5.0, 11.5], bold_first=True, alt_shade=True)
    _add_caption(doc, "Roles y responsabilidades BIM", t_num)

    # Team data table
    t_num = _tc()
    headers = ["Rol", "Nombre y Apellidos", "Empresa", "Contacto"]
    rows = []
    # ADIF
    for rol, nombre, empresa, email in EQUIPO_ADIF:
        rows.append([rol, nombre, empresa, email])
    # ATC
    for rol, nombre, empresa, email in EQUIPO_ATC:
        rows.append([rol, nombre, empresa, email])
    # AM
    rows.append(["Responsable BIM AM", data.responsable_bim.nombre,
                 data.responsable_bim.empresa, data.responsable_bim.email])
    rows.append(["Coordinador BIM AM", data.coordinador_bim.nombre,
                 data.coordinador_bim.empresa, data.coordinador_bim.email])
    for m in data.modeladores:
        rows.append(["Modelador BIM", m.nombre, m.empresa, m.email])
    _make_table(doc, headers, rows, col_widths=[5.0, 4.5, 3.5, 3.5], alt_shade=True)
    _add_caption(doc, "Datos del equipo BIM", t_num)

    _heading(doc, "4.2. Recursos Materiales", 2)
    _heading(doc, "4.2.1. Requisitos de hardware", 3)
    _para(doc, "Los requisitos de hardware para el desarrollo de los trabajos BIM son los siguientes:")
    t_num = _tc()
    headers = ["Componente", "Mínimo / básico", "Recomendado / profesional", "Óptimo / workstation"]
    rows = [list(r) for r in HARDWARE_REQUIREMENTS]
    _make_table(doc, headers, rows, col_widths=[4.0, 4.0, 4.5, 4.0])
    _add_caption(doc, "Requisitos de hardware", t_num)

    _heading(doc, "4.2.2. Plataformas de software y versiones", 3)
    _para(doc, "El software utilizado por el equipo BIM del AM es el siguiente:")
    t_num = _tc()
    headers = ["Software", "Versión", "Propósito", "Sistema operativo", "Formatos generados"]
    sw_rows = [
        ["Autodesk Revit", data.version_revit, "Modelado BIM de arquitectura, estructura e instalaciones", "Windows 10/11", ".rvt / .ifc / .pdf / .nwc"],
        ["Autodesk Navisworks Manage", data.version_navisworks, "Federación de modelos, detección de interferencias, simulación 4D", "Windows 10/11", ".nwd / .nwc / .nwf"],
    ]
    if data.usa_civil3d:
        sw_rows.insert(1, ["Autodesk Civil 3D", data.version_civil3d,
                           "Modelado de infraestructura lineal, vía y obra civil",
                           "Windows 10/11", ".dwg / .ifc / .pdf / .nwc"])
    _make_table(doc, headers, sw_rows, col_widths=[3.5, 2.0, 5.5, 2.5, 3.0])
    _add_caption(doc, "Plataformas de software y versiones", t_num)

    _heading(doc, "4.2.3. Formatos de intercambio", 3)
    _para(doc, "Los formatos de intercambio de información entre agentes son los siguientes:")
    t_num = _tc()
    headers = ["Categoría", "Tipo de archivo", "Formato requerido", "Propósito principal"]
    rows = [[ef[0], ef[1], ef[2], ef[3]] for ef in EXCHANGE_FORMATS]
    _make_table(doc, headers, rows, col_widths=[4.0, 2.5, 3.5, 6.5])
    _add_caption(doc, "Formatos de intercambio", t_num)


def _add_section_5(doc: Document, data: PEBFormData):
    _heading(doc, "5. Estrategia BIM", 1)
    _heading(doc, "5.1. Organización de modelos por parte del AM", 2)
    _heading(doc, "5.1.1. División de modelos", 3)
    _para(doc, (
        "Los modelos se organizan por disciplina y por estado del proyecto (Estado Actual, "
        "Inicio de Obra, Obra en Marcha y As-Built). Cada modelo nativo corresponde a una "
        "disciplina y genera un modelo IFC equivalente para el intercambio en formato abierto. "
        "El siguiente diagrama muestra el ciclo de vida de los modelos:"
    ))
    states_bytes = generate_model_states_diagram()
    _image_to_inline(doc, states_bytes, width_cm=15.0)
    _add_caption(doc, "Ciclo de vida de los modelos BIM (MEA → MOI → MOM → As-Built)", _fc(), "Ilustración")

    for estado_label, estado_key in [("Estado Actual (MEA)", "MEA"), ("Inicio de Obra (MOI)", "MOI"), ("Obra en Marcha (MOM)", "MOM")]:
        t_num = _tc()
        _para(doc, f"División de modelos — {estado_label}", bold=True, size=9, space_before=6)
        model_rows = gen_model_division_table(data, estado_key)
        if model_rows:
            headers = ["Nombre del modelo", "Disciplina", "Empresa", "Software", "Ext."]
            rows = [[r["nombre"], r["disciplina"], r["empresa"], r["software"], r["extension"]]
                    for r in model_rows]
            _make_table(doc, headers, rows, col_widths=[7.0, 3.5, 2.5, 1.8, 0.7])
            _add_caption(doc, f"División de modelos — {estado_label}", t_num)

    _heading(doc, "5.1.2. Federación de modelos", 3)
    _para(doc, (
        "La federación de los modelos del AM se realizará mediante Autodesk Navisworks Manage, "
        "generando un modelo federado que integre todos los modelos de disciplina en formato IFC. "
        "El modelo federado principal del AM (MMP) servirá como base para las revisiones de "
        "coordinación y las reuniones digitales."
    ))
    fed_rows = gen_federation_table(data)
    t_num = _tc()
    headers = ["Nombre del modelo federado", "Descripción", "Modelos incluidos"]
    rows = [[r["nombre"], r["descripcion"], r["modelos_incluidos"]] for r in fed_rows]
    _make_table(doc, headers, rows, col_widths=[7.0, 4.5, 5.0])
    _add_caption(doc, "Federación de modelos del AM", t_num)

    _heading(doc, "5.2. Organización de actuaciones por parte de la ATC", 2)
    _heading(doc, "5.2.1. División de actuaciones", 3)
    _para(doc, (
        "La división en actuaciones del proyecto global es establecida por la ATC, quien comunica "
        "la estructura a todos los AMs. La información de esta sección ha sido completada a partir "
        "de la información proporcionada por la ATC en coordinación con todos los adjudicatarios "
        "de contrato y Adif."
    ))

    _heading(doc, "5.2.2. Federación entre actuaciones", 3)
    _para(doc, (
        "La ATC genera y gestiona tres modelos federados globales que integran las actuaciones "
        "de todos los AMs del proyecto:"
    ))
    atc_feds = [
        ("423208300021-INE-MFD-ME-DSA-5250000001-Norte_DIGITAL_MEA",
         "Modelo federado global del Estado Actual (MEA) de todas las actuaciones"),
        ("423208300021-INE-MFD-ME-DSA-5260000001-Norte_DIGITAL_MOI",
         "Modelo federado global de Inicio de Obra (MOI) de todas las actuaciones"),
        ("423208300021-INE-MFD-ME-DSA-5270000001-Norte_DIGITAL_MOM",
         "Modelo federado global de Obra en Marcha (MOM), actualizado periódicamente"),
    ]
    t_num = _tc()
    headers = ["Modelo federado ATC", "Descripción"]
    rows = [[a[0], a[1]] for a in atc_feds]
    _make_table(doc, headers, rows, col_widths=[9.0, 7.5])
    _add_caption(doc, "Modelos federados de la ATC", t_num)

    _heading(doc, "5.3. Nivel de información necesaria", 2)
    _heading(doc, "5.3.1. Nivel de detalle (LOD)", 3)
    _para(doc, (
        "El nivel de detalle gráfico requerido para los modelos BIM se establece en función de "
        "la disciplina y el estado de los elementos (reformados/nuevos o no reformados). "
        "Se aplica la escala de la norma UNE-EN 17412-1, empleando los niveles LOD 200 y LOD 300."
    ))
    lod_bytes = generate_lod_diagram()
    _image_to_inline(doc, lod_bytes, width_cm=14.0)
    _add_caption(doc, "Niveles de detalle LOD", _fc(), "Ilustración")

    disciplines = [d.nombre for d in data.disciplinas if d.activa] or [
        "Arquitectura", "Estructuras", "Superestructura de Vía", "Instalaciones", "Infraestructura"]
    t_num = _tc()
    headers = ["Disciplina", "Estado elementos", "Estado Actual", "Proy. Básico", "Proy. Constructivo", "Obra", "As-Built"]
    rows = []
    for disc in disciplines:
        rows.append([disc, "Reformados / Nuevos", "200", "200", "300", "300", "300"])
        rows.append([disc, "No reformados",        "200", "200", "200", "200", "200"])
    _make_table(doc, headers, rows, col_widths=[4.5, 4.0, 1.5, 1.5, 2.5, 1.5, 1.5])
    _add_caption(doc, "Tabla de nivel de detalle (LOD) por disciplina", t_num)

    _heading(doc, "5.3.2. Nivel de información no gráfica y vinculada (LOI)", 3)
    _para(doc, (
        "El nivel de información no gráfica requerido se define en la matriz de atributos del contrato, "
        "conforme a los Psets ADIF establecidos en el marco documental BIM de Adif. "
        "Los atributos se incorporan a los objetos BIM en los hitos de entrega indicados en el MIDP."
    ))

    _heading(doc, "5.4. Estructura de datos", 2)
    _heading(doc, "5.4.1. Sistema de clasificación de elementos", 3)
    _para(doc, (
        "El sistema de clasificación empleado es el Rail Innovation Hub (RIH) versión 2, "
        "sistema de clasificación de Adif para la homogeneización BIM en el sector ferroviario. "
        "Los elementos se clasifican mediante los atributos ADIF_00_Codigo_Producto y "
        "ADIF_00_Descripcion_Producto, conforme a la tabla de funciones del RIH."
    ))
    t_num = _tc()
    headers = ["Denominación Pset", "Atributo", "Descripción"]
    rows = [
        ["ADIF_00_Generales", "ADIF_00_Codigo_Producto", "Código según tabla de funciones del Rail Innovation Hub (RIH)"],
        ["ADIF_00_Generales", "ADIF_00_Descripcion_Producto", "Descripción según tabla de funciones del RIH"],
    ]
    _make_table(doc, headers, rows, col_widths=[4.5, 5.5, 6.5])
    _add_caption(doc, "Atributos para clasificación RIH", t_num)

    _heading(doc, "5.5. Organización de parámetros", 2)
    _para(doc, (
        "Los atributos de los objetos BIM se organizan en grupos de propiedades (Psets) conforme "
        "al estándar de Adif, agrupados por temática: generales, localización, coordinación 3D, "
        "simulación 4D, mediciones 5D, especificaciones 6D, seguimiento 7D y documentación vinculada."
    ))
    t_num = _tc()
    headers = ["Denominación Pset", "Atributo", "Aplica a", "Tipo dato", "Req. ATC (*)"]
    rows = [[p[0], p[1], p[2], p[3], "(*)" if p[4] else ""] for p in ADIF_PARAMS]
    _make_table(doc, headers, rows, col_widths=[4.0, 6.0, 2.5, 1.8, 2.2], alt_shade=True)
    _add_caption(doc, "Tabla de atributos generales (Psets ADIF)", t_num)

    _heading(doc, "5.5.1. Valores de atributos", 3)
    _para(doc, (
        "Los valores permitidos para los atributos de los grupos ADIF_02 (Localización) y "
        "ADIF_03 (Coordinación 3D) se recogen en el anejo de valores de atributos del contrato "
        f"({data.expediente_num}-{data.codigo_am}-MAT-ME-BIM-510001-VAL_ATRIBUTOS.xlsx). "
        "El atributo ADIF_03_Codigo_Estado toma los valores: MAM (Mantener), MAD (Demoler/eliminar), "
        "MNU (Nuevo), MTE (Temporal), MRE (Reubicado)."
    ))

    _heading(doc, "5.6. Sistema de coordenadas", 2)
    _para(doc, (
        "El sistema de coordenadas empleado para todos los modelos del contrato es el ETRS89 "
        "(European Terrestrial Reference System 1989) con proyección UTM Huso 30N. "
        "La altura se referencia al nivel medio del mar en Alicante (NAP). "
        "Todos los modelos deberán estar correctamente georreferenciados conforme al sistema indicado."
    ))

    _heading(doc, "5.7. Niveles y ejes de referencia", 2)
    _heading(doc, "5.7.1. Punto base", 3)
    _para(doc, (
        "El punto base del proyecto sirve de referencia para la georreferenciación de todos los "
        "modelos del AM. Se ubica visualmente en los modelos mediante un elemento geométrico "
        "que representa un cono invertido con una esfera, orientado en el norte geográfico."
    ))
    if data.coord_x and data.coord_y and data.coord_z:
        t_num = _tc()
        headers = ["Coordenada", "Valor", "Sistema"]
        rows = [
            ["X (E/O)", data.coord_x, data.sistema_coordenadas],
            ["Y (N/S)", data.coord_y, data.sistema_coordenadas],
            ["Z (Altitud)", data.coord_z, "NAP — Nivel Alicante"],
        ]
        _make_table(doc, headers, rows, col_widths=[3.0, 5.0, 8.5])
        _add_caption(doc, "Georreferenciación del punto base", t_num)

    _heading(doc, "5.7.2. Ejes de referencia", 3)
    _para(doc, (
        "Los ejes de referencia del modelo siguen el criterio establecido por la ATC: "
        "ejes horizontales nombrados numéricamente (01, 02, 03...) de menor a mayor longitud; "
        "ejes verticales nombrados alfabéticamente (AA, AB, AC...) de menor a mayor latitud."
    ))

    _heading(doc, "5.7.3. Niveles", 3)
    if data.niveles:
        t_num = _tc()
        headers = ["Nivel", "Elevación", "Comentarios"]
        rows = [[n.codigo, n.elevacion, n.comentario] for n in data.niveles]
        _make_table(doc, headers, rows, col_widths=[5.0, 2.5, 9.0])
        _add_caption(doc, "Niveles de referencia del modelo", t_num)
    else:
        _para(doc, "Los niveles de referencia del modelo serán definidos por la ATC y comunicados a todos los AMs al inicio del contrato.")

    _heading(doc, "5.8. Estrategia 2D", 2)
    _para(doc, "La generación de documentación 2D (planos) se extrae directamente de los modelos BIM:")
    t_num = _tc()
    headers = ["Software", "Alcance principal", "Estrategia de orientación y vistas"]
    rows = [
        ["Revit", "Arquitectura, estructuras, instalaciones",
         "Vistas ortogonales por niveles NSA_XXXX y ejes de referencia. Orientación estándar norte arriba."],
    ]
    if data.usa_civil3d:
        rows.append(["Civil 3D", "Infraestructura lineal, vía, drenaje",
                     "Perfiles longitudinales y secciones transversales con PK creciente hacia la derecha."])
    _make_table(doc, headers, rows, col_widths=[2.5, 5.0, 9.0])
    _add_caption(doc, "Estrategia 2D por software", t_num)

    _heading(doc, "5.9. Gestión de información existente", 2)
    _para(doc, "La documentación de partida recibida al inicio del contrato se recoge a continuación:")
    t_num = _tc()
    headers = ["Documentación de partida", "Suministrador", "Formato"]
    if data.docs_partida:
        rows = [[d.documento, d.suministrador, d.formato] for d in data.docs_partida]
    else:
        rows = [
            ["Nube de puntos del emplazamiento", "Adif / Adif-AV", ".rcs / .rcp"],
            ["Modelos nativos de proyecto (fase anterior)", "Adif / Adif-AV", ".rvt / .dwg"],
            ["Modelos IFC de proyecto (fase anterior)", "Adif / Adif-AV", ".ifc"],
            ["Modelo de coordinación BCP", "ATC", ".bcp"],
            ["Planos de proyecto en fase anterior", "Adif / Adif-AV", ".pdf / .dwg"],
            ["Manual BIM del contrato", "ATC", ".xlsx / .docx"],
        ]
    _make_table(doc, headers, rows, col_widths=[6.5, 4.5, 5.5])
    _add_caption(doc, "Documentación de partida", t_num)

    _heading(doc, "5.10. Plantillas de configuración", 2)
    _para(doc, (
        "El AM utilizará las plantillas de configuración proporcionadas por la ATC para garantizar "
        "la uniformidad del formato de exportación IFC entre todos los adjudicatarios:"
    ))
    t_num = _tc()
    headers = ["Plantilla de configuración", "Formato", "Descripción"]
    rows = [
        ["Fichero de Parámetros Compartidos Revit", ".txt", "Define todos los parámetros ADIF para Revit"],
        ["Plantilla exportación IFC 4 (DSV)", ".json", "Mapeo de categorías Revit a clases IFC"],
        ["Plantilla exportación IFC Psets", ".txt", "Definición de propiedades para exportación IFC"],
        ["Plantilla exportación NWC", ".xml", "Configuración exportación Navisworks Cache"],
        ["Plantilla Classification Manager", ".xlsx", "Clasificación RIH para elementos Revit"],
        ["Plantilla Model Checker", ".xml", "Reglas de verificación de modelos"],
    ]
    _make_table(doc, headers, rows, col_widths=[6.5, 1.5, 8.5])
    _add_caption(doc, "Plantillas de configuración", t_num)


def _add_section_6(doc: Document, data: PEBFormData):
    _heading(doc, "6. Documentación BIM a Entregar", 1)
    _para(doc, (
        "El listado completo de entregables BIM del contrato, con sus códigos de documento, "
        "fechas de entrega y responsables, se recoge en el Plan General de Desarrollo de la "
        "Información (MIDP). "
        f"El MIDP es el documento {data.expediente_num}-{data.codigo_am}-MID-ME-BIM-519001-MIDP.xlsx."
    ))
    _para(doc, "Los entregables BIM incluyen:")
    deliverables = [
        "El PEB y todos sus anejos (clasificación, matriz de atributos, estructura de carpetas, parámetros compartidos, etc.)",
        "Los modelos nativos de cada disciplina en los hitos MEA, MOI, MOM mensual y As-Built.",
        "Los modelos en formato IFC abierto correspondientes a los modelos nativos.",
        "El modelo federado en formato NWD (Navisworks) en cada hito de entrega.",
        "Los planos 2D extraídos de los modelos BIM.",
        "Los informes de detección de interferencias y coordinación 3D.",
        "Los informes de control de calidad de los modelos antes de cada entrega.",
        "Las actas de las reuniones digitales de coordinación BIM.",
        "El archivo de planificación y la simulación 4D en los hitos requeridos.",
        "Las mediciones BIM (mínimo 60% de las partidas de obra) en los hitos establecidos.",
    ]
    for d in deliverables:
        _bullet(doc, d)


def _add_section_7(doc: Document, data: PEBFormData):
    _heading(doc, "7. Entorno Común de Datos (CDE)", 1)
    _heading(doc, "7.1. Definición del entorno común de datos", 2)
    _para(doc, (
        f"El Entorno Común de Datos empleado en el presente contrato es {data.nombre_cde}. "
        "La información transitará por cuatro estados bien diferenciados, conforme al estándar "
        "ISO 19650 y a los requisitos del CDE de Adif:"
    ))
    cde_bytes = generate_cde_flow_diagram()
    _image_to_inline(doc, cde_bytes, width_cm=14.0)
    _add_caption(doc, "Estados de información en el CDE", _fc(), "Ilustración")

    t_num = _tc()
    headers = ["Estado", "Descripción", "Plataforma"]
    rows = [[s[0], s[1], s[2]] for s in CDE_STATES]
    _make_table(doc, headers, rows, col_widths=[2.5, 10.0, 4.0])
    _add_caption(doc, "Descripción de los estados del CDE", t_num)

    _heading(doc, "7.2. Roles y responsabilidades dentro del CDE", 2)
    _para(doc, (
        "El administrador del CDE de Adif es el Gestor de la información de Adif DACGP. "
        "El AM gestionará su propio entorno de trabajo interno (estado Trabajo/WIP) y será "
        "responsable de garantizar que la información se comparte en el CDE de Adif en los "
        "plazos y estados establecidos."
    ))

    _heading(doc, "7.3. Estrategia de colaboración", 2)
    _para(doc, (
        "La estrategia de colaboración define los flujos de información entre el AM, la ATC y Adif. "
        "El AM produce la información en su entorno local (estado Trabajo), la comparte en el CDE "
        "para revisión por parte de la ATC (estado Compartido), y una vez aprobada, la información "
        "se publica (estado Publicado) quedando disponible como referencia oficial para todos los agentes."
    ))

    _heading(doc, "7.4. Estructura de carpetas", 2)
    _para(doc, (
        "La estructura de carpetas en el CDE de Adif (ACC) sigue la organización estándar "
        "de Adif para proyectos BIM, con la siguiente jerarquía principal:"
    ))
    folders = [
        "10-TRB_ADF — Documentos de trabajo de ADIF",
        "20-COMP — Documentos en estado Compartido",
        "30-PUBL — Documentos en estado Publicado",
        "40-ARCH — Documentos archivados",
    ]
    for f in folders:
        _bullet(doc, f)
    _para(doc, "Dentro de cada estado, la carpeta 13-BIM contiene la siguiente estructura:")
    subfolders = [
        "00-ATC — Documentos de la ATC",
        "01-PEB — Plan de Ejecución BIM y anejos",
        "02-MOD — Modelos (00-ACTUAL / 01-INICIO / 02-SEGUI)",
        "03-MOD-AUX — Modelos auxiliares y de referencia",
        "04-MOD-3D — Modelos solo geometría 3D",
        "05-EXTRAC — Extracciones y datos del modelo",
        "06-USOS — Entregables por uso BIM (coordinación, 4D, 5D, reuniones…)",
        "07-CAL_BIM — Informes de control de calidad BIM",
        "08-HITOS — Entregas por hito",
        "99-COORD — Documentación de coordinación general",
    ]
    for sf in subfolders:
        _bullet(doc, sf)


def _add_section_8(doc: Document, data: PEBFormData):
    _heading(doc, "8. Control de Calidad", 1)
    _para(doc, (
        "El AM establece una estrategia de control de calidad en dos niveles: "
        "(1) control de calidad interno de producción, realizado por cada modelador y coordinador "
        "BIM de disciplina; y (2) control de calidad de entrega, realizado antes de cada entrega "
        "al CDE de Adif. La plantilla de control de calidad empleada es la facilitada por Adif "
        "(ACM-GEN-PA-1260) o su equivalente aprobado."
    ))
    t_num = _tc()
    headers = ["Documentación BIM", "Responsable", "Fase", "Control producción", "Control entrega"]
    rows = [
        ["Modelos nativos por disciplina", "Modelador BIM / Coordinador BIM " + data.codigo_am,
         "Producción", "✓", ""],
        ["Modelo federado MEA / MOI / MOM", "Coordinador BIM " + data.codigo_am,
         "Coordinación", "✓", "✓"],
        ["Extracciones (mediciones, planos)", "Coordinador BIM " + data.codigo_am,
         "Producción", "✓", ""],
        ["Entrega oficial al CDE", "Responsable BIM " + data.codigo_am,
         "Entrega", "", "✓"],
    ]
    _make_table(doc, headers, rows, col_widths=[6.0, 4.0, 2.5, 2.5, 2.5])
    _add_caption(doc, "Control de calidad de documentación BIM", t_num)


def _add_section_9(doc: Document, data: PEBFormData):
    _heading(doc, "9. Estandarización", 1)
    _heading(doc, "9.1. Nombrado de documentación de contrato", 2)
    _para(doc, (
        "El sistema de nomenclatura aplicado a todos los documentos y modelos BIM del contrato "
        "sigue el estándar de codificación de Adif (ADIF-IT-104-005-001). El patrón de nomenclatura es:"
    ))
    p = doc.add_paragraph()
    run = p.add_run(f"[Expediente]-[Originador]-[TipoDoc]-[EspecTécnica]-[Disciplina]-[NúmDoc]-[Descripción]")
    run.font.size = Pt(9)
    run.bold = True
    run.font.color.rgb = ADIF_DARK
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER

    _para(doc, f"Ejemplo: {data.expediente_num}-{data.codigo_am}-PEB-ME-BIM-500000-PEB.pdf")
    t_num = _tc()
    headers = ["Campo", "Descripción", "Formato", "Nº caracteres"]
    rows = [list(r) for r in NAMING_DOC_FIELDS]
    _make_table(doc, headers, rows, col_widths=[3.5, 7.0, 2.5, 2.5])
    _add_caption(doc, "Campos del nombre de documentación de contrato", t_num)

    _heading(doc, "9.2. Nombrado de objetos", 2)
    _para(doc, (
        "Los objetos BIM (familias, tipos y ejemplares) se nombran siguiendo el patrón: "
        "[disciplina]_[categoría]_[descripción]_[detalle]. "
        "Ejemplo: ARQ_PUE_aluminio_2100x820mm | SUV_TRA_madera_1200mm | ENE_EQU_transformador_traccion_750kVA"
    ))
    t_num = _tc()
    headers = ["Campo", "Formato", "Descripción", "Ejemplo"]
    rows = [list(r) for r in NAMING_OBJ_FIELDS]
    _make_table(doc, headers, rows, col_widths=[2.5, 2.5, 6.0, 5.5])
    _add_caption(doc, "Criterio de nombrado de objetos BIM", t_num)

    _heading(doc, "9.3. Nombrado y tipologías comunes", 3)
    _para(doc, (
        "Los elementos no físicos del modelo (ejes, niveles, materiales, fases, espacios, capas…) "
        "se nombran siguiendo el patrón: [categoría]_[tipo]_[detalle]. "
        "Ejemplo: EJE_B | NIV_primera_3000 | ESP_sala_reuniones"
    ))
    t_num = _tc()
    headers = ["Campo", "Formato", "Descripción", "Ejemplo"]
    rows = [list(r) for r in NAMING_TIPOL_FIELDS]
    _make_table(doc, headers, rows, col_widths=[2.5, 2.5, 6.0, 5.5])
    _add_caption(doc, "Criterio de nombrado de tipologías comunes", t_num)

    _heading(doc, "9.4. Unidades", 2)
    t_num = _tc()
    headers = ["Descripción", "Unidades", "Ejemplo", "Precisión mínima"]
    rows = [list(r) for r in UNITS_TABLE]
    _make_table(doc, headers, rows, col_widths=[4.5, 4.0, 4.5, 3.5])
    _add_caption(doc, "Unidades del proyecto", t_num)

    t_num = _tc()
    headers = ["Escalas normalizadas"]
    rows = [[s] for s in SCALES_TABLE]
    _make_table(doc, headers, rows)
    _add_caption(doc, "Escalas normalizadas", t_num)

    _heading(doc, "9.5. Idioma", 2)
    _para(doc, (
        "El idioma empleado en los modelos BIM, la documentación y los atributos de los objetos "
        "es el español castellano. En los casos en que el software no permita el uso de caracteres "
        "especiales (tildes, ñ), se empleará la forma equivalente sin caracteres especiales."
    ))


def _add_section_10(doc: Document, data: PEBFormData):
    _heading(doc, "10. Reuniones Digitales", 1)
    _heading(doc, "10.1. Estrategia de reuniones", 2)
    _para(doc, (
        "Las reuniones digitales constituyen el mecanismo principal de coordinación BIM entre el AM, "
        "la ATC y Adif. Se celebrarán con los modelos BIM como soporte, registrando las incidencias "
        "en el CDE conforme a la guía de reuniones digitales de Adif (ACM-GEN-GA-1187)."
    ))
    t_num = _tc()
    headers = ["Tipo de reunión", "Descripción", "Frecuencia", "Responsable", "Asistentes requeridos"]
    rows = [
        ["Aprobación del PEB", "Validación del PEB, MIDP y maqueta de prueba al inicio del contrato",
         "Puntual (inicio contrato)", "ATC / AM", "Resp. BIM Adif DACGP + ATC + AM"],
        ["Revisión Modelo MOI", "Revisión del Modelo de Inicio de Obra antes del comienzo de los trabajos",
         "Puntual (antes de obra)", "Resp. BIM Adif / ATC", "Resp. BIM Adif DACGP + ATC + AM"],
        ["Seguimiento del MOM", "Revisión del estado de avance del modelo de obra en marcha",
         "Mensual", "ATC / AM", "Resp. BIM Adif DACGP + ATC + AM"],
        ["Revisión Modelo As-Built", "Revisión final del modelo As-Built antes de la entrega definitiva",
         "Puntual (fin de obra)", "ATC / AM", "Resp. BIM Adif + ATC + AM"],
    ]
    _make_table(doc, headers, rows, col_widths=[3.5, 4.5, 2.5, 2.5, 3.5])
    _add_caption(doc, "Calendario de reuniones digitales", t_num)

    _heading(doc, "10.2. Detección de interferencias", 2)
    _para(doc, (
        "La detección de interferencias se realizará a distintos niveles de periodicidad y alcance, "
        "empleando la plantilla de interferencias del contrato (ACM-GEN-PA-1375). "
        "Las interferencias se clasifican por gravedad (A: alta, B: media, C: baja) y se resuelven "
        "en coordinación con los agentes afectados."
    ))
    t_num = _tc()
    headers = ["Modelos analizados", "Frecuencia", "Tipo de revisión", "Disciplinas", "Responsable"]
    rows = [
        ["Modelos nativos por disciplina", "Semanal", "Autochequeo interno",
         "Todas las disciplinas del AM", "Coordinador BIM " + data.codigo_am],
        ["Modelo federado MEA/MOI/MOM", "Trimestral o por hito", "Revisión interdisciplinar",
         "Todas las disciplinas del AM", "Coordinador BIM / Resp. BIM " + data.codigo_am],
        ["Modelo federado global ATC", "Mensual", "Coordinación entre actuaciones",
         "Todas las disciplinas del proyecto", "ATC — Coordinador BIM ATC"],
        ["Entrega final As-Built", "Puntual", "Revisión final de calidad",
         "Todas", "Resp. BIM " + data.codigo_am],
    ]
    _make_table(doc, headers, rows, col_widths=[4.5, 2.5, 3.0, 3.5, 3.0])
    _add_caption(doc, "Estrategia de detección de interferencias", t_num)


def _add_section_11(doc: Document, data: PEBFormData):
    _heading(doc, "11. Referencias", 1)
    _para(doc, (
        "El presente PEB se ha elaborado conforme a los documentos del marco documental BIM de "
        "Adif que se relacionan a continuación. Las versiones indicadas son las vigentes en el "
        "momento de la redacción del PEB. El AM es responsable de verificar que las versiones "
        "están actualizadas durante la vigencia del contrato."
    ))
    t_num = _tc()
    headers = ["Documentos de referencia del marco documental BIM de Adif"]
    rows = [[r] for r in REFERENCIAS_ADIF]
    _make_table(doc, headers, rows)
    _add_caption(doc, "Documentos de referencia", t_num)


def _update_footer(doc: Document, data: PEBFormData):
    """Update the footer text in all sections."""
    footer_text = f"Plan de Ejecución BIM (PEB) — {data.nombre_actuacion[:60]}"
    for section in doc.sections:
        footer = section.footer
        for para in footer.paragraphs:
            for run in para.runs:
                if run.text.strip():
                    run.text = footer_text
                    run.font.size = Pt(8)
                    run.font.color.rgb = RGBColor(0x80, 0x80, 0x80)
            if not any(r.text.strip() for r in para.runs):
                run = para.add_run(footer_text)
                run.font.size = Pt(8)
                run.font.color.rgb = RGBColor(0x80, 0x80, 0x80)


# ─────────────────────────────────────────────────────────────────────────────
# MAIN ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

def build_peb(data: PEBFormData) -> dict:
    """Build the complete PEB DOCX and PDF.

    Returns a dict with:
      job_id, docx_path, pdf_path (or None if conversion failed), page_count_approx
    """
    # Reset counters for each document build
    _table_counter[0] = 0
    _fig_counter[0]   = 0

    job_id  = str(uuid.uuid4())[:8]
    exp_short = data.expediente_num[-6:] if len(data.expediente_num) >= 6 else data.expediente_num
    base_name = f"PEB_{exp_short}_{data.codigo_am}_{job_id}"

    # Generate document code
    doc_code = f"{data.expediente_num}-{data.codigo_am}-PEB-ME-BIM-500000-PEB"

    # Start from a clean document (avoids template XML compatibility issues)
    doc = Document()

    # Set page margins (A4 standard)
    for section in doc.sections:
        section.page_height = Cm(29.7)
        section.page_width  = Cm(21.0)
        section.left_margin   = Cm(2.5)
        section.right_margin  = Cm(2.5)
        section.top_margin    = Cm(2.5)
        section.bottom_margin = Cm(2.0)

    # ── Build all sections ────────────────────────────────────────────────────
    _add_cover_page(doc, data, doc_code)
    _add_page_break(doc)

    # Revision table on page 2
    _heading(doc, "Revisiones", 1)
    rev_t = doc.add_table(rows=1, cols=4)
    _set_table_width(rev_t)
    _set_cell_borders(rev_t)
    _table_header_row(rev_t, ["Nº", "Fecha", "Estado", "Responsable"])
    _add_table_row(rev_t, [f"Rev.{data.revision_actual}", data.fecha_peb,
                            data.revision_estado,
                            f"{data.coordinador_bim.nombre} / {data.empresa_am}"])
    _add_page_break(doc)

    # TOC placeholder
    _heading(doc, "Índice", 1)
    _para(doc, "[Actualizar tabla de contenidos en Word: Referencias → Actualizar tabla]",
          italic=True, color=RGBColor(0xAA, 0xAA, 0xAA))
    _add_page_break(doc)

    # Main sections
    _add_section_0_prefacio(doc, data)
    _add_section_1(doc, data)
    _add_section_2(doc, data)
    _add_section_3(doc, data)
    _add_section_4(doc, data)
    _add_section_5(doc, data)
    _add_section_6(doc, data)
    _add_section_7(doc, data)
    _add_section_8(doc, data)
    _add_section_9(doc, data)
    _add_section_10(doc, data)
    _add_section_11(doc, data)

    _update_footer(doc, data)

    # ── Save DOCX ─────────────────────────────────────────────────────────────
    docx_path = OUTPUT_DIR / f"{base_name}.docx"
    doc.save(str(docx_path))

    # ── Convert to PDF via Word COM ────────────────────────────────────────────
    pdf_path = None
    try:
        from docx2pdf import convert
        pdf_path = OUTPUT_DIR / f"{base_name}.pdf"
        convert(str(docx_path), str(pdf_path))
    except Exception as exc:
        print(f"[PEB] PDF conversion failed: {exc}")
        pdf_path = None

    return {
        "job_id":      job_id,
        "docx_path":   str(docx_path),
        "pdf_path":    str(pdf_path) if pdf_path and Path(str(pdf_path)).exists() else None,
        "doc_code":    doc_code,
        "tables":      _table_counter[0],
        "figures":     _fig_counter[0],
    }
