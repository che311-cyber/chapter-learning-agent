/**
 * 特效工具：伤害数字、粒子爆发、受击白闪、冲击波。
 * 全部基于运行时生成的纹理（见 fx/textures.ts）。
 */
import Phaser from 'phaser'
import { TEX } from './textures'

const FONT = 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif'

export type DamageStyle = 'enemyHit' | 'playerHit' | 'combo' | 'crit' | 'xp' | 'label'

export function damageNumber(
  scene: Phaser.Scene,
  x: number,
  y: number,
  text: string,
  style: DamageStyle = 'enemyHit',
): void {
  const conf: Record<DamageStyle, { color: string; size: string; dy: number; dur: number }> = {
    enemyHit: { color: '#ffe9c4', size: '30px', dy: -56, dur: 800 },
    playerHit: { color: '#ff8d76', size: '28px', dy: -50, dur: 800 },
    combo: { color: '#ffd27a', size: '34px', dy: -80, dur: 950 },
    crit: { color: '#ffd27a', size: '40px', dy: -66, dur: 950 },
    xp: { color: '#a8e6d5', size: '24px', dy: -60, dur: 1100 },
    label: { color: '#e9e7df', size: '22px', dy: -44, dur: 1200 },
  }
  const c = conf[style]
  const t = scene.add
    .text(x, y, text, {
      fontFamily: FONT,
      fontSize: c.size,
      color: c.color,
      stroke: '#05070d',
      strokeThickness: 5,
      fontStyle: 'bold',
    })
    .setOrigin(0.5)
    .setDepth(900)
    .setAlpha(0)

  scene.tweens.add({
    targets: t,
    alpha: 1,
    y: y + c.dy * 0.4,
    scale: { from: 0.5, to: 1 },
    duration: 140,
    ease: 'Back.easeOut',
    onComplete: () => {
      scene.tweens.add({
        targets: t,
        y: y + c.dy,
        alpha: 0,
        duration: c.dur,
        ease: 'Cubic.easeOut',
        onComplete: () => t.destroy(),
      })
    },
  })
}

export interface EmitterSet {
  burst: Phaser.GameObjects.Particles.ParticleEmitter
  trail: Phaser.GameObjects.Particles.ParticleEmitter
  ambient: Phaser.GameObjects.Particles.ParticleEmitter
}

/** 创建一组可复用的粒子发射器（默认全部停止发射） */
export function createEmitters(scene: Phaser.Scene, tint: number): EmitterSet {
  const burst = scene.add
    .particles(0, 0, TEX.spark, {
      speed: { min: 80, max: 260 },
      lifespan: { min: 300, max: 700 },
      scale: { start: 1.1, end: 0 },
      alpha: { start: 1, end: 0 },
      blendMode: 'ADD',
      tint,
      emitting: false,
    })
    .setDepth(800)

  const trail = scene.add
    .particles(0, 0, TEX.soft, {
      speed: { min: 5, max: 30 },
      lifespan: 420,
      scale: { start: 0.55, end: 0 },
      alpha: { start: 0.7, end: 0 },
      blendMode: 'ADD',
      tint,
      emitting: false,
    })
    .setDepth(700)

  const ambient = scene.add
    .particles(0, 0, TEX.dust, {
      x: { min: 0, max: 1600 },
      y: { min: 0, max: 900 },
      lifespan: { min: 3000, max: 7000 },
      speedY: { min: -14, max: -4 },
      speedX: { min: -6, max: 6 },
      scale: { start: 0.7, end: 0.2 },
      alpha: { start: 0, end: 0 },
      quantity: 1,
      frequency: 420,
      tint,
    })
    .setDepth(60)

  // ambient 淡入淡出呼吸
  scene.tweens.add({
    targets: ambient,
    alpha: { from: 0, to: 0.5 },
    duration: 2000,
    yoyo: true,
    repeat: -1,
  })

  return { burst, trail, ambient }
}

/** 粒子爆发 + 冲击波圆环 */
export function impactBurst(
  scene: Phaser.Scene,
  fx: EmitterSet,
  x: number,
  y: number,
  count = 14,
): void {
  fx.burst.explode(count, x, y)
  const ring = scene.add
    .image(x, y, TEX.ring)
    .setDepth(790)
    .setBlendMode(Phaser.BlendModes.ADD)
    .setScale(0.3)
    .setAlpha(0.9)
  scene.tweens.add({
    targets: ring,
    scale: 1.6,
    alpha: 0,
    duration: 320,
    ease: 'Cubic.easeOut',
    onComplete: () => ring.destroy(),
  })
}
