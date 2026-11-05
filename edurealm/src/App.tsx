import { useEffect, useState } from 'react'
import { GameCanvas } from './components/GameCanvas'
import { OverlayRoot } from './components/OverlayRoot'
import { loadWorld } from './services/contentService'
import { sfx } from './game/audio/Sfx'

export default function App(): React.ReactElement {
  const [bootError, setBootError] = useState<string | null>(null)

  useEffect(() => {
    loadWorld().catch((e: unknown) => setBootError(e instanceof Error ? e.message : String(e)))
  }, [])

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
