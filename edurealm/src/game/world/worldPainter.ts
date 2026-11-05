/**
 * 世界画师 —— 把整个静态世界绘制进一张 Canvas 纹理（手绘奇幻战役地图）。
 *
 * 图层（绘制顺序 = 遮挡顺序）：
 *   底色草地 → 生态区色块（暗域/雪原/岩地/湖泊水系） → 远山剪影 →
 *   山脉/峡谷/悬崖 → 道路（土路/石路/木板桥） → 地表细节 →
 *   树木（阔叶/针叶/枯木，自动避让道路水域） → 村庄/学院/田野/风车/
 *   小船/营地/石阵/方尖碑 → 瀑布崖口 → 边缘暗角
 *
 * 动态元素（水光/瀑布/风车叶片/火把/树冠摆动/鸟群/云雾）由 ambient.ts 与
 * CloudLayer.ts 以活对象叠加，不在此绘制。
 */
import type { MapSpec, MapNodeSpec } from '../../schemas/types'
import type { Pt } from './shapes'
import { Rng, blob, traceSmooth, smoothPolyline, distToPolyline, distToCircles, dist } from './shapes'
import { BIOMES, WATER, ROAD } from './biomes'
export const WORLD_W = 2400
export const WORLD_H = 1350

export interface WorldMeta {
  textureKey: string
  /** 每条连边的平滑采样折线（世界坐标，供英雄行走） */
  edgeSamples: Map<string, Pt[]>
  /** 水域圆链（河流/湖泊），用于避让与检测 */
  water: { x: number; y: number; r: number }[]
  /** 火把/篝火位置（live 光晕） */
  torches: Pt[]
  /** 树冠摆动覆盖层位置 */
  swayTrees: { x: number; y: number; r: number }[]
  windmill: Pt
  waterfall: Pt
  boats: Pt[]
  lakeCenter: Pt
  bossCenter: Pt
}

interface PaintCtx {
  ctx: CanvasRenderingContext2D
  rng: Rng
  map: MapSpec
  nodes: Map<string, MapNodeSpec & { px: Pt }>
  water: { x: number; y: number; r: number }[]
  roadLines: Pt[][]
  structures: Pt[]
}

// ── 基础绘图小工具 ──────────────────────────────────────────────

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha = 1): void {
  ctx.globalAlpha = alpha
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = 1
}

function ell(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, color: string, alpha = 1, rot = 0): void {
  ctx.globalAlpha = alpha
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = 1
}

function poly(ctx: CanvasRenderingContext2D, pts: Pt[], color: string, alpha = 1): void {
  ctx.globalAlpha = alpha
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
  ctx.closePath()
  ctx.fill()
  ctx.globalAlpha = 1
}

/** 有机色块：暗色底 → 主体 → 亮核，三笔出体积 */
function paintBlobLayered(
  ctx: CanvasRenderingContext2D,
  pts: Pt[],
  dark: string,
  base: string,
  light: string,
  lightScale = 0.62,
): void {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
  traceSmooth(ctx, pts)
  ctx.fillStyle = dark
  ctx.fill()
  ctx.save()
  ctx.clip()
  ell(ctx, cx, cy + 4, (Math.max(...pts.map((p) => Math.abs(p.x - cx)))) * 0.98, (Math.max(...pts.map((p) => Math.abs(p.y - cy)))) * 0.98, base)
  const inner: Pt[] = pts.map((p) => ({ x: cx + (p.x - cx) * lightScale, y: cy + (p.y - cy) * lightScale }))
  traceSmooth(ctx, inner)
  ctx.fillStyle = light
  ctx.globalAlpha = 0.55
  ctx.fill()
  ctx.globalAlpha = 1
  ctx.restore()
}

// ── 地物图章 ────────────────────────────────────────────────────

function drawBroadleaf(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, b: (typeof BIOMES)['forest'], rng: Rng): void {
  ell(ctx, x + 3 * s, y + 5 * s, 13 * s, 5 * s, 'rgba(30,45,25,0.28)') // 影
  ctx.fillStyle = '#6e4f33'
  ctx.fillRect(x - 2 * s, y - 2 * s, 4 * s, 8 * s)
  const r = 11 * s
  circle(ctx, x - r * 0.45, y - r * 0.5, r * 0.78, b.treeDark)
  circle(ctx, x + r * 0.5, y - r * 0.42, r * 0.72, b.treeDark)
  circle(ctx, x, y - r * 0.85, r, b.treeMid)
  circle(ctx, x - r * 0.28, y - r * 1.05, r * 0.55, b.treeLight)
  if (rng.chance(0.5)) circle(ctx, x + r * 0.4, y - r * 1.0, r * 0.3, b.treeLight, 0.7)
}

function drawPine(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, b: (typeof BIOMES)['snow'], snowy: boolean, rng: Rng): void {
  ell(ctx, x + 3 * s, y + 4 * s, 10 * s, 4 * s, 'rgba(25,40,45,0.25)')
  ctx.fillStyle = '#5d4630'
  ctx.fillRect(x - 1.6 * s, y - 3 * s, 3.2 * s, 7 * s)
  const tiers = [
    { w: 11, h: 12, dy: -4 },
    { w: 8.4, h: 10, dy: -12 },
    { w: 5.6, h: 8, dy: -19 },
  ]
  for (const t of tiers) {
    poly(
      ctx,
      [
        { x: x - t.w * s, y: y + t.dy * s },
        { x: x + t.w * s, y: y + t.dy * s },
        { x, y: y + (t.dy - t.h) * s },
      ],
      rng.chance(0.5) ? b.treeDark : b.treeMid,
    )
    if (snowy) {
      poly(
        ctx,
        [
          { x: x - t.w * 0.55 * s, y: y + (t.dy - t.h * 0.45) * s },
          { x: x + t.w * 0.45 * s, y: y + (t.dy - t.h * 0.55) * s },
          { x, y: y + (t.dy - t.h) * s },
        ],
        '#f2f8fb',
      )
    }
  }
}

function drawDeadTree(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, rng: Rng): void {
  ell(ctx, x + 3 * s, y + 4 * s, 9 * s, 3.6 * s, 'rgba(10,8,16,0.35)')
  ctx.strokeStyle = '#453d52'
  ctx.lineWidth = 3.4 * s
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x - 1 * s, y - 16 * s)
  ctx.stroke()
  ctx.lineWidth = 2 * s
  const lean = rng.chance(0.5) ? 1 : -1
  ctx.beginPath()
  ctx.moveTo(x - 0.6 * s, y - 9 * s)
  ctx.lineTo(x - 9 * lean * s, y - 15 * s)
  ctx.moveTo(x - 0.8 * s, y - 12 * s)
  ctx.lineTo(x + 8 * lean * s, y - 19 * s)
  ctx.moveTo(x - 1 * s, y - 16 * s)
  ctx.lineTo(x - 4 * lean * s, y - 23 * s)
  ctx.stroke()
}

function drawHouse(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, roof: string): void {
  ell(ctx, x + 4 * s, y + 6 * s, 20 * s, 6 * s, 'rgba(30,40,25,0.3)')
  ctx.fillStyle = '#e7d9b8' // 墙
  ctx.fillRect(x - 13 * s, y - 12 * s, 26 * s, 17 * s)
  ctx.strokeStyle = 'rgba(120,95,60,0.5)'
  ctx.lineWidth = 1
  for (let i = 1; i < 3; i++) {
    ctx.beginPath()
    ctx.moveTo(x - 13 * s, y - 12 * s + i * 6 * s)
    ctx.lineTo(x + 13 * s, y - 12 * s + i * 6 * s)
    ctx.stroke()
  }
  poly(ctx, [{ x: x - 16 * s, y: y - 11 * s }, { x: x + 16 * s, y: y - 11 * s }, { x, y: y - 24 * s }], roof)
  ctx.fillStyle = '#5d4630'
  ctx.fillRect(x - 3 * s, y - 4 * s, 6 * s, 9 * s) // 门
  circle(ctx, x + 8 * s, y - 6 * s, 2.2 * s, '#4d3a26')
}

