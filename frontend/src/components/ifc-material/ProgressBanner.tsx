"use client";

/**
 * Barra de progreso para operaciones largas de IFC Material.
 * - Con done/total: barra rellena proporcional.
 * - Sin done/total: animación de sliding.
 */
export function ProgressBanner({
  label,
  phase,
  done,
  total,
}: {
  label: string;
  phase: string;
  done?: number;
  total?: number;
}) {
  const hasCounts = done != null && total != null && total > 0;
  const pct = hasCounts ? Math.min(100, Math.round((done! / total!) * 100)) : null;

  return (
    <div
      style={{
        background: "rgba(91,140,255,0.06)",
        border: "1px solid rgba(91,140,255,0.2)",
        borderRadius: 6,
        padding: "8px 14px",
        marginBottom: 12,
        overflow: "hidden",
        position: "relative",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 11,
          marginBottom: 6,
          position: "relative",
          zIndex: 1,
        }}
      >
        <span style={{ color: "var(--cyan)", fontWeight: 700 }}>{label}</span>
        <span style={{ color: "var(--text-muted)" }}>
          {hasCounts ? `${done}/${total}` : phase}
        </span>
      </div>
      {hasCounts && (
        <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4, position: "relative", zIndex: 1 }}>
          {phase}
        </div>
      )}
      {/* Barra de progreso */}
      <div style={{ height: 3, background: "rgba(91,140,255,0.12)", borderRadius: 2, overflow: "hidden" }}>
        {pct !== null ? (
          <div
            style={{
              height: "100%",
              width: `${pct}%`,
              background: "var(--cyan)",
              borderRadius: 2,
              transition: "width 0.3s ease",
            }}
          />
        ) : (
          <div
            style={{
              height: "100%",
              width: "40%",
              background: "var(--cyan)",
              borderRadius: 2,
              animation: "progress-slide 1.4s ease-in-out infinite",
            }}
          />
        )}
      </div>
      <style jsx>{`
        @keyframes progress-slide {
          0%   { transform: translateX(-250%); }
          50%  { transform: translateX(300%); }
          100% { transform: translateX(300%); }
        }
      `}</style>
    </div>
  );
}
