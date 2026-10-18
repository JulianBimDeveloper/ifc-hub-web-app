"use client";

import { useRef, useState, useEffect } from "react";

/**
 * Lista virtualizada: solo monta en el DOM las filas visibles (+ overscan).
 * keyExtractor evita desmontaje/remontaje innecesario al reordenar listas.
 */
export function VirtualList<T>({
  items,
  rowHeight,
  overscan = 10,
  renderRow,
  keyExtractor,
}: {
  items: T[];
  rowHeight: number;
  overscan?: number;
  renderRow: (item: T, index: number) => React.ReactNode;
  keyExtractor?: (item: T, index: number) => string | number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const total = items.length;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(total, Math.ceil((scrollTop + viewportH) / rowHeight) + overscan);
  const visible = items.slice(start, end);

  return (
    <div
      ref={ref}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      style={{ flex: 1, overflowY: "auto", position: "relative" }}
    >
      <div style={{ height: total * rowHeight, position: "relative" }}>
        {visible.map((item, i) => {
          const idx = start + i;
          const key = keyExtractor ? keyExtractor(item, idx) : idx;
          return (
            <div
              key={key}
              style={{
                position: "absolute",
                top: idx * rowHeight,
                left: 0,
                right: 0,
                height: rowHeight,
              }}
            >
              {renderRow(item, idx)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