// ── 主画师 ──────────────────────────────────────────────────────

export function paintWorld(scene: Phaser.Scene, map: MapSpec, layout: Record<string, Pt>): WorldMeta {
  const key = `world-${map.worldId}`
  if (scene.textures.exists(key)) scene.textures.remove(key)
  const tex = scene.textures.createCanvas(key, WORLD_W, WORLD_H)!
  const ctx = tex.getContext()
  const rng = new Rng(`world:${map.worldId}`)

  // 节点像素位置与场景布局完全一致（保证道路/建筑对齐）
  const nodes = new Map<string, MapNodeSpec & { px: Pt }>()
  for (const n of map.nodes) {
    nodes.set(n.id, { ...n, px: layout[n.id] ?? { x: WORLD_W / 2, y: WORLD_H / 2 } })
  }

  const P: PaintCtx = { ctx, rng, map, nodes, water: [], roadLines: [], structures: [...nodes.values()].map((n) => n.px) }
  const meta: WorldMeta = {
    textureKey: key,
    edgeSamples: new Map(),
    water: P.water,
    torches: [],
    swayTrees: [],
    windmill: { x: 716, y: 1078 },
    waterfall: { x: 1330, y: 680 },
    boats: [
      { x: 1436, y: 986 },
      { x: 1608, y: 856 },
    ],
    lakeCenter: { x: 1500, y: 920 },
    bossCenter: nodes.get('throne_of_infinity')?.px ?? { x: 2160, y: 756 },
  }

  paintBase(P)
  paintDarkWastes(P)
  paintSnowfield(P)
  paintWater(P)
  paintDistantRange(P)
  paintMountains(P)
  paintRoads(P, map, meta)
  paintDetails(P, meta)
  paintTrees(P, meta)
  paintVillage(P, meta)
  paintDarkDecor(P, meta)

  // 边缘暗角
  const vg = ctx.createRadialGradient(WORLD_W / 2, WORLD_H / 2, WORLD_H * 0.42, WORLD_W / 2, WORLD_H / 2, WORLD_H * 0.95)
  vg.addColorStop(0, 'rgba(20,26,16,0)')
  vg.addColorStop(1, 'rgba(16,20,12,0.42)')
  ctx.fillStyle = vg
  ctx.fillRect(0, 0, WORLD_W, WORLD_H)

  tex.refresh()
  return meta
}

// ── 各层 ────────────────────────────────────────────────────────

function paintBase(P: PaintCtx): void {
  const { ctx, rng } = P
  ctx.fillStyle = BIOMES.forest.ground
  ctx.fillRect(0, 0, WORLD_W, WORLD_H)
  // 大笔触亮暗斑（绘画感）
  for (let i = 0; i < 26; i++) {
    const x = rng.range(0, WORLD_W)
    const y = rng.range(0, WORLD_H)
    const r = rng.range(120, 340)
    ell(ctx, x, y, r, r * rng.range(0.4, 0.7), rng.chance(0.5) ? '#9cc768' : '#7cb152', 0.16)
  }
  // 草地颗粒
  for (let i = 0; i < 2400; i++) {
    const x = rng.range(0, WORLD_W)
    const y = rng.range(0, WORLD_H)
    ctx.strokeStyle = rng.chance(0.5) ? 'rgba(90,140,60,0.5)' : 'rgba(160,200,110,0.4)'
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + rng.range(-2, 2), y - rng.range(2, 5))
    ctx.stroke()
  }
}

function paintDarkWastes(P: PaintCtx): void {
  const { ctx, rng } = P
  const b = blob(2190, 760, 430, 520, 0.5, 22, rng)
  paintBlobLayered(ctx, b, '#332d40', BIOMES.dark.ground, BIOMES.dark.groundLight, 0.6)
  // 与草地交界的不规则咬边
  for (let i = 0; i < 30; i++) {
    const p = b[rng.int(0, b.length - 1)]
    circle(ctx, p.x + rng.range(-30, 30), p.y + rng.range(-30, 30), rng.range(16, 44), '#383244', 0.8)
  }
}

function paintSnowfield(P: PaintCtx): void {
  const { ctx, rng } = P
  const b = blob(1980, 260, 420, 300, 0.45, 20, rng)
  paintBlobLayered(ctx, b, '#b9cdd9', BIOMES.snow.ground, '#f7fbfd', 0.7)
  for (let i = 0; i < 16; i++) {
    const p = b[rng.int(0, b.length - 1)]
    ell(ctx, p.x, p.y + 10, rng.range(30, 80), rng.range(10, 22), '#cfdfe9', 0.6)
  }
}

function paintWater(P: PaintCtx): void {
  const { ctx, rng } = P
  const lake = { x: 1500, y: 920, rx: 310, ry: 235 }

  // 湖泊
  const shore = blob(lake.x, lake.y, lake.rx, lake.ry, 0.16, 26, rng)
  traceSmooth(ctx, shore)
  ctx.fillStyle = WATER.shadow
  ctx.fill()
  ctx.save()
  traceSmooth(ctx, shore)
  ctx.clip()
  ctx.fillStyle = WATER.deep
  ctx.fill()
  // 深水渐变
  const g = ctx.createRadialGradient(lake.x, lake.y + 20, 40, lake.x, lake.y, lake.rx)
  g.addColorStop(0, WATER.mid)
  g.addColorStop(1, WATER.deep)
  ctx.fillStyle = g
  ctx.fillRect(lake.x - lake.rx, lake.y - lake.ry, lake.rx * 2, lake.ry * 2)
  // 浅滩（北岸入水口与南岸）
  ell(ctx, lake.x - 180, lake.y - 150, 130, 60, WATER.light, 0.5)
  ell(ctx, lake.x + 140, lake.y + 150, 150, 55, WATER.light, 0.42)
  // 波纹高光
  for (let i = 0; i < 40; i++) {
    const a = rng.range(0, Math.PI * 2)
    const rr = rng.range(0.15, 0.9)
    const x = lake.x + Math.cos(a) * lake.rx * rr
    const y = lake.y + Math.sin(a) * lake.ry * rr
    ctx.strokeStyle = 'rgba(220,240,248,0.5)'
    ctx.lineWidth = rng.range(1.4, 2.6)
    ctx.beginPath()
    ctx.arc(x, y, rng.range(6, 16), Math.PI * 1.1, Math.PI * 1.9)
    ctx.stroke()
  }
  ctx.restore()
  // 岸边泡沫圈
  traceSmooth(ctx, shore)
  ctx.strokeStyle = 'rgba(217,238,245,0.85)'
  ctx.lineWidth = 5
  ctx.stroke()
  traceSmooth(ctx, shore)
  ctx.strokeStyle = 'rgba(255,255,255,0.5)'
  ctx.lineWidth = 2
  ctx.stroke()

  // 湖心小岛 + 石碑
  const island = blob(lake.x + 40, lake.y - 40, 46, 30, 0.3, 12, rng)
  traceSmooth(ctx, island)
  ctx.fillStyle = '#7ea854'
  ctx.fill()
  ctx.strokeStyle = '#d9eef5'
  ctx.lineWidth = 3
  ctx.stroke()
  ctx.fillStyle = '#8b8478'
  ctx.fillRect(lake.x + 36, lake.y - 62, 7, 20)
  poly(ctx, [{ x: lake.x + 30, y: lake.y - 60 }, { x: lake.x + 49, y: lake.y - 60 }, { x: lake.x + 39.5, y: lake.y - 70 }], '#a89c8c')

  // 河：北山 → 湖（圆链表示，宽度渐变）
  const riverWps: Pt[] = [
    { x: 1230, y: -30 },
    { x: 1130, y: 190 },
    { x: 1000, y: 380 },
    { x: 930, y: 540 },
    { x: 950, y: 700 },
    { x: 1050, y: 815 },
    { x: 1210, y: 862 },
    { x: 1362, y: 828 },
  ]
  const river = smoothPolyline(riverWps, 18)
  strokeRiver(ctx, river, 30)
  addCirclesFromLine(P.water, river, 17)

  // 湖出口 → 东南湿地
  const outWps: Pt[] = [
    { x: 1600, y: 1090 },
    { x: 1740, y: 1170 },
    { x: 1900, y: 1210 },
    { x: 2120, y: 1180 },
    { x: 2340, y: 1225 },
    { x: 2450, y: 1200 },
  ]
  const outlet = smoothPolyline(outWps, 18)
  strokeRiver(ctx, outlet, 24)
  addCirclesFromLine(P.water, outlet, 14)

  // 湿地小水洼
  for (let i = 0; i < 7; i++) {
    const p = outlet[rng.int(10, outlet.length - 10)]
    const pond = blob(p.x + rng.range(-60, 60), p.y + rng.range(-46, 46), rng.range(20, 46), rng.range(12, 26), 0.4, 10, rng)
    traceSmooth(ctx, pond)
    ctx.fillStyle = WATER.mid
    ctx.fill()
    ctx.strokeStyle = 'rgba(217,238,245,0.7)'
    ctx.lineWidth = 2.4
    ctx.stroke()
  }
}

