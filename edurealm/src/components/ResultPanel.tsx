import { EV, emit } from '../game/EventBus'
import { useActions, useUi } from '../state/gameStore'
import { sfx } from '../game/audio/Sfx'

export function ResultPanel(): React.ReactElement | null {
  const result = useUi().result
  const actions = useActions()
  if (!result) return null

  const acc = Math.round(result.accuracy * 100)
  const defeatText =
    result.defeatReason === 'exhausted' ? '题目用尽，敌人仍在坚守——回顾解析后再来。' : '你被击败了——失败也是进度的一部分。'

  const backToMap = () => {
    sfx.play('click')
    actions.leaveToMap()
    emit(EV.EXIT_BATTLE)
  }
  const retry = () => {
    sfx.play('click')
    actions.closeResult()
    emit(EV.RETRY_BATTLE)
  }

  return (
    <div className="result-backdrop">
      <div className={`panel result-panel ${result.victory ? 'is-victory' : 'is-defeat'}`}>
        <h2 className="result-title">{result.victory ? 'VICTORY' : 'DEFEATED'}</h2>
        <p className="result-sub">
          {result.levelName} · {result.enemyName}
        </p>

        <div className="result-stats">
          <div className="stat">
            <em>经验</em>
            <b className="stat-xp">+{result.xpGained} XP</b>
          </div>
          <div className="stat">
            <em>正确率</em>
            <b>{acc}%</b>
          </div>
          <div className="stat">
            <em>最高连击</em>
            <b>×{result.maxCombo}</b>
          </div>
          <div className="stat">
            <em>答对 / 总数</em>
            <b>
              {result.correct} / {result.total}
            </b>
          </div>
          <div className="stat">
            <em>提示</em>
            <b>{result.hintsUsed} 次</b>
          </div>
          {result.phaseReached && (
            <div className="stat">
              <em>Boss 阶段</em>
              <b>{result.phaseReached}</b>
            </div>
          )}
        </div>

        {!result.victory && <p className="defeat-note">{defeatText}</p>}

        <div className="result-actions">
          <button className="btn btn-primary" onClick={result.victory ? backToMap : retry}>
            {result.victory ? '返回地图' : '再次挑战'}
          </button>
          <button className="btn btn-ghost" onClick={result.victory ? retry : backToMap}>
            {result.victory ? '重复挑战' : '返回地图'}
          </button>
        </div>
      </div>
    </div>
  )
}
