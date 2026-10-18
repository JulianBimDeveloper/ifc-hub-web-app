# Generador de Conjuntos (IfcSystem) (`Sets (IfcSystem)`)

> **Standalone OpenBIM & IFC Tool** · `Navisworks` · `IfcSystem` · `IfcRelAssignsToGroup` · `XML & IFC`

Soluciona una limitación crítica de Navisworks: mientras que IfcGroup es ignorado, IfcSystem es interpretado directamente como Colección de IFC. Permite agrupar por cualquier propiedad, inyectar IfcSystem en el IFC o exportar Selection Sets XML.

---

## 📊 System Architecture

```mermaid
graph TD
    A["Local .IFC File (Revit / Civil 3D)"] -->|Zero-Server RAM Parser| B("ISO-10303-21 STEP Tokenizer")
    B -->|Entity & Pset Graph| C["Sets (IfcSystem) Engine"]
    C -->|Audit & Metrics| D["Interactive Web UI / CSV Report"]
    C -->|In-Memory STEP Mutation| E["Modified .IFC File Download"]
```

---

## 📁 Files inside this Standalone Suite

This folder is isolated and self-contained so you (or an AI coding assistant) can inspect, clone, or integrate **Generador de Conjuntos (IfcSystem)** independently:

- **[`standalone_tool.js`](standalone_tool.js)**: Zero-dependency JavaScript IFC STEP engine (runs 100% in browser RAM or Node.js) implementing entity parsing, property inheritance (`IFCRELDEFINESBYTYPE` / `IFCRELDEFINESBYPROPERTIES`), and STEP re-serialization.
- **[`ui_component.tsx`](ui_component.tsx)**: React / Next.js UI implementation for interactive visualization and batch editing.
- **[`python_processor.py`](python_processor.py)**: FastAPI / Python backend module for desktop or server automation.

---

## ✨ Key Capabilities

- Inyección real de entidades IFCSYSTEM e IFCRELASSIGNSTOGROUP en el archivo .ifc
- Exportación de Search Sets / Selection Sets XML para Autodesk Navisworks
- Agrupación dinámica por cualquier propiedad ADIF, material o clase IFC

---

## 🤖 AI Quick-Build Prompt (Cursor / Claude / ChatGPT)

To replicate or integrate **Generador de Conjuntos (IfcSystem)** into your own application using an AI assistant, share this folder URL and use this prompt:

```text
Build a standalone web/desktop module for "Generador de Conjuntos (IfcSystem)" based on JulianBimDeveloper/ifc-hub-web-app/tree/main/tools/03-Metadata-Injection/NavisworksSetsInjector.
Use standalone_tool.js for 100% client-side ISO-10303-21 IFC STEP parsing in RAM (supporting IFC2x3, IFC4, and IFC4x3 from Revit and Civil 3D) and replicate the workflow in ui_component.tsx.
```

---

## ⚖️ License

Distributed under the **MIT License**. Created by **Julian Mejia** ([@JulianBimDeveloper](https://github.com/JulianBimDeveloper)).
