# Auditoría e Inyección de Metadatos (`Metadata Manager`)

> **Standalone OpenBIM & IFC Tool** · `Cabecera STEP` · `FILE_NAME` · `IfcProjectedCRS` · `EPSG:25830`

Inspecciona y permite editar la cabecera STEP del archivo IFC (FILE_NAME, Autor, Organización, Originating System, Authorization) además de verificar el sistema de coordenadas proyectadas IfcProjectedCRS (EPSG:25830) e IfcMapConversion.

---

## 📊 System Architecture

```mermaid
graph TD
    A["Local .IFC File (Revit / Civil 3D)"] -->|Zero-Server RAM Parser| B("ISO-10303-21 STEP Tokenizer")
    B -->|Entity & Pset Graph| C["Metadata Manager Engine"]
    C -->|Audit & Metrics| D["Interactive Web UI / CSV Report"]
    C -->|In-Memory STEP Mutation| E["Modified .IFC File Download"]
```

---

## 📁 Files inside this Standalone Suite

This folder is isolated and self-contained so you (or an AI coding assistant) can inspect, clone, or integrate **Auditoría e Inyección de Metadatos** independently:

- **[`standalone_tool.js`](standalone_tool.js)**: Zero-dependency JavaScript IFC STEP engine (runs 100% in browser RAM or Node.js) implementing entity parsing, property inheritance (`IFCRELDEFINESBYTYPE` / `IFCRELDEFINESBYPROPERTIES`), and STEP re-serialization.
- **[`ui_component.tsx`](ui_component.tsx)**: React / Next.js UI implementation for interactive visualization and batch editing.
- **[`python_processor.py`](python_processor.py)**: FastAPI / Python backend module for desktop or server automation.

---

## ✨ Key Capabilities

- Edición interactiva de cabecera STEP (Autor, Organización, Sistema Origen)
- Inspección de georreferenciación IfcProjectedCRS (EPSG:25830) e IfcMapConversion
- Descarga inmediata del archivo IFC con cabecera actualizada

---

## 🤖 AI Quick-Build Prompt (Cursor / Claude / ChatGPT)

To replicate or integrate **Auditoría e Inyección de Metadatos** into your own application using an AI assistant, share this folder URL and use this prompt:

```text
Build a standalone web/desktop module for "Auditoría e Inyección de Metadatos" based on JulianBimDeveloper/ifc-hub-web-app/tree/main/tools/03-Metadata-Injection/StepHeaderMetadataEditor.
Use standalone_tool.js for 100% client-side ISO-10303-21 IFC STEP parsing in RAM (supporting IFC2x3, IFC4, and IFC4x3 from Revit and Civil 3D) and replicate the workflow in ui_component.tsx.
```

---

## ⚖️ License

Distributed under the **MIT License**. Created by **Julian Mejia** ([@JulianBimDeveloper](https://github.com/JulianBimDeveloper)).
