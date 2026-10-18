"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useProjectStore, useEnsureFileInfoLabels } from "@/stores/projectStore";

const API_URL = "http://127.0.0.1:8020";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TreeNode {
  id: string;
  name: string;
  type: string;
  children?: TreeNode[];
}

interface StructureResponse {
  schema: string;
  element_count: number;
  pset_count: number;
  tree: TreeNode[];
}

interface LocationData {
  contained_in: { type: string; name: string } | null;
  coordinates: { x: string; y: string; z: string } | null;
}

interface ClassificationEntry {
  nombre: string | null;
  fuente: string | null;
  edicion: string | null;
  fecha_edicion: string | null;
  localizacion: string | null;
  referencia: {
    clasificacion: string | null;
    nombre: string | null;
    localizacion: string | null;
  } | null;
}

interface RelationsData {
  type_object: {
    identity: string;
    nombre: string | null;
    guid: string | null;
    psets: string[];
  } | null;
  material: string | null;
  classifications: string[];
  spatial_structure: { type: string; name: string } | null;
}

interface ElementPropsResponse {
  attributes: Record<string, string | null>;
  psets: Record<string, Record<string, unknown>>;
  location: LocationData;
  classification: Record<string, ClassificationEntry>;
  relations: RelationsData;
}

type TabKey = "propiedades" | "localizacion" | "clasificacion" | "relaciones";

// ── Color helpers ─────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  IfcProject: "var(--cyan)",
  IfcSite: "#f0c040",
  IfcBuilding: "var(--magenta)",
  IfcBuildingStorey: "var(--green)",
  IfcRailwayPart: "#a0c8ff",
};

function typeBadgeStyle(type: string): React.CSSProperties {
  const color = TYPE_COLORS[type] ?? "var(--text-muted)";
  return {
    display: "inline-block",
    padding: "1px 6px",
    borderRadius: 4,
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: "0.05em",
    background: `${color}18`,
    border: `1px solid ${color}55`,
    color,
    fontFamily: "JetBrains Mono, monospace",
    flexShrink: 0,
    whiteSpace: "nowrap",
  };
}

// ── Collect initially-expanded nodes ─────────────────────────────────────────

function collectInitialExpanded(
  nodes: TreeNode[],
  maxDepth: number,
  depth = 0
): Set<string> {
  const ids = new Set<string>();
  if (depth >= maxDepth) return ids;
  for (const node of nodes) {
    ids.add(node.id);
    if (node.children?.length) {
      collectInitialExpanded(node.children, maxDepth, depth + 1).forEach((id) =>
        ids.add(id)
      );
    }
  }
  return ids;
}

// ── TreeNodeRow ───────────────────────────────────────────────────────────────

function TreeNodeRow({
  node,
  depth,
  expandedIds,
  selectedId,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  expandedIds: Set<string>;
  selectedId: string | null;
  onToggle: (id: string) => void;
  onSelect: (node: TreeNode) => void;
}) {
  const hasChildren = (node.children?.length ?? 0) > 0;
  const expanded = expandedIds.has(node.id);
  const selected = selectedId === node.id;

  return (
    <>
      <div
        onClick={() => {
          onSelect(node);
          if (hasChildren) onToggle(node.id);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 8px",
          paddingLeft: 8 + depth * 18,
          cursor: "pointer",
          borderRadius: 4,
          background: selected ? "rgba(91,140,255,0.10)" : "transparent",
          border: selected
            ? "1px solid rgba(91,140,255,0.30)"
            : "1px solid transparent",
          marginBottom: 1,
          transition: "background 0.12s",
        }}
        onMouseEnter={(e) => {
          if (!selected)
            (e.currentTarget as HTMLDivElement).style.background =
              "rgba(255,255,255,0.04)";
        }}
        onMouseLeave={(e) => {
          if (!selected)
            (e.currentTarget as HTMLDivElement).style.background = "transparent";
        }}
      >
        <span
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggle(node.id);
          }}
          style={{
            width: 14,
            height: 14,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: hasChildren ? "var(--text-muted)" : "transparent",
            fontSize: 8,
            cursor: hasChildren ? "pointer" : "default",
            flexShrink: 0,
            transition: "transform 0.15s",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
          }}
        >
          ▶
        </span>
        <span style={typeBadgeStyle(node.type)}>{node.type}</span>
        <span
          style={{
            fontSize: 11,
            color: selected ? "var(--cyan)" : "var(--text)",
            fontFamily: "JetBrains Mono, monospace",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {node.name || "(sin nombre)"}
        </span>
      </div>
      {expanded &&
        hasChildren &&
        node.children!.map((child) => (
          <TreeNodeRow
            key={child.id}
            node={child}
            depth={depth + 1}
            expandedIds={expandedIds}
            selectedId={selectedId}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        ))}
    </>
  );
}

