"use client";

import { useRef, useState } from "react";

interface Props {
  onImport: (file: File) => Promise<string | null>;
  onClose: () => void;
  reviewId: string | null;
}

export function ImportExcelDialog({ onImport, onClose, reviewId }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const handleFile = async (file: File) => {
    setLoading(true);
    setMsg(null);
    const id = await onImport(file);
    setLoading(false);
    if (id) {
      setMsg({ ok: true, text: `Importado correctamente. Review ID: ${id.slice(0, 8)}...` });
    } else {
      setMsg({ ok: false, text: "Error al importar el archivo." });
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 200,
      display: "flex", alignItems: "center", justifyContent: "center",
    }} onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: "#0d0d1a", border: "1px solid #4F8FB0",
          borderRadius: 8, padding: 28, width: 420, maxWidth: "90vw",
          boxShadow: "0 0 40px rgba(79,143,176,0.3)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <span style={{ color: "#4F8FB0", fontWeight: 700, fontSize: 14, letterSpacing: "0.06em" }}>
            IMPORTAR REVISIÓN DEL CLIENTE
          </span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: 18 }}>×</button>
        </div>

        <div style={{ fontSize: 12, color: "#888", marginBottom: 16, lineHeight: 1.6 }}>
          Sube el <strong style={{ color: "#ddd" }}>.xlsx</strong> original del cliente (con celdas rojas)
          o un <strong style={{ color: "#ddd" }}>.csv</strong> exportado.<br />
          Las celdas marcadas en rojo <span style={{ color: "#ff3355" }}>█</span> se importan
          como <em>pendientes de corrección</em>.
        </div>

        {/* Drop zone */}
        <div
          onDrop={onDrop}
          onDragOver={e => e.preventDefault()}
          onClick={() => inputRef.current?.click()}
          style={{
            border: "2px dashed #4F8FB055", borderRadius: 6,
            padding: "24px 16px", textAlign: "center", cursor: "pointer",
            background: "#4F8FB00a", marginBottom: 16,
            transition: "border-color 0.2s",
          }}
          onMouseEnter={e => (e.currentTarget.style.borderColor = "#4F8FB0")}
          onMouseLeave={e => (e.currentTarget.style.borderColor = "#4F8FB055")}
        >
          <div style={{ fontSize: 28, marginBottom: 8 }}>📊</div>
          <div style={{ color: "#4F8FB0", fontSize: 13, fontWeight: 600 }}>
            {loading ? "Procesando..." : "Clic o arrastrar archivo aquí"}
          </div>
          <div style={{ color: "#555", fontSize: 11, marginTop: 4 }}>.xlsx (recomendado) o .csv</div>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.csv"
          style={{ display: "none" }}
          onChange={e => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />

        {reviewId && !msg && (
          <div style={{ fontSize: 11, color: "#555", fontFamily: "JetBrains Mono, monospace", marginBottom: 8 }}>
            Review activo: <span style={{ color: "#888" }}>{reviewId.slice(0, 12)}...</span>
          </div>
        )}

        {msg && (
          <div style={{
            fontSize: 12, padding: "8px 12px", borderRadius: 4,
            background: msg.ok ? "#3FBE8A20" : "#ff335520",
            color: msg.ok ? "#3FBE8A" : "#ff3355",
            border: `1px solid ${msg.ok ? "#3FBE8A40" : "#ff335540"}`,
          }}>
            {msg.text}
          </div>
        )}

        {msg?.ok && (
          <button
            onClick={onClose}
            style={{
              marginTop: 12, width: "100%", background: "#4F8FB0",
              border: "none", color: "#fff", borderRadius: 4,
              padding: "9px 0", cursor: "pointer", fontWeight: 700, fontSize: 13,
            }}
          >
            Cerrar y comparar
          </button>
        )}
      </div>
    </div>
  );
}
