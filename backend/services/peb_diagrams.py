"""Generate diagrams for PEB documents using matplotlib."""
from __future__ import annotations
import io
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch


# ── Colors ────────────────────────────────────────────────────────────────────
C_ADIF   = "#1F3864"   # ADIF dark blue
C_ATC    = "#2E74B5"   # ATC blue
C_AM     = "#4472C4"   # AM lighter blue
C_ROLE   = "#D9E2F3"   # Light blue fill
C_LINE   = "#666666"
C_WHITE  = "#FFFFFF"
C_BORDER = "#1F3864"


def _fig_to_bytes(fig) -> bytes:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=150, bbox_inches="tight",
                facecolor="white", edgecolor="none")
    plt.close(fig)
    buf.seek(0)
    return buf.read()


def generate_organigram(
    empresa_am: str,
    responsable_bim_am: str,
    coordinador_bim_am: str,
    modeladores: list[str],
) -> bytes:
    """Generate a BIM team organigram PNG image."""
    fig, ax = plt.subplots(figsize=(13, 9))
    ax.set_xlim(0, 13)
    ax.set_ylim(0, 9)
    ax.axis("off")

    def box(x, y, w, h, text, color_bg, color_text="#FFFFFF", fontsize=7.5, bold=False):
        rect = FancyBboxPatch((x, y), w, h,
                              boxstyle="round,pad=0.08",
                              facecolor=color_bg, edgecolor=C_BORDER, linewidth=0.8)
        ax.add_patch(rect)
        weight = "bold" if bold else "normal"
        ax.text(x + w / 2, y + h / 2, text,
                ha="center", va="center", fontsize=fontsize, color=color_text,
                fontweight=weight, wrap=True,
                multialignment="center")

    def line(x1, y1, x2, y2):
        ax.plot([x1, x2], [y1, y2], color=C_LINE, linewidth=0.8, zorder=0)

    # ── Row 1: ADIF DACGP ────────────────────────────────────────────────────
    box(0.2, 7.5, 12.6, 0.9, "ADIF DACGP  —  Responsable de contrato + Responsable BIM + Gestor de la información",
        C_ADIF, bold=True, fontsize=8)

    # ── Row 2: ATC ───────────────────────────────────────────────────────────
    box(0.2, 6.1, 12.6, 0.9,
        "ATC (INECO)  —  Responsable BIM ATC + Gestor información + Coordinadores BIM",
        C_ATC, bold=True, fontsize=8)
    line(6.5, 7.5, 6.5, 7.0)

    # ── Row 3: AM box ─────────────────────────────────────────────────────────
    am_label = f"AM: {empresa_am}"
    box(0.2, 4.7, 12.6, 0.9, am_label, C_AM, bold=True, fontsize=8)
    line(6.5, 6.1, 6.5, 5.6)

    # ── Row 4: Responsable BIM AM ─────────────────────────────────────────────
    box(3.5, 3.3, 6.0, 0.9,
        f"Responsable BIM AM\n{responsable_bim_am}", C_ROLE, color_text=C_ADIF, fontsize=7.5, bold=False)
    line(6.5, 4.7, 6.5, 4.2)

    # ── Row 5: Coordinador BIM AM ─────────────────────────────────────────────
    box(3.5, 1.9, 6.0, 0.9,
        f"Coordinador BIM AM\n{coordinador_bim_am}", C_ROLE, color_text=C_ADIF, fontsize=7.5)
    line(6.5, 3.3, 6.5, 2.8)

    # ── Row 6: Modeladores ────────────────────────────────────────────────────
    n = max(len(modeladores), 1)
    box_w = min(2.8, 11.0 / n)
    total_w = n * box_w + (n - 1) * 0.15
    start_x = (13 - total_w) / 2

    line(6.5, 1.9, 6.5, 1.4)
    if n > 1:
        ax.plot([start_x + box_w / 2, start_x + (n - 1) * (box_w + 0.15) + box_w / 2],
                [1.4, 1.4], color=C_LINE, linewidth=0.8, zorder=0)

    for i, m in enumerate(modeladores):
        mx = start_x + i * (box_w + 0.15)
        box(mx, 0.3, box_w, 0.9, f"Modelador BIM\n{m}", C_ROLE, color_text=C_ADIF, fontsize=6.5)
        line(mx + box_w / 2, 1.4, mx + box_w / 2, 1.2)

    if not modeladores:
        box(start_x, 0.3, box_w, 0.9, "Modeladores BIM\n(a definir)", C_ROLE,
            color_text=C_ADIF, fontsize=6.5)

    ax.set_title("Organigrama de agentes BIM", fontsize=10, fontweight="bold",
                 color=C_ADIF, pad=6)
    return _fig_to_bytes(fig)


