"""Pydantic models for PEB form data."""
from __future__ import annotations
from typing import Optional
from pydantic import BaseModel


class PEBPersona(BaseModel):
    nombre: str
    empresa: str
    email: str
    rol: str = ""


class PEBHito(BaseModel):
    hito: str
    fecha: str
    descripcion: str = ""


class PEBDisciplina(BaseModel):
    code: str        # e.g. "ARQ"
    nombre: str      # e.g. "Arquitectura"
    software: str    # "REVIT" | "CIVIL3D" | "AMBOS"
    activa: bool = True


class PEBNivel(BaseModel):
    codigo: str       # e.g. "NSA_+611,00"
    elevacion: str    # e.g. "+611,00"
    comentario: str = ""


class PEBDocInput(BaseModel):
    documento: str
    suministrador: str
    formato: str


class PEBSoftware(BaseModel):
    nombre: str
    version: str
    proposito: str
    so: str = "Windows 10/11"
    formatos: str


class PEBUsoExcluido(BaseModel):
    codigo: str
    uso: str
    justificacion: str


class PEBFormData(BaseModel):
    # ── Proyecto ──────────────────────────────────────────────────────────────
    nombre_actuacion: str
    expediente: str               # e.g. "3.23/27507.0200"
    expediente_num: str           # e.g. "323275070200" – used for doc codes
    codigo_actuacion: str         # e.g. "060-442"
    direccion: str
    fecha_inicio: str
    fecha_fin: str = "Fecha a confirmar"
    descripcion_actuacion: str
    fecha_peb: str                # e.g. "Junio 2026"

    # ── Empresa contratista AM ─────────────────────────────────────────────────
    empresa_am: str               # e.g. "UTE GRUSAMAR - Asunto BIM"
    codigo_am: str                # e.g. "ACO"

    # ── Equipo BIM AM ──────────────────────────────────────────────────────────
    responsable_bim: PEBPersona
    coordinador_bim: PEBPersona
    modeladores: list[PEBPersona] = []

    # ── Hitos ─────────────────────────────────────────────────────────────────
    hitos: list[PEBHito] = []

    # ── Técnico ───────────────────────────────────────────────────────────────
    version_revit: str = "2025.2"
    usa_civil3d: bool = False
    version_civil3d: str = "2025"
    version_navisworks: str = "2026.2"

    # ── Disciplinas ───────────────────────────────────────────────────────────
    disciplinas: list[PEBDisciplina] = []

    # ── Sistema de coordenadas ────────────────────────────────────────────────
    coord_x: str = ""
    coord_y: str = ""
    coord_z: str = ""
    sistema_coordenadas: str = "ETRS89 UTM-30N"

    # ── CDE ───────────────────────────────────────────────────────────────────
    nombre_cde: str = "Autodesk Construction Cloud (ACC)"

    # ── Usos BIM ──────────────────────────────────────────────────────────────
    usos_activos: list[str] = []    # codigos: ["GE013", "CO011", ...]
    usos_excluidos: list[PEBUsoExcluido] = []

    # ── Niveles ───────────────────────────────────────────────────────────────
    niveles: list[PEBNivel] = []

    # ── Documentación de partida ───────────────────────────────────────────────
    docs_partida: list[PEBDocInput] = []

    # ── Alcance descriptivo (opcional, si quiere personalizar) ─────────────────
    alcance_descripcion: str = ""

    # ── Revisión actual ────────────────────────────────────────────────────────
    revision_actual: str = "01"
    revision_estado: str = "Borrador Primera Edición"
