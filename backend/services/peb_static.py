"""Static content for PEB documents — standard ADIF text."""

# ── BIM Objectives ─────────────────────────────────────────────────────────────
BIM_OBJECTIVES = [
    ("Modelo para el ciclo de vida",
     "El modelo BIM constituirá la base de información para el activo a lo largo de su ciclo de vida, facilitando la transferencia de información precisa entre las distintas fases."),
    ("Toma de decisiones",
     "El modelo BIM servirá de soporte en la toma de decisiones durante el proyecto y la obra, mejorando la capacidad de reacción ante imprevistos y optimizando la comunicación entre agentes."),
    ("Coordinación de la actuación",
     "Se empleará el modelo BIM para coordinar las distintas disciplinas durante la ejecución de los trabajos, detectando y resolviendo conflictos de forma anticipada."),
    ("Coordinación entre actuaciones",
     "La coordinación entre las distintas actuaciones que conforman el proyecto global se realizará mediante modelos federados que integren la información de todos los adjudicatarios."),
    ("Calidad",
     "El uso de modelos BIM permitirá aumentar y asegurar la calidad en todas las fases del ciclo de vida, reduciendo errores e inconsistencias en la documentación."),
    ("Mitigación de riesgos",
     "La simulación virtual de los trabajos mediante BIM permitirá identificar y mitigar riesgos antes de su materialización en obra."),
    ("Control del proyecto",
     "El modelo BIM mejorará las capacidades de control y seguimiento del proyecto, facilitando la detección temprana de desviaciones respecto a la planificación prevista."),
    ("Seguimiento BIM",
     "Se realizará un seguimiento continuo del avance de los trabajos mediante la actualización periódica del modelo BIM conforme al cronograma establecido."),
    ("Mejora de seguridad y salud",
     "El modelo BIM incorporará información relevante para la mejora de la seguridad y salud en obra, sirviendo de soporte a la documentación de Prevención de Riesgos Laborales (PRL)."),
    ("Estado actual",
     "El modelo BIM recogerá el conocimiento del estado actual del emplazamiento y de los elementos existentes, proporcionando una base fiable para el diseño y la construcción."),
    ("Sostenibilidad",
     "El modelo BIM permitirá evaluar y mejorar el proyecto desde el punto de vista de la sostenibilidad y la calidad ambiental, reduciendo el impacto medioambiental de los trabajos."),
    ("Economía operativa",
     "La información contenida en el modelo BIM contribuirá a reducir los costes operativos durante la fase de explotación y mantenimiento del activo."),
    ("Coherencia de la información",
     "El modelo BIM limitará la reentrada de información a lo largo de todo el ciclo de vida, garantizando la coherencia y trazabilidad de los datos del activo."),
    ("Gestión de activos Adif",
     "La información generada en el modelo BIM favorecerá la gestión eficaz de los activos de Adif, integrándose con los sistemas de gestión patrimonial existentes."),
    ("Comunicación",
     "El modelo BIM mejorará la comunicación interna y externa mediante el uso de nuevas herramientas de visualización, facilitando la comprensión del proyecto a todos los agentes implicados."),
]