function strokeRiver(ctx: CanvasRenderingContext2D, line: Pt[], width: number): void {
  const stroke = (w: number, c: string, a = 1) => {
    ctx.strokeStyle = c
    ctx.globalAlpha = a
    ctx.lineWidth = w
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(line[0].x, line[0].y)
    for (const p of line) ctx.lineTo(p.x, p.y)
    ctx.stroke()
    ctx.globalAlpha = 1
  }
  stroke(width + 8, 'rgba(50,90,60,0.35)') // 岸线植被暗边
  stroke(width + 3, WATER.shadow)
  stroke(width, WATER.deep)
  stroke(width * 0.55, WATER.mid)
  stroke(width * 0.2, WATER.light, 0.8)
}

function addCirclesFromLine(acc: { x: number; y: number; r: number }[], line: Pt[], r: number): void {
  for (let i = 0; i < line.length; i += 2) acc.push({ x: line[i].x, y: line[i].y, r })
}

function paintDistantRange(P: PaintCtx): void {
  const { ctx, rng } = P
  // 远景剪影（最北，弱对比）
  for (const [base, color, alpha] of [
    [150, '#8fa887', 0.5],
    [105, '#9db493', 0.65],
  ] as [number, string, number][]) {
    ctx.fillStyle = color
    ctx.globalAlpha = alpha
    ctx.beginPath()
    ctx.moveTo(-20, base + 60)
    let x = -20
    while (x < WORLD_W + 20) {
      const w = rng.range(90, 200)
      const h = rng.range(40, 130)
      ctx.lineTo(x + w / 2, base - h)
      ctx.lineTo(x + w, base + 20)
      x += w
    }
    ctx.lineTo(WORLD_W + 20, base + 80)
    ctx.closePath()
    ctx.fill()
    ctx.globalAlpha = 1
  }
}

/**
 * 手绘山体 —— 真实感的来源：
 *  1. 锯齿山脊（主峰 + 多副峰 + 肩部转折），山体彼此重叠成"山脉"而非孤三角
 *  2. 左亮右暗的体积光（线性渐变 + 分面）
 *  3. 顺坡岩层带 / 峰顶向下的裂缝 / 点彩岩石肌理
 *  4. 雪山：不规则融雪线 + 冰川舌 + 冰裂隙 + 蓝灰雪影
 *  5. 山麓碎石扇与巨石，融入地面（废除假椭圆底座）
 */
interface RockTone {
  lit: string
  mid: string
  dark: string
  line: string
}

const ROCK_FRONT: RockTone = {
  lit: '#b7ab99',
  mid: '#8d8172',
  dark: '#5c5348',
  line: 'rgba(46,41,36,0.55)',
}
const ROCK_FRONT_B: RockTone = {
  lit: '#aaa49b',
  mid: '#8b877d',
  dark: '#5b5750',
  line: 'rgba(40,38,34,0.55)',
}
const ROCK_BACK: RockTone = {
  lit: '#a9b3ab',
  mid: '#98a29a',
  dark: '#7f8980',
  line: 'rgba(60,66,60,0.4)',
}
const ROCK_DARK: RockTone = {
  lit: '#6f6779',
  mid: '#575070',
  dark: '#3e3852',
  line: 'rgba(20,16,30,0.6)',
}

