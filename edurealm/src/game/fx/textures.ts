/**
 * 运行时程序化纹理 —— 启动时生成，无任何外部素材。
 */
import Phaser from 'phaser'

export const TEX = {
  soft: 'fx-soft',
  spark: 'fx-spark',
  dust: 'fx-dust',
  ring: 'fx-ring',
  cloud: 'fx-cloud',
} as const

export function buildTextures(scene: Phaser.Scene): void {
  // 云朵（实心柔和团：迷雾用，中心近实心）
  if (!scene.textures.exists(TEX.cloud)) {
    const g = scene.add.graphics()
    const rings = 12
    for (let i = rings; i >= 1; i--) {
      const t = i / rings
      g.fillStyle(0xffffff, 0.16 + (1 - t) * 0.8)
      g.fillCircle(64, 64, 60 * t)
    }
    g.generateTexture(TEX.cloud, 128, 128)
    g.destroy()
  }

  // 柔光圆（粒子主体）：同心圆叠加模拟径向渐变
  if (!scene.textures.exists(TEX.soft)) {
    const g = scene.add.graphics()
    const steps = 10
    for (let i = steps; i >= 1; i--) {
      const t = i / steps
      g.fillStyle(0xffffff, 0.075 * (1 - t) + 0.012)
      g.fillCircle(32, 32, 30 * t)
    }
    g.generateTexture(TEX.soft, 64, 64)
    g.destroy()
  }

  // 四芒星火花
  if (!scene.textures.exists(TEX.spark)) {
    const g = scene.add.graphics()
    g.fillStyle(0xffffff, 1)
    g.fillPoints(
      [
        new Phaser.Geom.Point(6, 0),
        new Phaser.Geom.Point(7.5, 4.5),
        new Phaser.Geom.Point(12, 6),
        new Phaser.Geom.Point(7.5, 7.5),
        new Phaser.Geom.Point(6, 12),
        new Phaser.Geom.Point(4.5, 7.5),
        new Phaser.Geom.Point(0, 6),
        new Phaser.Geom.Point(4.5, 4.5),
      ],
      true,
    )
    g.generateTexture(TEX.spark, 12, 12)
    g.destroy()
  }

  // 尘埃微粒
  if (!scene.textures.exists(TEX.dust)) {
    const g = scene.add.graphics()
    g.fillStyle(0xffffff, 1)
    g.fillCircle(3, 3, 2.4)
    g.generateTexture(TEX.dust, 6, 6)
    g.destroy()
  }

  // 细圆环（冲击波）
  if (!scene.textures.exists(TEX.ring)) {
    const g = scene.add.graphics()
    g.lineStyle(3, 0xffffff, 1)
    g.strokeCircle(24, 24, 21)
    g.generateTexture(TEX.ring, 48, 48)
    g.destroy()
  }
}
