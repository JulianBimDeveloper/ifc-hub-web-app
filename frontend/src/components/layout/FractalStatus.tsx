"use client";

/**
 * FractalStatus — fractal tree of the loaded project, one glance per model/tool.
 *
 * Structure (self-similar branching, trunk → leaves → twigs):
 *   · Centre = the project (all loaded IFC files).
 *   · Branches = the filename hierarchy: models sharing a discipline
 *     (ARQUITECTURA, ESTRUCTURA → RVT/C3D, …) fork off the same branch, and the
 *     zone (MAM / MAD / MNU / MTE) is the last fork. More models → more branches.
 *   · Every model tip splits again into one twig per ribbon group that acts on
 *     a model (INJECT · DATA · VALIDATE), always in that order clockwise, and
 *     each dot on a twig is one tool of that group.
 *   · Dot colour = that tool's health for that model (toolStatusStore.fileStatuses):
 *     green OK · amber differences · red missing · blue loading · grey not yet run.
 *     Group is told apart by twig position + dot shape (● ◆ ▲), colour stays
 *     reserved for health.
 *
 * Groups that don't act on a model (MAIN/EXPLORE/DOCS/SYSTEM) are not drawn.
 * The sidebar version is a glance; the expand button opens a large labelled view.
 */

import { useMemo, useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useRouter, usePathname } from "next/navigation";
import { Maximize2, X } from "lucide-react";
import { useToolStatusStore, ToolHealth } from "@/stores/toolStatusStore";
import { useProjectStore, IFCFileEntry } from "@/stores/projectStore";
import { GROUPS } from "./Toolbar";

// ── Tools per model — derived from the ribbon (Toolbar.tsx GROUPS) ─────────
// Only groups that act on a model get a twig; shapes tell them apart since
// colour is reserved for health. New tools added to the ribbon show up here
// automatically.

type Shape = "circle" | "diamond" | "triangle";
interface TwigTool { label: string; href: string; slug: string; }
interface TwigGroup { id: string; label: string; shape: Shape; tools: TwigTool[]; }

const TWIG_SHAPES: Record<string, Shape> = { inject: "circle", data: "diamond", validate: "triangle" };