# ── BIM Uses ──────────────────────────────────────────────────────────────────
# Format: (codigo, nombre, descripcion, metodologia_base)
BIM_USES = {
    "GE013": (
        "Autoría mediante modelos BIM 3D",
        "Materialización del diseño en una maqueta digital 3D que constituye la fuente principal de generación de documentación y la base para los demás usos de modelo.",
        "Se generarán modelos nativos por disciplina en los software establecidos. Los modelos serán la fuente principal de extracción de documentación 2D, mediciones y demás entregables BIM. Se gestionarán los atributos LOI conforme a la matriz de atributos del contrato.",
    ),
    "RE013": (
        "Levantamiento digital de activos existentes",
        "Creación de un Modelo de Estado Actual (MEA) que recoja el estado de los activos existentes en el emplazamiento, basado en la documentación disponible y en trabajos de campo.",
        "Se generará el MEA a partir de la documentación de partida facilitada por Adif y la ATC, complementada con inspecciones de campo cuando sea necesario. El MEA servirá de base para la definición del Modelo de Inicio de Obras (MOI).",
    ),
    "RE023": (
        "Modelo construido (As-Built)",
        "Culminación del modelo de seguimiento de obra (MOM) recogiendo fielmente lo realmente construido, incorporando todas las modificaciones producidas durante la ejecución.",
        "El modelo As-Built se generará a partir de la última entrega del MOM, incorporando las modificaciones del proyecto reformado y verificando su correspondencia con la obra ejecutada. Se entregará en los formatos nativos e IFC establecidos en el MIDP.",
    ),
    "GE023": (
        "Seguimiento de obra con BIM",
        "Empleo del modelo BIM para el seguimiento de la ejecución de las obras, permitiendo auditar el avance, detectar desviaciones y documentar el proceso constructivo.",
        "Se actualizará mensualmente el Modelo de Obra en Marcha (MOM) reflejando el avance de los trabajos. El primer hito de consolidación corresponde al MOI. Los modelos se compartirán en el CDE en los estados y plazos establecidos.",
    ),
    "CO011": (
        "Gestión documental, colaboración y entrega BIM (CDE)",
        "Definición de los procesos y flujos de información para el intercambio ordenado de datos entre los distintos agentes del proyecto mediante un Entorno Común de Datos (CDE).",
        "Se empleará el CDE de Adif (Autodesk Construction Cloud) para el intercambio de información entre agentes. Los documentos transitarán por los estados Trabajo, Compartido, Publicado y Archivado conforme a los flujos establecidos en este PEB.",
    ),
    "CO022": (
        "Documentación 2D, planos",
        "Empleo de los modelos BIM como fuente principal de generación de la documentación 2D del proyecto, garantizando la coherencia entre el modelo y los planos.",
        "Los planos se extraerán directamente de los modelos BIM. Se establecerá una nomenclatura y estructura de vistas conforme al estándar de codificación de Adif. La documentación 2D se vinculará al modelo y se actualizará conjuntamente con él.",
    ),
    "CO043": (
        "Reuniones digitales",
        "Realización de reuniones de revisión y toma de decisiones utilizando los modelos BIM como soporte, facilitando la visualización del proyecto y el registro de incidencias.",
        "Se utilizará el modelo federado como soporte en las reuniones digitales periódicas. Las incidencias detectadas se registrarán mediante el CDE (Autodesk Construction Cloud). Se seguirá el protocolo de reuniones digitales establecido en la guía de Adif.",
    ),
    "CO053": (
        "Visualización para comercial e institucional",
        "Generación de imágenes y visualizaciones realistas del proyecto para su uso en comunicaciones comerciales e institucionales.",
        "A partir de la geometría de los modelos BIM se generarán renders e imágenes representativas del proyecto. Estas visualizaciones se emplearán en presentaciones institucionales y comunicaciones internas y externas.",
    ),
    "AN023": (
        "Coordinación BIM (3D), colisiones o interferencias",
        "Comprobación de la integración espacial inter e intra-disciplinar de los modelos, detectando y resolviendo interferencias y colisiones entre elementos de distintas disciplinas.",
        "Se realizarán revisiones de interferencias periódicas sobre el modelo federado, con las frecuencias establecidas en la sección de Reuniones Digitales. Los resultados se documentarán mediante la plantilla de interferencias del contrato y se comunicarán en las reuniones digitales correspondientes.",
    ),
    "AN034": (
        "Simulación constructiva (4D)",
        "Vinculación de la información temporal (planificación) a los objetos BIM del modelo, permitiendo la validación de las planificaciones y la simulación de la secuencia constructiva.",
        "Se vincularán los códigos de actividad de la planificación (campo ADIF_04_Codigo_Actividad) a los objetos BIM. La simulación 4D se validará en los hitos de entrega establecidos, verificando la coherencia entre el modelo y el cronograma de obra.",
    ),
    "AN045": (
        "Mediciones BIM (5D)",
        "Empleo de los modelos BIM para la obtención y verificación de mediciones y presupuestos, garantizando la coherencia entre el modelo y las mediciones del proyecto.",
        "Se extraerán las mediciones directamente del modelo BIM para al menos el 60% de las partidas de obra. Los datos de medición (campo ADIF_05) se incorporarán a los objetos BIM en los hitos de entrega establecidos.",
    ),
    "AN089": (
        "Interoperabilidad ferroviaria",
        "Incorporación en el modelo BIM de datos relativos a las Especificaciones Técnicas de Interoperabilidad (ETI) y al sistema de gálibos ferroviarios, garantizando el cumplimiento de los requisitos de interoperabilidad.",
        "Se modelarán los gálibos cinemáticos de las vías en el software de Civil 3D, conforme a las especificaciones técnicas de Adif. Los modelos de interoperabilidad se integrarán en el modelo federado para su verificación en las reuniones de coordinación.",
    ),
    "AN010": (
        "Seguridad operacional",
        "Apoyo BIM para la minimización de riesgos en el entorno ferroviario en tránsito.",
        "Análisis de las condiciones de seguridad operacional mediante el modelo BIM.",
    ),
    "CO063": (
        "Integración BIM SIG",
        "Preparación de modelos BIM para su integración con plataformas de Sistemas de Información Geográfica (SIG).",
        "Exportación de datos georreferenciados del modelo BIM para su integración en plataformas SIG.",
    ),
    "AN053": (
        "Cálculos de ingeniería y análisis",
        "Empleo de los modelos BIM como fuente para la realización de cálculos de ingeniería.",
        "Integración del modelo BIM con herramientas de cálculo estructural, hidráulico y geotécnico.",
    ),
    "AN066": (
        "Sostenibilidad con BIM",
        "Empleo del modelo BIM para la realización de cálculos relativos al empleo de recursos y su relación con el entorno.",
        "Análisis de sostenibilidad energética y ambiental mediante el modelo BIM.",
    ),
    "EM017": (
        "Logística, gestión de acopios y mantenimiento de vía con IFC",
        "Apoyo BIM para la gestión de acopios y materiales de vía.",
        "Gestión de materiales y logística de obra mediante el modelo BIM.",
    ),
    "AN078": (
        "Seguridad y salud con soporte BIM y SIG",
        "Información en los modelos para la documentación de PRL y mejora de la seguridad en obra.",
        "Integración de datos de seguridad y salud en el modelo BIM.",
    ),
    "EM027": (
        "Mantenimiento y conservación de activos con soporte BIM",
        "Incorporación de información en el modelo BIM para el mantenimiento de activos.",
        "Uso del modelo BIM en la fase de explotación y mantenimiento.",
    ),
    "EM037": (
        "Gestión de activos con soporte BIM",
        "Información BIM para gestión patrimonial de activos.",
        "Integración del modelo BIM con los sistemas de gestión patrimonial de Adif.",
    ),
}

