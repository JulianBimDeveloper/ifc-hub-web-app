"use client";

import { useState, useEffect } from "react";
import type { ReviewCell, ReviewMode } from "../lib/reviewTypes";
import { getCellBg } from "../lib/reviewTypes";

interface Selection {
  guid: string;
  colKey: string;
  cell: ReviewCell;
  path: string;
  psetInfo: { pset: string; prop: string };
}

interface Props {
  selection: Selection | null;
  multiGuids: Set<string>;
  mode: ReviewMode;
  onUpdateSingle: (path: string, guid: string, pset: string, prop: string, value: string) => Promise<{ ok: boolean; error?: string }>;
  onOpenBulkFill: (colKey: string, psetInfo: { pset: string; prop: string }, value: string) => void;
  onClose: () => void;
}

export function CellEditPanel({ selection, multiGuids, mode, onUpdateSingle, onOpenBulkFill, onClose }: Props) {
  const [value, setValue]   = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg]       = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (selection) {
      setValue(selection.cell.v ?? "");
      setMsg(null);
    }
  }, [selection]);

  if (!selection) return null;

  const bg = getCellBg(selection.cell, mode);
  const isMulti = multiGuids.size > 1;

  const handleSave = async () => {
    setSaving(true);
    setMsg(null);
    const res = await onUpdateSingle(
      selection.path, selection.guid,
      selection.psetInfo.pset, selection.psetInfo.prop,
      value,
    );
    setSaving(false);
    setMsg(res.ok
      ? { ok: true, text: "Guardado correctamente. Re-escaneando..." }
      : { ok: false, text: res.error ?? "Error desconocido" });
  };

  const handleBulk = () => {
    onOpenBulkFill(selection.colKey, selection.psetInfo, value);
  };

  return (
    <div style={{
      width: 280, flexShrink: 0, background: "#0d0d1a", borderLeft: "1px solid #333",
      display: "flex", flexDirection: "column", padding: 14, gap: 10, overflowY: "auto",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "#4F8FB0", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Editar celda
        </span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: 16 }}>×</button>
      </div>

      {/* Info celda */}
      <div style={{ background: "#111", borderRadius: 4, padding: "8px 10px", fontSize: 11 }}>
        <div style={{ color: "#666", marginBottom: 2 }}>Columna</div>
        <div style={{ color: "#ddd", fontFamily: "JetBrains Mono, monospace" }}>{selection.colKey}</div>
        <div style={{ color: "#666", marginTop: 6, marginBottom: 2 }}>Pset / Propiedad</div>
        <div style={{ color: "#888", fontFamily: "JetBrains Mono, monospace", fontSize: 10 }}>
          {selection.psetInfo.pset} / {selection.psetInfo.prop}
        </div>
        <div style={{ color: "#666", marginTop: 6, marginBottom: 2 }}>Valor actual</div>
        <div style={{
          fontFamily: "JetBrains Mono, monospace", padding: "3px 6px", borderRadius: 3,
          background: bg !== "transparent" ? bg + "44" : "#1a1a2a", color: bg !== "transparent" ? "#fff" : "#888",
          minHeight: 20, fontSize: 11,
        }}>
          {selection.cell.v || <em style={{ color: "#444" }}>(vacío)</em>}
        </div>
        {selection.cell.status && (
          <div style={{ marginTop: 4, fontSize: 10, color: "#888" }}>Estado: <span style={{ color: "#D9A441" }}>{selection.cell.status}</span></div>
        )}
        {selection.cell.client_value !== undefined && (
          <div style={{ marginTop: 2, fontSize: 10, color: "#888" }}>
            Valor cliente: <span style={{ color: "#D9A441", fontFamily: "JetBrains Mono, monospace" }}>{selection.cell.client_value || "(vacío)"}</span>
          </div>
        )}
      </div>

      {/* Input */}
      <div>
        <div style={{ fontSize: 10, color: "#666", marginBottom: 4 }}>Nuevo valor</div>
        <input
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => e.key === "Enter" && !e.shiftKey && !isMulti && handleSave()}
          placeholder="Escribe el nuevo valor..."
          style={{
            width: "100%", boxSizing: "border-box",
            background: "#111", border: "1px solid #333", borderRadius: 4,
            color: "#fff", padding: "7px 10px", fontSize: 12,
            fontFamily: "JetBrains Mono, monospace", outline: "none",
          }}
        />
      </div>

      {/* Acciones */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {!isMulti && (
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              background: saving ? "#333" : "#4F8FB033",
              border: "1px solid #4F8FB0",
              color: "#4F8FB0", borderRadius: 4, padding: "7px 0",
              cursor: saving ? "default" : "pointer", fontSize: 12, fontWeight: 600,
            }}
          >
            {saving ? "Guardando..." : "Guardar este elemento (Enter)"}
          </button>
        )}

        {/* Bulk fill (siempre disponible) */}
        <button
          onClick={handleBulk}
          style={{
            background: "#3FBE8A11", border: "1px solid #3FBE8A",
            color: "#3FBE8A", borderRadius: 4, padding: "7px 0",
            cursor: "pointer", fontSize: 12, fontWeight: 600,
          }}
        >
          {isMulti
            ? `Relleno masivo — ${multiGuids.size} seleccionados`
            : "Relleno masivo (agrupado)"}
        </button>
      </div>

      {msg && (
        <div style={{
          fontSize: 11, padding: "6px 10px", borderRadius: 4,
          background: msg.ok ? "#3FBE8A22" : "#ff335522",
          color: msg.ok ? "#3FBE8A" : "#ff3355",
          border: `1px solid ${msg.ok ? "#3FBE8A44" : "#ff335544"}`,
        }}>
          {msg.text}
        </div>
      )}

      {/* Multi-select info */}
      {isMulti && (
        <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>
          <strong style={{ color: "#4F8FB0" }}>{multiGuids.size}</strong> elementos seleccionados.<br />
          Usa <em>Relleno masivo</em> para aplicar a todos.
        </div>
      )}

      {/* Links a otras herramientas */}
      <div style={{ borderTop: "1px solid #222", paddingTop: 10, marginTop: "auto" }}>
        <div style={{ fontSize: 10, color: "#555", marginBottom: 6 }}>HERRAMIENTAS RELACIONADAS</div>
        {(selection.colKey.startsWith("ADIF_02_") || selection.colKey.startsWith("ADIF_04_") || selection.colKey === "LongName") && (
          <a href="/ifc-project-default" target="_blank" style={{ display: "block", fontSize: 11, color: "#7A6FD9", marginBottom: 4, textDecoration: "none" }}>
            → Project Defaults (nivel proyecto)
          </a>
        )}
        {selection.colKey === "IfcMaterial" && (
          <a href="/ifc-material" target="_blank" style={{ display: "block", fontSize: 11, color: "#D9A441", marginBottom: 4, textDecoration: "none" }}>
            → Material Tool (renombrar materiales)
          </a>
        )}
        {selection.colKey.startsWith("SCFClass_") && (
          <a href="/ifc-classify" target="_blank" style={{ display: "block", fontSize: 11, color: "#7A6FD9", marginBottom: 4, textDecoration: "none" }}>
            → Classifier (asignar clasificación)
          </a>
        )}
      </div>
    </div>
  );
}