const slugOf = (href: string) => href.replace(/^\//, "");

const TWIG_GROUPS: TwigGroup[] = GROUPS
  .filter(g => g.id in TWIG_SHAPES)
  .map(g => ({
    id: g.id, label: g.label, shape: TWIG_SHAPES[g.id],
    tools: g.items.map(t => ({ label: t.label, href: t.href, slug: slugOf(t.href) })),
  }));

const HEALTH: Record<ToolHealth, { color: string; label: string; opacity: number }> = {
  match:   { color: "var(--green)",        label: "OK",             opacity: 1    },
  diff:    { color: "var(--yellow)",       label: "Diferencias",    opacity: 1    },
  missing: { color: "var(--red)",          label: "Faltan valores", opacity: 1    },
  loading: { color: "var(--cyan)",         label: "Cargando…",      opacity: 0.6  },
  none:    { color: "var(--text-muted)",   label: "Sin aplicar",   opacity: 0.32 },
};

// Worst-wins roll-up used for model tips and branches.
const RANK: Record<ToolHealth, number> = { none: 0, match: 1, loading: 2, diff: 3, missing: 4 };
function worst(list: ToolHealth[]): ToolHealth {
  let w: ToolHealth = "none";
  for (const h of list) if (RANK[h] > RANK[w]) w = h;
  return w;
}

// ── Filename → hierarchy path ──────────────────────────────────────────────
// "000000000001-ACO-MOP-ME-ARQ-523110-442_MAM_ARQUITECTURA.ifc"
//   → ["ARQUITECTURA", "MAM"]      (discipline first, zone as the last fork)
// "…442_MAD_ESTRUCTURA_RVT.ifc" → ["ESTRUCTURA", "RVT", "MAD"]

const ZONE_RE = /^M[A-Z]{2}$/;

function modelPath(filename: string): { tokens: string[]; short: string } {
  const full = filename.replace(/\.ifc$/i, "");
  const m = full.match(/(\d{2,4})_([A-Z0-9]+(?:_[A-Z0-9]+)*)/i);
  const raw = m ? m[2] : full.split(/[-\s]/).pop() || full;
  const parts = raw.toUpperCase().split("_").filter(Boolean);
  const short = m ? `${m[1]}_${m[2]}` : raw;
  const zi = parts.findIndex(p => ZONE_RE.test(p));
  if (zi >= 0 && parts.length > 1) {
    const zone = parts[zi];
    const rest = parts.filter((_, i) => i !== zi);
    return { tokens: [...rest, zone], short };
  }
  return { tokens: parts.length ? parts : [full], short };
}

// ── Tree ───────────────────────────────────────────────────────────────────

interface TNode {
  key: string;
  label: string;
  children: TNode[];
  file?: IFCFileEntry;
  short?: string;
  leaves: number;
  depth: number;
  // layout (polar, radians / logical units)
  angle: number;
  radius: number;
  health: ToolHealth;
}

function buildTree(files: IFCFileEntry[]): TNode {
  const root: TNode = { key: "root", label: "PROYECTO", children: [], leaves: 0, depth: 0, angle: 0, radius: 0, health: "none" };
  const sorted = [...files].sort((a, b) => a.filename.localeCompare(b.filename));
  for (const f of sorted) {
    const { tokens, short } = modelPath(f.filename);
    let cur = root;
    tokens.forEach((tok, i) => {
      const isLeaf = i === tokens.length - 1;
      let child = isLeaf ? undefined : cur.children.find(c => c.label === tok && !c.file);
      if (!child) {
        child = { key: `${cur.key}/${tok}${isLeaf ? `#${f.path}` : ""}`, label: tok, children: [], leaves: 0, depth: 0, angle: 0, radius: 0, health: "none" };
        if (isLeaf) { child.file = f; child.short = short; }
        cur.children.push(child);
      }
      cur = child;
    });
  }
  // Collapse single-child internal chains (e.g. TEMPORAL → MTE) so the tree
  // only forks where models actually diverge.
  const collapse = (n: TNode): TNode => {
    n.children = n.children.map(collapse);
    if (n !== root && !n.file && n.children.length === 1) {
      const only = n.children[0];
      return { ...only, label: `${n.label} ${only.label}` };
    }
    return n;
  };
  collapse(root);
  const count = (n: TNode, d: number): number => {
    n.depth = d;
    n.leaves = n.file ? 1 : n.children.reduce((s, c) => s + count(c, d + 1), 0);
    return n.leaves;
  };
  count(root, 0);
  return root;
}

// Radial dendrogram: each subtree gets an angular wedge proportional to its
// leaves, all model tips end on the same ring so their twigs line up.
function layout(root: TNode, leafR: number) {
  let maxDepth = 1;
  const walk = (n: TNode) => { maxDepth = Math.max(maxDepth, n.depth); n.children.forEach(walk); };
  walk(root);
  const place = (n: TNode, a0: number, a1: number) => {
    n.angle = (a0 + a1) / 2;
    // Power < 1 pushes the first forks outward, giving the crowded centre room.
    n.radius = n.file ? leafR : leafR * Math.pow(n.depth / maxDepth, 0.6);
    let a = a0;
    for (const c of n.children) {
      const span = ((a1 - a0) * c.leaves) / Math.max(1, n.leaves);
      place(c, a, a + span);
      a += span;
    }
  };
  const start = -Math.PI / 2;
  place(root, start, start + Math.PI * 2);
  return maxDepth;
}

function leavesOf(n: TNode): TNode[] {
  return n.file ? [n] : n.children.flatMap(leavesOf);
}

// ── Drawing ────────────────────────────────────────────────────────────────

const VB = 400;
const C = VB / 2;

// Hexagonal frame (pointy-top, same as the FractalMark logo). HEX_R is the
// vertex radius; every point is progressively pulled onto hexagonal rings as
// it moves outward, so the centre stays round/organic and the rim reads as the
// logo's hexagon.
const HEX_R = 194;
const COS30 = Math.cos(Math.PI / 6);
function hexFactor(a: number) {
  const deg = (a * 180) / Math.PI;
  const delta = ((((deg + 30) % 60) + 60) % 60) - 30;  // 0 on an edge normal, ±30 at a vertex
  return COS30 / Math.cos((delta * Math.PI) / 180);
}
function pt(r: number, a: number) {
  const t = Math.min(1, r / HEX_R) ** 1.6;
  const rr = r * (1 + (hexFactor(a) - 1) * t);
  return { x: C + rr * Math.cos(a), y: C + rr * Math.sin(a) };
}
function hexAt(x: number, y: number, r: number) {
  return Array.from({ length: 6 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / 3;
    return `${(x + r * Math.cos(a)).toFixed(2)},${(y + r * Math.sin(a)).toFixed(2)}`;
  }).join(" ");
}
// Guide ring that follows the same round→hex morph as the tree itself.
function ringPath(r: number) {
  const n = 96;
  let d = "";
  for (let i = 0; i <= n; i++) {
    const p = pt(r, (i / n) * Math.PI * 2);
    d += `${i ? "L" : "M"}${p.x.toFixed(2)},${p.y.toFixed(2)}`;
  }
  return d + "Z";
}

// Small deterministic jitter so the tree doesn't look machine-perfect.
function hash01(key: string) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

// Branch as a tapered filled ribbon along a curved polar path — thick at the
// fork, thin at the tip, with a slight consistent twist (reads as growth, not a chart).
const TWIST = 0.16;
function taperedBranch(p: TNode, c: TNode, w0: number, w1: number) {
  const N = 18;
  const pts: { x: number; y: number }[] = [];
  const bend = TWIST * (0.6 + hash01(c.key) * 0.8) * (c.leaves > 1 ? 0.5 : 1);
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const e = t * t * (3 - 2 * t);               // ease: leaves radially, turns late
    const r = p.radius + (c.radius - p.radius) * t;
    // The root has no meaningful angle (radius 0) — its branches grow straight out.
    const a0 = p.radius === 0 ? c.angle : p.angle;
    const a = a0 + (c.angle - a0) * e + Math.sin(Math.PI * t) * bend;
    pts.push(pt(r, a));
  }
  const left: string[] = [], right: string[] = [];
  pts.forEach((q, i) => {
    const q0 = pts[Math.max(0, i - 1)], q1 = pts[Math.min(N, i + 1)];
    const dx = q1.x - q0.x, dy = q1.y - q0.y, len = Math.hypot(dx, dy) || 1;
    const w = (w0 + (w1 - w0) * (i / N)) / 2;
    const nx = (-dy / len) * w, ny = (dx / len) * w;
    left.push(`${(q.x + nx).toFixed(2)},${(q.y + ny).toFixed(2)}`);
    right.push(`${(q.x - nx).toFixed(2)},${(q.y - ny).toFixed(2)}`);
  });
  return `M${left.join(" L")} L${right.reverse().join(" L")} Z`;
}

function DotShape({ shape, x, y, r, fill, stroke, opacity }: { shape: Shape; x: number; y: number; r: number; fill: string; stroke?: string; opacity: number }) {
  const common = { fill, stroke: stroke ?? "none", strokeWidth: stroke ? 0.8 : 0, opacity, style: { transition: "fill 0.5s ease-out" } };
  if (shape === "diamond") {
    const s = r * 1.25;
    return <path d={`M${x},${y - s} L${x + s},${y} L${x},${y + s} L${x - s},${y} Z`} {...common} />;
  }
  if (shape === "triangle") {
    const s = r * 1.35;
    return <path d={`M${x},${y - s} L${x + s * 0.9},${y + s * 0.6} L${x - s * 0.9},${y + s * 0.6} Z`} {...common} />;
  }
  return <circle cx={x} cy={y} r={r} {...common} />;
}

interface Dot { x: number; y: number; group: TwigGroup; tool: TwigTool; health: ToolHealth; model: TNode; }
interface Hover { title: string; sub: string; color: string; }

function FractalTree({ large, onHover }: { large: boolean; onHover: (h: Hover | null) => void }) {
  const files = useProjectStore(s => s.files);
  const selected = useProjectStore(s => s.selectedPaths);
  const fileStatuses = useToolStatusStore(s => s.fileStatuses);
  const router = useRouter();
  const pathname = usePathname();

  const { root, dots, twigs, maxDepth, leafR } = useMemo(() => {
    const root = buildTree(files);
    const LEAF_R = large ? 128 : 122;
    const TWIG_LEN = large ? 58 : 66;
    const maxDepth = layout(root, LEAF_R);
    const leaves = leavesOf(root);
    const wedge = (Math.PI * 2) / Math.max(1, leaves.length);
    const fan = Math.min(wedge * 0.34, 0.32); // angular gap between twigs
    const dots: Dot[] = [];
    const twigs: { d: string; model: TNode; group: TwigGroup }[] = [];

    for (const leaf of leaves) {
      const path = leaf.file!.path;
      const healths: ToolHealth[] = [];
      TWIG_GROUPS.forEach((g, gi) => {
        const off = (gi - (TWIG_GROUPS.length - 1) / 2) * fan;
        const a = leaf.angle + off;
        const start = pt(leaf.radius, leaf.angle);
        const end = pt(leaf.radius + TWIG_LEN, a);
        const mid = pt(leaf.radius + TWIG_LEN * 0.4, leaf.angle + off * 0.2);
        twigs.push({ d: `M${start.x},${start.y} Q${mid.x},${mid.y} ${end.x},${end.y}`, model: leaf, group: g });
        g.tools.forEach((t, ti) => {
          const f = (ti + 1) / (g.tools.length + 0.4);
          const r = leaf.radius + TWIG_LEN * f;
          const j = hash01(`${path}|${t.slug}`) - 0.5;
          const aa = leaf.angle + off * Math.min(1, 0.2 + f * f * 1.1) + j * fan * 0.12;
          const p = pt(r + j * 2.5, aa);
          const h = fileStatuses[t.slug]?.[path] ?? "none";
          healths.push(h);
          dots.push({ x: p.x, y: p.y, group: g, tool: t, health: h, model: leaf });
        });
      });
      leaf.health = worst(healths);
    }
    // Roll health up to the branches (worst child wins).
    const up = (n: TNode): ToolHealth => {
      if (!n.file) n.health = worst(n.children.map(up));
      return n.health;
    };
    up(root);
    return { root, dots, twigs, maxDepth, leafR: LEAF_R };
  }, [files, fileStatuses, large]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const isLit = (n: TNode): boolean =>
    selectedSet.size === 0 || (n.file ? selectedSet.has(n.file.path) : n.children.some(isLit));

  const edges: { d: string; w: number; lit: boolean; node: TNode }[] = [];
  const collect = (n: TNode) => {
    for (const c of n.children) {
      const w0 = 1 + Math.sqrt(c.leaves) * (large ? 1.6 : 2.1);
      const w1 = c.file ? 0.9 : 1 + Math.sqrt(c.leaves) * (large ? 0.9 : 1.2);
      edges.push({ d: taperedBranch(n, c, w0, w1), w: w0, lit: isLit(c), node: c });
      collect(c);
    }
  };
  collect(root);

  const dotR = large ? 3.4 : 4.2;
  const empty = files.length === 0;

  return (
    <svg viewBox={`0 0 ${VB} ${VB}`} preserveAspectRatio="xMidYMid meet" style={{ width: "100%", height: "100%", display: "block" }}>
      <defs>
        <radialGradient id={large ? "fractalCoreL" : "fractalCore"} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--cyan)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--cyan)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Hexagon frame — same double-hex language as the FractalMark logo */}
      <polygon points={hexAt(C, C, HEX_R)} fill="var(--cyan)" fillOpacity={0.025} stroke="var(--cyan)" strokeOpacity={0.55}
        strokeWidth={large ? 1.2 : 2} strokeLinejoin="round" />
      <polygon points={hexAt(C, C, HEX_R - (large ? 6 : 9))} fill="none" stroke="var(--cyan)" strokeOpacity={0.14}
        strokeWidth={0.8} strokeLinejoin="round" />

      {/* Depth rings — morph from round (centre) to hexagonal (rim) */}
      {Array.from({ length: maxDepth }, (_, i) => (
        <path key={i} d={ringPath(leafR * Math.pow((i + 1) / maxDepth, 0.6))} fill="none" stroke="var(--border-bright)"
          strokeWidth={0.5} strokeDasharray="1 4" opacity={0.5} />
      ))}

      <circle cx={C} cy={C} r={30} fill={`url(#${large ? "fractalCoreL" : "fractalCore"})`} />

      {/* Branches */}
      {edges.map(e => (
        <path
          key={e.node.key}
          d={e.d}
          fill={e.node.health === "none" ? "var(--cyan)" : HEALTH[e.node.health].color}
          opacity={e.lit ? (e.node.health === "none" ? 0.5 : 0.75) : 0.14}
          style={{ transition: "fill 0.5s ease-out, opacity 0.3s" }}
        />
      ))}

      {/* Twigs (one per group at every model tip) */}
      {twigs.map(t => (
        <path key={`${t.model.key}-${t.group.id}`} d={t.d} fill="none" stroke="var(--border-bright)" strokeWidth={large ? 0.8 : 1}
          opacity={isLit(t.model) ? 0.8 : 0.2} strokeLinecap="round" />
      ))}

      {/* Core — the logo's inner hexagon + nucleus, where every branch is born */}
      <polygon points={hexAt(C, C, large ? 11 : 14)} fill="var(--surface)" stroke="var(--cyan)" strokeWidth={large ? 1 : 1.4} strokeLinejoin="round" />
      <polygon points={hexAt(C, C, large ? 11 : 14)} fill="var(--cyan)" fillOpacity={0.16} />
      <circle cx={C} cy={C} r={large ? 2.4 : 3.2} fill="var(--cyan)" />

      {/* Internal fork nodes */}
      {edges.filter(e => !e.node.file).map(e => {
        const p = pt(e.node.radius, e.node.angle);
        return (
          <g key={`n-${e.node.key}`}
            onMouseEnter={() => onHover({ title: e.node.label, sub: `${e.node.leaves} modelo(s) · ${HEALTH[e.node.health].label}`, color: HEALTH[e.node.health].color })}
            onMouseLeave={() => onHover(null)}>
            <polygon points={hexAt(p.x, p.y, large ? 3.6 : 4.6)} fill="var(--surface)" stroke="var(--cyan)" strokeWidth={1.1}
              strokeLinejoin="round" opacity={e.lit ? 1 : 0.3} />
            {large && (() => {
              // Radial label just past the fork, flipped on the left half to stay upright.
              const deg = (e.node.angle * 180) / Math.PI;
              const flip = deg > 90 && deg < 270;
              const lp = pt(e.node.radius + 5, e.node.angle);
              return (
                <text x={lp.x} y={lp.y} transform={`rotate(${flip ? deg + 180 : deg} ${lp.x} ${lp.y})`}
                  textAnchor={flip ? "end" : "start"} dominantBaseline="middle" fontSize={6.5} fill="var(--cyan)"
                  style={{ fontFamily: "var(--font-plex-mono), monospace", pointerEvents: "none", letterSpacing: "0.04em", paintOrder: "stroke", stroke: "var(--surface)", strokeWidth: 2 }}>
                  {e.node.label}
                </text>
              );
            })()}
          </g>
        );
      })}

      {/* Model tips */}
      {leavesOf(root).map(l => {
        const p = pt(l.radius, l.angle);
        const lit = isLit(l);
        const deg = (l.angle * 180) / Math.PI;
        const flip = deg > 90 && deg < 270;
        const lp = pt(l.radius - 7, l.angle);
        return (
          <g key={`m-${l.key}`}
            onMouseEnter={() => onHover({ title: l.short ?? l.label, sub: `Modelo · ${HEALTH[l.health].label}`, color: HEALTH[l.health].color })}
            onMouseLeave={() => onHover(null)}>
            <circle cx={p.x} cy={p.y} r={large ? 4.2 : 5.5} fill={HEALTH[l.health].color} opacity={lit ? 1 : 0.3}
              stroke="var(--surface)" strokeWidth={1.2} style={{ transition: "fill 0.5s ease-out" }} />
            {large && (
              <text
                x={lp.x} y={lp.y}
                transform={`rotate(${flip ? deg + 180 : deg} ${lp.x} ${lp.y})`}
                textAnchor={flip ? "start" : "end"} dominantBaseline="middle"
                fontSize={6} fill={lit ? "var(--text)" : "var(--text-muted)"}
                style={{ fontFamily: "var(--font-plex-mono), monospace", pointerEvents: "none", paintOrder: "stroke", stroke: "var(--surface)", strokeWidth: 2 }}>
                {l.label}
              </text>
            )}
          </g>
        );
      })}

      {/* Tool dots */}
      {dots.map(d => {
        const active = pathname.startsWith(d.tool.href);
        const hs = HEALTH[d.health];
        const lit = isLit(d.model);
        return (
          <g key={`${d.model.key}-${d.tool.slug}`} style={{ cursor: "pointer" }}
            onClick={() => router.push(d.tool.href)}
            onMouseEnter={() => onHover({ title: `${d.group.label} · ${d.tool.label}`, sub: `${d.model.short ?? d.model.label} · ${hs.label}`, color: hs.color })}
            onMouseLeave={() => onHover(null)}>
            <circle cx={d.x} cy={d.y} r={dotR + 3} fill="transparent" />
            <DotShape shape={d.group.shape} x={d.x} y={d.y} r={active ? dotR * 1.25 : dotR}
              fill={hs.color} stroke={active ? "var(--text)" : undefined}
              opacity={(lit ? 1 : 0.25) * hs.opacity} />
          </g>
        );
      })}

      {empty && (
        <text x={C} y={C + 4} textAnchor="middle" fontSize={11} fill="var(--text-muted)" style={{ fontFamily: "var(--font-plex-mono), monospace" }}>
          sin modelos
        </text>
      )}
    </svg>
  );
}