# ── Roles ADIF DACGP (fixed) ──────────────────────────────────────────────────
EQUIPO_ADIF = [
    ("Responsable de contrato", "Miguel A. Leor Roca", "ADIF DACGP", "mleor@adif.es"),
    ("Responsable BIM ADIF", "David Ibáñez Núñez", "ADIF DACGP", "david.ibanez@externos.adif.es"),
    ("Gestor de la información", "Marta Díaz Pulido", "ADIF DACGP", "marta.pulido@externos.adif.es"),
]

# ── Equipo ATC INECO (fixed for Norte, overridable) ─────────────────────────
EQUIPO_ATC = [
    ("Responsable ATC", "Fernando Gil Cantabrana", "INECO", "fgilc@ineco.com"),
    ("Responsable BIM ATC / Gestor información", "Adrián García Rodríguez", "INECO", "adrian.garcia@ineco.com"),
    ("Coordinador BIM ATC", "Samuel J. Triana González", "INECO", "samuel.triana@ineco.com"),
    ("Coordinador BIM ATC", "Mª Victoria Fdz. Galán", "INECO", "mvfernandezg@ineco.com"),
]

# ── Discipline catalog ─────────────────────────────────────────────────────────
DISCIPLINAS_CATALOG = [
    ("ARQ",  "Arquitectura",                  "REVIT",    True),
    ("EST",  "Estructuras",                   "REVIT",    True),
    ("SUV",  "Superestructura de Vía",         "CIVIL3D",  True),
    ("ENE",  "Electrificación",               "REVIT",    True),
    ("IAB",  "Instalaciones Abastecimiento",   "REVIT",    True),
    ("IDR",  "Instalaciones Drenaje",          "AMBOS",    True),
    ("IEL",  "Instalaciones Electricidad",     "REVIT",    True),
    ("IGA",  "Instalaciones Gas",              "REVIT",    True),
    ("INS",  "Instalaciones Generales",        "REVIT",    True),
    ("ISA",  "Instalaciones Saneamiento",      "REVIT",    True),
    ("ITE",  "Instalaciones Telecomunicación", "REVIT",    True),
    ("ITF",  "Telecomunicación Ferroviaria",   "CIVIL3D",  True),
    ("CMS",  "Sistemas CMS",                   "REVIT",    True),
    ("CYT",  "Topografía",                    "CIVIL3D",  True),
    ("INT",  "Gálibos Interoperabilidad",      "CIVIL3D",  True),
]

