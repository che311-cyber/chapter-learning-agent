/**
 * 敌人工厂 —— 按 EnemySpec.form 程序化绘制四种形态：
 * wisp（符文之灵）/ golem（石像）/ phantom（幻灵）/ colossus（Boss 巨像）。
 * 统一接口：idle / hurt / attack / phaseEnrage / die。
 */
import Phaser from 'phaser'
import type { EnemySpec } from '../../schemas/types'
import { sfx } from '../audio/Sfx'
import type { EmitterSet } from '../fx/Effects'
import { impactBurst } from '../fx/Effects'
import { TEX } from '../fx/textures'

export class EnemyView {
  readonly container: Phaser.GameObjects.Container
  private scene: Phaser.Scene
  private fx: EmitterSet
  private orbiters: Phaser.GameObjects.Image[] = []
  private eye?: Phaser.GameObjects.Graphics
  private orbitAngle = 0
  private dead = false
  readonly baseY: number

  constructor(scene: Phaser.Scene, spec: EnemySpec, x: number, y: number, fx: EmitterSet) {
    this.scene = scene
    this.fx = fx
    this.baseY = y

    const g = scene.add.graphics()
    const s = spec.size ?? 1
    let attackKind: 'lunge' | 'shot' = 'shot'

    switch (spec.form) {
      case 'wisp': {
        g.fillStyle(0x1c2c50, 0.9)
        g.fillCircle(0, 0, 34 * s)
        g.fillStyle(0x3b5f9e, 0.9)
        g.fillCircle(0, 0, 26 * s)
        g.fillStyle(0x8fd7ff, 1)
        g.fillCircle(-7 * s, -4 * s, 8 * s)
        g.fillCircle(9 * s, -2 * s, 5 * s)
        g.lineStyle(2, 0x5f86c9, 0.7)
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2
          g.beginPath()
          g.arc(0, 0, 40 * s, a, a + 0.9)
          g.strokePath()
        }
        attackKind = 'shot'
        break
      }
      case 'golem': {
        g.fillStyle(0x2a2f45, 1)
        g.fillRoundedRect(-46 * s, -20 * s, 92 * s, 64 * s, 10 * s)
        g.fillStyle(0x222739, 1)
        g.fillRoundedRect(-34 * s, -52 * s, 68 * s, 40 * s, 9 * s)
        g.fillStyle(0x1b1f30, 1)
        g.fillRoundedRect(-58 * s, -10 * s, 22 * s, 44 * s, 7 * s)
        g.fillRoundedRect(36 * s, -10 * s, 22 * s, 44 * s, 7 * s)
        g.fillStyle(0x57c8b4, 0.95)
        g.fillCircle(0, -32 * s, 7 * s)
        g.lineStyle(2.5, 0x57c8b4, 0.55)
        g.beginPath()
        g.moveTo(-18 * s, -8 * s)
        g.lineTo(-4 * s, -20 * s)
        g.lineTo(6 * s, -4 * s)
        g.lineTo(20 * s, -16 * s)
        g.strokePath()
        attackKind = 'lunge'
        break
      }
      case 'phantom': {
        g.fillStyle(0x232a4e, 0.85)
        g.fillCircle(0, -10 * s, 44 * s)
        g.fillStyle(0x2f3a6b, 0.9)
        g.fillCircle(0, -18 * s, 32 * s)
        g.fillStyle(0x10152c, 1)
        g.fillCircle(0, -22 * s, 18 * s)
        g.fillStyle(0xb7a2ff, 1)
        g.fillCircle(-6 * s, -24 * s, 3.4 * s)
        g.fillCircle(7 * s, -24 * s, 3.4 * s)
        g.fillStyle(0x232a4e, 0.5)
        g.fillCircle(-30 * s, 26 * s, 10 * s)
        g.fillCircle(28 * s, 30 * s, 8 * s)
        attackKind = 'shot'
        break
      }
      case 'colossus': {
        // Boss：巨大方尖碑体 + 悬浮碎片 + 独眼
        g.fillStyle(0x1a1f38, 1)
        g.fillRoundedRect(-52 * s, -120 * s, 104 * s, 190 * s, 14 * s)
        g.fillStyle(0x232a4e, 1)
        g.fillRoundedRect(-40 * s, -108 * s, 80 * s, 70 * s, 10 * s)
        g.fillStyle(0x141830, 1)
        g.fillTriangle(-52 * s, -120 * s, 0, -170 * s, 52 * s, -120 * s)
        g.lineStyle(2, 0xe06a55, 0.8)
        g.beginPath()
        g.moveTo(-24 * s, -40 * s)
        g.lineTo(-8 * s, -80 * s)
        g.lineTo(10 * s, -30 * s)
        g.lineTo(26 * s, -66 * s)
        g.strokePath()
        // 王冠尖刺
        g.fillStyle(0x3a2534, 1)
        g.fillTriangle(-40 * s, -120 * s, -28 * s, -160 * s, -16 * s, -120 * s)
        g.fillTriangle(16 * s, -120 * s, 28 * s, -160 * s, 40 * s, -120 * s)
        this.eye = scene.add.graphics()
        this.eye.fillStyle(0x57c8b4, 1)
        this.eye.fillCircle(0, -70 * s, 13 * s)
        this.eye.fillStyle(0xffffff, 0.85)
        this.eye.fillCircle(-4 * s, -74 * s, 4 * s)
        this.eye.setScale(s)
        // 悬浮碎片
        for (let i = 0; i < 4; i++) {
          const orb = scene.add
            .image(x, y - 60 * s, TEX.spark)
            .setTint(0x8fd7ff)
            .setScale(1.6 * s)
            .setBlendMode(Phaser.BlendModes.ADD)
          this.orbiters.push(orb)
        }
        attackKind = 'lunge'
        break
      }
    }