// ── Inline-editable row ───────────────────────────────────────────────────────

function PropRow({
  label,
  value,
  editable,
  onSave,
}: {
  label: string;
  value: string | null | undefined;
  editable?: boolean;
  onSave?: (newVal: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = () => {
    setDraft(value ?? "");
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 30);
  };

  const cancel = () => setEditing(false);

  const save = async () => {
    if (!onSave) return;
    setSaving(true);
    try {
      await onSave(draft);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const displayVal = value ?? "—";

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "38% 1fr auto",
        gap: 8,
        padding: "4px 6px",
        borderRadius: 3,
        fontSize: 12,
        alignItems: "center",
      }}
      onMouseEnter={(e) =>
        ((e.currentTarget as HTMLDivElement).style.background =
          "rgba(255,255,255,0.025)")
      }
      onMouseLeave={(e) =>
        ((e.currentTarget as HTMLDivElement).style.background = "transparent")
      }
    >
      <span
        style={{
          color: "var(--text-muted)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: 11,
        }}
      >
        {label}
      </span>

      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") cancel();
          }}
          style={{
            background: "rgba(91,140,255,0.06)",
            border: "1px solid rgba(91,140,255,0.4)",
            borderRadius: 4,
            color: "var(--cyan)",
            fontSize: 12,
            fontFamily: "JetBrains Mono, monospace",
            padding: "2px 6px",
            outline: "none",
            width: "100%",
          }}
        />
      ) : (
        <span
          style={{
            color: value ? "var(--text)" : "var(--text-muted)",
            fontFamily: "JetBrains Mono, monospace",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontStyle: value ? "normal" : "italic",
            fontSize: 12,
          }}
        >
          {displayVal}
        </span>
      )}

      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
        {editing ? (
          <>
            <button
              onClick={save}
              disabled={saving}
              title="Guardar"
              style={btnStyle("var(--green)")}
            >
              {saving ? "…" : "✓"}
            </button>
            <button onClick={cancel} title="Cancelar" style={btnStyle("var(--text-muted)")}>
              ✕
            </button>
          </>
        ) : editable && onSave ? (
          <button
            onClick={startEdit}
            title="Editar"
            style={{ ...btnStyle("var(--text-muted)"), opacity: 0 }}
            className="edit-btn"
          >
            ✎
          </button>
        ) : (
          <span style={{ width: 22 }} />
        )}
      </div>
    </div>
  );
}

function btnStyle(color: string): React.CSSProperties {
  return {
    background: "none",
    border: "none",
    cursor: "pointer",
    color,
    fontSize: 13,
    padding: "0 3px",
    lineHeight: 1,
    borderRadius: 3,
  };
}

// ── Section header ────────────────────────────────────────────────────────────