# ── Hardware requirements ──────────────────────────────────────────────────────
HARDWARE_REQUIREMENTS = [
    ("Sistema operativo",     "Windows 10 64-bit",         "Windows 10/11 64-bit Pro",    "Windows 11 64-bit Pro"),
    ("Procesador (CPU)",      "Intel Core i5 (8ª gen+)",   "Intel Core i7/i9 (10ª gen+)", "Intel Xeon / AMD Ryzen 9"),
    ("Memoria RAM",           "16 GB",                     "32 GB",                       "64 GB o más"),
    ("Tarjeta gráfica (GPU)", "NVIDIA GTX 1060 4 GB",      "NVIDIA RTX 3060 8 GB",        "NVIDIA RTX 4090 24 GB"),
    ("Almacenamiento",        "SSD 512 GB",                "SSD NVMe 1 TB",               "SSD NVMe 2 TB RAID"),
    ("Resolución / Monitor",  "1920×1080 (FHD)",           "2560×1440 (QHD)",             "3840×2160 (UHD) dual"),
]

# ── Exchange formats ──────────────────────────────────────────────────────────
EXCHANGE_FORMATS = [
    ("Modelos BIM (Open BIM)",    "MOP",  "IFC 4 o equivalente",    "Interoperabilidad y entrega a Adif"),
    ("Modelos BIM (Nativo)",      "MBN",  ".rvt / .dwg",            "Producción y coordinación"),
    ("Modelos Federados",         "MFD",  ".nwd / .nwc (Navisworks)", "Coordinación y reuniones digitales"),
    ("Documentación General",     "—",    ".pdf",                    "Entrega de documentos"),
    ("Datos / Extracciones",      "EDM",  ".xlsx",                   "Tablas de datos y mediciones"),
    ("Nomenclatura",              "—",    "Estándar Codificación Adif", "Nombrado de todos los entregables"),
]

# ── Reference standards ──────────────────────────────────────────────────────
REFERENCE_STANDARDS = [
    "Manual BIM de Adif y Adif-AV (marco documental)",
    "UNE-EN ISO 19650-1:2019 — Gestión de la información a través del ciclo de vida de los activos construidos",
    "UNE-EN ISO 19650-2:2019 — Fase de entrega de activos",
    "UNE-EN ISO 19650-3:2020 — Fase operacional de los activos",
    "UNE-EN ISO 19650-5:2020 — Enfoque de seguridad en la gestión de la información",
    "UNE-EN 17412-1:2021 — Nivel de Información Necesaria",
    "ISO 29481-1:2016 — Manual de entrega de la información - Metodología e Formato",
    "ISO 29481-2:2012 — Marco de interacción",
    "es.BIM — Guías de uso BIM del Comité Técnico de BIM",
    "Comité Técnico de BIM (CBIM) — Documentación de referencia",
    "BIMe Initiative — BIM Excellence Framework",
    "Penn State BEP Guide — BIM Project Execution Planning Guide",
    "AEC UK BIM Technology Protocol",
    "The Uses of BIM 3.0 — Penn State University",
    "buildingSMART International — IFC Standards",
]

