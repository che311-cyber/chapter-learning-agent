/**
 * 世界地图 Scene V2 —— 手绘奇幻战役地图。
 * 世界 2400×1350，明显大于屏幕：支持拖拽平移 / 滚轮缩放 / 自动聚焦。
 * 图层：世界纹理(0) → 水光/环境(2-5) → 关卡建筑(10) → 英雄(20) → 云雾(30)。
 * 关卡即地点（LevelSite），英雄沿真实道路折线行走，云层随解锁散开。
 */
import Phaser from 'phaser'
import type { MapNodeSpec } from '../../schemas/types'
import type { Pt } from '../world/shapes'
import { loadWorld, type WorldBundle } from '../../services/contentService'
import { EV, EventBus, type NodeSelectedPayload } from '../EventBus'
import { useGameStore } from '../../state/gameStore'
import { deriveNodeStatuses, resolveHeroNodeId } from '../../state/progression'
import { computeLayout, type WorldLayout } from '../map/computeLayout'
import { paintWorld, WORLD_W, WORLD_H, type WorldMeta } from '../world/worldPainter'
import { LevelSite } from '../world/LevelSite'
import { CloudLayer } from '../world/CloudLayer'
import { createAmbient } from '../world/ambient'
import { Hero } from '../entities/Hero'
import { getPalette } from '../palette'
import { createEmitters, type EmitterSet } from '../fx/Effects'
import { sfx } from '../audio/Sfx'

interface DragState {
  active: boolean
  dist: number
}

export class WorldMapScene extends Phaser.Scene {
  private bundle!: WorldBundle
  private layout!: WorldLayout
  private meta!: WorldMeta
  private pal = getPalette('fantasy-academic')
  private fx!: EmitterSet
  private sites = new Map<string, LevelSite>()
  private clouds!: CloudLayer
  private hero?: Hero
  private traveling = false
  private inited = false
  private eventBinds: Array<[string, (p: unknown) => void]> = []
  private drag: DragState = { active: false, dist: 0 }

  constructor() {
    super('WorldMapScene')
  }

  create(): void {
    this.sites = new Map()
    this.hero = undefined
    this.traveling = false
    this.inited = false
    this.drag = { active: false, dist: 0 }

    void loadWorld().then((bundle) => {
      if (this.inited || !this.scene.isActive()) return
      this.initWorld(bundle)
    })

    this.events.once('shutdown', () => {
      this.eventBinds.forEach(([n, f]) => EventBus.off(n, f))
      this.eventBinds = []
      this.hero = undefined
      this.inited = false
    })
  }

  private bindEvent(name: string, fn: (p: unknown) => void): void {
    this.eventBinds.push([name, fn])
    EventBus.on(name, fn)
  }

