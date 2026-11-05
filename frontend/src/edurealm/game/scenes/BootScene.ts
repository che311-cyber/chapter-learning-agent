/**
 * 启动场景：生成运行时纹理 → 等字体就绪 → 进入世界地图。
 */
import Phaser from 'phaser'
import { buildTextures } from '../fx/textures'

export class BootScene extends Phaser.Scene {
  private started = false

  constructor() {
    super('BootScene')
  }

  create(): void {
    buildTextures(this)
    const start = () => {
      if (this.started) return
      this.started = true
      this.scene.start('WorldMapScene')
    }
    // 字体加载通常很快；2.5s 兜底防止离线环境卡死
    const timer = setTimeout(start, 2500)
    if (document.fonts) {
      void document.fonts.ready.then(() => {
        clearTimeout(timer)
        start()
      })
    }
  }
}