    const parts: Phaser.GameObjects.GameObject[] = [g]
    if (this.eye) parts.push(this.eye)
    this.container = scene.add.container(x, y, parts).setDepth(210)
    this.baseY = y

    // 待机
    scene.tweens.add({
      targets: this.container,
      y: y + (spec.form === 'colossus' ? 5 : 9),
      duration: spec.form === 'colossus' ? 2200 : 1300,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    })

    // Boss 碎片轨道运动在 Scene update 中驱动（storeOrbiters）
    this.container.setData('orbiters', this.orbiters)
    this.container.setData('attackKind', attackKind)
    this.container.setData('size', s)
  }

  /** Scene.update 每帧调用：Boss 碎片轨道 */
  update(delta: number): void {
    if (this.orbiters.length === 0 || this.dead) return
    this.orbitAngle += (delta / 1000) * (this.enraged ? 3.2 : 1.6)
    const s = (this.container.getData('size') as number) ?? 1
    const radius = 90 * s
    const oy = -60 * s
    this.orbiters.forEach((orb, i) => {
      const a = this.orbitAngle + (i / this.orbiters.length) * Math.PI * 2
      orb.setPosition(
        this.container.x + Math.cos(a) * radius,
        this.container.y + oy + Math.sin(a) * radius * 0.42,
      )
      orb.setDepth(Math.sin(a) > 0 ? 215 : 205)
      orb.setAlpha(0.55 + 0.35 * Math.sin(a * 2))
    })
  }

  private enraged = false

  /** Boss 阶段强化：变红 + 提速 */
  phaseEnrage(): void {
    this.enraged = true
    const g = this.container.list[0] as Phaser.GameObjects.Graphics
    this.scene.tweens.add({
      targets: g,
      alpha: { from: 1, to: 0.85 },
      duration: 120,
      yoyo: true,
      repeat: 3,
    })
    if (this.eye) {
      this.eye.clear()
      this.eye.fillStyle(0xff5a45, 1)
      this.eye.fillCircle(0, -70 * ((this.container.getData('size') as number) ?? 1), 13 * ((this.container.getData('size') as number) ?? 1))
      this.eye.fillStyle(0xffffff, 0.9)
      this.eye.fillCircle(-4, -74 * ((this.container.getData('size') as number) ?? 1), 4 * ((this.container.getData('size') as number) ?? 1))
    }
    this.orbiters.forEach((o) => o.setTint(0xff8d76))
    sfx.play('phase')
  }

  hurt(): void {
    const tintable = this.container.list as Array<{ setTintFill?: (c: number) => void; clearTint?: () => void }>
    tintable.forEach((c) => c.setTintFill?.(0xffffff))
    this.scene.tweens.add({
      targets: this.container,
      x: this.container.x + 14,
      duration: 80,
      yoyo: true,
      ease: 'Sine.easeOut',
    })
    this.scene.time.delayedCall(90, () => tintable.forEach((c) => c.clearTint?.()))
  }

  get attackType(): 'lunge' | 'shot' {
    return this.container.getData('attackKind') as 'lunge' | 'shot'
  }

  /** 攻击玩家：近战突进或弹丸 */
  async attack(targetX: number, targetY: number): Promise<void> {
    if (this.dead) return
    if (this.attackType === 'lunge') {
      const sx = this.container.x
      await new Promise<void>((res) => {
        this.scene.tweens.add({
          targets: this.container,
          x: targetX + 120,
          duration: 220,
          ease: 'Cubic.easeIn',
          onComplete: () => res(),
        })
      })
      impactBurst(this.scene, this.fx, targetX + 60, targetY, 8)
      await new Promise<void>((res) => {
        this.scene.tweens.add({
          targets: this.container,
          x: sx,
          duration: 340,
          ease: 'Sine.easeOut',
          onComplete: () => res(),
        })
      })
    } else {
      const orb = this.scene.add
        .image(this.container.x - 30, this.container.y - 10, TEX.soft)
        .setTint(this.enraged ? 0xff8d76 : 0x8fb8ff)
        .setScale(0.85)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(820)
      await new Promise<void>((res) => {
        this.scene.tweens.add({
          targets: orb,
          x: targetX + 30,
          y: targetY,
          duration: 340,
          ease: 'Cubic.easeIn',
          onUpdate: () => this.fx.trail.emitParticleAt(orb.x, orb.y, 1),
          onComplete: () => res(),
        })
      })
      impactBurst(this.scene, this.fx, targetX + 30, targetY, 10)
      orb.destroy()
    }
  }

  /** 死亡：粒子消散 */
  async die(): Promise<void> {
    if (this.dead) return
    this.dead = true
    this.scene.tweens.killTweensOf(this.container)
    this.orbiters.forEach((o) => o.destroy())
    this.orbiters = []
    sfx.play('hit')
    this.fx.burst.explode(46, this.container.x, this.container.y)
    await new Promise<void>((res) => {
      this.scene.tweens.add({
        targets: this.container,
        alpha: 0,
        scaleY: 0.1,
        scaleX: 1.4,
        duration: 620,
        ease: 'Cubic.easeIn',
        onComplete: () => {
          this.container.setVisible(false)
          res()
        },
      })
    })
  }
}

export function createEnemy(scene: Phaser.Scene, spec: EnemySpec, x: number, y: number, fx: EmitterSet): EnemyView {
  return new EnemyView(scene, spec, x, y, fx)
}