# ── ADIF parameter groups ──────────────────────────────────────────────────────
ADIF_PARAMS = [
    ("ADIF_00_Generales",       "ADIF_00_Codigo_Archivo",         "Modelo/Objeto", "Text",    True),
    ("ADIF_00_Generales",       "ADIF_00_Codigo_Producto",        "Objeto",        "Text",    True),
    ("ADIF_00_Generales",       "ADIF_00_Descripcion_Producto",   "Objeto",        "Text",    True),
    ("ADIF_00_Generales",       "ADIF_00_Disciplina",             "Modelo/Objeto", "Text",    True),
    ("ADIF_00_Generales",       "ADIF_00_Id_Objeto",              "Objeto",        "Text",    True),
    ("ADIF_00_Generales",       "ADIF_00_Subdisciplina",          "Objeto",        "Text",    True),
    ("ADIF_02_Localizacion",    "ADIF_02_Codigo_Actuacion",       "Modelo/Objeto", "Text",    True),
    ("ADIF_02_Localizacion",    "ADIF_02_Direccion_Ubicacion",    "Modelo",        "Text",    True),
    ("ADIF_02_Localizacion",    "ADIF_02_Entorno_Actuacion",      "Modelo",        "Text",    True),
    ("ADIF_02_Localizacion",    "ADIF_02_Expediente_Actuacion",   "Modelo",        "Text",    True),
    ("ADIF_02_Localizacion",    "ADIF_02_Km_Fin",                 "Modelo/Objeto", "Text",    True),
    ("ADIF_02_Localizacion",    "ADIF_02_Km_Inicio",              "Modelo/Objeto", "Text",    True),
    ("ADIF_02_Localizacion",    "ADIF_02_Nombre_Actuacion",       "Modelo",        "Text",    True),
    ("ADIF_02_Localizacion",    "ADIF_02_Nombre_Global",          "Modelo",        "Text",    True),
    ("ADIF_02_Localizacion",    "ADIF_02_Sistema_Coordenadas",    "Modelo",        "Text",    True),
    ("ADIF_02_Localizacion",    "ADIF_02_Zonificacion",           "Modelo/Objeto", "Text",    True),
    ("ADIF_03_Coordinacion3D",  "ADIF_03_Codigo_Estado",          "Objeto",        "Text",    True),
    ("ADIF_03_Coordinacion3D",  "ADIF_03_Codigo_Estudio",         "Objeto",        "Text",    True),
    ("ADIF_03_Coordinacion3D",  "ADIF_03_Descripcion_Estado",     "Objeto",        "Text",    True),
    ("ADIF_03_Coordinacion3D",  "ADIF_03_Codigo_Reubicacion",     "Objeto",        "Text",    True),
    ("ADIF_03_Coordinacion3D",  "ADIF_03_Fuente_Comentario",      "Objeto",        "Text",    True),
    ("ADIF_03_Coordinacion3D",  "ADIF_03_Fuente_Definicion",      "Objeto",        "Text",    True),
    ("ADIF_03_Coordinacion3D",  "ADIF_03_Visibilidad_Temporal",   "Objeto",        "Text",    True),
    ("ADIF_04_4D",              "ADIF_04_Codigo_Actividad",       "Objeto",        "Text",    True),
    ("ADIF_04_4D",              "ADIF_04_Fase",                   "Objeto",        "Text",    True),
    ("ADIF_04_4D",              "ADIF_04_Inicio_Actuacion",       "Objeto",        "Date",    True),
    ("ADIF_04_4D",              "ADIF_04_Fin_Actuacion",          "Objeto",        "Date",    True),
    ("ADIF_04_4D",              "ADIF_04_Inicio_Actividad",       "Objeto",        "Date",    True),
    ("ADIF_04_4D",              "ADIF_04_Fin_Actividad",          "Objeto",        "Date",    True),
    ("ADIF_05_5D",              "ADIF_05_Capitulo",               "Objeto",        "Text",    False),
    ("ADIF_05_5D",              "ADIF_05_Partida",                "Objeto",        "Text",    False),
    ("ADIF_05_5D",              "ADIF_05_Unid",                   "Objeto",        "Text",    False),
    ("ADIF_06_6D",              "ADIF_06_Codigo_Especificacion_1","Objeto",        "Text",    False),
    ("ADIF_07_7D",              "ADIF_07_Ejecutado",              "Objeto",        "Text",    False),
    ("ADIF_07_7D",              "ADIF_07_Fecha_Ejecucion",        "Objeto",        "Date",    False),
    ("ADIF_07_7D",              "ADIF_07_Verificado",             "Objeto",        "Text",    False),
    ("ADIF_07_7D",              "ADIF_07_Certificado",            "Objeto",        "Text",    False),
    ("ADIF_08_DocVinculada",    "ADIF_08_Doc1",                   "Objeto",        "Text",    False),
    ("ADIF_08_DocVinculada",    "ADIF_08_Doc2",                   "Objeto",        "Text",    False),
]

