"use client";

/**
 * IFC TREE — dynamic, lazily-loaded hierarchy explorer.
 *
 * Unlike /ifc-structure (which fetches the FULL tree — one JSON node per
 * element — in a single request), this page never asks the backend for more
 * than one node's worth of children at a time:
 *   - /api/ifc/tree/root      → spatial skeleton only (Project/Site/Building/
 *                                Storey…), always small, fetched once.
 *   - /api/ifc/tree/children  → direct elements of ONE spatial node. If there
 *                                are few, they come back as leaves. If there
 *                                are many, the backend groups them by IFC
 *                                class (counts only) instead of listing every
 *                                element — a group only turns into a real
 *                                list, paginated, once the user opens it.
 *
 * That's what keeps this responsive on a model with tens of thousands of
 * elements: nothing renders (or is even asked for) until it's expanded.
 */

import { useState, useCallback, useEffect } from "react";
import { useProjectStore } from "@/stores/projectStore";
import { IFCFileSelector } from "@/components/domain/IFCFileSelector";

const API = "http://127.0.0.1:8020";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SkeletonNode {
  id: string;
  name: string;
  type: string;
  element_count: number;
  children: SkeletonNode[];
}

interface LeafItem { id: string; name: string; type: string; }

interface LeavesResponse {
  mode: "leaves";
  items: LeafItem[];
  total: number;
  offset?: number;
  limit?: number;
  has_more?: boolean;
}

interface GroupsResponse {
  mode: "groups";
  groups: { type: string; count: number }[];
  total: number;
}

type ChildrenResponse = LeavesResponse | GroupsResponse;

interface ElementDetail {
  attributes: Record<string, string | null>;
  psets: Record<string, Record<string, unknown>>;
}

// ── Colors ────────────────────────────────────────────────────────────────────

const SPATIAL_COLORS: Record<string, string> = {
  IfcProject: "var(--cyan)",
  IfcSite: "#D9A441",
  IfcBuilding: "var(--magenta)",
  IfcBuildingStorey: "var(--green)",
};

const TYPE_PALETTE = [
  "#5B8CFF", "#7A6FD9", "#3FBE8A", "#D9A441", "#E2685C",
  "#4FA8C9", "#B0762E", "#5FA8D3", "#8C6FE0", "#3F9E6B",
];

function colorForType(type: string): string {
  if (SPATIAL_COLORS[type]) return SPATIAL_COLORS[type];
  let hash = 0;
  for (let i = 0; i < type.length; i++) hash = (hash * 31 + type.charCodeAt(i)) >>> 0;
  return TYPE_PALETTE[hash % TYPE_PALETTE.length];
}

function TypeBadge({ type }: { type: string }) {
  const color = colorForType(type);
  return (
    <span style={{
      display: "inline-block", padding: "1px 6px", borderRadius: 4,
      fontSize: 9.5, fontWeight: 600, letterSpacing: "0.03em",
      background: `${color}18`, border: `1px solid ${color}55`, color,
      fontFamily: "var(--font-plex-mono), monospace", flexShrink: 0, whiteSpace: "nowrap",
    }}>
      {type.replace(/^Ifc/, "")}
    </span>
  );
}

function CountBadge({ n }: { n: number }) {
  return (
    <span style={{
      fontSize: 9.5, color: "var(--text-muted)", fontFamily: "var(--font-plex-mono), monospace",
      background: "var(--surface-2)", border: "1px solid var(--border)",
      borderRadius: 4, padding: "1px 6px", flexShrink: 0, marginLeft: "auto",
    }}>
      {n.toLocaleString("es-ES")}
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span style={{
      display: "inline-flex", width: 12, height: 12, flexShrink: 0,
      color: "var(--text-muted)", transition: "transform 0.12s ease",
      transform: open ? "rotate(90deg)" : "none",
    }}>
      <svg width="12" height="12" viewBox="0 0 12 12"><path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </span>
  );
}

function Spinner() {
  return (
    <span style={{
      display: "inline-block", width: 9, height: 9, border: "2px solid var(--cyan)",
      borderTopColor: "transparent", borderRadius: "50%",
      animation: "spin 0.7s linear infinite", flexShrink: 0,
    }} />
  );
}

const ROW: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 6, padding: "3px 6px",
  borderRadius: 4, cursor: "pointer", fontSize: 11.5, minWidth: 0,
};

