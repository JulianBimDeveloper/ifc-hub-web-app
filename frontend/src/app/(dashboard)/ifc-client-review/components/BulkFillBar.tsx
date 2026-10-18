"use client";

import { useState } from "react";
import type { FillScope, BulkFillRequest } from "../lib/reviewTypes";

interface Props {
  colKey: string;
  psetInfo: { pset: string; prop: string };
  initialValue?: string;
  selectedGuids: Set<string>;
  selectedPaths: string[];
  onApply: (req: BulkFillRequest) => Promise<{ ok: boolean; updated: number; error?: string }>;
  onClose: () => void;
}

export function BulkFillBar({
  colKey, psetInfo, initialValue = "", selectedGuids, selectedPaths, onApply, onClose,
}: Props) {
  const [value, setValue]     = useState(initialValue);
  const [scope, setScope]     = useState<FillScope>("empty");
  const [ifcClass, setIfcClass] = useState("");
  const [nameBase, setNameBase] = useState("");
  const [onlyEmpty, setOnlyEmpty] = useState(true);
  const [applying, setApplying]  = useState(false);
  const [result, setResult]      = useState<{ ok: boolean; updated: number; error?: string } | null>(null);

  const buildRequest = (): BulkFillRequest => {
    const targets: Record<string, string[]> = {};

    if (scope === "manual" && selectedGuids.size > 0) {
      // Agrupar GUIDs seleccionados por archivo — no sabemos a qué archivo pertenece
      // cada GUID sin consultar al backend, así que los ponemos en todos los paths.
      // El backend ignora los GUIDs que no estén en el archivo.
      for (const p of selectedPaths) {
        targets[p] = Array.from(selectedGuids);
      }
    } else {
      for (const p of selectedPaths) {
        targets[p] = ["__all__"];
      }
    }

    return {
      targets_by_file: targets,
      fills: [{
        pset_name:        psetInfo.pset,
        prop_name:        psetInfo.prop,
        value,
        only_if_empty:    scope === "empty" || onlyEmpty,
        create_if_missing: true,
      }],
      ifc_class: (scope === "ifc_class" && ifcClass) ? ifcClass : undefined,
      name_base: (scope === "name_base" && nameBase) ? nameBase : undefined,
    };
  };

  const handleApply = async () => {
    setApplying(true);
    setResult(null);
    const req = buildRequest();
    const res = await onApply(req);
    setApplying(false);
    setResult(res);
  };

  return (
    <div style={{
      position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 100,
      background: "#0d0d20", borderTop: "2px solid #4F8FB0",
      padding: "12px 20px", display: "flex", alignItems: "flex-start", gap: 16,
      boxShadow: "0 -4px 24px rgba(79,143,176,0.3)",
    }}>
      {/* Columna / pset */}
      <div style={{ flexShrink: 0 }}>
        <div style={{ fontSize: 9, color: "#888", letterSpacing: "0.1em", marginBottom: 2 }}>COLUMNA</div>
        <div style={{ fontFamily: "JetBrains Mono, monospace", color: "#4F8FB0", fontSize: 12 }}>{colKey}</div>
        <div style={{ fontSize: 10, color: "#555", fontFamily: "JetBrains Mono, monospace" }}>
          {psetInfo.pset} / {psetInfo.prop}
        </div>
      </div>

      <div style={{ width: 1, background: "#333", alignSelf: "stretch" }} />

      {/* Valor */}
      <div style={{ minWidth: 200 }}>
        <div style={{ fontSize: 9, color: "#888", letterSpacing: "0.1em", marginBottom: 4 }}>NUEVO VALOR</div>
        <input
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder="Valor a escribir..."
          style={{
            background: "#111", border: "1px solid #444", borderRadius: 4,
            color: "#fff", padding: "6px 10px", fontSize: 12,
            fontFamily: "JetBrains Mono, monospace", outline: "none", width: "100%", boxSizing: "border-box",
          }}
        />
      </div>

      <div style={{ width: 1, background: "#333", alignSelf: "stretch" }} />

      {/* Alcance */}
      <div>
        <div style={{ fontSize: 9, color: "#888", letterSpacing: "0.1em", marginBottom: 4 }}>ALCANCE</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {([
            ["empty",     "Vacíos (este pset+prop)"],
            ["file",      "Todos en archivos sel."],
            ["ifc_class", "Por clase IFC"],
            ["name_base", "Por nombre-tipo"],
            ["manual",    `Manual (${selectedGuids.size} sel.)`],
          ] as [FillScope, string][]).map(([s, label]) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              style={{
                background: scope === s ? "#4F8FB033" : "#111",
                border: `1px solid ${scope === s ? "#4F8FB0" : "#333"}`,
                color: scope === s ? "#4F8FB0" : "#888",
                borderRadius: 4, padding: "4px 10px", cursor: "pointer", fontSize: 11,
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {scope === "ifc_class" && (
          <input
            value={ifcClass}
            onChange={e => setIfcClass(e.target.value)}
            placeholder="e.g. IfcWall, IfcPipeSegment..."
            style={{
              marginTop: 6, background: "#111", border: "1px solid #444", borderRadius: 4,
              color: "#fff", padding: "5px 10px", fontSize: 11, outline: "none",
              fontFamily: "JetBrains Mono, monospace",
            }}
          />
        )}
        {scope === "name_base" && (
          <input
            value={nameBase}
            onChange={e => setNameBase(e.target.value)}
            placeholder="e.g. ARQ_MAM_Mampara_5cm (sin _123456)"
            style={{
              marginTop: 6, background: "#111", border: "1px solid #444", borderRadius: 4,
              color: "#fff", padding: "5px 10px", fontSize: 11, outline: "none",
              fontFamily: "JetBrains Mono, monospace", minWidth: 260,
            }}
          />
        )}

        {scope !== "empty" && (
          <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 11, color: "#888", cursor: "pointer" }}>
            <input type="checkbox" checked={onlyEmpty} onChange={e => setOnlyEmpty(e.target.checked)} />
            Solo si el campo está vacío (no sobreescribir valores existentes)
          </label>
        )}
      </div>

      <div style={{ width: 1, background: "#333", alignSelf: "stretch" }} />

      {/* Botones */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
        <button
          onClick={handleApply}
          disabled={applying || !value.trim()}
          style={{
            background: applying ? "#333" : "#4F8FB0",
            border: "none", color: "#fff", borderRadius: 4,
            padding: "8px 20px", cursor: applying ? "default" : "pointer",
            fontWeight: 700, fontSize: 13,
          }}
        >
          {applying ? "Aplicando..." : "Aplicar"}
        </button>
        <button
          onClick={onClose}
          style={{
            background: "none", border: "1px solid #444",
            color: "#666", borderRadius: 4, padding: "6px 20px", cursor: "pointer", fontSize: 12,
          }}
        >
          Cancelar
        </button>
      </div>

      {/* Resultado */}
      {result && (
        <div style={{
          fontSize: 12, padding: "8px 14px", borderRadius: 4, alignSelf: "center",
          background: result.ok ? "#3FBE8A22" : "#ff335522",
          color: result.ok ? "#3FBE8A" : "#ff3355",
          border: `1px solid ${result.ok ? "#3FBE8A44" : "#ff335544"}`,
          fontFamily: "JetBrains Mono, monospace",
        }}>
          {result.ok
            ? `${result.updated} propiedades actualizadas`
            : `Error: ${result.error}`}
        </div>
      )}
    </div>
  );
}
