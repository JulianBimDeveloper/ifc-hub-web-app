# Clasificador IFC Normativo (`Classifier`)

> **Standalone OpenBIM & IFC Tool** · `SCFClass_Funciones` · `IfcClassificationReference` · `ADIF` · `OpenBIM`

Empareja cada elemento físico mediante ADIF_00_Codigo_Producto y ADIF_00_Descripcion_Producto con IfcClassification ('SCFClass_Funciones') e inyecta las entidades IfcClassificationReference e IfcRelAssociatesClassification en el archivo STEP.

---

## 📊 System Architecture

```mermaid
graph TD
    A["Local .IFC File (Revit / Civil 3D)"] -->|Zero-Server RAM Parser| B("ISO-10303-21 STEP Tokenizer")
    B -->|Entity & Pset Graph| C["Classifier Engine"]
    C -->|Audit & Metrics| D["Interactive Web UI / CSV Report"]
    C -->|In-Memory STEP Mutation| E["Modified .IFC File Download"]
```

---

## 📁 Files inside this Standalone Suite

This folder is isolated and self-contained so you (or an AI coding assistant) can inspect, clone, or integrate **Clasificador IFC Normativo** independently:

- **[`standalone_tool.js`](standalone_tool.js)**: Zero-dependency JavaScript IFC STEP engine (runs 100% in browser RAM or Node.js) implementing entity parsing, property inheritance (`IFCRELDEFINESBYTYPE` / `IFCRELDEFINESBYPROPERTIES`), and STEP re-serialization.
- **[`ui_component.tsx`](ui_component.tsx)**: React / Next.js UI implementation for interactive visualization and batch editing.
- **[`python_processor.py`](python_processor.py)**: FastAPI / Python backend module for desktop or server automation.

---

## ✨ Key Capabilities

- Detección de IfcClassification e IfcRelAssociatesClassification existentes
- Inyección automática de IfcClassificationReference en el archivo IFC en memoria
- Semáforo de elementos clasificados vs pendientes de clasificación

---

## 🤖 AI Quick-Build Prompt (Cursor / Claude / ChatGPT)

To replicate or integrate **Clasificador IFC Normativo** into your own application using an AI assistant, share this folder URL and use this prompt:

```text
Build a standalone web/desktop module for "Clasificador IFC Normativo" based on JulianBimDeveloper/ifc-hub-web-app/tree/main/tools/03-Metadata-Injection/SCFClassInjector.
Use standalone_tool.js for 100% client-side ISO-10303-21 IFC STEP parsing in RAM (supporting IFC2x3, IFC4, and IFC4x3 from Revit and Civil 3D) and replicate the workflow in ui_component.tsx.
```

---

## ⚖️ License

Distributed under the **MIT License**. Created by **Julian Mejia** ([@JulianBimDeveloper](https://github.com/JulianBimDeveloper)).