# ── CDE states ────────────────────────────────────────────────────────────────
CDE_STATES = [
    ("Trabajo (WIP)",
     "Estado en el que el autor trabaja de forma individual. La información en este estado no ha sido revisada ni aprobada. Solo visible para el equipo de producción.",
     "Entorno del AM / proveedor"),
    ("Compartido",
     "La información ha sido revisada internamente y se comparte con otros agentes para su revisión. Los destinatarios pueden consultarla pero no modificarla directamente.",
     "CDE de Adif (ACC)"),
    ("Publicado",
     "La información ha sido aprobada por todos los agentes relevantes y constituye la versión oficial. Sirve como referencia para los demás participantes.",
     "CDE de Adif (ACC)"),
    ("Archivado",
     "La información ha quedado obsoleta por la publicación de una versión superior. Se conserva para trazabilidad pero no está activa.",
     "CDE de Adif (ACC)"),
]

# ── Naming convention fields ───────────────────────────────────────────────────
NAMING_DOC_FIELDS = [
    ("Expediente", "Código del expediente de la actuación", "XXXXXXXXXXXX", "12"),
    ("Originador", "Empresa originadora del documento", "XXX", "3"),
    ("Tipo de documento", "Código del tipo de documento (PEB, MBN, MOP…)", "XXX", "3"),
    ("Especialidad técnica", "Especialidad técnica del documento", "XX", "2"),
    ("Disciplina", "Disciplina BIM del modelo o documento", "XXX", "3"),
    ("Número de documento", "Número secuencial del documento", "XXXXXX", "6"),
    ("Descripción", "Descripción libre del contenido (sin espacios, guión bajo)", "XXXXXXXXXXXXXXXXXX", "máx. 20"),
]

NAMING_OBJ_FIELDS = [
    ("Disciplina", "XXX", "Abreviatura de 3 caracteres en mayúscula", "ARQ, SUV, ENE, ISA…"),
    ("Categoría", "XXX", "Abreviatura de 3 caracteres en mayúscula", "PUE, TRA, EQU, TUB…"),
    ("Descripción", "Xxxxxx…", "Descripción del elemento (máx. 20 chars)", "aluminio, madera, hormigon…"),
    ("Detalle", "Xxxxxx…", "Detalle diferenciador (dimensión, potencia…)", "2100x820mm, 1200mm, 750kVA…"),
]

NAMING_TIPOL_FIELDS = [
    ("Categoría", "XXX", "Abreviatura de 3 caracteres", "EJE, NIV, ESP, CAP, FAS, MAT…"),
    ("Tipo", "Xxxxxx…", "Nombre del tipo", "CentroVia, ViaActual, SalaReuniones…"),
    ("Detalle", "Xxxxxx…", "Detalle diferenciador", "Curva, Nivel, 3000mm…"),
]

# ── Units ─────────────────────────────────────────────────────────────────────
UNITS_TABLE = [
    ("Longitud",                "Metros (m)",              "1.000,000 m",        "3 decimales"),
    ("Área",                    "Metros cuadrados (m²)",   "1.000,00 m²",        "2 decimales"),
    ("Volumen",                 "Metros cúbicos (m³)",     "1.000,00 m³",        "2 decimales"),
    ("Ángulo",                  "Grados decimales (°)",    "50,20°",             "2 decimales"),
    ("Pendiente",               "Grados decimales (%)",    "1,50%",              "2 decimales"),
    ("Coordenadas cartesianas", "Metros (m)",              "4.473.159,541 m",    "3 decimales"),
]

