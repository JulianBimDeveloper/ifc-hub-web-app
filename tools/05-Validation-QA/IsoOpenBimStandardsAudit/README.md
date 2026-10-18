# Auditoría de Estándares Internacionales (`Standards Audit`)

> **Standalone OpenBIM & IFC Tool** · `IFC4X3_ADD2` · `EN 17632` · `ISO 19148` · `EPSG:25830`

Evalúa el cumplimiento normativo del archivo IFC frente a los estándares ferroviarios e internacionales: esquema IFC4X3_ADD2, contenedores ferroviarios (IfcRailway / IfcRailwayPart), georreferenciación EPSG:25830 (IfcProjectedCRS) y referenciación kilométrica.

---

## 📊 System Architecture

```mermaid
graph TD
    A["Local .IFC File (Revit / Civil 3D)"] -->|Zero-Server RAM Parser| B("ISO-10303-21 STEP Tokenizer")
    B -->|Entity & Pset Graph| C["Standards Audit Engine"]
    C -->|Audit & Metrics| D["Interactive Web UI / CSV Report"]
    C -->|In-Memory STEP Mutation| E["Modified .IFC File Download"]
```

---

## 📁 Files inside this Standalone Suite

This folder is isolated and self-contained so you (or an AI coding assistant) can inspect, clone, or integrate **Auditoría de Estándares Internacionales** independently:

- **[`standalone_tool.js`](standalone_tool.js)**: Zero-dependency JavaScript IFC STEP engine (runs 100% in browser RAM or Node.js) implementing entity parsing, property inheritance (`IFCRELDEFINESBYTYPE` / `IFCRELDEFINESBYPROPERTIES`), and STEP re-serialization.
- **[`ui_component.tsx`](ui_component.tsx)**: React / Next.js UI implementation for interactive visualization and batch editing.
- **[`python_processor.py`](python_processor.py)**: FastAPI / Python backend module for desktop or server automation.

---

## ✨ Key Capabilities

- Auditoría detallada de esquema IFC4X3_ADD2, IfcProjectedCRS e IfcMapConversion
- Verificación de referenciación lineal PK (ADIF_02_Km_Inicio / Km_Fin e IfcAlignment)
- Desglose de puntuación por estándar con diagnóstico técnico

---

## 🤖 AI Quick-Build Prompt (Cursor / Claude / ChatGPT)

To replicate or integrate **Auditoría de Estándares Internacionales** into your own application using an AI assistant, share this folder URL and use this prompt:

```text
Build a standalone web/desktop module for "Auditoría de Estándares Internacionales" based on JulianBimDeveloper/ifc-hub-web-app/tree/main/tools/05-Validation-QA/IsoOpenBimStandardsAudit.
Use standalone_tool.js for 100% client-side ISO-10303-21 IFC STEP parsing in RAM (supporting IFC2x3, IFC4, and IFC4x3 from Revit and Civil 3D) and replicate the workflow in ui_component.tsx.
```

---

## ⚖️ License

Distributed under the **MIT License**. Created by **Julian Mejia** ([@JulianBimDeveloper](https://github.com/JulianBimDeveloper)).
