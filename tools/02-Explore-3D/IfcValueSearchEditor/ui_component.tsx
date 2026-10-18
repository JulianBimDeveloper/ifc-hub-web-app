"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useProjectStore, useEnsureFileInfoLabels } from "@/stores/projectStore";
import { cacheKeyPsetsIndex, cacheKeyPsetValues } from "@/hooks/useBackgroundPreCache";

const API = "http://127.0.0.1:8020";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PsetInfo {
  name: string;
  prop_count: number;
  element_count: number;
  props: string[];
}

interface PropInfo {
  name: string;
  unique_values?: number;
  element_count?: number;
}

interface ValueInfo {
  value: string;
  count: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPathsQuery(paths: string[]) {
  return paths.map((p) => `paths=${encodeURIComponent(p)}`).join("&");
}

function Spinner() {
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
      }}
    />
  );
}

function PanelHeader({
  label,
  badge,
  extra,
}: {
  label: string;
  badge?: string | number;
  extra?: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: "8px 12px",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        {label}
      </span>
      {badge !== undefined && (
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: "var(--cyan)",
            background: "rgba(91,140,255,0.08)",
            border: "1px solid rgba(91,140,255,0.2)",
            borderRadius: 10,
            padding: "1px 7px",
          }}
        >
          {badge}
        </span>
      )}
      {extra && <div style={{ marginLeft: "auto" }}>{extra}</div>}
    </div>
  );
}

function EmptyPlaceholder({ text }: { text: string }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--text-muted)",
        fontSize: 12,
        fontStyle: "italic",
        padding: 16,
        textAlign: "center",
      }}
    >
      {text}
    </div>
  );
}

// ── AutocompleteInput ─────────────────────────────────────────────────────────