def generate_lod_diagram() -> bytes:
    """Generate a simplified LOD levels visual (200 / 300)."""
    fig, ax = plt.subplots(figsize=(10, 2.5))
    ax.set_xlim(0, 10)
    ax.set_ylim(0, 2.5)
    ax.axis("off")

    levels = [
        (1.0,  "LOD 100\nConceptual",  "#BFBFBF"),
        (3.0,  "LOD 200\nEsquemático", "#4472C4"),
        (5.0,  "LOD 300\nDefinido",    "#1F3864"),
        (7.0,  "LOD 350\nCoordiando",  "#ED7D31"),
        (9.0,  "LOD 400\nFabricación", "#A9D18E"),
    ]
    for x, label, color in levels:
        rect = FancyBboxPatch((x - 0.7, 0.5), 1.4, 1.5,
                              boxstyle="round,pad=0.05",
                              facecolor=color, edgecolor="white", linewidth=1.2)
        ax.add_patch(rect)
        ax.text(x, 1.25, label, ha="center", va="center",
                fontsize=7.5, color="white", fontweight="bold", multialignment="center")

    ax.annotate("", xy=(9.5, 1.25), xytext=(0.2, 1.25),
                arrowprops=dict(arrowstyle="->", color=C_LINE, lw=1.5))
    ax.text(5, 0.15, "Este proyecto utiliza LOD 200 (elementos no reformados) y LOD 300 (elementos reformados/nuevos)",
            ha="center", va="center", fontsize=7, color=C_ADIF, style="italic")
    ax.set_title("Niveles de Detalle (LOD)", fontsize=9, fontweight="bold", color=C_ADIF, pad=4)
    return _fig_to_bytes(fig)


def generate_model_states_diagram() -> bytes:
    """Generate the MEA→MOI→MOM→As-Built lifecycle diagram."""
    fig, ax = plt.subplots(figsize=(12, 2.8))
    ax.set_xlim(0, 12)
    ax.set_ylim(0, 2.8)
    ax.axis("off")

    states = [
        (1.2,  "MEA\nModelo Estado\nActual",     C_ATC),
        (4.0,  "MOI\nModelo Inicio\nde Obra",     C_AM),
        (6.8,  "MOM\nModelo Obra\nen Marcha",     "#ED7D31"),
        (9.6,  "As-Built\nModelo\nFinal",         "#70AD47"),
    ]

    for i, (x, label, color) in enumerate(states):
        rect = FancyBboxPatch((x - 0.9, 0.6), 1.8, 1.6,
                              boxstyle="round,pad=0.08",
                              facecolor=color, edgecolor=C_BORDER, linewidth=0.8)
        ax.add_patch(rect)
        ax.text(x, 1.4, label, ha="center", va="center",
                fontsize=8, color="white", fontweight="bold", multialignment="center")
        if i < len(states) - 1:
            next_x = states[i + 1][0]
            ax.annotate("", xy=(next_x - 0.9, 1.4), xytext=(x + 0.9, 1.4),
                        arrowprops=dict(arrowstyle="->", color=C_LINE, lw=1.5))

    # Periodic MOM label
    ax.text(6.8, 0.25, "Actualización mensual", ha="center", va="center",
            fontsize=6.5, color="#ED7D31", style="italic")

    ax.set_title("Ciclo de vida de los modelos BIM", fontsize=9, fontweight="bold",
                 color=C_ADIF, pad=6)
    return _fig_to_bytes(fig)


def generate_cde_flow_diagram() -> bytes:
    """Generate the CDE states workflow diagram."""
    fig, ax = plt.subplots(figsize=(11, 2.5))
    ax.set_xlim(0, 11)
    ax.set_ylim(0, 2.5)
    ax.axis("off")

    items = [
        (1.2,  "TRABAJO\n(WIP)",     "#7F7F7F"),
        (3.8,  "COMPARTIDO",         C_ATC),
        (6.4,  "PUBLICADO",          "#70AD47"),
        (9.0,  "ARCHIVADO",          "#BFBFBF"),
    ]
    for i, (x, label, color) in enumerate(items):
        rect = FancyBboxPatch((x - 0.9, 0.55), 1.8, 1.4,
                              boxstyle="round,pad=0.06",
                              facecolor=color, edgecolor=C_BORDER, linewidth=0.8)
        ax.add_patch(rect)
        ax.text(x, 1.25, label, ha="center", va="center",
                fontsize=8, color="white", fontweight="bold", multialignment="center")
        if i < len(items) - 1:
            next_x = items[i + 1][0]
            ax.annotate("", xy=(next_x - 0.9, 1.25), xytext=(x + 0.9, 1.25),
                        arrowprops=dict(arrowstyle="->", color=C_LINE, lw=1.5))

    ax.set_title("Estados de información en el Entorno Común de Datos (CDE)", fontsize=9,
                 fontweight="bold", color=C_ADIF, pad=6)
    return _fig_to_bytes(fig)