  private initWorld(bundle: WorldBundle): void {
    this.bundle = bundle
    this.inited = true
    this.pal = getPalette(bundle.map.theme.environment)

    const W = this.scale.width
    const H = this.scale.height
    this.cameras.main.setBounds(0, 0, WORLD_W, WORLD_H)

    // 世界纹理（一次性绘制）
    this.layout = computeLayout(bundle.map, WORLD_W, WORLD_H)
    this.meta = paintWorld(this, bundle.map, this.layout.nodes)
    this.add.image(0, 0, this.meta.textureKey).setOrigin(0, 0).setDepth(0)

    this.fx = createEmitters(this, this.pal.teal)
    createAmbient(this, this.meta)

    // 关卡地点
    for (const node of bundle.map.nodes) {
      const p = this.layout.nodes[node.id]
      const site = new LevelSite(this, node, p.x, p.y, (n) => this.onNodeClicked(n))
      this.sites.set(node.id, site)
    }

    // 云雾迷雾
    this.clouds = new CloudLayer(this, bundle.map, this.layout.nodes)
    this.refreshStatuses(false)

    // 英雄
    const heroNodeId = resolveHeroNodeId(bundle.map, useGameStore.getState().save)
    const hp = this.layout.nodes[heroNodeId]
    this.hero = new Hero(this, hp.x, hp.y - 10, heroNodeId, this.fx)

    // 镜头
    const cam = this.cameras.main
    const minZ = Math.max(W / WORLD_W, H / WORLD_H)
    cam.setZoom(Math.max(minZ + 0.05, 0.88))
    cam.centerOn(hp.x, hp.y)
    cam.fadeIn(650, 24, 30, 22)
    // 开场拉远：逐帧 centerOn 补偿边界钳制，保证英雄始终居中
    this.time.delayedCall(700, () => {
      this.tweens.add({
        targets: cam,
        zoom: Math.max(minZ + 0.04, 0.74),
        duration: 1800,
        ease: 'Sine.easeInOut',
        onUpdate: () => cam.centerOn(hp.x, hp.y),
      })
    })

    this.bindDragZoom()
    this.bindEvent(EV.TRAVEL_TO, (p) => {
      const { nodeId } = p as { nodeId: string }
      void this.travelTo(nodeId, { silent: false })
    })
    this.bindEvent(EV.MAP_REFRESH, () => this.refreshStatuses(true))

    this.events.on('resume', this.onResume, this)
    this.events.once('shutdown', () => this.events.off('resume', this.onResume, this))

    // QA / 自动化钩子：确定性镜头控制 + 场景引用
    const win = window as unknown as Record<string, unknown>
    win.__edurealmMap = this
    win.__focusCam = (wx: number, wy: number, z: number) => {
      this.tweens.killTweensOf(cam)
      cam.stopFollow()
      cam.setZoom(z)
      cam.centerOn(wx, wy)
    }
  }

  private onResume(): void {
    this.refreshStatuses(true)
  }

  // ── 镜头：拖拽 + 滚轮 ──────────────────────────────────────────

