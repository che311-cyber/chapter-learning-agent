import { useActions } from '../state/gameStore'
import { useWorldBundle } from '../hooks/useWorldBundle'

export function Landing(): React.ReactElement {
  const actions = useActions()
  const world = useWorldBundle()

  return (
    <div className="landing">
      <div className="landing-rune" aria-hidden />
      <div className="landing-inner">
        <div className="landing-overline">EDUREALM ENGINE · V0</div>
        <h1 className="landing-title">{world?.map.worldName ?? 'EduRealm'}</h1>
        <p className="landing-sub">{world?.map.subtitle ?? '数据驱动的教育冒险引擎'}</p>
        <p className="landing-desc">
          {world?.map.theme.description ??
            '教材 → AI 理解 → MapSpec / LevelSpec → 游戏世界。本演示的全部内容来自可替换的 JSON 配置。'}
        </p>
        <button className="btn btn-primary btn-lg" onClick={actions.beginGame}>
          进入世界
        </button>
        <button className="btn btn-ghost btn-sm landing-reset" onClick={actions.devResetSave}>
          重置存档
        </button>
        <div className="landing-foot">React × Phaser · 内容与规则完全配置化 · 进度本地保存</div>
      </div>
    </div>
  )
}
