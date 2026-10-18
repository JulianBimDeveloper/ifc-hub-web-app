# Revisión de Cliente y Aprobaciones (`Client Review`)

> **Standalone OpenBIM & IFC Tool** · `Revisión` · `Aprobación` · `BCF / CSV` · `Colaboración`

Permite al revisor del cliente o coordinador BIM asignar estados de revisión y comentarios técnicos a elementos o grupos del modelo, persistiendo las revisiones localmente y exportando el acta de revisión o incidencias BCF.

---

## 📊 System Architecture

```mermaid
graph TD
    A["Local .IFC File (Revit / Civil 3D)"] -->|Zero-Server RAM Parser| B("ISO-10303-21 STEP Tokenizer")
    B -->|Entity & Pset Graph| C["Client Review Engine"]
    C -->|Audit & Metrics| D["Interactive Web UI / CSV Report"]
    C -->|In-Memory STEP Mutation| E["Modified .IFC File Download"]
```

---

## 📁 Files inside this Standalone Suite

This folder is isolated and self-contained so you (or an AI coding assistant) can inspect, clone, or integrate **Revisión de Cliente y Aprobaciones** independently:

- **[`standalone_tool.js`](standalone_tool.js)**: Zero-dependency JavaScript IFC STEP engine (runs 100% in browser RAM or Node.js) implementing entity parsing, property inheritance (`IFCRELDEFINESBYTYPE` / `IFCRELDEFINESBYPROPERTIES`), and STEP re-serialization.
- **[`ui_component.tsx`](ui_component.tsx)**: React / Next.js UI implementation for interactive visualization and batch editing.
- **[`python_processor.py`](python_processor.py)**: FastAPI / Python backend module for desktop or server automation.

---

## ✨ Key Capabilities

- Asignación interactiva de estados (Aprobado, Con Comentarios, Rechazado) por elemento
- Filtro rápido por estado de revisión y búsqueda de elementos observados
- Exportación de informe de revisión técnica en CSV y estructura BCF

---

## 🤖 AI Quick-Build Prompt (Cursor / Claude / ChatGPT)

To replicate or integrate **Revisión de Cliente y Aprobaciones** into your own application using an AI assistant, share this folder URL and use this prompt:

```text
Build a standalone web/desktop module for "Revisión de Cliente y Aprobaciones" based on JulianBimDeveloper/ifc-hub-web-app/tree/main/tools/05-Validation-QA/ClientDeliverableReview.
Use standalone_tool.js for 100% client-side ISO-10303-21 IFC STEP parsing in RAM (supporting IFC2x3, IFC4, and IFC4x3 from Revit and Civil 3D) and replicate the workflow in ui_component.tsx.
```

---

## ⚖️ License

Distributed under the **MIT License**. Created by **Julian Mejia** ([@JulianBimDeveloper](https://github.com/JulianBimDeveloper)).
