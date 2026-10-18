"use client";

import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { getPB } from "@/lib/pb";
import { FileBox, Layers, CheckSquare, Activity } from "lucide-react";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

function useCount(collection: string) {
  return useQuery({
    queryKey: ["count", collection],
    queryFn: async () => {
      const r = await getPB().collection(collection).getList(1, 1, { requestKey: null });
      return r.totalItems;
    },
    retry: 1,
    staleTime: 30_000,
  });
}

function KpiCard({ label, value, icon: Icon, color }: {
  label: string; value: number | string | undefined; icon: any; color: string;
}) {
  return (
    <div style={{
      background: "var(--surface)", border: "1px solid var(--border)",
      borderRadius: 6, padding: "16px 20px",
      display: "flex", alignItems: "center", gap: 14,
      boxShadow: "var(--shadow-sm)",
    }}>
      <div style={{
        width: 40, height: 40, borderRadius: 6, background: `${color}18`,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <Icon size={18} color={color} />
      </div>
      <div>
        <div style={{ fontSize: 24, fontWeight: 700, color, lineHeight: 1.2 }}>
          {value ?? "—"}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
          {label}
        </div>
      </div>
    </div>
  );
}

function activityChart(data: number[]) {
  return {
    backgroundColor: "transparent",
    grid: { left: 40, right: 16, top: 16, bottom: 24 },
    xAxis: {
      type: "category", data: ["L", "M", "X", "J", "V", "S", "D"],
      axisLine: { lineStyle: { color: "#1e2d4a" } },
      axisLabel: { color: "#6b7a99", fontSize: 11 },
    },
    yAxis: {
      type: "value", axisLine: { show: false },
      axisLabel: { color: "#6b7a99", fontSize: 11 },
      splitLine: { lineStyle: { color: "#1e2d4a", type: "dashed" } },
    },
    series: [{
      data, type: "line", smooth: true,
      lineStyle: { color: "#5B8CFF", width: 2 },
      itemStyle: { color: "#5B8CFF" },
      areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1,
        colorStops: [
          { offset: 0, color: "rgba(91,140,255,0.25)" },
          { offset: 1, color: "rgba(91,140,255,0)" },
        ],
      }},
      symbol: "circle", symbolSize: 4,
    }],
  };
}

function donutChart(items: { name: string; value: number; color: string }[]) {
  return {
    backgroundColor: "transparent",
    tooltip: { trigger: "item", backgroundColor: "#0a0f1e", borderColor: "#1e2d4a",
      textStyle: { color: "#c8d6f0", fontFamily: "var(--font-plex-mono)" } },
    legend: { show: false },
    series: [{
      type: "pie", radius: ["50%", "75%"],
      data: items.map(i => ({ ...i, itemStyle: { color: i.color } })),
      label: { show: false }, emphasis: { scale: false },
    }],
  };
}

export function DashboardContent() {
  const models   = useCount("ifc_models");
  const params   = useCount("ifc_params");
  const products = useCount("master_productos");
  const mappings = useCount("midp_mapping");

  const mockActivity = [12, 18, 9, 24, 16, 8, 21];
  const donutData = [
    { name: "Modelos",    value: models.data   ?? 0, color: "#5B8CFF" },
    { name: "Parámetros", value: params.data   ?? 0, color: "#4FA8C9" },
    { name: "Productos",  value: products.data ?? 0, color: "#3FBE8A" },
    { name: "Mappings",   value: mappings.data ?? 0, color: "#D9A441" },
  ];

  const tools = [
    { name: "IFC Metadata",    href: "/ifc-metadata" },
    { name: "Name Validator",  href: "/ifc-name-validator" },
    { name: "Classifier",      href: "/ifc-classify" },
    { name: "Structure",       href: "/ifc-structure" },
    { name: "Value Search",    href: "/ifc-value-search" },
    { name: "Material",        href: "/ifc-material" },
    { name: "Export Control",  href: "/ifc-export-control" },
    { name: "Relation Params", href: "/ifc-relation-params" },
    { name: "Nomenclature",    href: "/ifc-nomenclature" },
    { name: "Name-Type-ID",    href: "/ifc-name-type-id" },
    { name: "Model Checker",   href: "/ifc-model-checker" },
    { name: "Duplicates",      href: "/ifc-duplicates" },
    { name: "Standards Audit", href: "/ifc-standards-audit" },
    { name: "BIM Scope",       href: "/bim-scope" },
    { name: "3D Viewer",       href: "/viewer" },
  ];

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{
          fontSize: 22, fontWeight: 700, color: "var(--text-bright)",
          letterSpacing: "-0.01em",
        }}>
          Dashboard
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
          Fractal IFC — BIM Intelligence Suite
        </p>
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: 12, marginBottom: 24,
      }}>
        <KpiCard label="IFC Models"    value={models.data}   icon={FileBox}     color="#5B8CFF" />
        <KpiCard label="Parámetros"    value={params.data}   icon={Layers}      color="#5B8CFF" />
        <KpiCard label="Productos"     value={products.data} icon={CheckSquare} color="#5B8CFF" />
        <KpiCard label="MIDP Mappings" value={mappings.data} icon={Activity}    color="#5B8CFF" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, marginBottom: 24 }}>
        <div className="card-cyber" style={{ padding: 16 }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10,
            textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Actividad semanal
          </div>
          <ReactECharts option={activityChart(mockActivity)} style={{ height: 160 }} opts={{ renderer: "canvas" }} />
        </div>
        <div className="card-cyber" style={{ padding: 16 }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10,
            textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Distribución
          </div>
          <ReactECharts option={donutChart(donutData)} style={{ height: 160 }} opts={{ renderer: "canvas" }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
            {donutData.map(d => (
              <div key={d.name} style={{ display: "flex", justifyContent: "space-between",
                fontSize: 11, color: "var(--text-muted)" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%",
                    background: d.color, display: "inline-block" }} />
                  {d.name}
                </span>
                <span style={{ color: "var(--text-bright)", fontWeight: 600 }}>{d.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 8, fontSize: 11, color: "var(--text-muted)",
        textTransform: "uppercase", letterSpacing: "0.08em" }}>
        Herramientas disponibles
      </div>
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8,
      }}>
        {tools.map(t => (
          <a key={t.href} href={t.href} style={{
            background: "var(--surface)", border: "1px solid var(--border)",
            borderRadius: 6, padding: "10px 12px",
            display: "flex", alignItems: "center", justifyContent: "space-between",
            textDecoration: "none", transition: "all 0.15s",
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLElement).style.borderColor = "var(--border-bright)";
            (e.currentTarget as HTMLElement).style.background = "var(--surface-2)";
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLElement).style.borderColor = "var(--border)";
            (e.currentTarget as HTMLElement).style.background = "var(--surface)";
          }}
          >
            <span style={{ fontSize: 12, color: "var(--text)", fontWeight: 500 }}>{t.name}</span>
            <span className="badge-green badge" style={{ fontSize: 9 }}>ON</span>
          </a>
        ))}
      </div>
    </div>
  );
}