function AutocompleteInput({
  placeholder,
  suggestions,
  onConfirm,
  onCancel,
  accentColor = "var(--cyan)",
}: {
  placeholder: string;
  suggestions: string[];
  onConfirm: (value: string) => Promise<void>;
  onCancel: () => void;
  accentColor?: string;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    if (!text.trim()) return suggestions.slice(0, 12);
    const q = text.toLowerCase();
    return suggestions.filter((s) => s.toLowerCase().includes(q)).slice(0, 12);
  }, [text, suggestions]);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 30);
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const confirm = async (val?: string) => {
    const finalVal = (val ?? text).trim();
    if (!finalVal) return;
    setSaving(true);
    setErr(null);
    try {
      await onConfirm(finalVal);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
      setSaving(false);
      return;
    }
    setSaving(false);
  };

  return (
    <div ref={containerRef} style={{ position: "relative", padding: "6px 8px", borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => { setText(e.target.value); setOpen(true); setErr(null); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") confirm();
            if (e.key === "Escape") onCancel();
          }}
          placeholder={placeholder}
          style={{
            flex: 1,
            fontSize: 11,
            fontFamily: "JetBrains Mono, monospace",
            background: "rgba(255,255,255,0.04)",
            border: `1px solid ${accentColor}55`,
            borderRadius: 4,
            color: "var(--text)",
            padding: "4px 8px",
            outline: "none",
          }}
        />
        <button
          onClick={() => confirm()}
          disabled={saving || !text.trim()}
          title="Añadir"
          style={{
            background: saving ? "rgba(91,140,255,0.06)" : `${accentColor}18`,
            border: `1px solid ${accentColor}55`,
            borderRadius: 4,
            color: accentColor,
            cursor: "pointer",
            fontSize: 14,
            padding: "2px 8px",
            fontWeight: 700,
          }}
        >
          {saving ? <Spinner /> : "+"}
        </button>
        <button
          onClick={onCancel}
          title="Cancelar"
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 13, padding: "0 3px" }}
        >
          ✕
        </button>
      </div>

      {err && (
        <div style={{ fontSize: 10, color: "#ff5555", marginTop: 3 }}>✗ {err}</div>
      )}

      {/* Dropdown */}
      {open && matches.length > 0 && (
        <div
          style={{
            position: "absolute",
            bottom: "100%",
            left: 8,
            right: 8,
            background: "#0d1624",
            border: "1px solid rgba(91,140,255,0.25)",
            borderRadius: 6,
            boxShadow: "0 -4px 16px rgba(0,0,0,0.5)",
            zIndex: 50,
            maxHeight: 200,
            overflowY: "auto",
          }}
        >
          {matches.map((s) => (
            <div
              key={s}
              onMouseDown={(e) => {
                e.preventDefault();
                setText(s);
                setOpen(false);
                confirm(s);
              }}
              style={{
                padding: "5px 10px",
                fontSize: 11,
                fontFamily: "JetBrains Mono, monospace",
                color: "var(--text)",
                cursor: "pointer",
                borderBottom: "1px solid rgba(255,255,255,0.04)",
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.background = "rgba(91,140,255,0.08)")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.background = "transparent")}
            >
              {s}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Inline edit value row ─────────────────────────────────────────────────────

function ValueRow({
  info,
  selectedPaths,
  psetName,
  propName,
  onEdited,
  isSelected,
  onSelect,
}: {
  info: ValueInfo;
  selectedPaths: string[];
  psetName: string;
  propName: string;
  onEdited: () => void;
  isSelected?: boolean;
  onSelect?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(info.value);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = () => {
    setDraft(info.value);
    setSaveErr(null);
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 30);
  };

  const cancel = () => {
    setEditing(false);
    setSaveErr(null);
  };

  const save = async () => {
    if (draft === info.value) { cancel(); return; }
    setSaving(true);
    setSaveErr(null);
    try {
      const res = await fetch(`${API}/api/ifc/bulk-edit-property`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paths: selectedPaths,
          pset_name: psetName,
          prop_name: propName,
          old_value: info.value,
          new_value: draft,
        }),
      });
      if (!res.ok) {
        setSaveErr(await res.text());
        return;
      }
      // Invalidate localStorage cache for this pset (values changed)
      localStorage.removeItem(cacheKeyPsetValues(selectedPaths, psetName));
      setEditing(false);
      onEdited();
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div
        onClick={() => { if (!editing) onSelect?.(); }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 10px",
          borderRadius: 4,
          borderBottom: "1px solid rgba(255,255,255,0.03)",
          cursor: editing ? "default" : "pointer",
          background: isSelected ? "rgba(217,164,65,0.08)" : "transparent",
          borderLeft: isSelected ? "2px solid var(--orange, #D9A441)" : "2px solid transparent",
        }}
        onMouseEnter={(e) => {
          if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = "rgba(255,255,255,0.025)";
        }}
        onMouseLeave={(e) => {
          if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = "transparent";
        }}
      >
        {editing ? (
          <>
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") cancel();
              }}
              style={{
                flex: 1,
                background: "rgba(91,140,255,0.06)",
                border: "1px solid rgba(91,140,255,0.4)",
                borderRadius: 4,
                color: "var(--cyan)",
                fontSize: 12,
                fontFamily: "JetBrains Mono, monospace",
                padding: "2px 6px",
                outline: "none",
              }}
            />
            <button
              onClick={save}
              disabled={saving}
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--green)", fontSize: 14, padding: "0 3px" }}
              title="Guardar"
            >
              {saving ? <Spinner /> : "✓"}
            </button>
            <button
              onClick={cancel}
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 12, padding: "0 3px" }}
              title="Cancelar"
            >
              ✕
            </button>
          </>
        ) : (
          <>
            <span
              style={{
                flex: 1,
                fontSize: 12,
                fontFamily: "JetBrains Mono, monospace",
                color: info.value ? "var(--text)" : "var(--text-muted)",
                fontStyle: info.value ? "normal" : "italic",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={info.value}
            >
              {info.value || "(vacío)"}
            </span>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: "var(--cyan)",
                fontFamily: "JetBrains Mono, monospace",
                flexShrink: 0,
                minWidth: 28,
                textAlign: "right",
              }}
            >
              {info.count}
            </span>
            <button
              onClick={startEdit}
              title="Editar todos los elementos con este valor"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--text-muted)",
                fontSize: 13,
                padding: "0 2px",
                opacity: 0.5,
                flexShrink: 0,
              }}
              className="edit-btn"
            >
              ✎
            </button>
          </>
        )}
      </div>
      {saveErr && (
        <div style={{ fontSize: 10, color: "#ff5555", padding: "2px 10px 4px" }}>
          ✗ {saveErr}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function IFCValueSearchPage() {
  const { files, selectedPaths } = useProjectStore();
  const { ensureLoaded } = useEnsureFileInfoLabels(API);

  // Panel 2: psets
  const [psets, setPsets] = useState<PsetInfo[]>([]);
  const [loadingPsets, setLoadingPsets] = useState(false);
  const [selectedPset, setSelectedPset] = useState<string | null>(null);
  const [psetFilter, setPsetFilter] = useState("");
  type PsetSort = "az" | "za" | "props-desc" | "props-asc" | "elem-desc" | "elem-asc";
  const [psetSort, setPsetSort] = useState<PsetSort>("az");

  // Panel 3: properties (derived from selected pset info)
  const [propsData, setPropsData] = useState<PropInfo[]>([]);
  const [loadingProps, setLoadingProps] = useState(false);
  const [selectedProp, setSelectedProp] = useState<string | null>(null);

  // Panel 4: values
  const [valuesData, setValuesData] = useState<{ values: ValueInfo[]; total_elements: number; unique_count: number } | null>(null);
  const [loadingValues, setLoadingValues] = useState(false);

  // Panel 5: elements by selected value
  const [selectedValue, setSelectedValue] = useState<string | null>(null);
  interface ElemRow { name: string; entity_type: string; global_id: string; filename: string; path: string; step_id: number; }
  const [elemRows, setElemRows] = useState<ElemRow[]>([]);
  const [loadingElems, setLoadingElems] = useState(false);
  const [editingElemIdx, setEditingElemIdx] = useState<number | null>(null);
  const [elemDraft, setElemDraft] = useState("");
  const [elemSaving, setElemSaving] = useState(false);
  const [elemSaveErr, setElemSaveErr] = useState<string | null>(null);

  // Add inputs visibility
  const [showAddProp, setShowAddProp] = useState(false);
  const [showAddValue, setShowAddValue] = useState(false);

  // Autocomplete suggestions
  const allPropSuggestions = useMemo(() => {
    const names = new Set<string>();
    psets.forEach((p) => p.props.forEach((n) => names.add(n)));
    return Array.from(names).sort();
  }, [psets]);

  const allValueSuggestions = useMemo(
    () => valuesData?.values.map((v) => v.value).filter(Boolean) ?? [],
    [valuesData]
  );

  // Cargar badges (origin + schema) del sidebar si faltan
  useEffect(() => {
    if (files.length > 0) {
      ensureLoaded();
    }
  }, [files.length, ensureLoaded]);

  // Load psets when selectedPaths changes
  useEffect(() => {
    if (selectedPaths.length === 0) {
      setPsets([]);
      setSelectedPset(null);
      return;
    }
    loadPsets(selectedPaths);
  }, [selectedPaths]);

  // Load props when selectedPset changes + precalculate values in background
  useEffect(() => {
    if (!selectedPset) { setPropsData([]); setSelectedProp(null); return; }
    const psetInfo = psets.find((p) => p.name === selectedPset);
    if (!psetInfo) return;
    setLoadingProps(true);
    setSelectedProp(null);
    setValuesData(null);

    // Show prop names immediately
    setPropsData(psetInfo.props.map((name) => ({ name })));
    setLoadingProps(false);

    // Pre-calculate all values for this PSet in background (no await)
    precalculatePsetValues(selectedPaths, selectedPset);
  }, [selectedPset, psets, selectedPaths]);

  // Load values when selectedProp changes
  useEffect(() => {
    if (!selectedPset || !selectedProp || selectedPaths.length === 0) {
      setValuesData(null);
      setSelectedValue(null);
      setElemRows([]);
      return;
    }
    setSelectedValue(null);
    setElemRows([]);
    loadValues(selectedPaths, selectedPset, selectedProp);
  }, [selectedProp, selectedPset, selectedPaths]);

  // Load elements when a value is selected — AbortController cancels any stale in-flight fetch
  useEffect(() => {
    const controller = new AbortController();
    setEditingElemIdx(null);
    setElemSaveErr(null);
    setElemRows([]);            // clear immediately so old rows never linger
    if (!selectedValue || !selectedPset || !selectedProp || selectedPaths.length === 0) {
      return;
    }
    setLoadingElems(true);
    const q = selectedPaths.map(p => `paths=${encodeURIComponent(p)}`).join("&");
    fetch(
      `${API}/api/ifc/elements-by-value?${q}&pset=${encodeURIComponent(selectedPset)}&prop=${encodeURIComponent(selectedProp)}&value=${encodeURIComponent(selectedValue)}`,
      { signal: controller.signal }
    )
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => setElemRows(data.elements ?? []))
      .catch(e => { if ((e as Error).name !== "AbortError") setElemRows([]); })
      .finally(() => setLoadingElems(false));
    return () => controller.abort();
  }, [selectedValue, selectedPset, selectedProp, selectedPaths]);

  const reloadElemRows = (value: string) => {
    if (!selectedPset || !selectedProp || selectedPaths.length === 0) return;
    setLoadingElems(true);
    const q = selectedPaths.map(p => `paths=${encodeURIComponent(p)}`).join("&");
    fetch(`${API}/api/ifc/elements-by-value?${q}&pset=${encodeURIComponent(selectedPset)}&prop=${encodeURIComponent(selectedProp)}&value=${encodeURIComponent(value)}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => setElemRows(data.elements ?? []))
      .catch(() => setElemRows([]))
      .finally(() => setLoadingElems(false));
  };

  const startElemEdit = (idx: number) => {
    setEditingElemIdx(idx);
    setElemDraft(selectedValue ?? "");
    setElemSaveErr(null);
  };

  const cancelElemEdit = () => {
    setEditingElemIdx(null);
    setElemSaveErr(null);
  };

  const saveElemEdit = async () => {
    if (editingElemIdx === null || !selectedPset || !selectedProp) return;
    const el = elemRows[editingElemIdx];
    const trimmed = elemDraft.trim();
    if (trimmed === selectedValue) { cancelElemEdit(); return; }
    setElemSaving(true);
    setElemSaveErr(null);
    try {
      const res = await fetch(`${API}/api/ifc/edit-element-property`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: el.path,
          step_id: el.step_id,
          pset_name: selectedPset,
          prop_name: selectedProp,
          new_value: trimmed,
        }),
      });
      if (!res.ok) { setElemSaveErr(await res.text()); return; }
      localStorage.removeItem(cacheKeyPsetValues(selectedPaths, selectedPset));
      setEditingElemIdx(null);
      reloadElemRows(selectedValue!);
      loadValues(selectedPaths, selectedPset, selectedProp);
    } catch (e) {
      setElemSaveErr(e instanceof Error ? e.message : "Error");
    } finally {
      setElemSaving(false);
    }
  };

  async function loadPsets(paths: string[]) {
    setLoadingPsets(true);
    setSelectedPset(null);
    setSelectedProp(null);
    setSelectedValue(null);
    setElemRows([]);
    setPsets([]);
    setValuesData(null);

    const cacheKey = cacheKeyPsetsIndex(paths);
    try {
      // Check localStorage first (pre-populated by useBackgroundPreCache)
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const data = JSON.parse(cached);
        setPsets(data.psets);
        setLoadingPsets(false);
        return;
      }

      // Fetch from backend (only if not pre-cached yet)
      const res = await fetch(`${API}/api/ifc/psets-index?${buildPathsQuery(paths)}`, {
        signal: AbortSignal.timeout(120000),
      });
      if (res.ok) {
        const data = await res.json();
        localStorage.setItem(cacheKey, JSON.stringify(data));
        setPsets(data.psets);
      }
    } catch {
      /* silent */
    } finally {
      setLoadingPsets(false);
    }
  }

  // Precalculate all values for a PSet (fires in background, no await)
  async function precalculatePsetValues(paths: string[], pset: string) {
    const cacheKey = cacheKeyPsetValues(paths, pset);
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) return; // Already pre-cached by useBackgroundPreCache

      const res = await fetch(
        `${API}/api/ifc/precalculate-pset-values?${buildPathsQuery(paths)}&pset=${encodeURIComponent(pset)}`,
        { signal: AbortSignal.timeout(120000) }
      );
      if (res.ok) {
        const data = await res.json();
        localStorage.setItem(cacheKey, JSON.stringify(data));
      }
    } catch {
      /* silent — pre-calc is best-effort */
    }
  }

  async function loadValues(paths: string[], pset: string, prop: string) {
    setLoadingValues(true);
    setValuesData(null);

    const cacheKey = cacheKeyPsetValues(paths, pset);
    const cached = localStorage.getItem(cacheKey);

    try {
      // Try to use precalculated data first
      if (cached) {
        const data = JSON.parse(cached);
        if (data.properties && data.properties[prop]) {
          setValuesData(data.properties[prop]);
          setLoadingValues(false);
          return;
        }
      }

      // Fallback: load individual property
      const res = await fetch(
        `${API}/api/ifc/property-values?${buildPathsQuery(paths)}&pset=${encodeURIComponent(pset)}&prop=${encodeURIComponent(prop)}`,
        { signal: AbortSignal.timeout(60000) }
      );
      if (res.ok) {
        const data = await res.json();
        setValuesData(data);
      }
    } catch {
      /* silent */
    } finally {
      setLoadingValues(false);
    }
  }

  const filteredPsets = (() => {
    let list = psetFilter.trim()
      ? psets.filter((p) => p.name.toLowerCase().includes(psetFilter.toLowerCase()))
      : [...psets];
    switch (psetSort) {
      case "az":        list.sort((a, b) => a.name.localeCompare(b.name)); break;
      case "za":        list.sort((a, b) => b.name.localeCompare(a.name)); break;
      case "props-desc":list.sort((a, b) => b.prop_count - a.prop_count);  break;
      case "props-asc": list.sort((a, b) => a.prop_count - b.prop_count);  break;
      case "elem-desc": list.sort((a, b) => b.element_count - a.element_count); break;
      case "elem-asc":  list.sort((a, b) => a.element_count - b.element_count); break;
    }
    return list;
  })();

  const PANEL_H = "calc(100vh - 160px)";

  if (files.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <PageTitle />
        <div
          className="card-cyber"
          style={{ padding: 48, textAlign: "center", color: "var(--text-muted)", fontSize: 13, marginTop: 20 }}
        >
          <div style={{ fontSize: 32, opacity: 0.3, marginBottom: 10 }}>⬡</div>
          Sin archivos IFC. Ve a{" "}
          <a href="/models" style={{ color: "var(--cyan)" }}>Models</a>{" "}
          para añadir una fuente.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 0 }}>
      {/* Header */}
      <div style={{ marginBottom: 14 }}>
        <PageTitle />
        {/* Breadcrumb */}
        {selectedPset && (
          <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-muted)", display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ color: "var(--magenta)" }}>{selectedPset}</span>
            {selectedProp && (
              <>
                <span>›</span>
                <span style={{ color: "var(--cyan)" }}>{selectedProp}</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* panels grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: selectedValue !== null ? "1fr 1fr 1fr 1.4fr" : "1fr 1fr 1fr",
          gap: 10,
          flex: 1,
          minHeight: 0,
          transition: "grid-template-columns 0.2s",
        }}
      >
        {/* ── Panel 1: Property Sets ── */}
        <div
          className="card-cyber"
          style={{ display: "flex", flexDirection: "column", height: PANEL_H, overflow: "hidden" }}
        >
          <PanelHeader
            label="Property Sets"
            badge={loadingPsets ? "…" : filteredPsets.length}
            extra={
              loadingPsets ? <Spinner /> : undefined
            }
          />
          {/* Filter input */}
          <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
            <input
              type="text"
              placeholder="Filtrar pset…"
              value={psetFilter}
              onChange={(e) => setPsetFilter(e.target.value)}
              style={{
                width: "100%",
                fontSize: 11,
                background: "rgba(255,255,255,0.04)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                color: "var(--text)",
                padding: "3px 8px",
                outline: "none",
                fontFamily: "JetBrains Mono, monospace",
                boxSizing: "border-box",
              }}
            />
          </div>

          {/* Sort bar */}
          <div style={{
            padding: "5px 8px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
            display: "flex",
            gap: 4,
            flexWrap: "wrap",
          }}>
            {(
              [
                { key: "az",         label: "A→Z",    title: "Nombre A→Z" },
                { key: "za",         label: "Z→A",    title: "Nombre Z→A" },
                { key: "props-desc", label: "Props ↓", title: "Más propiedades primero" },
                { key: "props-asc",  label: "Props ↑", title: "Menos propiedades primero" },
                { key: "elem-desc",  label: "Elem ↓",  title: "Más elementos primero" },
                { key: "elem-asc",   label: "Elem ↑",  title: "Menos elementos primero" },
              ] as { key: typeof psetSort; label: string; title: string }[]
            ).map((opt) => (
              <button
                key={opt.key}
                onClick={() => setPsetSort(opt.key)}
                title={opt.title}
                style={{
                  background: psetSort === opt.key ? "rgba(91,140,255,0.12)" : "rgba(255,255,255,0.04)",
                  border: `1px solid ${psetSort === opt.key ? "rgba(91,140,255,0.4)" : "rgba(255,255,255,0.08)"}`,
                  borderRadius: 4,
                  color: psetSort === opt.key ? "var(--cyan)" : "var(--text-muted)",
                  fontSize: 10,
                  fontWeight: psetSort === opt.key ? 700 : 400,
                  padding: "2px 7px",
                  cursor: "pointer",
                  fontFamily: "JetBrains Mono, monospace",
                  letterSpacing: "0.03em",
                  transition: "all 0.12s",
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {!loadingPsets && filteredPsets.length === 0 && (
              <EmptyPlaceholder text="Sin property sets. Selecciona modelos." />
            )}
            {filteredPsets.map((p) => {
              const active = selectedPset === p.name;
              return (
                <div
                  key={p.name}
                  onClick={() => setSelectedPset(p.name)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 10px",
                    cursor: "pointer",
                    background: active ? "rgba(91,140,255,0.08)" : "transparent",
                    borderBottom: "1px solid rgba(255,255,255,0.03)",
                    borderLeft: active ? "2px solid var(--cyan)" : "2px solid transparent",
                  }}
                  onMouseEnter={(e) => {
                    if (!active) (e.currentTarget as HTMLDivElement).style.background = "rgba(255,255,255,0.03)";
                  }}
                  onMouseLeave={(e) => {
                    if (!active) (e.currentTarget as HTMLDivElement).style.background = "transparent";
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      fontSize: 11,
                      fontFamily: "JetBrains Mono, monospace",
                      color: active ? "var(--cyan)" : "var(--text)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={p.name}
                  >
                    {p.name}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      color: "var(--text-muted)",
                      flexShrink: 0,
                      fontFamily: "JetBrains Mono, monospace",
                    }}
                  >
                    {p.prop_count} props
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Panel 2: Properties ── */}
        <div
          className="card-cyber"
          style={{ display: "flex", flexDirection: "column", height: PANEL_H, overflow: "hidden" }}
        >
          <PanelHeader
            label="Properties"
            badge={selectedPset ? propsData.length : undefined}
            extra={
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {loadingProps && <Spinner />}
                {selectedPset && (
                  <button
                    onClick={() => { setShowAddProp((v) => !v); setShowAddValue(false); }}
                    title="Añadir propiedad"
                    style={{
                      background: showAddProp ? "rgba(91,140,255,0.12)" : "none",
                      border: `1px solid ${showAddProp ? "rgba(91,140,255,0.4)" : "rgba(255,255,255,0.1)"}`,
                      borderRadius: 4,
                      color: showAddProp ? "var(--cyan)" : "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: 14,
                      fontWeight: 700,
                      padding: "0px 7px",
                      lineHeight: "18px",
                    }}
                  >
                    +
                  </button>
                )}
              </div>
            }
          />
          <div style={{ flex: 1, overflowY: "auto" }}>
            {!selectedPset && (
              <EmptyPlaceholder text="Selecciona un Property Set" />
            )}
            {selectedPset && !loadingProps && propsData.length === 0 && (
              <EmptyPlaceholder text="Sin propiedades" />
            )}
            {propsData.map((prop) => {
              const active = selectedProp === prop.name;
              return (
                <div
                  key={prop.name}
                  onClick={() => setSelectedProp(prop.name)}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    padding: "6px 10px",
                    cursor: "pointer",
                    background: active ? "rgba(91,140,255,0.07)" : "transparent",
                    borderBottom: "1px solid rgba(255,255,255,0.03)",
                    borderLeft: active ? "2px solid var(--cyan)" : "2px solid transparent",
                  }}
                  onMouseEnter={(e) => {
                    if (!active) (e.currentTarget as HTMLDivElement).style.background = "rgba(255,255,255,0.03)";
                  }}
                  onMouseLeave={(e) => {
                    if (!active) (e.currentTarget as HTMLDivElement).style.background = "transparent";
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      fontFamily: "JetBrains Mono, monospace",
                      color: active ? "var(--cyan)" : "var(--text)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {prop.name}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Add property input */}
          {showAddProp && selectedPset && (
            <AutocompleteInput
              placeholder="Nombre de la nueva propiedad…"
              suggestions={allPropSuggestions}
              accentColor="var(--cyan)"
              onConfirm={async (propName) => {
                const res = await fetch(`${API}/api/ifc/add-property-to-pset`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    paths: selectedPaths,
                    pset_name: selectedPset,
                    prop_name: propName,
                    default_value: "",
                  }),
                });
                if (!res.ok) throw new Error(await res.text());
                setShowAddProp(false);
                // Refresh psets — clear psets-index cache (values cache stays valid)
                localStorage.removeItem(cacheKeyPsetsIndex(selectedPaths));
                await loadPsets(selectedPaths);
              }}
              onCancel={() => setShowAddProp(false)}
            />
          )}
        </div>

        {/* ── Panel 3: Values ── */}
        <div
          className="card-cyber"
          style={{ display: "flex", flexDirection: "column", height: PANEL_H, overflow: "hidden" }}
        >
          <PanelHeader
            label="Values"
            badge={
              valuesData
                ? `${valuesData.unique_count} únicos`
                : selectedProp
                ? "…"
                : undefined
            }
            extra={
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {loadingValues && <Spinner />}
                {valuesData && !loadingValues && (
                  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                    {valuesData.total_elements.toLocaleString()} elem
                  </span>
                )}
                {selectedProp && (
                  <button
                    onClick={() => { setShowAddValue((v) => !v); setShowAddProp(false); }}
                    title="Añadir valor (asignar a elementos vacíos)"
                    style={{
                      background: showAddValue ? "rgba(217,164,65,0.12)" : "none",
                      border: `1px solid ${showAddValue ? "rgba(217,164,65,0.4)" : "rgba(255,255,255,0.1)"}`,
                      borderRadius: 4,
                      color: showAddValue ? "var(--orange, #D9A441)" : "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: 14,
                      fontWeight: 700,
                      padding: "0px 7px",
                      lineHeight: "18px",
                    }}
                  >
                    +
                  </button>
                )}
              </div>
            }
          />
          <div style={{ flex: 1, overflowY: "auto" }}>
            {!selectedProp && (
              <EmptyPlaceholder text="Selecciona una propiedad" />
            )}
            {selectedProp && loadingValues && (
              <div style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                gap: 12,
                color: "var(--text-muted)",
                fontSize: 12,
              }}>
                <div style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}>
                  <Spinner />
                  <span>Analizando valores...</span>
                </div>
                <span style={{ fontSize: 11, opacity: 0.6, fontStyle: "italic" }}>
                  (Esto puede tardar unos segundos)
                </span>
              </div>
            )}
            {selectedProp && !loadingValues && valuesData && valuesData.values.length === 0 && (
              <EmptyPlaceholder text="Sin valores encontrados" />
            )}
            {valuesData &&
              valuesData.values.map((v) => (
                <ValueRow
                  key={v.value}
                  info={v}
                  selectedPaths={selectedPaths}
                  psetName={selectedPset!}
                  propName={selectedProp!}
                  onEdited={() => { setSelectedValue(null); setElemRows([]); loadValues(selectedPaths, selectedPset!, selectedProp!); }}
                  isSelected={selectedValue === v.value}
                  onSelect={() => setSelectedValue(selectedValue === v.value ? null : v.value)}
                />
              ))}
          </div>

          {/* Add value input */}
          {showAddValue && selectedProp && selectedPset && (
            <AutocompleteInput
              placeholder="Nuevo valor (se asigna a elementos vacíos)…"
              suggestions={allValueSuggestions}
              accentColor="var(--orange, #D9A441)"
              onConfirm={async (newValue) => {
                const res = await fetch(`${API}/api/ifc/assign-empty-value`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    paths: selectedPaths,
                    pset_name: selectedPset,
                    prop_name: selectedProp,
                    new_value: newValue,
                  }),
                });
                if (!res.ok) throw new Error(await res.text());
                setShowAddValue(false);
                await loadValues(selectedPaths, selectedPset!, selectedProp!);
              }}
              onCancel={() => setShowAddValue(false)}
            />
          )}
        </div>

        {/* ── Panel 4: Elements by value ── */}
        {selectedValue !== null && (
          <div
            className="card-cyber"
            style={{ display: "flex", flexDirection: "column", height: PANEL_H, overflow: "hidden" }}
          >
            <PanelHeader
              label="Elementos"
              badge={loadingElems ? "…" : elemRows.length}
              extra={
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  {loadingElems && <Spinner />}
                  <button
                    onClick={() => { setSelectedValue(null); setElemRows([]); }}
                    title="Cerrar panel"
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 14, padding: "0 2px", lineHeight: 1 }}
                  >
                    ✕
                  </button>
                </div>
              }
            />
            {/* Value chip */}
            <div style={{ padding: "5px 10px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
              <span style={{
                fontSize: 11, fontFamily: "JetBrains Mono, monospace",
                color: "var(--orange, #D9A441)", background: "rgba(217,164,65,0.1)",
                border: "1px solid rgba(217,164,65,0.3)", borderRadius: 4,
                padding: "2px 7px",
              }}>
                {selectedValue || "(vacío)"}
              </span>
            </div>
            <div style={{ flex: 1, overflowY: "auto" }}>
              {!loadingElems && elemRows.length === 0 && (
                <EmptyPlaceholder text="Sin elementos" />
              )}
              {elemRows.map((el, i) => {
                const isEditing = editingElemIdx === i;
                return (
                  <div
                    key={el.global_id || i}
                    style={{
                      padding: "5px 10px",
                      borderBottom: "1px solid rgba(255,255,255,0.03)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 3,
                      background: isEditing ? "rgba(91,140,255,0.04)" : "transparent",
                    }}
                    onMouseEnter={(e) => { if (!isEditing) (e.currentTarget as HTMLDivElement).style.background = "rgba(255,255,255,0.025)"; }}
                    onMouseLeave={(e) => { if (!isEditing) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
                  >
                    {isEditing ? (
                      <>
                        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                          <input
                            autoFocus
                            value={elemDraft}
                            onChange={(e) => setElemDraft(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") saveElemEdit(); if (e.key === "Escape") cancelElemEdit(); }}
                            style={{
                              flex: 1, fontSize: 11, fontFamily: "JetBrains Mono, monospace",
                              background: "rgba(91,140,255,0.06)", border: "1px solid rgba(91,140,255,0.4)",
                              borderRadius: 4, color: "var(--cyan)", padding: "2px 6px", outline: "none",
                            }}
                          />
                          <button
                            onClick={saveElemEdit}
                            disabled={elemSaving}
                            title="Guardar"
                            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--green, #50fa7b)", fontSize: 14, padding: "0 3px" }}
                          >
                            {elemSaving ? <Spinner /> : "✓"}
                          </button>
                          <button
                            onClick={cancelElemEdit}
                            title="Cancelar"
                            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 12, padding: "0 3px" }}
                          >
                            ✕
                          </button>
                        </div>
                        {elemSaveErr && (
                          <div style={{ fontSize: 10, color: "#ff5555" }}>✗ {elemSaveErr}</div>
                        )}
                      </>
                    ) : (
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={{ flex: 1, fontSize: 11, fontFamily: "JetBrains Mono, monospace", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={el.name}>
                          {el.name}
                        </span>
                        <button
                          onClick={() => startElemEdit(i)}
                          title="Editar valor de este elemento"
                          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 13, padding: "0 2px", opacity: 0.4, flexShrink: 0 }}
                          className="edit-btn"
                        >
                          ✎
                        </button>
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span style={{ fontSize: 10, color: "var(--cyan)", fontFamily: "JetBrains Mono, monospace" }}>{el.entity_type}</span>
                      <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "JetBrains Mono, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={el.filename}>
                        {el.filename}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        div:hover .edit-btn { opacity: 0.5 !important; }
        .edit-btn:hover { opacity: 1 !important; color: var(--cyan) !important; }
      `}</style>
    </div>
  );
}

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
        VALUE SEARCH
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 2 }}>
        Explora Property Sets, propiedades y valores — selecciona archivos y edita valores masivamente
      </p>
    </div>
  );
}