function drawMassif(
  ctx: CanvasRenderingContext2D,
  cx: number,
  baseY: number,
  w: number,
  h: number,
  tone: RockTone,
  snowy: boolean,
  rng: Rng,
): void {
  const hw = w / 2

  // ── 1. 山脊：主峰 + 2 副峰（高肩） ──
  interface Rp { x: number; y: number }
  const subs: { dx: number; hh: number }[] = [
    { dx: -hw * rng.range(0.45, 0.7), hh: h * rng.range(0.6, 0.76) },
    { dx: hw * rng.range(0.42, 0.68), hh: h * rng.range(0.64, 0.82) },
  ]
  const mainDx = rng.range(-0.14, 0.12) * w
  subs.push({ dx: mainDx, hh: h })
  subs.sort((a, b) => a.dx - b.dx)

  const ridge: Rp[] = [{ x: -hw, y: 0 }]
  for (const s of subs) {
    const prev = ridge[ridge.length - 1]
    if (s.dx - prev.x > w * 0.1) ridge.push({ x: (prev.x + s.dx) / 2, y: -s.hh * rng.range(0.6, 0.74) })
    ridge.push({ x: s.dx, y: -s.hh })
  }
  ridge.push({ x: hw, y: 0 })

  // 轮廓粗糙化：每条边中点位移（手绘抖动）
  const roughen = (pts: Rp[]): Rp[] => {
    const out: Rp[] = []
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]
      const b = pts[i + 1]
      out.push(a)
      const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 26))
      for (let k = 1; k < n; k++) {
        const t = k / n
        out.push({
          x: a.x + (b.x - a.x) * t + rng.range(-1, 1) * Math.min(9, w * 0.02),
          y: a.y + (b.y - a.y) * t + rng.range(-1, 1) * 5,
        })
      }
    }
    out.push(pts[pts.length - 1])
    return out
  }
  const outline = roughen(ridge)
  const bL = baseY + h * 0.05 + rng.range(-16, 12)
  const bR = baseY + h * 0.05 + rng.range(-12, 16)

  // ── 0. 山脚丘陵基座（把山"种"进地面） ──
  const mound = blob(cx, baseY + 2, hw * 1.2, h * 0.15, 0.45, 14, rng)
  traceSmooth(ctx, mound)
  ctx.fillStyle = snowy ? '#d7e3ea' : '#75855f'
  ctx.fill()

  // ── 2. 主体：右暗底 + 左亮渐变 + 粗糙轮廓 ──
  const body = new Path2D()
  body.moveTo(cx + outline[0].x, baseY + outline[0].y)
  for (const p of outline) body.lineTo(cx + p.x, baseY + p.y)
  body.lineTo(cx + hw, bR)
  body.lineTo(cx - hw, bL)
  body.closePath()
  ctx.save()
  ctx.fillStyle = tone.dark
  ctx.fill(body)
  ctx.clip(body)
  const g = ctx.createLinearGradient(cx - hw, 0, cx + hw, 0)
  g.addColorStop(0, tone.lit)
  g.addColorStop(0.45, tone.mid)
  g.addColorStop(1, tone.dark)
  ctx.globalAlpha = 0.9
  ctx.fillStyle = g
  ctx.fillRect(cx - hw, baseY - h - 10, w, h + 20)
  ctx.globalAlpha = 1

  // ── 3. 分面光影（每个峰的右侧面阴影 + 左侧面微光） ──
  for (const s of subs) {
    const px = cx + s.dx
    ctx.fillStyle = 'rgba(20,16,12,0.24)'
    ctx.beginPath()
    ctx.moveTo(px, baseY - s.hh)
    ctx.lineTo(px + hw * 0.56, baseY - s.hh * 0.04)
    ctx.lineTo(px + hw * 0.12, baseY - s.hh * 0.02)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = 'rgba(255,244,224,0.16)'
    ctx.beginPath()
    ctx.moveTo(px, baseY - s.hh)
    ctx.lineTo(px - hw * 0.4, baseY - s.hh * 0.08)
    ctx.lineTo(px - hw * 0.08, baseY - s.hh * 0.05)
    ctx.closePath()
    ctx.fill()
  }

  // ── 4. 岩层带（下半段、低对比） ──
  for (let i = 0; i < 4; i++) {
    const t = i / 4
    const y = baseY - (0.04 + t * 0.48) * h
    ctx.strokeStyle = `rgba(30,26,22,${0.06 + (1 - t) * 0.11})`
    ctx.lineWidth = 1.4 + (1 - t) * 2.6
    ctx.beginPath()
    ctx.moveTo(cx - hw, y)
    ctx.lineTo(cx + hw, y - w * rng.range(-0.08, 0.04))
    ctx.stroke()
  }

  // ── 5. 笔触色块（brush dabs，岩壁的"画"感） ──
  for (let i = 0; i < 30; i++) {
    const px = cx + rng.range(-hw, hw)
    const py = baseY - rng.range(h * 0.05, h * 0.92)
    const litSide = px - cx + (baseY - py) * 0.1 < w * 0.08
    const r = rng.range(4, 13)
    traceSmooth(ctx, blob(px, py, r, r * rng.range(0.45, 0.75), 0.5, 7, rng))
    ctx.fillStyle = litSide ? `rgba(236,226,206,${rng.range(0.06, 0.16).toFixed(2)})` : `rgba(28,24,20,${rng.range(0.07, 0.2).toFixed(2)})`
    ctx.fill()
  }

  // ── 6. 峰顶向下的裂缝 ──
  ctx.strokeStyle = tone.line
  for (const s of subs) {
    let x = cx + s.dx + rng.range(-3, 3)
    let y = baseY - s.hh * 0.88
    ctx.lineWidth = 1.6
    ctx.beginPath()
    ctx.moveTo(x, y)
    const segs = 5 + rng.int(0, 3)
    for (let k = 0; k < segs; k++) {
      x += rng.range(-w * 0.035, w * 0.035)
      y += (s.hh * 0.88 / segs) * rng.range(0.7, 1.05)
      ctx.lineTo(x, Math.min(y, baseY - 2))
    }
    ctx.stroke()
  }

  // ── 7. 点彩肌理 ──
  for (let i = 0; i < 90; i++) {
    const px = rng.range(-hw, hw)
    const py = -rng.range(0, h * 0.96)
    const litSide = px + (py / h) * w * 0.12 < w * 0.12
    ctx.fillStyle = litSide ? 'rgba(255,246,230,0.10)' : 'rgba(15,12,10,0.14)'
    ctx.fillRect(cx + px, baseY + py, rng.range(1, 2.6), rng.range(1, 2.2))
  }

  // ── 8. 雪盖：不规则融雪边 + 冰川舌 + 雪影 ──
  if (snowy) {
    const snowTop = -h * 0.52
    ctx.fillStyle = '#f4f8fb'
    ctx.beginPath()
    ctx.moveTo(cx + ridge[0].x, baseY + ridge[0].y)
    for (let i = 1; i < ridge.length; i++) {
      const p = ridge[i]
      const prev = ridge[i - 1]
      if (p.y <= snowTop && prev.y <= snowTop) {
        ctx.lineTo(cx + p.x, baseY + p.y)
      } else {
        const n = 4 + rng.int(0, 3)
        for (let k = 1; k <= n; k++) {
          const t = k / n
          const mx = prev.x + (p.x - prev.x) * t
          const dip = rng.range(0.05, 0.13) * h
          const my = Math.max(p.y, prev.y) + dip
          ctx.lineTo(cx + mx, baseY + Math.min(my, -h * 0.3))
        }
      }
    }
    ctx.lineTo(cx + hw, baseY - h * 0.34 + rng.range(-14, 14))
    ctx.lineTo(cx - hw, baseY - h * 0.34 + rng.range(-14, 14))
    ctx.closePath()
    ctx.fill()

    for (let i = 0; i < 34; i++) {
      const px = rng.range(-hw, hw) * 0.92
      const py = -rng.range(h * 0.36, h)
      ctx.fillStyle = px > 0 ? 'rgba(150,178,205,0.42)' : 'rgba(255,255,255,0.55)'
      ctx.fillRect(cx + px, baseY + py, rng.range(2, 8), rng.range(1.4, 3.2))
    }
    const tallest = subs.reduce((m, s2) => (s2.hh > m.hh ? s2 : m), subs[0])
    for (let i = 0; i < 2; i++) {
      const gx = tallest.dx + (i === 0 ? 0 : rng.range(-0.12, 0.12) * w)
      ctx.fillStyle = 'rgba(240,247,251,0.94)'
      ctx.beginPath()
      ctx.moveTo(cx + gx - w * 0.05, baseY - h * 0.6)
      ctx.lineTo(cx + gx + w * 0.05, baseY - h * 0.58)
      ctx.lineTo(cx + gx + w * 0.016 + h * 0.04, baseY - h * 0.3)
      ctx.lineTo(cx + gx - w * 0.016 - h * 0.028, baseY - h * 0.32)
      ctx.closePath()
      ctx.fill()
      ctx.strokeStyle = 'rgba(150,178,205,0.6)'
      ctx.lineWidth = 1.3
      for (let k = 0; k < 3; k++) {
        const yy = baseY - h * rng.range(0.36, 0.5)
        ctx.beginPath()
        ctx.moveTo(cx + gx - w * 0.028, yy)
        ctx.lineTo(cx + gx + w * 0.028, yy - 3)
        ctx.stroke()
      }
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'
    ctx.lineWidth = 1.8
    ctx.beginPath()
    let started = false
    for (const p of ridge) {
      if (p.y < snowTop + h * 0.08) {
        if (!started) {
          ctx.moveTo(cx + p.x, baseY + p.y)
          started = true
        } else ctx.lineTo(cx + p.x, baseY + p.y)
      } else started = false
    }
    ctx.stroke()
  } else {
    ctx.strokeStyle = 'rgba(255,240,214,0.42)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    let started = false
    for (const p of ridge) {
      if (p.y < -h * 0.22) {
        if (!started) {
          ctx.moveTo(cx + p.x, baseY + p.y)
          started = true
        } else ctx.lineTo(cx + p.x, baseY + p.y)
      } else started = false
    }
    ctx.stroke()
  }

  // ── 9. 山体在地面上的投影（光从左上来 → 影朝右） ──
  ctx.restore()
  ell(ctx, cx + hw * 0.42, baseY + 4, hw * 0.72, h * 0.045, 'rgba(38,48,28,0.2)')

  // ── 10. 接地：碎石扇 + 巨石 ──
  for (let i = 0; i < 14; i++) {
    const px = rng.range(-hw * 1.04, hw * 1.04)
    const py = baseY + rng.range(3, h * 0.07)
    ell(ctx, cx + px, py, rng.range(3, 8), rng.range(1.6, 3.6), rng.chance(0.5) ? tone.mid : tone.dark, 0.5)
  }
  for (let i = 0; i < 2; i++) {
    const px = rng.range(-hw * 0.7, hw * 0.7)
    const py = baseY + rng.range(5, h * 0.06)
    ell(ctx, cx + px, py, rng.range(8, 15), rng.range(5, 8), tone.mid)
    ell(ctx, cx + px - 2, py - 2, rng.range(4, 7), rng.range(2.4, 4), tone.lit, 0.9)
  }
}

