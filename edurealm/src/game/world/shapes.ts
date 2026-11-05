/**
 * 程序化绘图工具：种子随机 / 有机形状 / 采样。
 * 手绘感的核心 = 带扰动的有机多边形 + 分层描边 + 细节图章。
 */

export interface Pt {
  x: number
  y: number
}

/** 字符串 → 32 位种子 */
export function hashSeed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** mulberry32 种子随机（可复现的世界） */
export class Rng {
  private s: number
  constructor(seed: number | string) {
    this.s = typeof seed === 'string' ? hashSeed(seed) : seed >>> 0
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  range(min: number, max: number): number {
    return min + this.next() * (max - min)
  }
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1))
  }
  pick<T>(arr: T[]): T {
    return arr[this.int(0, arr.length - 1)]
  }
  chance(p: number): boolean {
    return this.next() < p
  }
}

/**
 * 有机色块：绕中心的扰动闭合多边形（用于湖泊/草地/暗域等所有大地貌）。
 * wobble ∈ [0,1]，越大边缘越不规则。
 */
export function blob(cx: number, cy: number, rx: number, ry: number, wobble: number, points: number, rng: Rng): Pt[] {
  const pts: Pt[] = []
  const phase = rng.range(0, Math.PI * 2)
  for (let i = 0; i < points; i++) {
    const a = phase + (i / points) * Math.PI * 2
    const w = 1 + Math.sin(a * 3 + phase) * wobble * 0.35 + rng.range(-wobble, wobble) * 0.3
    pts.push({ x: cx + Math.cos(a) * rx * w, y: cy + Math.sin(a) * ry * w })
  }
  return pts
}

/** 平滑填充有机多边形（中点二次曲线，消除折角） */
export function traceSmooth(ctx: CanvasRenderingContext2D, pts: Pt[], close = true): void {
  const n = pts.length
  const mid = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  ctx.beginPath()
  const start = mid(pts[n - 1], pts[0])
  ctx.moveTo(start.x, start.y)
  for (let i = 0; i < n; i++) {
    const cur = pts[i]
    const next = pts[(i + 1) % n]
    const m = mid(cur, next)
    ctx.quadraticCurveTo(cur.x, cur.y, m.x, m.y)
  }
  if (close) ctx.closePath()
}

/** Catmull-Rom 采样：折线 → 平滑点列（用于道路/河流） */
export function smoothPolyline(waypoints: Pt[], seg = 16): Pt[] {
  if (waypoints.length < 3) {
    const [a, b] = waypoints
    const out: Pt[] = []
    for (let i = 0; i <= seg; i++) out.push({ x: a.x + ((b.x - a.x) * i) / seg, y: a.y + ((b.y - a.y) * i) / seg })
    return out
  }
  const pts = [waypoints[0], ...waypoints, waypoints[waypoints.length - 1]]
  const out: Pt[] = []
  for (let i = 1; i < pts.length - 2; i++) {
    const [p0, p1, p2, p3] = [pts[i - 1], pts[i], pts[i + 1], pts[i + 2]]
    for (let j = 0; j < seg; j++) {
      const t = j / seg
      const t2 = t * t
      const t3 = t2 * t
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      })
    }
  }
  out.push(waypoints[waypoints.length - 1])
  return out
}

/** 点到折线最近距离（用于树木避让道路/水域） */
export function distToPolyline(p: Pt, line: Pt[]): number {
  let best = Infinity
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]
    const b = line[i + 1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const l2 = dx * dx + dy * dy
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
    const d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
    if (d < best) best = d
  }
  return best
}

export function dist(p: Pt, q: Pt): number {
  return Math.hypot(p.x - q.x, p.y - q.y)
}

/** 圆集（河流以圆链表示，便于查询与避让） */
export function distToCircles(p: Pt, circles: { x: number; y: number; r: number }[]): number {
  let best = Infinity
  for (const c of circles) best = Math.min(best, Math.hypot(p.x - c.x, p.y - c.y) - c.r)
  return best
}
