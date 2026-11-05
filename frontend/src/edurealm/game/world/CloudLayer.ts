/**
 * CloudLayer —— 云雾战争迷雾。
 * 每个区域（region）由一团柔软云朵覆盖；区域内出现可进入的关卡时，
 * 云层以错落的散开动画揭开新地域（Curiosity / Information Gap）。
 * Boss 区域的云更暗、边缘带紫。
 */
import Phaser from 'phaser'
import type { MapSpec, MapNodeSpec } from '../../schemas/types'
import { TEX } from '../fx/textures'
interface RegionClouds {
  id: string
  puffs: Phaser.GameObjects.Image[]
  label?: Phaser.GameObjects.Text
  dispersed: boolean
}

export class CloudLayer {
  private scene: Phaser.Scene
  private regions = new Map<string, RegionClouds>()
  private nodeRegions = new Map<string, string>()
  private container: Phaser.GameObjects.Container

  constructor(scene: Phaser.Scene, map: MapSpec, layout: Record<string, { x: number; y: number }>) {
    this.scene = scene
    this.container = scene.add.container(0, 0).setDepth(30)

    const rng = new Phaser.Math.RandomDataGenerator([`clouds:${map.worldId}`])
    const regionOf = (n: MapNodeSpec) => n.region ?? n.id
    const labelOf = new Map((map.regions ?? []).map((r) => [r.id, r.label]))

    // 按 region 聚合节点锚点
    const anchors = new Map<string, { x: number; y: number }[]>()
    for (const n of map.nodes) {
      const r = regionOf(n)
      this.nodeRegions.set(n.id, r)
      const p = layout[n.id] ?? { x: 0, y: 0 }
      if (!anchors.has(r)) anchors.set(r, [])
      anchors.get(r)!.push(p)
    }

    for (const [regionId, pts] of anchors) {
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
      const isBoss = map.nodes.some((n) => regionOf(n) === regionId && n.type === 'boss')

      // 云朵围绕区域内的节点聚团（少量在质心），避免向邻区扩散
      const puffs: Phaser.GameObjects.Image[] = []
      const count = 12 + pts.length * 7
      for (let i = 0; i < count; i++) {
        const hugNode = i % 4 !== 0
        const anchor = hugNode ? rng.pick(pts) : { x: cx, y: cy }
        const spread = hugNode ? 190 : 240
        const a = rng.rotation()
        const rr = Math.sqrt(rng.realInRange(0, 1)) * spread
        const x = anchor.x + Math.cos(a) * rr
        const y = anchor.y + Math.sin(a) * rr * 0.78
        const puff = scene.add
          .image(x, y, TEX.cloud)
          .setScale(rng.realInRange(1.35, 2.7))
          .setAlpha(rng.realInRange(0.84, 0.97))
          .setTint(isBoss ? 0x9a8fc0 : 0xf2f4f2)
        puffs.push(puff)
        this.container.add(puff)
        // 缓慢漂移
        scene.tweens.add({
          targets: puff,
          x: x + rng.realInRange(-30, 30),
          y: y + rng.realInRange(-16, 12),
          duration: rng.realInRange(6000, 11000),
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
        })
      }

      // 区域地名（云开后可见）
      const label = labelOf.get(regionId)
      let labelText: Phaser.GameObjects.Text | undefined
      if (label) {
        labelText = scene.add
          .text(cx, cy - 210, label, {
            fontFamily: 'Cinzel, "PingFang SC", serif',
            fontSize: '26px',
            color: isBoss ? '#c8b8ee' : '#6b5a33',
          })
          .setOrigin(0.5)
          .setAlpha(0)
        labelText.setLetterSpacing(6)
        this.container.add(labelText)
      }

      this.regions.set(regionId, { id: regionId, puffs, label: labelText, dispersed: false })
    }
  }

  /** 根据最新解锁状态刷新云层；返回刚散开的区域 id 列表 */
  refresh(statuses: Record<string, 'locked' | 'unlocked' | 'completed'>, animate: boolean): string[] {
    const byRegion = new Map<string, boolean>()
    for (const [nodeId, regionId] of this.nodeRegions) {
      const st = statuses[nodeId]
      if (st === 'unlocked' || st === 'completed') byRegion.set(regionId, true)
    }
    const justRevealed: string[] = []
    for (const [regionId, cloud] of this.regions) {
      const open = byRegion.get(regionId) ?? false
      if (open && !cloud.dispersed) {
        cloud.dispersed = true
        justRevealed.push(regionId)
        if (animate) this.disperse(cloud)
        else this.hide(cloud)
      }
    }
    return justRevealed
  }

  isDispersed(regionId: string): boolean {
    return this.regions.get(regionId)?.dispersed ?? false
  }

  private hide(cloud: RegionClouds): void {
    cloud.puffs.forEach((p) => p.setAlpha(0))
    cloud.label?.setAlpha(0.62)
  }

  private disperse(cloud: RegionClouds): void {
    this.scene.tweens.killTweensOf(cloud.puffs)
    cloud.puffs.forEach((p, i) => {
      this.scene.tweens.add({
        targets: p,
        alpha: 0,
        x: `+=${Phaser.Math.Between(60, 170)}`,
        y: `-=${Phaser.Math.Between(20, 70)}`,
        scale: p.scale * 1.25,
        duration: Phaser.Math.Between(900, 1500),
        delay: i * 42,
        ease: 'Sine.easeOut',
      })
    })
    if (cloud.label) {
      this.scene.tweens.add({
        targets: cloud.label,
        alpha: 0.62,
        delay: 700,
        duration: 900,
      })
    }
  }
}
