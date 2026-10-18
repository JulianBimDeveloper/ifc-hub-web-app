# Detector de Duplicados Geométricos (`Duplicates`)

> **Standalone OpenBIM & IFC Tool** · `Clash` · `Duplicados 3D` · `UTM Centroid` · `Mediciones`

Calcula la coordenada global real (UTM ETRS89) de cada elemento resolviendo la cadena completa IfcLocalPlacement + geometría, y detecta elementos duplicados por posición 3D (con tolerancia configurable en metros), por GlobalId o por ADIF_00_Id_Objeto.

---

## 📊 System Architecture

```mermaid
graph TD
    A["Local .IFC File (Revit / Civil 3D)"] -->|Zero-Server RAM Parser| B("ISO-10303-21 STEP Tokenizer")
    B -->|Entity & Pset Graph| C["Duplicates Engine"]
    C -->|Audit & Metrics| D["Interactive Web UI / CSV Report"]
    C -->|In-Memory STEP Mutation| E["Modified .IFC File Download"]
```

---

## 📁 Files inside this Standalone Suite

This folder is isolated and self-contained so you (or an AI coding assistant) can inspect, clone, or integrate **Detector de Duplicados Geométricos** independently:

- **[`standalone_tool.js`](standalone_tool.js)**: Zero-dependency JavaScript IFC STEP engine (runs 100% in browser RAM or Node.js) implementing entity parsing, property inheritance (`IFCRELDEFINESBYTYPE` / `IFCRELDEFINESBYPROPERTIES`), and STEP re-serialization.
- **[`ui_component.tsx`](ui_component.tsx)**: React / Next.js UI implementation for interactive visualization and batch editing.
- **[`python_processor.py`](python_processor.py)**: FastAPI / Python backend module for desktop or server automation.

---

## ✨ Key Capabilities

- Cálculo matemático de coordenadas globales UTM para cada elemento del modelo
- Tolerancia espacial configurable (ej. 0.01 m, 0.05 m, 0.20 m) para detectar solapes
- Detección de colisiones tanto dentro de un modelo como federando RVT + C3D

---

## 🤖 AI Quick-Build Prompt (Cursor / Claude / ChatGPT)

To replicate or integrate **Detector de Duplicados Geométricos** into your own application using an AI assistant, share this folder URL and use this prompt:

```text
Build a standalone web/desktop module for "Detector de Duplicados Geométricos" based on JulianBimDeveloper/ifc-hub-web-app/tree/main/tools/05-Validation-QA/GeometricDuplicatesDetector.
Use standalone_tool.js for 100% client-side ISO-10303-21 IFC STEP parsing in RAM (supporting IFC2x3, IFC4, and IFC4x3 from Revit and Civil 3D) and replicate the workflow in ui_component.tsx.
```

---

## ⚖️ License

Distributed under the **MIT License**. Created by **Julian Mejia** ([@JulianBimDeveloper](https://github.com/JulianBimDeveloper)).
