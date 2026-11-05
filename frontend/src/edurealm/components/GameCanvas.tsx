import { useEffect, useRef } from 'react'
import type Phaser from 'phaser'
import { createGame } from '../game/createGame'

type AnyWindow = Window & Record<string, any>

export function GameCanvas(): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const gameRef = useRef<Phaser.Game | null>(null)

  useEffect(() => {
    if (!hostRef.current || gameRef.current) return
    const game = createGame(hostRef.current)
    gameRef.current = game
    const w = window as AnyWindow
    w.__erLive = ((w.__erLive as number) || 0) + 1

    return () => {
      gameRef.current = null
      // 第二个参数 noReturn 必须为 false（默认）：传 true 会销毁 Phaser 模块级的
      // 全局核心插件注册表（PluginCache），导致后续 new Phaser.Game() 在 boot
      // 第一行 abort——表现为第二次进入游戏模式永远黑屏。
      // pre-boot 销毁时 Phaser 可能遗留 canvas，稍后定点移除本实例的画布。
      const cv = game.canvas
      game.destroy(true)
      w.__erLive = Math.max(0, ((w.__erLive as number) || 1) - 1)
      if (w.__edurealmGame === game) delete w.__edurealmGame
      setTimeout(() => {
        if (cv?.parentElement) cv.parentElement.removeChild(cv)
      }, 250)
    }
  }, [])

  return <div ref={hostRef} className="game-canvas" aria-label="game-canvas" />
}
