/**
 * EduRealm 引擎挂载组件（拷贝自 edurealm App.tsx，适配集成模式）：
 *  - skipLanding: 跳过落地页，直接进入世界地图（由外层 GameContainer 水合存档后使用）
 *  - 其余（Phaser Canvas / Overlay / 音频解锁）与原引擎完全一致
 */
import { useEffect, useState } from 'react'
import { GameCanvas } from './GameCanvas'
import { OverlayRoot } from './OverlayRoot'
import { loadWorld } from '../services/contentService'
import { sfx } from '../game/audio/Sfx'
import { useGameStore } from '../state/gameStore'

export default function EdurealmApp({ skipLanding = false }: { skipLanding?: boolean }): React.ReactElement {
  const [bootError, setBootError] = useState<string | null>(null)

  useEffect(() => {
    loadWorld().catch((e: unknown) => setBootError(e instanceof Error ? e.message : String(e)))
  }, [])

  // 集成模式：跳过 Landing 直达地图
  useEffect(() => {
    if (skipLanding && useGameStore.getState().ui.screen === 'landing') {
      useGameStore.setState({ ui: { ...useGameStore.getState().ui, screen: 'map' } })
    }
  }, [skipLanding])

  // 浏览器自动播放策略：首次手势解锁音频
  useEffect(() => {
    const h = () => sfx.unlock()
    window.addEventListener('pointerdown', h, { once: true })
    return () => window.removeEventListener('pointerdown', h)
  }, [])

  if (bootError) {
    return (
      <div className="boot-error">
        <h2>内容加载失败</h2>
        <pre>{bootError}</pre>
      </div>
    )
  }

  return (
    <div className="app">
      <GameCanvas />
      <div className="vignette" aria-hidden />
      <OverlayRoot />
    </div>
  )
}
