# Verificador de Calidad QA (Model Checker) (`Model Checker`)

> **Standalone OpenBIM & IFC Tool** · `QA / QC` · `Model Checker` · `Auditoría` · `Reglas`

Ejecuta una batería de reglas QA (inspirada en Autodesk Model Checker) sobre el modelo cargado: presencia de geometría 3D, detección de valores 'N/A' en campos obligatorios, clasificación SCFClass, materiales válidos y asignación espacial.

---

## 📊 System Architecture

```mermaid
graph TD
    A["Local .IFC File (Revit / Civil 3D)"] -->|Zero-Server RAM Parser| B("ISO-10303-21 STEP Tokenizer")
    B -->|Entity & Pset Graph| C["Model Checker Engine"]
    C -->|Audit & Metrics| D["Interactive Web UI / CSV Report"]
    C -->|In-Memory STEP Mutation| E["Modified .IFC File Download"]
```

---

## 📁 Files inside this Standalone Suite

This folder is isolated and self-contained so you (or an AI coding assistant) can inspect, clone, or integrate **Verificador de Calidad QA (Model Checker)** independently:

- **[`standalone_tool.js`](standalone_tool.js)**: Zero-dependency JavaScript IFC STEP engine (runs 100% in browser RAM or Node.js) implementing entity parsing, property inheritance (`IFCRELDEFINESBYTYPE` / `IFCRELDEFINESBYPROPERTIES`), and STEP re-serialization.
- **[`ui_component.tsx`](ui_component.tsx)**: React / Next.js UI implementation for interactive visualization and batch editing.
- **[`python_processor.py`](python_processor.py)**: FastAPI / Python backend module for desktop or server automation.

---

## ✨ Key Capabilities

- Detección detallada de parámetros con valor 'N/A' por Property Set
- Chequeo de integridad geométrica, espacial, material y clasificación
- Exportación de informe ejecutivo QA/QC en CSV

---

## 🤖 AI Quick-Build Prompt (Cursor / Claude / ChatGPT)

To replicate or integrate **Verificador de Calidad QA (Model Checker)** into your own application using an AI assistant, share this folder URL and use this prompt:

```text
Build a standalone web/desktop module for "Verificador de Calidad QA (Model Checker)" based on JulianBimDeveloper/ifc-hub-web-app/tree/main/tools/05-Validation-QA/ModelCheckerQA.
Use standalone_tool.js for 100% client-side ISO-10303-21 IFC STEP parsing in RAM (supporting IFC2x3, IFC4, and IFC4x3 from Revit and Civil 3D) and replicate the workflow in ui_component.tsx.
```

---

## ⚖️ License

Distributed under the **MIT License**. Created by **Julian Mejia** ([@JulianBimDeveloper](https://github.com/JulianBimDeveloper)).
