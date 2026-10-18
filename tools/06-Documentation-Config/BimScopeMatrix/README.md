# Gestión del Alcance BIM (BIM Scope) (`BIM Scope`)

> **Standalone OpenBIM & IFC Tool** · `Alcance` · `Milestones` · `LOD / LOI` · `Matriz Entregables`

Matriz de control del alcance BIM que cruza los entregables planificados del proyecto con los archivos IFC realmente cargados en sesión, verificando disciplina, software de autoría, número de elementos y porcentaje de cumplimiento.

---

## 📊 System Architecture

```mermaid
graph TD
    A["Local .IFC File (Revit / Civil 3D)"] -->|Zero-Server RAM Parser| B("ISO-10303-21 STEP Tokenizer")
    B -->|Entity & Pset Graph| C["BIM Scope Engine"]
    C -->|Audit & Metrics| D["Interactive Web UI / CSV Report"]
    C -->|In-Memory STEP Mutation| E["Modified .IFC File Download"]
```

---

## 📁 Files inside this Standalone Suite

This folder is isolated and self-contained so you (or an AI coding assistant) can inspect, clone, or integrate **Gestión del Alcance BIM (BIM Scope)** independently:

- **[`standalone_tool.js`](standalone_tool.js)**: Zero-dependency JavaScript IFC STEP engine (runs 100% in browser RAM or Node.js) implementing entity parsing, property inheritance (`IFCRELDEFINESBYTYPE` / `IFCRELDEFINESBYPROPERTIES`), and STEP re-serialization.
- **[`ui_component.tsx`](ui_component.tsx)**: React / Next.js UI implementation for interactive visualization and batch editing.
- **[`python_processor.py`](python_processor.py)**: FastAPI / Python backend module for desktop or server automation.

---

## ✨ Key Capabilities

- Sincronización automática de los modelos cargados en la matriz de alcance BIM
- Gestión interactiva de estados (En Modelado, En Revisión QA, Entregado PDE)
- Exportación de la matriz de alcance y avance en formato CSV

---

## 🤖 AI Quick-Build Prompt (Cursor / Claude / ChatGPT)

To replicate or integrate **Gestión del Alcance BIM (BIM Scope)** into your own application using an AI assistant, share this folder URL and use this prompt:

```text
Build a standalone web/desktop module for "Gestión del Alcance BIM (BIM Scope)" based on JulianBimDeveloper/ifc-hub-web-app/tree/main/tools/06-Documentation-Config/BimScopeMatrix.
Use standalone_tool.js for 100% client-side ISO-10303-21 IFC STEP parsing in RAM (supporting IFC2x3, IFC4, and IFC4x3 from Revit and Civil 3D) and replicate the workflow in ui_component.tsx.
```

---

## ⚖️ License

Distributed under the **MIT License**. Created by **Julian Mejia** ([@JulianBimDeveloper](https://github.com/JulianBimDeveloper)).