function paintMountains(P: PaintCtx): void {
  const { ctx, rng, map, nodes } = P

  // 主山脉：彼此重叠的连续山体（西段岩石 → 东段雪峰），先远排后退排
  const front = [
    { x: 645, base: 342, w: 350, h: 205, snow: false },
    { x: 902, base: 306, w: 380, h: 260, snow: false },
    { x: 1152, base: 366, w: 336, h: 180, snow: false },
    { x: 1408, base: 308, w: 366, h: 235, snow: false },
    { x: 1660, base: 360, w: 344, h: 200, snow: true },
    { x: 1916, base: 300, w: 392, h: 285, snow: true },
    { x: 2168, base: 356, w: 350, h: 215, snow: true },
  ]
  for (const m of front) {
    drawMassif(ctx, m.x + 118, m.base - 118, m.w * 0.7, m.h * 0.7, ROCK_BACK, m.snow, rng)
  }
  // 大气透视雾带（压远排）
  const haze = ctx.createLinearGradient(0, 70, 0, 330)
  haze.addColorStop(0, 'rgba(216,227,225,0.24)')
  haze.addColorStop(1, 'rgba(216,227,225,0)')
  ctx.fillStyle = haze
  ctx.fillRect(380, 50, WORLD_W - 380, 290)
  for (const m of front) {
    drawMassif(ctx, m.x, m.base, m.w, m.h, rng.chance(0.5) ? ROCK_FRONT : ROCK_FRONT_B, m.snow, rng)
  }
  // 山谷 V 形谷地：露出草地 + 松树前景（打破连墙感）
  const gapPines: [number, number, boolean][] = [
    [770, 384, false], [1024, 396, false], [1278, 390, false],
    [1532, 384, false], [1786, 378, true], [2040, 384, true], [2290, 392, true],
  ]
  for (const [gx, gy, snowy] of gapPines) {
    for (let k = 0; k < 3; k++) {
      drawPine(ctx, gx + k * 16 - 16, gy + (k % 2) * 7, 0.75 + k * 0.08, snowy ? BIOMES.snow : BIOMES.mountain, snowy, rng)
    }
  }

  // 黑曜岩丘（神龛所在）：暗色断崖山体 + 黑曜尖晶
  const shrineNode = map.nodes.find((n) => n.structure === 'shrine') ?? map.nodes.find((n) => n.type === 'elite')
  const ob = shrineNode ? nodes.get(shrineNode.id)!.px : { x: 840, y: 324 }
  drawMassif(ctx, ob.x + 10, ob.y + 96, 330, 165, ROCK_DARK, false, rng)
  for (let i = 0; i < 4; i++) {
    const sx = ob.x + rng.range(-110, 110)
    const sy = ob.y + rng.range(10, 60)
    poly(
      ctx,
      [
        { x: sx - 16, y: sy + 10 },
        { x: sx + 13, y: sy + 10 },
        { x: sx + rng.range(-4, 4), y: sy - rng.range(24, 46) },
      ],
      '#443d58',
    )
    poly(
      ctx,
      [
        { x: sx - 16, y: sy + 10 },
        { x: sx - 4, y: sy + 10 },
        { x: sx - 2 + rng.range(-2, 2), y: sy - rng.range(16, 30) },
      ],
      '#575070',
    )
  }

  // 峡谷崖壁（峡谷节点两侧，按 structure 通用推导锚点）
  const canyonNode = map.nodes.find((n) => n.structure === 'canyon_gate')
  const cy = canyonNode ? nodes.get(canyonNode.id)!.px : { x: 1056, y: 918 }
  drawCliff(ctx, cy.x - 86, cy.y - 6, 1, rng)
  drawCliff(ctx, cy.x + 60, cy.y - 2, -1, rng)
  // 谷底碎石
  for (let i = 0; i < 14; i++) {
    ell(ctx, cy.x + rng.range(-70, 70), cy.y + rng.range(6, 30), rng.range(4, 9), rng.range(2, 5), '#7d8894', 0.8)
  }
}

function drawCliff(ctx: CanvasRenderingContext2D, x: number, y: number, dir: number, rng: Rng): void {
  // 顶面草台
  poly(ctx, [{ x: x - 60 * dir, y: y - 26 }, { x: x + 66 * dir, y: y - 30 }, { x: x + 74 * dir, y: y - 12 }, { x: x - 52 * dir, y: y - 8 }], '#7ea85c')
  // 岩壁
  poly(ctx, [{ x: x - 52 * dir, y: y - 8 }, { x: x + 74 * dir, y: y - 12 }, { x: x + 66 * dir, y: y + 26 }, { x: x - 44 * dir, y: y + 22 }], '#6f655a')
  // 岩层纹理（密 + 粗细变化）
  for (let i = 0; i < 7; i++) {
    const t = i / 6
    ctx.strokeStyle = i % 2 === 0 ? `rgba(45,40,35,${0.3 + t * 0.3})` : `rgba(220,210,190,${0.12 + t * 0.1})`
    ctx.lineWidth = 1.2 + (1 - t) * 2.2
    ctx.beginPath()
    ctx.moveTo(x - 46 * dir, y - 5 + i * 4.6)
    ctx.lineTo(x + 60 * dir, y - 8 + i * 4.9)
    ctx.stroke()
  }
  // 点彩风化
  for (let i = 0; i < 22; i++) {
    const px = x + (rng.next() - 0.5) * 100 * dir
    const py = y - 4 + rng.next() * 26
    ctx.fillStyle = rng.chance(0.5) ? 'rgba(20,16,12,0.16)' : 'rgba(235,226,205,0.14)'
    ctx.fillRect(px, py, 1.8, 1.5)
  }
  // 顶缘阳光边
  ctx.strokeStyle = 'rgba(255,240,210,0.5)'
  ctx.lineWidth = 1.6
  ctx.beginPath()
  ctx.moveTo(x - 52 * dir, y - 9)
  ctx.lineTo(x + 70 * dir, y - 13)
  ctx.stroke()
  // 塌方碎石（固定偏移，保证可复现）
  for (const [ox, oy] of [[-30, 30], [4, 34], [34, 29], [-8, 38], [22, 40], [-44, 33]] as [number, number][]) {
    ell(ctx, x + ox, y + oy, 5, 3, '#8b8478', 0.9)
  }
}

// ── 道路 ────────────────────────────────────────────────────────

function paintRoads(P: PaintCtx, map: MapSpec, meta: WorldMeta): void {
  const { ctx, rng, nodes } = P
  for (const n of map.nodes) {
    for (const to of n.connections) {
      const a = nodes.get(n.id)!.px
      const b = nodes.get(to)!.px
      // 途经点：自然绕行
      const wps: Pt[] = [a]
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len = Math.hypot(dx, dy) || 1
      const nx = -dy / len
      const ny = dx / len
      const bend = rng.range(-0.14, 0.2)
      wps.push({ x: mx + nx * len * bend, y: my + ny * len * bend })
      // 特例绕行：沿湖/绕山更自然
      if (n.id === 'bridge_of_limits' && to === 'library_of_proof')
        wps.splice(1, 1, { x: 1430, y: 1198 }, { x: 1580, y: 1210 })
      if (n.id === 'library_of_proof' && to === 'summit_ascent')
        wps.splice(1, 1, { x: 1840, y: 1000 }, { x: 1900, y: 720 })
      if (n.id === 'forest_of_functions' && to === 'canyon_of_continuity')
        wps.splice(1, 1, { x: 858, y: 886 })
      if (n.id === 'obsidian_shrine' && to === 'bridge_of_limits')
        wps.splice(1, 1, { x: 1010, y: 480 }, { x: 1210, y: 660 })
      wps.push(b)

      const line = smoothPolyline(wps, 18)
      P.roadLines.push(line)
      meta.edgeSamples.set(`${n.id}>${to}`, line)
      meta.edgeSamples.set(`${to}>${n.id}`, [...line].reverse())

      const style = roadStyleFor(nodes.get(to)!.biome)
      // 岸土 → 路 → 车辙光
      strokeRoad(ctx, line, style)
      // 水面穿越段 → 木桥
      drawBridgesOnLine(ctx, line, P.water, rng)
    }
  }
}

