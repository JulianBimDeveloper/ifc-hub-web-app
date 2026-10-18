"use client";

import { useMemo, useState } from "react";

interface CubeCell {
  id: number;
  filename: string;
  status: "applied" | "pending" | "na";
  x: number;
  y: number;
  z: number;
}

interface IFCStatusCubeProps {
  files: Array<{ filename: string; path: string }>;
  appliedFiles: Set<string>;
  naFiles?: Set<string>;
}

/**
 * Cubo 3D tipo Rubik donde cada celda es un subcubo con 6 caras.
 * - Verde: aplicado
 * - Naranja: pendiente
 * - Gris: no aplica
 */
export function IFCStatusCube({ files, appliedFiles, naFiles = new Set() }: IFCStatusCubeProps) {
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const [rotX, setRotX] = useState(25);
  const [rotY, setRotY] = useState(-35);

  const cubeSize = useMemo(() => {
    const n = files.length;
    if (n === 0) return 0;
    if (n <= 8) return 2;
    if (n <= 27) return 3;
    if (n <= 64) return 4;
    return Math.ceil(Math.cbrt(n));
  }, [files.length]);

  // Construir celdas con coordenadas 3D
  const cells: CubeCell[] = useMemo(() => {
    return files.map((f, idx) => {
      let status: "applied" | "pending" | "na" = "pending";
      if (naFiles.has(f.filename)) status = "na";
      else if (appliedFiles.has(f.filename)) status = "applied";

      const x = idx % cubeSize;
      const y = Math.floor((idx / cubeSize) % cubeSize);
      const z = Math.floor(idx / (cubeSize * cubeSize));

      return {
        id: idx,
        filename: f.filename,
        status,
        x,
        y,
        z,
      };
    });
  }, [files, appliedFiles, naFiles, cubeSize]);

  const colors = {
    applied: "#3FBE8A",
    pending: "#D9A441",
    na: "#707070",
  };

  if (cubeSize === 0) {
    return (
      <div style={{
        width: "100%",
        height: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--text-muted)",
        fontSize: 12,
      }}>
        Sin archivos IFC
      </div>
    );
  }

  const cellSize = 60;
  const gap = 4;
  const totalSize = cubeSize * (cellSize + gap);
  const offset = totalSize / 2;

  return (
    <div
      style={{
        width: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 16,
        padding: "16px 0",
      }}
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const centerX = rect.width / 2;
        const centerY = rect.height / 3;
        const x = ((e.clientX - rect.left) - centerX) / 12;
        const y = ((e.clientY - rect.top) - centerY) / 12;
        setRotY(Math.max(-70, Math.min(10, -35 + x)));
        setRotX(Math.max(-10, Math.min(70, 25 - y)));
      }}
      onMouseLeave={() => {
        setRotX(25);
        setRotY(-35);
      }}
    >
      {/* Contenedor 3D */}
      <div
        style={{
          perspective: "2000px",
          width: "100%",
          height: 480,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "radial-gradient(circle at center, rgba(91,140,255,0.1), transparent)",
          borderRadius: 8,
        }}
      >
        {/* Cubo 3D */}
        <div
          style={{
            position: "relative",
            width: totalSize,
            height: totalSize,
            transformStyle: "preserve-3d",
            transform: `rotateX(${rotX}deg) rotateY(${rotY}deg)`,
            transition: "transform 0.05s ease-out",
          }}
        >
          {/* Render cada subcubo */}
          {cells.map((cell) => {
            const color = colors[cell.status];
            const isHovered = hoveredId === cell.id;

            // Posición del subcubo en el espacio 3D
            const posX = cell.x * (cellSize + gap) - offset;
            const posY = cell.y * (cellSize + gap) - offset;
            const posZ = cell.z * (cellSize + gap) - offset;

            return (
              <div
                key={cell.id}
                onMouseEnter={() => setHoveredId(cell.id)}
                onMouseLeave={() => setHoveredId(null)}
                title={cell.filename}
                style={{
                  position: "absolute",
                  width: cellSize,
                  height: cellSize,
                  left: posX,
                  top: posY,
                  transformStyle: "preserve-3d",
                  transform: `translateZ(${posZ}px) ${isHovered ? "scale(1.1)" : "scale(1)"}`,
                  transition: "all 0.2s",
                  cursor: "pointer",
                }}
              >
                {/* Cara FRONTAL */}
                <div
                  style={{
                    position: "absolute",
                    width: cellSize,
                    height: cellSize,
                    background: color,
                    border: `1px solid ${isHovered ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0.2)"}`,
                    boxShadow: isHovered ? `0 0 16px ${color}80, inset 0 1px 2px rgba(255,255,255,0.3)` : `inset 0 1px 2px rgba(255,255,255,0.2)`,
                    transform: `translateZ(${cellSize / 2}px)`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 16,
                    fontWeight: 700,
                    color: cell.status === "na" ? "#505050" : "#1a1a1a",
                    borderRadius: 4,
                  }}
                >
                  {cell.status === "applied" && "✓"}
                  {cell.status === "pending" && "○"}
                  {cell.status === "na" && "—"}
                </div>

                {/* Cara TRASERA */}
                <div
                  style={{
                    position: "absolute",
                    width: cellSize,
                    height: cellSize,
                    background: color,
                    opacity: 0.7,
                    border: `1px solid rgba(0,0,0,0.2)`,
                    transform: `rotateY(180deg) translateZ(${cellSize / 2}px)`,
                    borderRadius: 4,
                  }}
                />

                {/* Cara ARRIBA */}
                <div
                  style={{
                    position: "absolute",
                    width: cellSize,
                    height: cellSize,
                    background: color,
                    opacity: 0.85,
                    border: `1px solid rgba(0,0,0,0.2)`,
                    transform: `rotateX(90deg) translateZ(${cellSize / 2}px)`,
                    borderRadius: 4,
                  }}
                />

                {/* Cara ABAJO */}
                <div
                  style={{
                    position: "absolute",
                    width: cellSize,
                    height: cellSize,
                    background: color,
                    opacity: 0.6,
                    border: `1px solid rgba(0,0,0,0.2)`,
                    transform: `rotateX(-90deg) translateZ(${cellSize / 2}px)`,
                    borderRadius: 4,
                  }}
                />

                {/* Cara IZQUIERDA */}
                <div
                  style={{
                    position: "absolute",
                    width: cellSize,
                    height: cellSize,
                    background: color,
                    opacity: 0.75,
                    border: `1px solid rgba(0,0,0,0.2)`,
                    transform: `rotateY(-90deg) translateZ(${cellSize / 2}px)`,
                    borderRadius: 4,
                  }}
                />

                {/* Cara DERECHA */}
                <div
                  style={{
                    position: "absolute",
                    width: cellSize,
                    height: cellSize,
                    background: color,
                    opacity: 0.8,
                    border: `1px solid rgba(0,0,0,0.2)`,
                    transform: `rotateY(90deg) translateZ(${cellSize / 2}px)`,
                    borderRadius: 4,
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Tooltip */}
      {hoveredId !== null && (
        <div
          style={{
            fontSize: 10,
            color: "var(--text-muted)",
            fontFamily: "JetBrains Mono",
            maxWidth: 340,
            textAlign: "center",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            padding: "4px 8px",
            background: "rgba(0,0,0,0.5)",
            borderRadius: 3,
            border: "1px solid rgba(91,140,255,0.3)",
          }}
        >
          {cells.find(c => c.id === hoveredId)?.filename}
        </div>
      )}

      {/* Leyenda */}
      <div
        style={{
          display: "flex",
          gap: 20,
          justifyContent: "center",
          fontSize: 10,
          fontFamily: "JetBrains Mono",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div
            style={{
              width: 14,
              height: 14,
              background: colors.applied,
              borderRadius: 3,
              boxShadow: `0 0 6px ${colors.applied}80`,
            }}
          />
          <span style={{ color: "var(--text-muted)" }}>Aplicado ({appliedFiles.size})</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div
            style={{
              width: 14,
              height: 14,
              background: colors.pending,
              borderRadius: 3,
              boxShadow: `0 0 6px ${colors.pending}80`,
            }}
          />
          <span style={{ color: "var(--text-muted)" }}>Pendiente ({files.length - appliedFiles.size - naFiles.size})</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div
            style={{
              width: 14,
              height: 14,
              background: colors.na,
              borderRadius: 3,
              boxShadow: `0 0 6px ${colors.na}80`,
            }}
          />
          <span style={{ color: "var(--text-muted)" }}>No aplica ({naFiles.size})</span>
        </div>
      </div>

      <div style={{ fontSize: 9, color: "var(--text-muted)", textAlign: "center" }}>
        Mueve el mouse para girar el cubo 3D Rubik
      </div>
    </div>
  );
}