  private bindDragZoom(): void {
    const cam = this.cameras.main
    this.input.on('pointerdown', () => {
      this.drag = { active: true, dist: 0 }
      cam.stopFollow() // 用户随时可拖拽接管镜头（行走继续在底层进行）
    })
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this.drag.active || !p.isDown) return
      const dx = p.x - p.prevPosition.x
      const dy = p.y - p.prevPosition.y
      this.drag.dist += Math.abs(dx) + Math.abs(dy)
      cam.scrollX -= dx / cam.zoom
      cam.scrollY -= dy / cam.zoom
    })
    this.input.on('pointerup', () => {
      this.drag.active = false
      this.time.delayedCall(30, () => {
        this.drag.dist = 0
      })
    })
    this.input.on('wheel', (pointer: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => {
      if (this.traveling) return
      const before = cam.getWorldPoint(pointer.x, pointer.y)
      const minZ = Math.max(this.scale.width / WORLD_W, this.scale.height / WORLD_H)
      const nz = Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.88 : 1.14), minZ, 1.8)
      if (nz === cam.zoom) return
      cam.setZoom(nz)
      const after = cam.getWorldPoint(pointer.x, pointer.y)
      cam.scrollX += before.x - after.x
      cam.scrollY += before.y - after.y
    })
  }

  /** 站点点击是否有效（拖拽/行走中无效） */
  canClick(): boolean {
    return !this.traveling && this.drag.dist < 12
  }

  // ── 交互 / 状态 ────────────────────────────────────────────────

  private onNodeClicked(node: MapNodeSpec): void {
    if (!this.canClick()) return
    const statuses = deriveNodeStatuses(this.bundle.map, useGameStore.getState().save)
    if (statuses[node.id] === 'locked') return
    EventBus.emit(EV.NODE_SELECTED, { nodeId: node.id, levelRef: node.levelRef } satisfies NodeSelectedPayload)
  }

  private refreshStatuses(animate: boolean): void {
    if (!this.inited) return
    const { save } = useGameStore.getState()
    const statuses = deriveNodeStatuses(this.bundle.map, save)
    for (const [id, site] of this.sites) site.setStatus(statuses[id], animate)
    const revealed = this.clouds.refresh(statuses, animate)
    if (animate && revealed.length > 0) {
      // 镜头轻推向新区域，配合云层散开
      const firstNode = this.bundle.map.nodes.find((n) => (n.region ?? n.id) === revealed[0])
      if (firstNode) {
        const p = this.layout.nodes[firstNode.id]
        this.cameras.main.pan(p.x, p.y, 900, 'Sine.easeInOut')
      }
      sfx.play('unlock')
    }
    if (this.hero && !this.traveling) {
      const desired = resolveHeroNodeId(this.bundle.map, save)
      if (this.hero.currentNodeId !== desired) void this.travelTo(desired, { silent: true })
    }
  }

  // ── 行走 → 进入战斗 ────────────────────────────────────────────

  private findPath(fromId: string, toId: string): string[] {
    const statuses = deriveNodeStatuses(this.bundle.map, useGameStore.getState().save)
    const walkable = (id: string) => id === toId || statuses[id] !== 'locked'
    const adj = new Map<string, string[]>()
    for (const n of this.bundle.map.nodes) {
      for (const to of n.connections) {
        if (!adj.has(n.id)) adj.set(n.id, [])
        if (!adj.has(to)) adj.set(to, [])
        adj.get(n.id)!.push(to)
        adj.get(to)!.push(n.id)
      }
    }
    const prev = new Map<string, string | null>([[fromId, null]])
    const queue: string[] = [fromId]
    while (queue.length) {
      const cur = queue.shift()!
      if (cur === toId) break
      for (const nx of adj.get(cur) ?? []) {
        if (!prev.has(nx) && walkable(nx)) {
          prev.set(nx, cur)
          queue.push(nx)
        }
      }
    }
    if (!prev.has(toId)) return [fromId, toId]
    const path: string[] = []
    let cur: string | null = toId
    while (cur) {
      path.unshift(cur)
      cur = prev.get(cur) ?? null
    }
    return path
  }

  private pathPoints(path: string[]): Pt[] {
    const pts: Pt[] = []
    for (let i = 0; i < path.length - 1; i++) {
      const seg = this.meta.edgeSamples.get(`${path[i]}>${path[i + 1]}`)
      if (!seg) {
        const a = this.layout.nodes[path[i]]
        const b = this.layout.nodes[path[i + 1]]
        pts.push({ x: a.x, y: a.y }, { x: b.x, y: b.y })
        continue
      }
      for (let j = i === 0 ? 0 : 1; j < seg.length; j++) pts.push(seg[j])
    }
    // 终点吸附到建筑门口
    const site = this.sites.get(path[path.length - 1])
    if (site && pts.length) pts.push({ x: site.door.x, y: site.door.y })
    return pts
  }

  private async travelTo(targetId: string, opts: { silent?: boolean } = {}): Promise<void> {
    if (!this.hero || this.traveling) return
    const site = this.sites.get(targetId)
    if (!site) return

    if (this.hero.currentNodeId === targetId) {
      if (!opts.silent) this.arriveAndLaunch(targetId)
      return
    }

    this.traveling = true
    const cam = this.cameras.main
    const path = this.findPath(this.hero.currentNodeId, targetId)
    const pts = this.pathPoints(path)

    if (!opts.silent) {
      cam.startFollow(this.hero.container, false, 0.09, 0.09)
      cam.zoomTo(1.05, 600, 'Sine.easeInOut')
    }
    if (pts.length > 1) {
      await this.hero.walkPoints(pts)
    } else {
      const t = this.layout.nodes[targetId]
      await this.hero.hopTo(t.x, t.y - 10)
    }
    this.hero.currentNodeId = targetId
    if (!opts.silent) {
      cam.stopFollow()
      cam.pan(site.x, site.y, 420, 'Sine.easeInOut')
      cam.zoomTo(1.0, 500, 'Sine.easeInOut')
      sfx.play('step')
      this.traveling = false
      this.arriveAndLaunch(targetId)
    } else {
      this.traveling = false
    }
  }

  private arriveAndLaunch(nodeId: string): void {
    const node = this.bundle.map.nodes.find((n) => n.id === nodeId)
    if (!node) return
    EventBus.emit(EV.ARRIVED, { nodeId })
    this.time.delayedCall(140, () => {
      this.scene.pause()
      this.scene.launch('BattleScene', { levelId: node.levelRef, nodeId: node.id })
    })
  }
}