function SectionHeader({ label, count }: { label: string; count?: number }) {
  return (
    <div
      style={{
        fontSize: 10,
        color: "var(--cyan)",
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        fontWeight: 700,
        padding: "10px 6px 4px",
        borderBottom: "1px solid rgba(91,140,255,0.12)",
        marginBottom: 4,
        display: "flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      {label}
      {count !== undefined && (
        <span
          style={{
            fontSize: 9,
            color: "var(--magenta)",
            fontWeight: 400,
            marginLeft: "auto",
          }}
        >
          {count} props
        </span>
      )}
    </div>
  );
}

// ── Collapsible PSet ──────────────────────────────────────────────────────────

function PSetSection({
  name,
  props,
  onSaveProp,
}: {
  name: string;
  props: Record<string, unknown>;
  onSaveProp: (psetName: string, propName: string, val: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(true);
  const entries = Object.entries(props).filter(([k]) => k !== "id");

  return (
    <div style={{ marginBottom: 8 }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: "pointer",
          padding: "5px 6px",
          borderRadius: 4,
          background: "rgba(122,111,217,0.04)",
          border: "1px solid rgba(122,111,217,0.12)",
          marginBottom: open ? 2 : 0,
        }}
      >
        <span
          style={{
            fontSize: 8,
            color: "var(--text-muted)",
            transition: "transform 0.15s",
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
          }}
        >
          ▶
        </span>
        <span
          style={{
            fontSize: 11,
            color: "var(--magenta)",
            fontFamily: "JetBrains Mono, monospace",
            fontWeight: 600,
          }}
        >
          {name}
        </span>
        <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: "auto" }}>
          {entries.length} props
        </span>
      </div>
      {open && (
        <div style={{ paddingLeft: 4 }}>
          {entries.map(([k, v]) => (
            <PropRow
              key={k}
              label={k}
              value={v != null ? String(v) : null}
              editable
              onSave={(val) => onSaveProp(name, k, val)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Tab: Propiedades ──────────────────────────────────────────────────────────

function TabPropiedades({
  props,
  onSaveAttr,
  onSaveProp,
}: {
  props: ElementPropsResponse;
  onSaveAttr: (attrName: string, val: string) => Promise<void>;
  onSaveProp: (psetName: string, propName: string, val: string) => Promise<void>;
}) {
  const editableAttrs = new Set(["Name", "Description", "ObjectType", "Tag"]);
  return (
    <div>
      <SectionHeader label="Atributos" />
      {Object.entries(props.attributes).map(([k, v]) => (
        <PropRow
          key={k}
          label={k}
          value={v}
          editable={editableAttrs.has(k)}
          onSave={editableAttrs.has(k) ? (val) => onSaveAttr(k, val) : undefined}
        />
      ))}

      {Object.keys(props.psets).length > 0 && (
        <>
          <SectionHeader label="Property Sets" count={Object.keys(props.psets).length} />
          {Object.entries(props.psets).map(([psetName, psetProps]) => (
            <PSetSection
              key={psetName}
              name={psetName}
              props={psetProps as Record<string, unknown>}
              onSaveProp={onSaveProp}
            />
          ))}
        </>
      )}

      {Object.keys(props.psets).length === 0 && (
        <p style={{ color: "var(--text-muted)", fontSize: 12, fontStyle: "italic", padding: "8px 6px" }}>
          Sin Property Sets definidos.
        </p>
      )}
    </div>
  );
}

// ── Tab: Localización ─────────────────────────────────────────────────────────

function TabLocalizacion({ data }: { data: LocationData }) {
  return (
    <div>
      <SectionHeader label="Contenido en" />
      {data.contained_in ? (
        <div style={{ padding: "6px 6px", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={typeBadgeStyle(data.contained_in.type)}>{data.contained_in.type}</span>
          <span style={{ fontSize: 12, fontFamily: "JetBrains Mono, monospace", color: "var(--text)" }}>
            {data.contained_in.name}
          </span>
        </div>
      ) : (
        <p style={{ color: "var(--text-muted)", fontSize: 12, fontStyle: "italic", padding: "6px 6px" }}>
          Sin contenedor espacial.
        </p>
      )}

      <SectionHeader label="Coordenadas (Locales)" />
      {data.coordinates ? (
        <>
          <PropRow label="x" value={data.coordinates.x} />
          <PropRow label="y" value={data.coordinates.y} />
          <PropRow label="z" value={data.coordinates.z} />
        </>
      ) : (
        <p style={{ color: "var(--text-muted)", fontSize: 12, fontStyle: "italic", padding: "6px 6px" }}>
          Sin datos de posición.
        </p>
      )}
    </div>
  );
}

// ── Tab: Clasificación ────────────────────────────────────────────────────────

function TabClasificacion({ data }: { data: Record<string, ClassificationEntry> }) {
  const entries = Object.entries(data);

  if (entries.length === 0) {
    return (
      <p style={{ color: "var(--text-muted)", fontSize: 12, fontStyle: "italic", padding: "12px 6px" }}>
        Sin clasificaciones asignadas.
      </p>
    );
  }

  return (
    <div>
      {entries.map(([key, cls]) => (
        <div key={key} style={{ marginBottom: 16 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "#f0c040",
              padding: "8px 6px 4px",
              borderBottom: "1px solid rgba(240,192,64,0.2)",
              marginBottom: 4,
            }}
          >
            {key}
          </div>
          <PropRow label="Nombre" value={cls.nombre} />
          <PropRow label="Fuente" value={cls.fuente} />
          <PropRow label="Edición" value={cls.edicion} />
          <PropRow label="Fecha edición" value={cls.fecha_edicion} />
          <PropRow label="Localización" value={cls.localizacion} />

          {cls.referencia && (
            <>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "var(--text-muted)",
                  padding: "8px 6px 4px",
                  borderBottom: "1px solid var(--border)",
                  marginBottom: 4,
                  marginTop: 4,
                }}
              >
                Referencia
              </div>
              <PropRow label="Clasificación" value={cls.referencia.clasificacion} />
              <PropRow label="Nombre" value={cls.referencia.nombre} />
              <PropRow label="Localización" value={cls.referencia.localizacion} />
            </>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Tab: Relaciones ───────────────────────────────────────────────────────────

function TabRelaciones({ data }: { data: RelationsData }) {
  return (
    <div>
      <SectionHeader label="Tipo de Objeto" />
      {data.type_object ? (
        <>
          <PropRow label="IfcIdentity" value={data.type_object.identity} />
          <PropRow label="Nombre" value={data.type_object.nombre} />
          <PropRow label="GUID" value={data.type_object.guid} />
        </>
      ) : (
        <p style={{ color: "var(--text-muted)", fontSize: 12, fontStyle: "italic", padding: "4px 6px" }}>
          Sin tipo de objeto.
        </p>
      )}

      <SectionHeader label="Material" />
      {data.material ? (
        <PropRow label="Nombre" value={data.material} />
      ) : (
        <p style={{ color: "var(--text-muted)", fontSize: 12, fontStyle: "italic", padding: "4px 6px" }}>
          Sin material asignado.
        </p>
      )}

      {data.type_object?.psets && data.type_object.psets.length > 0 && (
        <>
          <SectionHeader label="Property Sets Vinculados" count={data.type_object.psets.length} />
          {data.type_object.psets.map((ps) => (
            <div
              key={ps}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "3px 6px",
                fontSize: 12,
              }}
            >
              <span
                style={{
                  fontSize: 9,
                  color: "var(--text-muted)",
                  flexShrink: 0,
                }}
              >
                Pset
              </span>
              <span
                style={{
                  fontFamily: "JetBrains Mono, monospace",
                  fontSize: 11,
                  color: "var(--text)",
                }}
              >
                {ps}
              </span>
            </div>
          ))}
        </>
      )}

      {data.classifications.length > 0 && (
        <>
          <SectionHeader label="Clasificaciones" count={data.classifications.length} />
          {data.classifications.map((c) => (
            <div
              key={c}
              style={{
                padding: "3px 6px",
                fontSize: 12,
                fontFamily: "JetBrains Mono, monospace",
                color: "#f0c040",
              }}
            >
              {c}
            </div>
          ))}
        </>
      )}

      <SectionHeader label="Estructura Espacial" />
      {data.spatial_structure ? (
        <div style={{ padding: "6px 6px", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={typeBadgeStyle(data.spatial_structure.type)}>
            {data.spatial_structure.type}
          </span>
          <span
            style={{
              fontSize: 12,
              fontFamily: "JetBrains Mono, monospace",
              color: "var(--text)",
            }}
          >
            {data.spatial_structure.name}
          </span>
        </div>
      ) : (
        <p
          style={{
            color: "var(--text-muted)",
            fontSize: 12,
            fontStyle: "italic",
            padding: "4px 6px",
          }}
        >
          Sin estructura espacial.
        </p>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function IFCStructurePage() {
  const { files, selectedPaths } = useProjectStore();
  const { ensureLoaded } = useEnsureFileInfoLabels("http://127.0.0.1:8020");

  // Only the files that are checked in the selection tree — memoized so its
  // reference only changes when the selection itself changes. Without this,
  // any local state update (e.g. clicking a tree node) re-renders the page,
  // `.filter()` returns a brand-new array every time, and the load-structure
  // effect below (keyed on this array) sees a "changed" dependency and refires
  // — re-fetching the whole tree from the backend and resetting every node
  // back to its default collapsed state. That's what made expanding a node
  // look like it "opened for a second then closed itself".
  const activeFiles = useMemo(
    () => files.filter(f => selectedPaths.includes(f.path)),
    [files, selectedPaths]
  );

  // Load ALL selected files' structures simultaneously
  const [structureDataByPath, setStructureDataByPath] = useState<Record<string, StructureResponse>>({});
  const [expandedIdsByPath, setExpandedIdsByPath] = useState<Record<string, Set<string>>>({});
  const [expandedFilesByPath, setExpandedFilesByPath] = useState<Set<string>>(new Set());
  const [selectedNode, setSelectedNode] = useState<{ path: string; node: TreeNode } | null>(null);
  const [elementProps, setElementProps] = useState<ElementPropsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingProps, setLoadingProps] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("propiedades");
  const [saveError, setSaveError] = useState<string | null>(null);

  // Load all structures when activeFiles changes
  useEffect(() => {
    if (activeFiles.length === 0) {
      setStructureDataByPath({});
      setExpandedIdsByPath({});
      setSelectedNode(null);
      setElementProps(null);
      return;
    }

    setLoading(true);
    const loadAll = async () => {
      const results: Record<string, StructureResponse> = {};
      const expandedMap: Record<string, Set<string>> = {};

      await Promise.all(
        activeFiles.map(async (f) => {
          try {
            const res = await fetch(
              `${API_URL}/api/ifc/structure?path=${encodeURIComponent(f.path)}`,
              { signal: AbortSignal.timeout(60000) }
            );
            if (res.ok) {
              const data: StructureResponse = await res.json();
              results[f.path] = data;
              expandedMap[f.path] = collectInitialExpanded(data.tree, 2);
            }
          } catch {
            /* skip failed files */
          }
        })
      );

      setStructureDataByPath(results);
      setExpandedIdsByPath(expandedMap);
      // Auto-expand all files
      setExpandedFilesByPath(new Set(activeFiles.map(f => f.path)));
    };

    loadAll().finally(() => setLoading(false));
  }, [activeFiles]);

  // Cargar badges (origin + schema) del sidebar si faltan
  useEffect(() => {
    if (files.length > 0) {
      ensureLoaded();
    }
  }, [files.length, ensureLoaded]);

  const handleToggleFile = useCallback((path: string) => {
    setExpandedFilesByPath((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }, []);

  const handleToggle = useCallback((path: string, id: string) => {
    setExpandedIdsByPath((prev) => {
      const current = prev[path] ?? new Set<string>();
      const newSet = new Set(current);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return { ...prev, [path]: newSet };
    });
  }, []);

  async function handleSelect(path: string, node: TreeNode) {
    setSelectedNode({ path, node });
    setElementProps(null);
    setLoadingProps(true);
    setActiveTab("propiedades");
    setSaveError(null);
    try {
      const res = await fetch(
        `${API_URL}/api/ifc/element-properties?path=${encodeURIComponent(path)}&global_id=${encodeURIComponent(node.id)}`,
        { signal: AbortSignal.timeout(20000) }
      );
      if (res.ok) setElementProps(await res.json());
    } catch {
      /* silent */
    } finally {
      setLoadingProps(false);
    }
  }

  async function handleSaveAttr(attrName: string, value: string) {
    if (!selectedNode) return;
    setSaveError(null);
    const res = await fetch(`${API_URL}/api/ifc/update-property`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: selectedNode.path,
        global_id: selectedNode.node.id,
        pset_name: "__attr__",
        prop_name: attrName,
        value,
      }),
    });
    if (!res.ok) {
      setSaveError(`No se pudo guardar: ${await res.text()}`);
      throw new Error("save failed");
    }
    const r2 = await fetch(
      `${API_URL}/api/ifc/element-properties?path=${encodeURIComponent(selectedNode.path)}&global_id=${encodeURIComponent(selectedNode.node.id)}`
    );
    if (r2.ok) setElementProps(await r2.json());
  }

  async function handleSaveProp(psetName: string, propName: string, value: string) {
    if (!selectedNode) return;
    setSaveError(null);
    const res = await fetch(`${API_URL}/api/ifc/update-property`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: selectedNode.path,
        global_id: selectedNode.node.id,
        pset_name: psetName,
        prop_name: propName,
        value,
      }),
    });
    if (!res.ok) {
      setSaveError(`No se pudo guardar: ${await res.text()}`);
      throw new Error("save failed");
    }
    const r2 = await fetch(
      `${API_URL}/api/ifc/element-properties?path=${encodeURIComponent(selectedNode.path)}&global_id=${encodeURIComponent(selectedNode.node.id)}`
    );
    if (r2.ok) setElementProps(await r2.json());
  }

  const TABS: { key: TabKey; label: string }[] = [
    { key: "propiedades", label: "Propiedades" },
    { key: "localizacion", label: "Localización" },
    { key: "clasificacion", label: "Clasificación" },
    { key: "relaciones", label: "Relaciones" },
  ];

  // ── Empty state ───────────────────────────────────────────────────────────
  if (activeFiles.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <PageTitle />
        <div
          className="card-cyber"
          style={{ padding: 48, textAlign: "center", color: "var(--text-muted)", fontSize: 13, marginTop: 24 }}
        >
          <div style={{ fontSize: 32, marginBottom: 10, opacity: 0.4 }}>⬡</div>
          {files.length === 0 ? (
            <>No hay archivos IFC cargados. Ve a{" "}
            <a href="/models" style={{ color: "var(--cyan)" }}>
              Models
            </a>{" "}
            para añadir una fuente.</>
          ) : (
            "Selecciona archivos en el árbol de selección para explorar su estructura."
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* ── Header ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginBottom: 14,
          flexWrap: "wrap",
        }}
      >
        <PageTitle />

        {loading && (
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              color: "var(--cyan)",
            }}
          >
            <Spinner />
            Cargando estructura…
          </div>
        )}
      </div>

      {saveError && (
        <div
          style={{
            background: "rgba(255,51,85,0.08)",
            border: "1px solid rgba(255,51,85,0.4)",
            borderRadius: 6,
            padding: "8px 14px",
            marginBottom: 12,
            fontSize: 12,
            color: "var(--red, #ff3355)",
          }}
        >
          ✗ {saveError}
        </div>
      )}

      {/* ── Main panels ── */}
      {Object.keys(structureDataByPath).length > 0 ? (
        <div style={{ display: "flex", gap: 12, flex: 1, minHeight: 0 }}>
          {/* Left: Trees (one per file) */}
          <div
            className="card-cyber"
            style={{
              width: "38%",
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              height: "calc(100vh - 180px)",
              overflow: "hidden",
            }}
          >
            <PanelHeader label="Estructuras Espaciales" badge={activeFiles.length} />
            <div style={{ flex: 1, overflowY: "auto", padding: "6px 6px" }}>
              {activeFiles.map((file) => {
                const structData = structureDataByPath[file.path];
                if (!structData) return null;
                const isExpanded = expandedFilesByPath.has(file.path);
                return (
                  <div key={file.path} style={{ marginBottom: 8 }}>
                    {/* File header (collapsible) */}
                    <div
                      onClick={() => handleToggleFile(file.path)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "6px 8px",
                        borderRadius: 4,
                        background: "rgba(91,140,255,0.06)",
                        border: "1px solid rgba(91,140,255,0.2)",
                        cursor: "pointer",
                        marginBottom: 4,
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(91,140,255,0.12)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(91,140,255,0.06)")}
                    >
                      <span style={{
                        display: "inline-block",
                        width: 8,
                        height: 8,
                        borderRadius: 1,
                        border: "1px solid var(--cyan)",
                        transform: isExpanded ? "rotate(90deg)" : "none",
                        transition: "transform 0.15s",
                      }} />
                      <span style={{
                        fontSize: 10,
                        fontWeight: 600,
                        color: "var(--cyan)",
                        fontFamily: "JetBrains Mono, monospace",
                        flex: 1,
                      }}>
                        {file.filename}
                      </span>
                      <span style={{
                        fontSize: 9,
                        color: "rgba(91,140,255,0.6)",
                        marginLeft: "auto",
                      }}>
                        {structData.element_count} elem
                      </span>
                    </div>

                    {/* Tree nodes (collapsible) */}
                    {isExpanded && (
                      <div style={{ paddingLeft: 4 }}>
                        {structData.tree.map((node) => (
                          <TreeNodeRow
                            key={node.id}
                            node={node}
                            depth={0}
                            expandedIds={expandedIdsByPath[file.path] ?? new Set()}
                            selectedId={selectedNode?.path === file.path ? selectedNode.node.id : null}
                            onToggle={(id) => handleToggle(file.path, id)}
                            onSelect={(n) => handleSelect(file.path, n)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right: Properties */}
          <div
            className="card-cyber"
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              height: "calc(100vh - 180px)",
              overflow: "hidden",
            }}
          >
            {/* Properties header */}
            <div
              style={{
                padding: "8px 14px",
                borderBottom: "1px solid var(--border)",
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.07em",
                }}
              >
                Propiedades
              </span>
              {selectedNode && (
                <>
                  <span style={{ color: "var(--border)" }}>|</span>
                  <span
                    style={{
                      fontSize: 11,
                      fontFamily: "JetBrains Mono, monospace",
                      color: "var(--text)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: 220,
                    }}
                  >
                    {selectedNode.node.name || "(sin nombre)"}
                  </span>
                  <span style={typeBadgeStyle(selectedNode.node.type)}>{selectedNode.node.type}</span>
                </>
              )}
              {loadingProps && <Spinner style={{ marginLeft: "auto" }} />}
            </div>

            {/* Tabs */}
            {selectedNode && !loadingProps && elementProps && (
              <div
                style={{
                  display: "flex",
                  borderBottom: "1px solid var(--border)",
                  flexShrink: 0,
                }}
              >
                {TABS.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => setActiveTab(t.key)}
                    style={{
                      background: "none",
                      border: "none",
                      borderBottom: activeTab === t.key
                        ? "2px solid var(--cyan)"
                        : "2px solid transparent",
                      color: activeTab === t.key ? "var(--cyan)" : "var(--text-muted)",
                      fontSize: 11,
                      fontWeight: activeTab === t.key ? 600 : 400,
                      padding: "7px 14px",
                      cursor: "pointer",
                      letterSpacing: "0.04em",
                      transition: "color 0.12s, border-color 0.12s",
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}

            {/* Save error */}
            {saveError && (
              <div
                style={{
                  background: "rgba(255,51,85,0.08)",
                  border: "1px solid rgba(255,51,85,0.3)",
                  borderRadius: 4,
                  margin: "6px 10px 0",
                  padding: "5px 10px",
                  fontSize: 11,
                  color: "var(--red, #ff3355)",
                  flexShrink: 0,
                }}
              >
                ✗ {saveError}
              </div>
            )}

            {/* Tab content */}
            <div style={{ flex: 1, overflowY: "auto", padding: "8px 10px" }}>
              {!selectedNode && (
                <div
                  style={{
                    height: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--text-muted)",
                    fontSize: 13,
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <span style={{ fontSize: 28, opacity: 0.35 }}>👆</span>
                  Selecciona un elemento en el árbol
                </div>
              )}

              {selectedNode && loadingProps && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    height: 80,
                    gap: 8,
                    fontSize: 12,
                    color: "var(--text-muted)",
                  }}
                >
                  <Spinner />
                  Cargando propiedades…
                </div>
              )}

              {selectedNode && !loadingProps && !elementProps && (
                <p
                  style={{
                    color: "var(--text-muted)",
                    fontSize: 12,
                    fontStyle: "italic",
                    padding: "12px 6px",
                  }}
                >
                  No se pudieron cargar las propiedades de este elemento.
                </p>
              )}

              {selectedNode && !loadingProps && elementProps && (
                <>
                  {activeTab === "propiedades" && (
                    <TabPropiedades
                      props={elementProps}
                      onSaveAttr={handleSaveAttr}
                      onSaveProp={handleSaveProp}
                    />
                  )}
                  {activeTab === "localizacion" && (
                    <TabLocalizacion data={elementProps.location} />
                  )}
                  {activeTab === "clasificacion" && (
                    <TabClasificacion data={elementProps.classification} />
                  )}
                  {activeTab === "relaciones" && (
                    <TabRelaciones data={elementProps.relations} />
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      ) : (
        !loading &&
        !saveError && (
          <div
            className="card-cyber"
            style={{
              padding: 48,
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: 13,
              flex: 1,
            }}
          >
            <div style={{ fontSize: 32, marginBottom: 10, opacity: 0.5 }}>🌳</div>
            Selecciona un archivo IFC para ver su jerarquía espacial.
          </div>
        )
      )}

      {/* Hover-reveal edit buttons */}
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        div:hover .edit-btn { opacity: 0.45 !important; }
        .edit-btn:hover { opacity: 1 !important; color: var(--cyan) !important; }
      `}</style>
    </div>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function PageTitle() {
  return (
    <div>
      <h1
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: "var(--cyan)",
          letterSpacing: "0.06em",
          margin: 0,
        }}
      >
        IFC STRUCTURE
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 2 }}>
        Jerarquía espacial — Proyecto → Sitio → Edificio → Planta → Elementos
      </p>
    </div>
  );
}

function PanelHeader({ label, badge }: { label: string; badge?: number }) {
  return (
    <div
      style={{
        padding: "8px 12px",
        borderBottom: "1px solid var(--border)",
        fontSize: 10,
        color: "var(--text-muted)",
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        flexShrink: 0,
        fontWeight: 600,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <span>{label}</span>
      {badge !== undefined && (
        <span style={{
          fontSize: 9,
          background: "rgba(91,140,255,0.15)",
          color: "var(--cyan)",
          padding: "2px 6px",
          borderRadius: 3,
          fontWeight: 700,
        }}>
          {badge}
        </span>
      )}
    </div>
  );
}

function StatBadge({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
      {label}:{" "}
      <span style={{ color, fontWeight: 600, fontFamily: "JetBrains Mono, monospace" }}>
        {value}
      </span>
    </span>
  );
}

function Spinner({ style }: { style?: React.CSSProperties }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        border: "2px solid var(--cyan)",
        borderTopColor: "transparent",
        borderRadius: "50%",
        animation: "spin 0.7s linear infinite",
        flexShrink: 0,
        ...style,
      }}
    />
  );
}
