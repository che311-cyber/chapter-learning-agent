/**
 * Ambient —— 克制的环境动画层：
 * 水面波光 / 瀑布 / 风车叶片 / 火把火光 / 树冠摆动 / 鸟群 / Boss 区域低压云涡。
 * 全部低强度，负责"世界是活的"，不抢关卡视觉。
 */
import Phaser from 'phaser'
import type { WorldMeta } from './worldPainter'

export function createAmbient(scene: Phaser.Scene, meta: WorldMeta): void {
  // ── 水面波光（湖 + 河） ──
  const water = meta.water.filter((c) => c.r >= 12)
  for (let i = 0; i < Math.min(26, water.length); i++) {
    const c = water[Math.floor((i * water.length) / 26)]
    const x = c.x + Phaser.Math.Between(-c.r * 0.4, c.r * 0.4)
    const y = c.y + Phaser.Math.Between(-c.r * 0.25, c.r * 0.25)
    const glint = scene.add
      .arc(x, y, Phaser.Math.Between(5, 11), 0, 360, false)
      .setStrokeStyle(1.6, 0xd9eef5, 0.7)
      .setAlpha(0)
      .setDepth(2)
    scene.tweens.add({
      targets: glint,
      alpha: { from: 0, to: 0.7 },
      duration: Phaser.Math.Between(1400, 2600),
      yoyo: true,
      repeat: -1,
      delay: Phaser.Math.Between(0, 3000),
      ease: 'Sine.easeInOut',
    })
  }

  // ── 瀑布（垂落光带 + 底部泡沫粒子） ──
  const wf = meta.waterfall
  for (let i = 0; i < 3; i++) {
    const x = wf.x - 20 + i * 20
    const streak = scene.add
      .rectangle(x, wf.y + 26, 7 - i, Phaser.Math.Between(38, 52), 0xd9eef5, 0.55)
      .setDepth(3)
      .setBlendMode(Phaser.BlendModes.SCREEN)
    scene.tweens.add({
      targets: streak,
      alpha: { from: 0.25, to: 0.75 },
      scaleY: { from: 0.8, to: 1.15 },
      duration: Phaser.Math.Between(500, 800),
      yoyo: true,
      repeat: -1,
      delay: i * 160,
      ease: 'Sine.easeInOut',
    })
  }
  const foam = scene.add.particles(wf.x, wf.y + 46, 'fx-dust', {
    speedX: { min: -26, max: 26 },
    speedY: { min: -8, max: 12 },
    lifespan: 900,
    scale: { start: 1.1, end: 0 },
    alpha: { start: 0.8, end: 0 },
    tint: 0xd9eef5,
    frequency: 180,
    quantity: 1,
  })
  foam.setDepth(3)

  // ── 风车叶片 ──
  const wm = meta.windmill
  const blades = scene.add.graphics({ x: wm.x, y: wm.y - 48 }).setDepth(3)
  blades.lineStyle(3, 0x6e4f33, 1)
  for (let i = 0; i < 4; i++) {
    blades.save()
    blades.rotateCanvas((i * Math.PI) / 2)
    blades.beginPath()
    blades.moveTo(0, 0)
    blades.lineTo(30, -4)
    blades.strokePath()
    blades.fillStyle(0xe8e0c8, 0.95)
    blades.fillPoints([new Phaser.Geom.Point(30, -4), new Phaser.Geom.Point(29, -16), new Phaser.Geom.Point(12, -6)], true)
    blades.restore()
  }
  scene.tweens.add({ targets: blades, angle: 360, duration: 16000, repeat: -1 })

  // ── 火把火光 ──
  for (const t of meta.torches) {
    const glow = scene.add
      .image(t.x, t.y - 4, 'fx-soft')
      .setTint(0xf2a541)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(0.5)
      .setAlpha(0.4)
      .setDepth(4)
    scene.tweens.add({
      targets: glow,
      alpha: { from: 0.24, to: 0.5 },
      scale: { from: 0.42, to: 0.6 },
      duration: Phaser.Math.Between(420, 700),
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    })
  }

  // ── 树冠摆动（道路沿线的半透明树冠覆盖层） ──
  for (const t of meta.swayTrees) {
    const canopy = scene.add
      .graphics({ x: t.x, y: t.y })
      .setDepth(3)
    canopy.fillStyle(0x579649, 0.85)
    canopy.fillCircle(0, 0, t.r)
    canopy.fillStyle(0x74b35c, 0.7)
    canopy.fillCircle(-t.r * 0.3, -t.r * 0.3, t.r * 0.6)
    scene.tweens.add({
      targets: canopy,
      angle: { from: -2.4, to: 2.4 },
      duration: Phaser.Math.Between(1800, 2600),
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    })
  }

  // ── 鸟群（定时横越） ──
  const spawnBirds = () => {
    const y = Phaser.Math.Between(120, 420)
    const fromLeft = Math.random() < 0.5
    const flock = scene.add.container(fromLeft ? -60 : 2460, y).setDepth(5)
    const n = Phaser.Math.Between(3, 5)
    for (let i = 0; i < n; i++) {
      const g = scene.add.graphics({ x: -i * 18, y: (i % 2 === 0 ? -1 : 1) * i * 6 })
      g.lineStyle(2, 0x3a3f35, 0.85)
      g.beginPath()
      g.moveTo(-6, 0)
      g.lineTo(0, -4)
      g.lineTo(6, 0)
      g.strokePath()
      flock.add(g)
      scene.tweens.add({
        targets: g,
        scaleY: { from: 1, to: 0.3 },
        duration: 340,
        yoyo: true,
        repeat: -1,
        delay: i * 90,
      })
    }
    scene.tweens.add({
      targets: flock,
      x: fromLeft ? 2460 : -60,
      y: y + Phaser.Math.Between(-60, 60),
      duration: Phaser.Math.Between(26000, 34000),
      onComplete: () => flock.destroy(),
    })
  }
  scene.time.addEvent({ delay: 9000, loop: true, callback: spawnBirds })
  scene.time.delayedCall(1500, spawnBirds)

  // ── Boss 区域：低压紫雾涡 ──
  const bc = meta.bossCenter
  for (let i = 0; i < 4; i++) {
    const mist = scene.add
      .image(bc.x + Phaser.Math.Between(-150, 150), bc.y + Phaser.Math.Between(40, 130), 'fx-soft')
      .setTint(0x6d5a9e)
      .setAlpha(Phaser.Math.Between(8, 16) / 100)
      .setScale(Phaser.Math.Between(16, 26) / 10)
      .setDepth(4)
    scene.tweens.add({
      targets: mist,
      x: mist.x + Phaser.Math.Between(-50, 50),
      alpha: { from: 0.08, to: 0.2 },
      duration: Phaser.Math.Between(3600, 5600),
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    })
  }
}