SCALES_TABLE = ["1:3000", "1:1500", "1:1000", "1:500", "1:250", "1:200", "1:150", "1:100", "1:75", "1:50", "1:25", "1:10"]

# ── Role descriptions ─────────────────────────────────────────────────────────
ROLE_DESCRIPTIONS = {
    "Responsable de contrato ADIF": "Autorizar y supervisar el cumplimiento de los objetivos contractuales en materia BIM. Aprobar las modificaciones sustanciales del PEB y del MIDP.",
    "Responsable BIM ADIF": "Coordinar y supervisar la implementación BIM del contrato. Validar el PEB y sus anexos. Aprobar los entregables BIM en estado Publicado. Presidir las reuniones digitales.",
    "Gestor de la información ADIF": "Administrar el CDE de Adif. Gestionar los permisos de acceso. Verificar el nombrado y estructura de los entregables. Archivar la información obsoleta.",
    "Responsable ATC": "Dirigir y coordinar los trabajos de la Asistencia Técnica. Supervisar la calidad de los entregables BIM de todos los adjudicatarios de modelo.",
    "Responsable BIM ATC": "Coordinar la estrategia BIM de la ATC. Validar los PEB de todos los AMs. Coordinar la federación de modelos entre actuaciones. Presidir las reuniones digitales de coordinación.",
    "Coordinador BIM ATC": "Realizar la detección de interferencias entre actuaciones. Apoyar la validación de los PEB de los AMs. Coordinar la generación del modelo federado de la ATC.",
    "Responsable BIM AM": "Responsable técnico BIM del AM. Aprobar el PEB y los entregables BIM del AM. Supervisar el trabajo del equipo BIM del AM. Reportar a la ATC y a Adif.",
    "Coordinador BIM AM": "Coordinar el trabajo del equipo BIM del AM. Realizar el control de calidad interno. Gestionar el intercambio de información con la ATC. Actualizar el MIDP.",
    "Modelador BIM": "Generar y actualizar los modelos BIM de su disciplina. Incorporar los atributos LOI conforme a la matriz de atributos. Exportar los modelos a formato IFC y nativos.",
}

# ── Reference docs lists ──────────────────────────────────────────────────────
REFERENCIAS_ADIF = [
    "ACM-GEN-IT-1000 — Guía de implementación BIM para el proveedor (Rev. vigente)",
    "ACM-GEN-GA-1008 — Guía CDE para el proveedor",
    "ACM-GEN-GA-1043 — Glosario de términos BIM",
    "ACM-GEN-GA-1060 — Guía de elaboración del PEB",
    "ACM-GEN-GA-1066 — Reglas de modelado",
    "ACM-GEN-GA-1082 — Guía CDE de Adif y Adif-AV",
    "ACM-GEN-GA-1167 — Guía de análisis de PEB",
    "ACM-GEN-GA-1187 — Guía de reuniones digitales",
    "ACM-GEN-GA-1256 — Guía de entrega digital",
    "ACM-GEN-PA-1063 — Plantilla de elaboración del PEB",
    "ACM-GEN-PA-1143 — Plantilla de análisis del PEB",
    "ACM-GEN-PA-1170 — Plantilla MIDP",
    "ACM-GEN-PA-1260 — Plantilla de control de calidad",
    "ACM-GEN-PA-1375 — Plantilla de detección de interferencias",
    "ADIF-IT-104-005-001 — Estándar de codificación",
    "ADIF-IT-104-005-010 — Guía específica Uso de modelo: IFC",
    "ADIF-IT-104-005-011 — Guía específica: Coordinación 3D",
    "ADIF-IT-104-005-012 — Guía específica: Documentación 2D",
    "ADIF-IT-104-005-013 — Guía específica: Simulación 4D",
    "ADIF-IT-104-005-014 — Guía específica: Mediciones 5D",
    "ADIF-IT-104-005-015 — Guía específica: Reuniones digitales",
    "ADIF-IT-104-005-016 — Guía específica: Seguimiento de obra",
    "ADIF-IT-104-005-017 — Guía específica: Levantamiento digital",
    "ADIF-IT-104-005-018 — Guía específica: As-Built",
]