function roadStyleFor(biome?: string): { edge: string; mid: string; light: string; stone: boolean } {
  if (biome === 'mountain' || biome === 'snow') return { edge: '#6f695f', mid: '#9a938a', light: '#b5aea2', stone: true }
  if (biome === 'dark') return { edge: '#332d3f', mid: '#544a68', light: '#6d6284', stone: true }
  return { edge: ROAD.edge, mid: ROAD.mid, light: ROAD.light, stone: false }
}

function strokeRoad(ctx: CanvasRenderingContext2D, line: Pt[], style: { edge: string; mid: string; light: string }): void {
  const stroke = (w: number, c: string, a = 1) => {
    ctx.strokeStyle = c
    ctx.globalAlpha = a
    ctx.lineWidth = w
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(line[0].x, line[0].y)
    for (const p of line) ctx.lineTo(p.x, p.y)
    ctx.stroke()
    ctx.globalAlpha = 1
  }
  stroke(24, style.edge, 0.95)
  stroke(17, style.mid)
  // 中线磨损亮纹（虚线段）
  ctx.setLineDash([10, 14])
  stroke(6, style.light, 0.75)
  ctx.setLineDash([])
}

function drawBridgesOnLine(ctx: CanvasRenderingContext2D, line: Pt[], water: { x: number; y: number; r: number }[], rng: Rng): void {
  let i = 0
  while (i < line.length) {
    const p = line[i]
    if (distToCircles(p, water) < 0) {
      // 找到穿越段
      let j = i
      while (j < line.length && distToCircles(line[j], water) < 0) j++
      const a = line[Math.max(0, i - 2)]
      const b = line[Math.min(line.length - 1, j + 1)]
      drawWoodBridge(ctx, a, b, p, rng)
      i = j
    } else i++
  }
}

function drawWoodBridge(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, mid: Pt, rng: Rng): void {
  const ang = Math.atan2(b.y - a.y, b.x - a.x)
  const len = Math.max(60, dist(a, b) + 26)
  ctx.save()
  ctx.translate(mid.x, mid.y)
  ctx.rotate(ang)
  ell(ctx, 0, 8, len / 2 + 6, 10, 'rgba(30,40,25,0.3)') // 水面影
  // 桥面
  ctx.fillStyle = ROAD.plank
  ctx.fillRect(-len / 2, -14, len, 28)
  // 栏杆
  ctx.fillStyle = ROAD.plankDark
  ctx.fillRect(-len / 2, -20, len, 6)
  ctx.fillRect(-len / 2, 14, len, 6)
  // 木板缝
  ctx.strokeStyle = 'rgba(60,40,22,0.7)'
  ctx.lineWidth = 1.6
  for (let x = -len / 2 + 7; x < len / 2; x += 11) {
    ctx.beginPath()
    ctx.moveTo(x, -14)
    ctx.lineTo(x, 14)
    ctx.stroke()
  }
  // 桥桩
  for (const px of [-len / 2 + 8, 0, len / 2 - 8]) {
    ctx.fillStyle = '#5d4026'
    ctx.fillRect(px - 3, -24, 6, 44)
  }
  ctx.restore()
  for (let i = 0; i < 4; i++) circle(ctx, mid.x + rng.range(-20, 20), mid.y + rng.range(18, 26), rng.range(2, 4), '#d9eef5', 0.7)
}

// ── 地表细节 ────────────────────────────────────────────────────

function paintDetails(P: PaintCtx, meta: WorldMeta): void {
  const { ctx, rng } = P
  const roadsFlat = P.roadLines.flat()

  const scatter = (count: number, ok: (x: number, y: number) => boolean, draw: (x: number, y: number) => void): void => {
    let placed = 0
    let guard = 0
    while (placed < count && guard++ < count * 30) {
      const x = rng.range(40, WORLD_W - 40)
      const y = rng.range(40, WORLD_H - 40)
      if (!ok(x, y)) continue
      draw(x, y)
      placed++
    }
  }
  const clearOf = (x: number, y: number, d: number): boolean =>
    distToPolyline({ x, y }, roadsFlat) > d && distToCircles({ x, y }, P.water) > d * 0.4

  // 草茎与野花（草地）
  scatter(300, (x, y) => clearOf(x, y, 20), (x, y) => {
    ctx.strokeStyle = 'rgba(80,125,55,0.7)'
    ctx.lineWidth = 1.6
    for (let k = -1; k <= 1; k++) {
      ctx.beginPath()
      ctx.moveTo(x + k * 2, y)
      ctx.lineTo(x + k * 3, y - rng.range(4, 7))
      ctx.stroke()
    }
  })
  scatter(70, (x, y) => clearOf(x, y, 24), (x, y) => {
    const c = rng.pick(['#f2ead0', '#e8d97a', '#e0a9c0'])
    for (const [ox, oy] of [[-2, 0], [2, 0], [0, -2], [0, 2]])
      circle(ctx, x + ox, y + oy, 1.8, c, 0.95)
    circle(ctx, x, y, 1.4, '#d8b36a')
  })
  // 蘑菇
  scatter(14, (x, y) => clearOf(x, y, 26), (x, y) => {
    ctx.fillStyle = '#efe6d2'
    ctx.fillRect(x - 1.4, y - 4, 2.8, 4)
    ctx.fillStyle = '#c75b45'
    ell(ctx, x, y - 4.4, 3.6, 2.4, '#c75b45')
    circle(ctx, x - 1, y - 5, 0.7, '#f5ede0')
  })
  // 碎石/巨石（高地）
  scatter(90, (x, y) => clearOf(x, y, 22), (x, y) => {
    ell(ctx, x, y, rng.range(3, 7), rng.range(2, 4.4), '#7d8894', 0.85)
    ell(ctx, x - 1, y - 1.4, rng.range(1.6, 3), 1.2, '#a5aeb6', 0.8)
  })
  // 雪晶
  scatter(130, (x, y) => y < 480 && x > 1700 && clearOf(x, y, 20), (x, y) => circle(ctx, x, y, rng.range(1, 2.2), '#ffffff', 0.9))
  // 余烬（暗域）
  scatter(60, (x, y) => x > 1900 && clearOf(x, y, 20), (x, y) => circle(ctx, x, y, rng.range(1.2, 2.6), rng.chance(0.5) ? '#c97b4a' : '#a3542e', 0.9))
  // 芦苇（水岸，抽稀采样）
  for (let ci = 0; ci < P.water.length; ci += 5) {
    const c = P.water[ci]
    if (c.r < 12) continue
    for (let i = 0; i < 3; i++) {
      const a = rng.range(0, Math.PI * 2)
      const x = c.x + Math.cos(a) * (c.r + rng.range(2, 8))
      const y = c.y + Math.sin(a) * (c.r * 0.6 + rng.range(2, 8))
      if (distToPolyline({ x, y }, roadsFlat) < 18) continue
      ctx.strokeStyle = '#6d8f4e'
      ctx.lineWidth = 1.8
      for (let k = -1; k <= 1; k++) {
        ctx.beginPath()
        ctx.moveTo(x + k * 2, y)
        ctx.quadraticCurveTo(x + k * 3, y - 7, x + k * 4, y - 11)
        ctx.stroke()
      }
    }
  }
  // 睡莲
  for (let i = 0; i < 16; i++) {
    const c = P.water[rng.int(0, P.water.length - 1)]
    if (c.r < 12) continue
    const x = c.x + rng.range(-c.r * 0.5, c.r * 0.5)
    const y = c.y + rng.range(-c.r * 0.3, c.r * 0.3)
    circle(ctx, x, y, rng.range(3.4, 5.6), '#5f9a4c', 0.95)
    ctx.fillStyle = '#8fbf5a'
    ctx.beginPath()
    ctx.arc(x, y, 4.4, 0.4, Math.PI * 1.5)
    ctx.lineTo(x, y)
    ctx.fill()
    if (rng.chance(0.3)) circle(ctx, x + 1, y - 1, 1.4, '#f2ead0')
  }
  // 暗域裂痕与符文光点
  scatter(40, (x, y) => x > 1950 && clearOf(x, y, 24), (x, y) => {
    ctx.strokeStyle = 'rgba(20,16,28,0.7)'
    ctx.lineWidth = 1.8
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + rng.range(-14, 14), y + rng.range(-8, 8))
    ctx.stroke()
  })

  // 火把位置（村庄 + 营地）
  meta.torches.push({ x: 356, y: 1006 }, { x: 452, y: 1010 }, { x: 586, y: 838 })
}

