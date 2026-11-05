/**
 * 玩家角色 ——「行者」：全程序化绘制的兜帽学者。
 * 动画：待机呼吸 / 沿曲线路径行走 / 冲刺攻击 / 施法弹丸 / 受击 / 欢庆。
 */
import Phaser from 'phaser'
import type { EmitterSet } from '../fx/Effects'
import { impactBurst } from '../fx/Effects'
import { TEX } from '../fx/textures'
import { sfx } from '../audio/Sfx'

export class Hero {
  readonly container: Phaser.GameObjects.Container
  private scene: Phaser.Scene
  private fx: EmitterSet
  private orb: Phaser.GameObjects.Image
  private scarf: Phaser.GameObjects.Triangle
  currentNodeId: string

  constructor(scene: Phaser.Scene, x: number, y: number, nodeId: string, fx: EmitterSet) {
    this.scene = scene
    this.fx = fx
    this.currentNodeId = nodeId

    const g = scene.add.graphics()
    // 披风
    g.fillStyle(0x24405c, 1)
    g.fillTriangle(-16, 8, 16, 8, 0, -26)
    g.fillStyle(0x1a3049, 1)
    g.fillTriangle(-16, 8, -6, 8, -11, -20)
    // 身体下摆
    g.fillStyle(0x2b4a68, 1)
    g.fillRoundedRect(-11, -6, 22, 16, 4)
    // 头
    g.fillStyle(0x0d1420, 1)
    g.fillCircle(0, -30, 9)
    // 兜帽
    g.fillStyle(0x2e5170, 1)
    g.slice(0, -31, 12, Phaser.Math.DegToRad(200), Phaser.Math.DegToRad(20), false)
    g.fillCircle(0, -31, 6)
    // 发光的眼睛
    g.fillStyle(0x9fe8dc, 1)
    g.fillCircle(-3, -30, 1.6)
    g.fillCircle(3, -30, 1.6)
    // 法杖
    g.lineStyle(3, 0x6b5a3e, 1)
    g.beginPath()
    g.moveTo(14, 6)
    g.lineTo(20, -34)
    g.strokePath()
    // 围巾飘带
    this.scarf = scene.add.triangle(0, -14, 0, 0, 16, 4, 2, 10, 0x57c8b4)

    this.orb = scene.add
      .image(21, -37, TEX.soft)
      .setTint(0xd8b36a)
      .setScale(0.5)
      .setBlendMode(Phaser.BlendModes.ADD)

    this.container = scene.add.container(x, y, [g, this.scarf, this.orb]).setDepth(200)

    // 待机呼吸
    scene.tweens.add({
      targets: this.container,
      y: y - 4,
      duration: 1500,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    })
    scene.tweens.add({
      targets: this.orb,
      alpha: { from: 0.65, to: 1 },
      scale: { from: 0.45, to: 0.58 },
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    })
    // 围巾摆动
    scene.tweens.add({
      targets: this.scarf,
      angle: { from: -8, to: 8 },
      duration: 1200,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    })
  }

  get x(): number {
    return this.container.x
  }
  get y(): number {
    return this.container.y
  }

  private wait(ms: number): Promise<void> {
    return new Promise((res) => this.scene.time.delayedCall(ms, () => res()))
  }

  /** 沿曲线序列行走（旧接口，保留兼容） */
  async walkAlong(curves: Phaser.Curves.QuadraticBezier[], emitArrivalDust = true): Promise<void> {
    const pts: { x: number; y: number }[] = []
    for (const c of curves) for (let i = 0; i <= 24; i++) pts.push(c.getPoint(i / 24))
    await this.walkPoints(pts, emitArrivalDust)
  }

