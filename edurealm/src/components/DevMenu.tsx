/**
 * 开发作弊菜单 —— 试玩与 QA 的效率工具。
 * 快捷键 ` （Backquote）开关。
 */
import { useEffect, useState } from 'react'
import { EV, emit } from '../game/EventBus'
import { useActions, useSave, useUi } from '../state/gameStore'

export function DevMenu(): React.ReactElement {
  const open = useUi().devMenuOpen
  const screen = useUi().screen
  const godMode = useUi().godMode
  const save = useSave()
  const actions = useActions()
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === '`') actions.toggleDevMenu()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [actions])

  useEffect(() => {
    if (!open) setConfirmReset(false)
  }, [open])

  const inBattle = screen === 'battle'
  const d = save.settings.difficulty

  return (
    <>
      <button className="dev-fab" onClick={() => actions.toggleDevMenu()} title="开发菜单（`）">
        {open ? '✕' : 'DEV'}
      </button>
      {open && (
        <aside className="panel dev-panel" role="dialog" aria-label="开发菜单">
          <div className="dev-title">DEV MENU</div>

          <div className="dev-group">
            <div className="dev-label">进度</div>
            <button
              className="dev-btn"
              onClick={() => {
                actions.devUnlockAll()
                emit(EV.MAP_REFRESH)
              }}
            >
              解锁全部关卡
            </button>
            <button
              className="dev-btn"
              onClick={() => {
                actions.devUnlockAll()
                emit(EV.MAP_REFRESH)
              }}
            >
              直达 Boss（解锁全部后从地图进入）
            </button>
            <button
              className={`dev-btn ${confirmReset ? 'danger-armed' : ''}`}
              onClick={() => {
                if (!confirmReset) {
                  setConfirmReset(true)
                  return
                }
                actions.devResetSave()
                emit(EV.MAP_REFRESH)
                setConfirmReset(false)
              }}
            >
              {confirmReset ? '确认重置？再点一次' : '重置存档'}
            </button>
          </div>

          <div className="dev-group">
            <div className="dev-label">资源</div>
            <div className="dev-row">
              <button className="dev-btn" onClick={() => actions.devAddXp(50)}>
                XP +50
              </button>
              <button className="dev-btn" onClick={() => actions.devAddXp(-50)}>
                XP −50
              </button>
            </div>
          </div>

          <div className="dev-group">
            <div className="dev-label">战斗{inBattle ? '' : '（进入战斗后可用）'}</div>
            <div className="dev-row">
              <button className="dev-btn" disabled={!inBattle} onClick={() => emit(EV.DEV_SIMULATE, { correct: true })}>
                模拟答对
              </button>
              <button className="dev-btn" disabled={!inBattle} onClick={() => emit(EV.DEV_SIMULATE, { correct: false })}>
                模拟答错
              </button>
            </div>
            <div className="dev-row">
              <button className="dev-btn" disabled={!inBattle} onClick={() => emit(EV.DEV_BATTLE, { action: 'heal', amount: 40 })}>
                回血 +40
              </button>
              <button
                className={`dev-btn ${godMode ? 'on' : ''}`}
                onClick={() => actions.setGodMode(!godMode)}
                title="无敌模式：答错不扣血（即时生效）"
              >
                无敌 {godMode ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>

          <div className="dev-group">
            <div className="dev-label">难度</div>
            <div className="dev-row">
              {(['easy', 'normal', 'hard'] as const).map((k) => (
                <button key={k} className={`dev-btn ${d === k ? 'on' : ''}`} onClick={() => actions.setDifficulty(k)}>
                  {k === 'easy' ? '轻松' : k === 'hard' ? '严苛' : '标准'}
                </button>
              ))}
            </div>
          </div>

          <div className="dev-group">
            <div className="dev-label">查看数据</div>
            <div className="dev-row">
              <button className="dev-btn" onClick={() => actions.openJson('map')}>
                MapSpec
              </button>
              <button className="dev-btn" onClick={() => actions.openJson('level')}>
                LevelSpec
              </button>
              <button className="dev-btn" onClick={() => actions.openJson('state')}>
                StudentState
              </button>
            </div>
          </div>
        </aside>
      )}
    </>
  )
}