// ── 树木 ────────────────────────────────────────────────────────

function paintTrees(P: PaintCtx, meta: WorldMeta): void {
  const { ctx, rng } = P
  const roadsFlat = P.roadLines.flat()
  const blocked = (x: number, y: number, d = 26): boolean =>
    distToPolyline({ x, y }, roadsFlat) < d ||
    distToCircles({ x, y }, P.water) < 6 ||
    P.structures.some((s) => dist({ x, y }, s) < 96) ||
    // 村庄/学院/农田/风车留白
    (x > 180 && x < 580 && y > 920) ||
    (x > 640 && x < 800 && y > 990) ||
    // 北部山脉带与南部湿地留白
    y < 340 ||
    (y > 1140 && x > 1500)

  const place = (count: number, near: Pt | null, spread: number, draw: (x: number, y: number, s: number) => void): void => {
    let placed = 0
    let guard = 0
    while (placed < count && guard++ < count * 24) {
      let x: number
      let y: number
      if (near) {
        const a = rng.range(0, Math.PI * 2)
        const r = Math.sqrt(rng.next()) * spread
        x = near.x + Math.cos(a) * r
        y = near.y + Math.sin(a) * r * 0.72
      } else {
        x = rng.range(60, WORLD_W - 60)
        y = rng.range(360, WORLD_H - 50)
      }
      if (x < 40 || x > WORLD_W - 40 || y < 340 || y > WORLD_H - 40) continue
      if (blocked(x, y)) continue
      draw(x, y, rng.range(0.72, 1.25))
      placed++
    }
  }

  const fb = BIOMES.forest
  // 核心林区（heartland 深林）
  place(46, { x: 620, y: 700 }, 210, (x, y, s) => drawBroadleaf(ctx, x, y, s, fb, rng))
  place(30, { x: 420, y: 620 }, 170, (x, y, s) => drawBroadleaf(ctx, x, y, s, fb, rng))
  place(20, { x: 250, y: 780 }, 150, (x, y, s) => drawBroadleaf(ctx, x, y, s, fb, rng))
  place(16, { x: 900, y: 1020 }, 130, (x, y, s) => drawBroadleaf(ctx, x, y, s, fb, rng))
  // 湖畔树
  place(22, { x: 1560, y: 1150 }, 200, (x, y, s) => drawBroadleaf(ctx, x, y, s, BIOMES.lake, rng))
  place(14, { x: 1220, y: 1060 }, 150, (x, y, s) => drawBroadleaf(ctx, x, y, s, BIOMES.lake, rng))
  // 高地针叶
  const mb = BIOMES.mountain
  place(26, { x: 1080, y: 520 }, 220, (x, y, s) => drawPine(ctx, x, y, s, mb, false, rng))
  place(16, { x: 1420, y: 460 }, 170, (x, y, s) => drawPine(ctx, x, y, s, mb, false, rng))
  // 雪原针叶
  const sb = BIOMES.snow
  place(24, { x: 1900, y: 440 }, 200, (x, y, s) => drawPine(ctx, x, y, s, sb, true, rng))
  place(12, { x: 2080, y: 300 }, 150, (x, y, s) => drawPine(ctx, x, y, s, sb, true, rng))
  // 暗域枯木
  place(20, { x: 2130, y: 820 }, 260, (x, y, s) => drawDeadTree(ctx, x, y, s, rng))
  place(10, { x: 2300, y: 500 }, 160, (x, y, s) => drawDeadTree(ctx, x, y, s, rng))

  // 散布（全局空地随机）
  place(60, null, 0, (x, y, s) => {
    if (x > 1900) return drawDeadTree(ctx, x, y, s, rng)
    if (y < 420 && x > 700) return drawPine(ctx, x, y, s, x > 1650 ? BIOMES.snow : mb, x > 1650, rng)
    drawBroadleaf(ctx, x, y, s, fb, rng)
  })

  // 记录道路附近树冠（供摆动覆盖层）
  const cap: { x: number; y: number; r: number }[] = []
  for (const line of P.roadLines) {
    for (let i = 0; i < line.length; i += 6) {
      const p = line[i]
      for (const s of P.structures) {
        const d = dist(p, s)
        if (d > 100 && d < 320 && cap.length < 14 && rng.chance(0.08)) {
          cap.push({ x: p.x + rng.range(-46, 46), y: p.y + rng.range(-40, 10), r: rng.range(9, 12) })
        }
      }
    }
  }
  meta.swayTrees = cap
}

// ── 村庄 / 学院 / 装饰 ──────────────────────────────────────────

