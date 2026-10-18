"use client";

/**
 * IFCFileSelector — Shared file-selection widget for tool pages.
 *
 * Reads the file list from the global projectStore.
 * Each tool keeps its own `selectedPaths` state locally and passes it here.
 *
 * Mode "multi"  → checkbox list (classify, model-checker, validator, …)
 * Mode "single" → click-to-select (structure, value-search, material, …)
 */

import Link from "next/link";
import { useProjectStore } from "@/stores/projectStore";

// ── Types ─────────────────────────────────────────────────────────────────────

interface MultiProps {
  mode: "multi";
  selectedPaths: string[];
  onSelectionChange: (paths: string[]) => void;
}

interface SingleProps {
  mode: "single";
  selectedPath: string;
  onSelectionChange: (path: string) => void;
}

type Props = MultiProps | SingleProps;

// ── Component ─────────────────────────────────────────────────────────────────

export function IFCFileSelector(props: Props) {
  const { files, sources } = useProjectStore();

  // ── Empty state ─────────────────────────────────────────────────────────────
  if (sources.length === 0 || files.length === 0) {
    return (
      <div style={{
        padding: "20px 16px", textAlign: "center",
        border: "1px dashed rgba(91,140,255,0.15)", borderRadius: 6,
        background: "rgba(91,140,255,0.02)",
      }}>
        <div style={{ fontSize: 22, marginBottom: 8, opacity: 0.3 }}>⬡</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>
          No hay archivos IFC cargados
        </div>
        <Link
          href="/models"
          style={{
            fontSize: 11, color: "var(--cyan)", textDecoration: "none",
            border: "1px solid rgba(91,140,255,0.3)", borderRadius: 4,
            padding: "5px 12px", display: "inline-block",
          }}
        >
          → Ir a Models para seleccionar carpeta
        </Link>
      </div>
    );
  }

  // ── Multi mode ──────────────────────────────────────────────────────────────
  if (props.mode === "multi") {
    const { selectedPaths, onSelectionChange } = props;

    const togglePath = (path: string) => {
      onSelectionChange(
        selectedPaths.includes(path)
          ? selectedPaths.filter((p) => p !== path)
          : [...selectedPaths, path]
      );
    };

    const allSelected  = files.every((f) => selectedPaths.includes(f.path));
    const noneSelected = files.every((f) => !selectedPaths.includes(f.path));

    return (
      <div>
        {/* Select all / none bar */}
        <div style={{ display: "flex", gap: 8, marginBottom: 8, fontSize: 11 }}>
          <button
            onClick={() => onSelectionChange(files.map((f) => f.path))}
            style={{ background: "none", border: "none", color: "var(--cyan)", cursor: "pointer", padding: 0, fontSize: 11 }}
          >
            Seleccionar todos
          </button>
          <span style={{ color: "var(--border)" }}>|</span>
          <button
            onClick={() => onSelectionChange([])}
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 0, fontSize: 11 }}
          >
            Deseleccionar todos
          </button>
          <span style={{ marginLeft: "auto", color: "var(--text-muted)" }}>
            {selectedPaths.length}/{files.length} seleccionados
          </span>
        </div>

        {/* File list */}
        <div style={{ maxHeight: 260, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
          {files.map((f) => {
            const selected = selectedPaths.includes(f.path);
            return (
              <label
                key={f.path}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "5px 8px", borderRadius: 4, cursor: "pointer",
                  background: selected ? "rgba(91,140,255,0.05)" : "transparent",
                  border: `1px solid ${selected ? "rgba(91,140,255,0.2)" : "transparent"}`,
                }}
              >
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => togglePath(f.path)}
                  style={{ accentColor: "var(--cyan)", flexShrink: 0 }}
                />
                <span style={{
                  fontSize: 11, color: selected ? "var(--text)" : "var(--text-muted)",
                  fontFamily: "JetBrains Mono, monospace",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {f.filename}
                </span>
              </label>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Single mode ─────────────────────────────────────────────────────────────
  const { selectedPath, onSelectionChange } = props;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 200, overflowY: "auto" }}>
      {files.map((f) => {
        const active = selectedPath === f.path;
        return (
          <button
            key={f.path}
            onClick={() => onSelectionChange(f.path)}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "5px 8px", borderRadius: 4, cursor: "pointer",
              background: active ? "rgba(91,140,255,0.08)" : "transparent",
              border: `1px solid ${active ? "rgba(91,140,255,0.3)" : "rgba(255,255,255,0.04)"}`,
              textAlign: "left", width: "100%",
            }}
          >
            <span style={{
              width: 5, height: 5, borderRadius: "50%", flexShrink: 0,
              background: active ? "var(--cyan)" : "var(--border-bright)",
              boxShadow: active ? "0 0 5px var(--cyan)" : "none",
            }} />
            <span style={{
              fontSize: 11, color: active ? "var(--text)" : "var(--text-muted)",
              fontFamily: "JetBrains Mono, monospace",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {f.filename}
            </span>
          </button>
        );
      })}
    </div>
  );
}
