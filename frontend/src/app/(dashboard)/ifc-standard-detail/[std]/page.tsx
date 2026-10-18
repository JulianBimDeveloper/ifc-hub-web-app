"use client";

import { useParams } from "next/navigation";

export default function StandardDetailPage() {
  const { std } = useParams<{ std: string }>();
  return (
    <div>
      <h1 style={{
        fontSize: 20, fontWeight: 700, color: "var(--cyan)",
        letterSpacing: "0.04em", marginBottom: 8,
      }}>
        ESTÁNDAR: {std?.toUpperCase()}
      </h1>
      <div className="card-cyber" style={{ padding: 24, textAlign: "center" }}>
        <div style={{ color: "var(--text-muted)", fontSize: 14 }}>
          Detalle del estándar en construcción
        </div>
      </div>
    </div>
  );
}