function paintVillage(P: PaintCtx, meta: WorldMeta): void {
  const { ctx, rng } = P
  const roof = '#b25b46'
  const roofAlt = '#8f6f4e'

  // 农田（耕地条纹）
  ctx.save()
  ctx.translate(180, 1130)
  ctx.rotate(-0.08)
  ctx.fillStyle = '#c9a96e'
  ctx.fillRect(-90, -46, 180, 92)
  ctx.strokeStyle = 'rgba(120,90,50,0.55)'
  ctx.lineWidth = 3
  for (let y = -38; y < 46; y += 11) {
    ctx.beginPath()
    ctx.moveTo(-84, y)
    ctx.lineTo(84, y)
    ctx.stroke()
  }
  ctx.restore()

  // 学院大厅（heartland 地标）
  const ax = 500
  const ay = 1122
  ell(ctx, ax + 6, ay + 16, 58, 14, 'rgba(30,40,25,0.3)')
  ctx.fillStyle = '#ded0ae'
  ctx.fillRect(ax - 44, ay - 34, 88, 48)
  ctx.strokeStyle = 'rgba(120,95,60,0.45)'
  ctx.lineWidth = 1
  for (let i = 1; i < 4; i++) {
    ctx.beginPath()
    ctx.moveTo(ax - 44, ay - 34 + i * 12)
    ctx.lineTo(ax + 44, ay - 34 + i * 12)
    ctx.stroke()
  }
  // 柱廊
  ctx.fillStyle = '#c9b78f'
  for (let i = 0; i < 5; i++) ctx.fillRect(ax - 38 + i * 19, ay - 30, 6, 40)
  // 阶梯
  ctx.fillStyle = '#b5a480'
  ctx.fillRect(ax - 50, ay + 12, 100, 8)
  ctx.fillRect(ax - 44, ay + 20, 88, 6)
  // 大屋顶
  poly(ctx, [{ x: ax - 54, y: ay - 32 }, { x: ax + 54, y: ay - 32 }, { x: ax + 30, y: ay - 58 }, { x: ax - 30, y: ay - 58 }], '#7e5a9e')
  poly(ctx, [{ x: ax - 54, y: ay - 32 }, { x: ax - 26, y: ay - 32 }, { x: ax - 30, y: ay - 56 }, { x: ax - 34, y: ay - 32 }], 'rgba(0,0,0,0.18)')
  ctx.fillStyle = '#ded0ae'
  ctx.fillRect(ax + 34, ay - 88, 18, 58)
  poly(ctx, [{ x: ax + 30, y: ay - 86 }, { x: ax + 56, y: ay - 86 }, { x: ax + 43, y: ay - 104 }], '#7e5a9e')
  ctx.strokeStyle = '#6e4f33'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(ax + 43, ay - 104)
  ctx.lineTo(ax + 43, ay - 124)
  ctx.stroke()
  poly(ctx, [{ x: ax + 43, y: ay - 124 }, { x: ax + 66, y: ay - 119 }, { x: ax + 43, y: ay - 112 }], '#57a3b8')

  // 农舍 ×3 + 水井
  drawHouse(ctx, 318, 1052, 1.1, roof)
  drawHouse(ctx, 402, 1096, 0.92, roofAlt)
  drawHouse(ctx, 268, 986, 0.8, roof)
  // 水井
  circle(ctx, 356, 1000, 9, '#8b8478')
  circle(ctx, 356, 1000, 5.4, '#4d4a42')
  poly(ctx, [{ x: 344, y: 996 }, { x: 368, y: 996 }, { x: 356, y: 982 }], roof)
  // 栅栏
  ctx.strokeStyle = '#8a6a42'
  ctx.lineWidth = 2
  for (let x = 120; x < 460; x += 26) {
    if (rng.chance(0.12)) continue
    ctx.beginPath()
    ctx.moveTo(x, 1178)
    ctx.lineTo(x, 1166)
    ctx.stroke()
  }
  ctx.beginPath()
  ctx.moveTo(120, 1170)
  ctx.lineTo(460, 1170)
  ctx.stroke()

  // 风车（底座；叶片为活对象）
  const wm = meta.windmill
  ell(ctx, wm.x + 6, wm.y + 20, 30, 9, 'rgba(30,40,25,0.3)')
  poly(ctx, [{ x: wm.x - 20, y: wm.y + 18 }, { x: wm.x + 20, y: wm.y + 18 }, { x: wm.x + 12, y: wm.y - 44 }, { x: wm.x - 12, y: wm.y - 44 }], '#d8cbaa')
  ctx.strokeStyle = 'rgba(120,95,60,0.4)'
  ctx.lineWidth = 1.2
  for (let i = 0; i < 3; i++) {
    ctx.beginPath()
    ctx.moveTo(wm.x - 17, wm.y + 4 + i * 14)
    ctx.lineTo(wm.x + 17, wm.y + 4 + i * 14)
    ctx.stroke()
  }
  poly(ctx, [{ x: wm.x - 24, y: wm.y - 42 }, { x: wm.x + 24, y: wm.y - 42 }, { x: wm.x, y: wm.y - 66 }], roof)

  // 林间营地（L2 附近）：帐篷 ×2 + 火堆
  const cx = 586
  const cy2 = 858
  ell(ctx, cx + 8, cy2 + 14, 46, 11, 'rgba(30,40,25,0.28)')
  poly(ctx, [{ x: cx - 26, y: cy2 + 10 }, { x: cx + 2, y: cy2 + 10 }, { x: cx - 12, y: cy2 - 20 }], '#b8874e')
  poly(ctx, [{ x: cx + 4, y: cy2 + 10 }, { x: cx + 30, y: cy2 + 10 }, { x: cx + 14, y: cy2 - 16 }], '#a3763f')
  // 火堆
  for (const s of [-1, 1]) {
    ctx.strokeStyle = '#6e4f33'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(cx + 40 + s * 6, cy2 + 8)
    ctx.lineTo(cx + 40 - s * 6, cy2 + 2)
    ctx.stroke()
  }
  circle(ctx, cx + 40, cy2 + 2, 4.6, '#f2a541')

  // 石阵（heartland 小立石）
  for (const [mx, my] of [
    [508, 596],
    [534, 616],
    [486, 622],
  ] as [number, number][]) {
    ctx.fillStyle = '#9a938a'
    ctx.fillRect(mx - 4, my - 18, 8, 20)
    ell(ctx, mx, my - 18, 4.6, 3, '#b5aea2')
  }

  // 小船 ×2（湖上）
  for (const [i, bp] of meta.boats.entries()) {
    ell(ctx, bp.x, bp.y + 6, 20, 5, 'rgba(20,50,70,0.4)')
    ctx.fillStyle = i === 0 ? '#8a6238' : '#6e4c2a'
    ctx.beginPath()
    ctx.moveTo(bp.x - 16, bp.y)
    ctx.quadraticCurveTo(bp.x, bp.y + 9, bp.x + 16, bp.y)
    ctx.quadraticCurveTo(bp.x, bp.y - 4, bp.x - 16, bp.y)
    ctx.fill()
    if (i === 0) {
      ctx.strokeStyle = '#5d4630'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(bp.x, bp.y - 2)
      ctx.lineTo(bp.x, bp.y - 24)
      ctx.stroke()
      poly(ctx, [{ x: bp.x, y: bp.y - 24 }, { x: bp.x + 15, y: bp.y - 6 }, { x: bp.x, y: bp.y - 6 }], '#e8e0c8')
    }
  }

  // 瀑布崖口（北湖岸）
  const wf = meta.waterfall
  poly(ctx, [{ x: wf.x - 44, y: wf.y - 26 }, { x: wf.x + 44, y: wf.y - 26 }, { x: wf.x + 36, y: wf.y - 2 }, { x: wf.x - 36, y: wf.y - 2 }], '#6f655a')
  ctx.strokeStyle = 'rgba(50,45,40,0.5)'
  ctx.lineWidth = 2
  for (let i = 0; i < 3; i++) {
    ctx.beginPath()
    ctx.moveTo(wf.x - 30 + i * 26, wf.y - 24)
    ctx.lineTo(wf.x - 34 + i * 26, wf.y - 4)
    ctx.stroke()
  }
  ell(ctx, wf.x, wf.y + 8, 30, 9, '#d9eef5', 0.9)
}

function paintDarkDecor(P: PaintCtx, meta: WorldMeta): void {
  const { ctx, rng } = P
  const bc = meta.bossCenter
  // 方尖碑 ×3
  for (const [ox, oy, s] of [
    [2010, 620, 1],
    [2270, 900, 1.15],
    [2120, 1020, 0.85],
  ] as [number, number, number][]) {
    ell(ctx, ox + 5 * s, oy + 6 * s, 16 * s, 6 * s, 'rgba(0,0,0,0.4)')
    poly(ctx, [{ x: ox - 9 * s, y: oy + 4 * s }, { x: ox + 9 * s, y: oy + 4 * s }, { x: ox + 6 * s, y: oy - 46 * s }, { x: ox - 6 * s, y: oy - 46 * s }], '#3f3850')
    poly(ctx, [{ x: ox - 9 * s, y: oy + 4 * s }, { x: ox - 1 * s, y: oy + 4 * s }, { x: ox - 3 * s, y: oy - 46 * s }, { x: ox - 6 * s, y: oy - 46 * s }], '#4c4460')
    poly(ctx, [{ x: ox - 7 * s, y: oy - 46 * s }, { x: ox + 7 * s, y: oy - 46 * s }, { x: ox, y: oy - 60 * s }], '#38324a')
    // 符文
    for (let i = 0; i < 3; i++) circle(ctx, ox, oy - 12 * s - i * 13 * s, 1.8 * s, '#a88fe8', 0.9)
  }
  // 篝火余烬堆（暗域营地感）
  for (let i = 0; i < 3; i++) {
    const x = bc.x - 180 + rng.range(0, 120)
    const y = bc.y + 160 + rng.range(-30, 30)
    circle(ctx, x, y, 6, '#2c2735')
    circle(ctx, x, y - 2, 3, '#c97b4a')
  }
}
