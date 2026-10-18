# Renombrado de Tipo y Objeto ID (`Name Type ID`)

> **Standalone OpenBIM & IFC Tool** · `Trazabilidad` · `ADIF_00_Id_Objeto` · `Renombrado STEP` · `QA`

Asegura la trazabilidad unívoca entre Revit, Civil 3D y Navisworks estampando el valor de ADIF_00_Id_Objeto (o Tag) como sufijo del atributo Name de la entidad IFC (ej. IDR_DPR_TuboDrenajePVC_1717352).

---

## 📊 System Architecture

```mermaid
graph TD
    A["Local .IFC File (Revit / Civil 3D)"] -->|Zero-Server RAM Parser| B("ISO-10303-21 STEP Tokenizer")
    B -->|Entity & Pset Graph| C["Name Type ID Engine"]
    C -->|Audit & Metrics| D["Interactive Web UI / CSV Report"]
    C -->|In-Memory STEP Mutation| E["Modified .IFC File Download"]
```

---

## 📁 Files inside this Standalone Suite

This folder is isolated and self-contained so you (or an AI coding assistant) can inspect, clone, or integrate **Renombrado de Tipo y Objeto ID** independently:

- **[`standalone_tool.js`](standalone_tool.js)**: Zero-dependency JavaScript IFC STEP engine (runs 100% in browser RAM or Node.js) implementing entity parsing, property inheritance (`IFCRELDEFINESBYTYPE` / `IFCRELDEFINESBYPROPERTIES`), and STEP re-serialization.
- **[`ui_component.tsx`](ui_component.tsx)**: React / Next.js UI implementation for interactive visualization and batch editing.
- **[`python_processor.py`](python_processor.py)**: FastAPI / Python backend module for desktop or server automation.

---

## ✨ Key Capabilities

- Detección automática de elementos que ya cumplen vs pendientes de renombrar
- Previsualización antes/después del atributo Name en cada entidad
- Aplicación directa en el archivo STEP y descarga del IFC estandarizado

---

## 🤖 AI Quick-Build Prompt (Cursor / Claude / ChatGPT)

To replicate or integrate **Renombrado de Tipo y Objeto ID** into your own application using an AI assistant, share this folder URL and use this prompt:

```text
Build a standalone web/desktop module for "Renombrado de Tipo y Objeto ID" based on JulianBimDeveloper/ifc-hub-web-app/tree/main/tools/03-Metadata-Injection/NameTypeIdStandardizer.
Use standalone_tool.js for 100% client-side ISO-10303-21 IFC STEP parsing in RAM (supporting IFC2x3, IFC4, and IFC4x3 from Revit and Civil 3D) and replicate the workflow in ui_component.tsx.
```

---

## ⚖️ License

Distributed under the **MIT License**. Created by **Julian Mejia** ([@JulianBimDeveloper](https://github.com/JulianBimDeveloper)).
