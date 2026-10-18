# Buscador Universal de Valores y Edición Masiva (`Value Search`)

> **Standalone OpenBIM & IFC Tool** · `Búsqueda Rápida` · `Psets` · `Edición en Lote` · `Export CSV/IFC`

Indexa todos los Property Sets de instancia y de tipo de los archivos IFC cargados para buscar elementos por cualquier cadena (código ADIF, material, estado, PK) y permite editar o reemplazar valores directamente en el IFC.

---

## 📊 System Architecture

```mermaid
graph TD
    A["Local .IFC File (Revit / Civil 3D)"] -->|Zero-Server RAM Parser| B("ISO-10303-21 STEP Tokenizer")
    B -->|Entity & Pset Graph| C["Value Search Engine"]
    C -->|Audit & Metrics| D["Interactive Web UI / CSV Report"]
    C -->|In-Memory STEP Mutation| E["Modified .IFC File Download"]
```

---

## 📁 Files inside this Standalone Suite

This folder is isolated and self-contained so you (or an AI coding assistant) can inspect, clone, or integrate **Buscador Universal de Valores y Edición Masiva** independently:

- **[`standalone_tool.js`](standalone_tool.js)**: Zero-dependency JavaScript IFC STEP engine (runs 100% in browser RAM or Node.js) implementing entity parsing, property inheritance (`IFCRELDEFINESBYTYPE` / `IFCRELDEFINESBYPROPERTIES`), and STEP re-serialization.
- **[`ui_component.tsx`](ui_component.tsx)**: React / Next.js UI implementation for interactive visualization and batch editing.
- **[`python_processor.py`](python_processor.py)**: FastAPI / Python backend module for desktop or server automation.

---

## ✨ Key Capabilities

- Búsqueda instantánea en todos los Psets de instancia y tipo
- Filtro combinado por clase IFC, nombre de Pset y propiedad
- Reemplazo masivo de valores en memoria y descarga del IFC actualizado

---

## 🤖 AI Quick-Build Prompt (Cursor / Claude / ChatGPT)

To replicate or integrate **Buscador Universal de Valores y Edición Masiva** into your own application using an AI assistant, share this folder URL and use this prompt:

```text
Build a standalone web/desktop module for "Buscador Universal de Valores y Edición Masiva" based on JulianBimDeveloper/ifc-hub-web-app/tree/main/tools/02-Explore-3D/IfcValueSearchEditor.
Use standalone_tool.js for 100% client-side ISO-10303-21 IFC STEP parsing in RAM (supporting IFC2x3, IFC4, and IFC4x3 from Revit and Civil 3D) and replicate the workflow in ui_component.tsx.
```

---

## ⚖️ License

Distributed under the **MIT License**. Created by **Julian Mejia** ([@JulianBimDeveloper](https://github.com/JulianBimDeveloper)).