function Legend() {
  const mono = { fontFamily: "var(--font-plex-mono), monospace" } as const;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px", fontSize: 10, color: "var(--text-muted)", ...mono }}>
      {(["match", "diff", "missing", "loading", "none"] as ToolHealth[]).map(h => (
        <span key={h} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: HEALTH[h].color }} />{HEALTH[h].label}
        </span>
      ))}
      <span style={{ width: "100%" }} />
      {TWIG_GROUPS.map(g => (
        <span key={g.id} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <svg width={10} height={10} viewBox="-5 -5 10 10"><DotShape shape={g.shape} x={0} y={0} r={3.2} fill="var(--text-muted)" opacity={1} /></svg>
          {g.label} <span style={{ opacity: 0.7 }}>({g.tools.map(t => t.label).join(", ")})</span>
        </span>
      ))}
    </div>
  );
}

export function FractalStatus() {
  const files = useProjectStore(s => s.files);
  const fileStatuses = useToolStatusStore(s => s.fileStatuses);
  const [hovered, setHovered] = useState<Hover | null>(null);
  const [expanded, setExpanded] = useState(false);

  // Trig-based layout differs enough between SSR and the browser to trip
  // React's hydration diff — decorative widget, so client-only mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const onHover = useCallback((h: Hover | null) => setHovered(h), []);

  // "x/y OK" over every (model × tool) pair that has actually been evaluated.
  const { ok, evaluated, total } = useMemo(() => {
    let ok = 0, evaluated = 0;
    const paths = new Set(files.map(f => f.path));
    for (const g of TWIG_GROUPS) for (const t of g.tools) {
      const m = fileStatuses[t.slug];
      if (!m) continue;
      for (const [p, h] of Object.entries(m)) {
        if (!paths.has(p) || h === "none") continue;
        evaluated++;
        if (h === "match") ok++;
      }
    }
    return { ok, evaluated, total: files.length * TWIG_GROUPS.reduce((s, g) => s + g.tools.length, 0) };
  }, [files, fileStatuses]);

  if (!mounted) {
    return <div style={{ height: 190, borderBottom: "1px solid var(--border)", flexShrink: 0 }} />;
  }

  const caption = hovered
    ? <><span style={{ color: hovered.color }}>{hovered.title}</span> <span style={{ opacity: 0.8 }}>· {hovered.sub}</span></>
    : <span>{files.length} modelos · {ok}/{evaluated} OK · {total - evaluated} sin aplicar</span>;

  return (
    <>
      <div style={{ position: "relative", padding: "6px 8px 6px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <button
          onClick={() => setExpanded(true)}
          title="Ampliar árbol fractal"
          style={{
            position: "absolute", top: 4, right: 4, zIndex: 1, padding: 3, lineHeight: 0,
            background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer",
          }}
        >
          <Maximize2 size={11} />
        </button>
        <div style={{ width: "100%", maxWidth: 220, aspectRatio: "1 / 1", margin: "0 auto" }}>
          <FractalTree large={false} onHover={onHover} />
        </div>
        <div style={{
          marginTop: 2, textAlign: "center", fontSize: 8, color: "var(--text-muted)",
          fontFamily: "var(--font-plex-mono), monospace", letterSpacing: "0.04em", minHeight: 11,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {caption}
        </div>
      </div>

      {/* Portal: the sidebar is its own containing block, so a fixed overlay
          rendered in place would be clipped to it. */}
      {expanded && createPortal(
        <div
          onClick={() => setExpanded(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "color-mix(in srgb, var(--background) 70%, transparent)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: "min(820px, 100%)", maxHeight: "100%", overflow: "auto",
              background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8,
              padding: 16, display: "flex", flexDirection: "column", gap: 10,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", color: "var(--cyan)", fontFamily: "var(--font-plex-mono), monospace" }}>
                ÁRBOL FRACTAL DEL PROYECTO
              </span>
              <span style={{ flex: 1 }} />
              <button onClick={() => setExpanded(false)} title="Cerrar (Esc)"
                style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", lineHeight: 0 }}>
                <X size={16} />
              </button>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-plex-mono), monospace", minHeight: 16 }}>
              {caption}
            </div>
            <div style={{ width: "100%", aspectRatio: "1 / 1", maxHeight: "68vh", margin: "0 auto" }}>
              <FractalTree large onHover={onHover} />
            </div>
            <Legend />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
