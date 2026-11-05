import { useActions, useSave } from '../state/gameStore'
import { useWorldBundle } from '../hooks/useWorldBundle'

export function HUD(): React.ReactElement {
  const save = useSave()
  const actions = useActions()
  const world = useWorldBundle()

  return (
    <header className="hud">
      <div className="hud-left">
        <span className="hud-glyph" aria-hidden />
        <span className="hud-world">{world?.map.worldName ?? 'EduRealm'}</span>
        {world?.map.subtitle && <span className="hud-sub">{world.map.subtitle}</span>}
      </div>
      <div className="hud-right">
        <span className="hud-chip hud-xp" title="经验值">
          <span className="xp-glyph" aria-hidden>◆</span> {save.xp} XP
        </span>
        <span className={`hud-chip diff diff-${save.settings.difficulty}`}>
          {save.settings.difficulty === 'easy' ? '轻松' : save.settings.difficulty === 'hard' ? '严苛' : '标准'}
        </span>
        <button className="hud-btn" onClick={actions.toggleMute} title="音效开关">
          {save.settings.muted ? '音效 关' : '音效 开'}
        </button>
        <button className="hud-btn" onClick={() => actions.toggleDevMenu()} title="开发菜单（`）">
          DEV
        </button>
      </div>
    </header>
  )
}