function Name({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      color: "var(--text)", fontFamily: "var(--font-plex-mono), monospace",
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0,
    }}>
      {children}
    </span>
  );
}

// ── Leaf row (clickable element, fetches properties on click) ──────────────────

function LeafRow({ item, depth, selected, onSelect }: {
  item: LeafItem; depth: number; selected: boolean; onSelect: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      style={{
        ...ROW, paddingLeft: 6 + depth * 16,
        background: selected ? "color-mix(in srgb, var(--cyan) 10%, transparent)" : "transparent",
      }}
      onMouseEnter={e => { if (!selected) (e.currentTarget as HTMLElement).style.background = "var(--surface-2)"; }}
      onMouseLeave={e => { if (!selected) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
    >
      <span style={{ width: 12, flexShrink: 0 }} />
      <TypeBadge type={item.type} />
      <Name>{item.name}</Name>
    </div>
  );
}

// ── Group bucket (opened lazily, paginated) ─────────────────────────────────────

function GroupNode({ path, nodeId, group, depth, selectedId, onSelectLeaf }: {
  path: string; nodeId: string; group: { type: string; count: number }; depth: number;
  selectedId: string | null; onSelectLeaf: (item: LeafItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<LeafItem[]>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const loadPage = useCallback(async (offset: number) => {
    setLoading(true);
    try {
      const res = await fetch(
        `${API}/api/ifc/tree/children?path=${encodeURIComponent(path)}&node_id=${encodeURIComponent(nodeId)}` +
        `&group=${encodeURIComponent(group.type)}&offset=${offset}&limit=100`,
        { signal: AbortSignal.timeout(20000) }
      );
      if (res.ok) {
        const data: LeavesResponse = await res.json();
        setItems(prev => (offset === 0 ? data.items : [...prev, ...data.items]));
        setHasMore(!!data.has_more);
      }
    } catch { /* silent — a failed page just shows nothing new, tree stays usable */ }
    setLoading(false);
    setLoadedOnce(true);
  }, [path, nodeId, group.type]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !loadedOnce) await loadPage(0);
  }

  return (
    <div>
      <div
        onClick={toggle}
        style={{ ...ROW, paddingLeft: 6 + depth * 16 }}
        onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "var(--surface-2)"}
        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"}
      >
        <Chevron open={open} />
        <TypeBadge type={group.type} />
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>(agrupado)</span>
        <CountBadge n={group.count} />
      </div>
      {open && (
        <div>
          {items.map(it => (
            <LeafRow key={it.id} item={it} depth={depth + 1} selected={selectedId === it.id}
              onSelect={() => onSelectLeaf(it)} />
          ))}
          {loading && (
            <div style={{ ...ROW, paddingLeft: 6 + (depth + 1) * 16, cursor: "default" }}>
              <Spinner /> <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}>Cargando…</span>
            </div>
          )}
          {!loading && hasMore && (
            <button
              onClick={() => loadPage(items.length)}
              style={{
                ...ROW, paddingLeft: 6 + (depth + 1) * 16, background: "none", border: "none",
                color: "var(--cyan)", fontSize: 10.5, fontFamily: "var(--font-plex-mono), monospace",
                width: "100%", textAlign: "left",
              }}
            >
              ↓ Cargar más ({(group.count - items.length).toLocaleString("es-ES")} restantes)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Children of a spatial node: either leaves or class groups ──────────────────

function ChildrenView({ path, nodeId, data, depth, selectedId, onSelectLeaf }: {
  path: string; nodeId: string; data: ChildrenResponse; depth: number;
  selectedId: string | null; onSelectLeaf: (item: LeafItem) => void;
}) {
  if (data.mode === "leaves") {
    return (
      <>
        {data.items.map(it => (
          <LeafRow key={it.id} item={it} depth={depth} selected={selectedId === it.id}
            onSelect={() => onSelectLeaf(it)} />
        ))}
      </>
    );
  }
  return (
    <>
      {data.groups.map(g => (
        <GroupNode key={g.type} path={path} nodeId={nodeId} group={g} depth={depth}
          selectedId={selectedId} onSelectLeaf={onSelectLeaf} />
      ))}
    </>
  );
}

// ── Spatial node (Project/Site/Building/Storey — always few, so its own tree
// structure is rendered eagerly; only ITS elements are lazy) ───────────────────

function SpatialNode({ path, node, depth, selectedId, onSelectLeaf }: {
  path: string; node: SkeletonNode; depth: number;
  selectedId: string | null; onSelectLeaf: (item: LeafItem) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const [childrenData, setChildrenData] = useState<ChildrenResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const expandable = node.children.length > 0 || node.element_count > 0;

  async function toggle() {
    if (!expandable) return;
    const next = !open;
    setOpen(next);
    if (next && node.element_count > 0 && childrenData === null) {
      setLoading(true);
      try {
        const res = await fetch(
          `${API}/api/ifc/tree/children?path=${encodeURIComponent(path)}&node_id=${encodeURIComponent(node.id)}`,
          { signal: AbortSignal.timeout(20000) }
        );
        if (res.ok) setChildrenData(await res.json());
      } catch { /* silent */ }
      setLoading(false);
    }
  }

  return (
    <div>
      <div
        onClick={toggle}
        style={{ ...ROW, paddingLeft: 6 + depth * 16, cursor: expandable ? "pointer" : "default" }}
        onMouseEnter={e => { if (expandable) (e.currentTarget as HTMLElement).style.background = "var(--surface-2)"; }}
        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"}
      >
        {expandable ? <Chevron open={open} /> : <span style={{ width: 12, flexShrink: 0 }} />}
        <TypeBadge type={node.type} />
        <Name>{node.name}</Name>
        {node.element_count > 0 && <CountBadge n={node.element_count} />}
      </div>
      {open && (
        <div>
          {node.children.map(c => (
            <SpatialNode key={c.id} path={path} node={c} depth={depth + 1}
              selectedId={selectedId} onSelectLeaf={onSelectLeaf} />
          ))}
          {loading && (
            <div style={{ ...ROW, paddingLeft: 6 + (depth + 1) * 16, cursor: "default" }}>
              <Spinner /> <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}>Cargando…</span>
            </div>
          )}
          {childrenData && (
            <ChildrenView path={path} nodeId={node.id} data={childrenData} depth={depth + 1}
              selectedId={selectedId} onSelectLeaf={onSelectLeaf} />
          )}
        </div>
      )}
    </div>
  );
}

// ── Detail panel: properties of the selected leaf element ──────────────────────

function DetailPanel({ path, item, onClose }: { path: string; item: LeafItem; onClose: () => void }) {
  const [detail, setDetail] = useState<ElementDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    fetch(`${API}/api/ifc/element-properties?path=${encodeURIComponent(path)}&global_id=${encodeURIComponent(item.id)}`,
      { signal: AbortSignal.timeout(20000) })
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (!cancelled) setDetail(data); })
      .catch(() => { /* silent */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path, item.id]);

  return (
    <div className="card-cyber" style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
        <TypeBadge type={item.type} />
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-bright)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
          {item.name}
        </span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 2 }}>
          ✕
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {loading && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)", fontSize: 11.5 }}>
            <Spinner /> Cargando propiedades…
          </div>
        )}
        {!loading && !detail && (
          <div style={{ color: "var(--text-muted)", fontSize: 11.5, fontStyle: "italic" }}>No se pudieron cargar las propiedades.</div>
        )}
        {detail && (
          <>
            <div style={{ fontSize: 9.5, color: "var(--text-muted)", fontWeight: 700, letterSpacing: "0.08em", marginBottom: 6 }}>
              ATRIBUTOS
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 16 }}>
              {Object.entries(detail.attributes).map(([k, v]) => (
                <div key={k} style={{ display: "flex", gap: 10 }}>
                  <span style={{ fontSize: 10.5, color: "var(--text-muted)", fontFamily: "var(--font-plex-mono), monospace", width: 90, flexShrink: 0 }}>{k}</span>
                  <span style={{ fontSize: 10.5, color: "var(--text)", fontFamily: "var(--font-plex-mono), monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {v ?? "—"}
                  </span>
                </div>
              ))}
            </div>

            <div style={{ fontSize: 9.5, color: "var(--text-muted)", fontWeight: 700, letterSpacing: "0.08em", marginBottom: 6 }}>
              PROPERTY SETS ({Object.keys(detail.psets).length})
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {Object.entries(detail.psets).map(([psetName, props]) => (
                <div key={psetName}>
                  <div style={{ fontSize: 10.5, color: "var(--magenta)", fontWeight: 600, marginBottom: 3 }}>{psetName}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    {Object.entries(props).map(([k, v]) => (
                      <div key={k} style={{ display: "flex", gap: 10 }}>
                        <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-plex-mono), monospace", width: 90, flexShrink: 0 }}>{k}</span>
                        <span style={{ fontSize: 10, color: "var(--text)", fontFamily: "var(--font-plex-mono), monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {String(v ?? "—")}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Page title ───────────────────────────────────────────────────────────────

function PageTitle() {
  return (
    <div>
      <h1 style={{ fontSize: 18, fontWeight: 700, color: "var(--cyan)", letterSpacing: "0.06em", margin: 0 }}>
        TREE
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 2 }}>
        Árbol dinámico con carga perezosa — cada nodo pide sus hijos solo al abrirse, y las ramas con muchos
        elementos se agrupan por tipo en vez de listarse una por una
      </p>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function IFCTreePage() {
  const { files } = useProjectStore();
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [root, setRoot] = useState<SkeletonNode[] | null>(null);
  const [loadingRoot, setLoadingRoot] = useState(false);
  const [selectedLeaf, setSelectedLeaf] = useState<LeafItem | null>(null);

  const handlePick = useCallback(async (path: string) => {
    setSelectedPath(path);
    setSelectedLeaf(null);
    setRoot(null);
    setLoadingRoot(true);
    try {
      const res = await fetch(`${API}/api/ifc/tree/root?path=${encodeURIComponent(path)}`,
        { signal: AbortSignal.timeout(30000) });
      if (res.ok) {
        const data = await res.json();
        setRoot(data.tree);
      }
    } catch { /* silent */ }
    setLoadingRoot(false);
  }, []);

  if (files.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <PageTitle />
        <div className="card-cyber" style={{ padding: 48, textAlign: "center", color: "var(--text-muted)", fontSize: 13, marginTop: 20 }}>
          <div style={{ fontSize: 32, opacity: 0.3, marginBottom: 10 }}>⬡</div>
          Sin archivos IFC. Ve a{" "}
          <a href="/models" style={{ color: "var(--cyan)" }}>Models</a>{" "}
          para añadir una fuente.
        </div>
      </div>
    );
  }

  const PANEL_H = "calc(100vh - 160px)";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 0 }}>
      <div style={{ marginBottom: 14 }}>
        <PageTitle />
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: selectedLeaf ? "220px 1fr 340px" : "220px 1fr",
        gap: 10, flex: 1, minHeight: 0, transition: "grid-template-columns 0.15s",
      }}>
        {/* ── File selector ── */}
        <div className="card-cyber" style={{ display: "flex", flexDirection: "column", height: PANEL_H, overflow: "hidden" }}>
          <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", fontSize: 10, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.08em" }}>
            MODELO
          </div>
          <div style={{ padding: 8, overflowY: "auto", flex: 1 }}>
            <IFCFileSelector mode="single" selectedPath={selectedPath} onSelectionChange={handlePick} />
          </div>
        </div>

        {/* ── Tree ── */}
        <div className="card-cyber" style={{ display: "flex", flexDirection: "column", height: PANEL_H, overflow: "hidden" }}>
          <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", fontSize: 10, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.08em" }}>
            JERARQUÍA ESPACIAL
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "8px 6px" }}>
            {!selectedPath && (
              <div style={{ color: "var(--text-muted)", fontSize: 11.5, fontStyle: "italic", padding: 12 }}>
                Elegí un modelo a la izquierda.
              </div>
            )}
            {loadingRoot && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)", fontSize: 11.5, padding: 12 }}>
                <Spinner /> Cargando jerarquía…
              </div>
            )}
            {root && root.length === 0 && !loadingRoot && (
              <div style={{ color: "var(--text-muted)", fontSize: 11.5, fontStyle: "italic", padding: 12 }}>
                Este archivo no tiene IfcProject.
              </div>
            )}
            {root && root.map(n => (
              <SpatialNode key={n.id} path={selectedPath} node={n} depth={0}
                selectedId={selectedLeaf?.id ?? null} onSelectLeaf={setSelectedLeaf} />
            ))}
          </div>
        </div>

        {/* ── Detail panel ── */}
        {selectedLeaf && (
          <DetailPanel path={selectedPath} item={selectedLeaf} onClose={() => setSelectedLeaf(null)} />
        )}
      </div>
    </div>
  );
}