  /** 沿折线匀速行走（地图道路） */
  async walkPoints(points: { x: number; y: number }[], emitDust = true): Promise<void> {
    if (points.length < 2) return
    this.scene.tweens.killTweensOf(this.container)
    // 累计长度
    const segLens: number[] = []
    let total = 0
    for (let i = 0; i < points.length - 1; i++) {
      const l = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y)
      segLens.push(l)
      total += l
    }
    const duration = Phaser.Math.Clamp(total * 1.9, 500, 4200)
    const proxy = { d: 0 }
    let lastStepD = 0
    await new Promise<void>((res) => {
      this.scene.tweens.add({
        targets: proxy,
        d: total,
        duration,
        ease: 'Sine.easeInOut',
        onUpdate: () => {
          let remain = proxy.d
          let i = 0
          while (i < segLens.length - 1 && remain > segLens[i]) {
            remain -= segLens[i]
            i++
          }
          const t = segLens[i] === 0 ? 0 : remain / segLens[i]
          const x = points[i].x + (points[i + 1].x - points[i].x) * t
          const y = points[i].y + (points[i + 1].y - points[i].y) * t
          this.container.setPosition(x, y)
          if (proxy.d - lastStepD > 34) {
            lastStepD = proxy.d
            sfx.play('step')
            if (emitDust) this.fx.trail.emitParticleAt(x, y + 14, 1)
          }
        },
        onComplete: () => res(),
      })
    })
    this.resumeIdle()
  }

  private resumeIdle(): void {
    const baseY = this.container.y
    this.scene.tweens.add({
      targets: this.container,
      y: baseY - 4,
      duration: 1500,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    })
  }

  /** 冲刺攻击：冲向目标 → 挥砍 → 返回 */
  async dashAttack(targetX: number, targetY: number): Promise<void> {
    this.scene.tweens.killTweensOf(this.container)
    const sx = this.container.x
    const ex = targetX - 110
    await new Promise<void>((res) => {
      this.scene.tweens.add({
        targets: this.container,
        x: ex,
        y: targetY - 6,
        duration: 240,
        ease: 'Cubic.easeIn',
        onComplete: () => res(),
      })
    })
    // 挥砍弧光
    const slash = this.scene.add.graphics().setDepth(850)
    slash.lineStyle(5, 0xffffff, 0.95)
    slash.beginPath()
    slash.arc(targetX - 40, targetY, 56, Phaser.Math.DegToRad(110), Phaser.Math.DegToRad(250))
    slash.strokePath()
    sfx.play('slash')
    this.scene.tweens.add({
      targets: slash,
      alpha: 0,
      duration: 220,
      onComplete: () => slash.destroy(),
    })
    impactBurst(this.scene, this.fx, targetX - 30, targetY, 10)
    await this.wait(120)
    await new Promise<void>((res) => {
      this.scene.tweens.add({
        targets: this.container,
        x: sx,
        y: this.container.y,
        duration: 340,
        ease: 'Sine.easeOut',
        onComplete: () => res(),
      })
    })
    this.resumeIdle()
  }

  /** 施法：法杖射出能量弹 */
  async castProjectile(targetX: number, targetY: number, tint = 0xd8b36a): Promise<void> {
    const orb = this.scene.add
      .image(this.container.x + 21, this.container.y - 37, TEX.soft)
      .setTint(tint)
      .setScale(0.7)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(820)
    sfx.play('skill')
    await new Promise<void>((res) => {
      this.scene.tweens.add({
        targets: orb,
        x: targetX,
        y: targetY,
        scale: 1.1,
        duration: 300,
        ease: 'Cubic.easeIn',
        onUpdate: () => this.fx.trail.emitParticleAt(orb.x, orb.y, 2),
        onComplete: () => res(),
      })
    })
    impactBurst(this.scene, this.fx, targetX, targetY, 16)
    orb.destroy()
  }

  /** 受击：红闪 + 击退 */
  hurt(): void {
    const sx = this.container.x
    this.scene.tweens.add({
      targets: this.container,
      x: sx - 16,
      duration: 90,
      yoyo: true,
      ease: 'Sine.easeOut',
    })
    const tintable = this.container.list as Array<{ setTintFill?: (c: number) => void; clearTint?: () => void }>
    tintable.forEach((c) => c.setTintFill?.(0xff6a55))
    this.scene.time.delayedCall(110, () => tintable.forEach((c) => c.clearTint?.()))
  }

  /** 胜利欢庆 */
  celebrate(): void {
    this.scene.tweens.add({
      targets: this.container,
      y: this.container.y - 26,
      duration: 260,
      yoyo: true,
      repeat: 2,
      ease: 'Sine.easeOut',
    })
    this.fx.burst.explode(20, this.container.x, this.container.y - 20)
  }

  /** 战败倒下 */
  fall(): void {
    this.scene.tweens.killTweensOf(this.container)
    this.scene.tweens.add({
      targets: this.container,
      angle: 80,
      alpha: 0.35,
      y: this.container.y + 14,
      duration: 700,
      ease: 'Cubic.easeIn',
    })
  }

  /** 短距离跳到某点（回位） */
  async hopTo(x: number, y: number): Promise<void> {
    this.scene.tweens.killTweensOf(this.container)
    await new Promise<void>((res) => {
      this.scene.tweens.add({
        targets: this.container,
        x,
        y,
        duration: 500,
        ease: 'Sine.easeInOut',
        onComplete: () => res(),
      })
    })
    this.resumeIdle()
  }
}
