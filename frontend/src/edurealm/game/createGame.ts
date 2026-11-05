/**
 * Phaser 游戏实例创建（设计分辨率 1600×900，FIT 缩放）。
 */
import Phaser from 'phaser'
import { BootScene } from './scenes/BootScene'
import { WorldMapScene } from './scenes/WorldMapScene'
import { BattleScene } from './scenes/BattleScene'

export const GAME_WIDTH = 1600
export const GAME_HEIGHT = 900

export function createGame(parent: HTMLElement): Phaser.Game {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    backgroundColor: '#101509',
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    render: { antialias: true, powerPreference: 'high-performance' },
    scene: [BootScene, WorldMapScene, BattleScene],
  })

  // QA / 自动化调试钩子
  if (typeof window !== 'undefined') {
    ;(window as unknown as Record<string, unknown>).__edurealmGame = game
  }
  return game
}
