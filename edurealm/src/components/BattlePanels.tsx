/**
 * 战斗 React 层：顶部状态条 + 底部题目面板 + 解析抽屉。
 * 数据来自 EventBus（实时战斗状态），引擎在 Phaser 侧。
 */
import { useEffect, useState } from 'react'
import type { Question, QuestionResponse } from '../schemas/types'
import {
  EV,
  emit,
  type AnswerResolvedPayload,
  type BattleQuestionPayload,
  type BattleStatePayload,
  type HintResultPayload,
} from '../game/EventBus'
import { useEvent } from '../hooks/useEvent'
import { useUi } from '../state/gameStore'
import { useWorldBundle } from '../hooks/useWorldBundle'
import { SingleChoiceView, OrderingView, OpenInputView } from './questions/QuestionViews'

export function BattlePanels(): React.ReactElement {
  const [qp, setQp] = useState<BattleQuestionPayload | null>(null)
  const [battle, setBattle] = useState<BattleStatePayload | null>(null)
  const [hint, setHint] = useState<HintResultPayload | null>(null)
  const [resolved, setResolved] = useState<AnswerResolvedPayload | null>(null)
  const [locked, setLocked] = useState(false)
  const selectedNodeId = useUi().selectedNodeId
  const world = useWorldBundle()

  useEvent<BattleQuestionPayload>(EV.BATTLE_QUESTION, (p) => {
    setQp(p)
    setHint(null)
    setResolved(null)
    setLocked(false)
  })
  useEvent<BattleStatePayload>(EV.BATTLE_STATE, setBattle)
  useEvent<HintResultPayload>(EV.HINT_RESULT, setHint)
  useEvent<AnswerResolvedPayload>(EV.ANSWER_RESOLVED, (p) => {
    setResolved(p)
    setLocked(false)
  })

  const level = selectedNodeId && world ? world.levels[selectedNodeId] : undefined
  const q = qp?.question

  const submit = (r: QuestionResponse) => {
    if (locked || !qp) return
    setLocked(true)
    emit(EV.SUBMIT_ANSWER, r)
  }

  const useHint = () => {
    if (locked || !q?.hint) return
    emit(EV.USE_HINT)
  }
  const useSkill = () => {
    if (locked || !battle) return
    emit(EV.USE_SKILL)
  }
  const continueNext = () => {
    emit(EV.BATTLE_CONTINUE)
    setResolved(null)
  }

  // 键盘：1-4 快速选择；Enter 继续
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && resolved && !resolved.correct && !battle?.finished) {
        continueNext()
        return
      }
      if (!q || locked || q.type !== 'single_choice') return
      const n = Number(e.key)
      if (n >= 1 && n <= q.options.length) submit(n - 1)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  const skillReady = !!battle && battle.charge >= battle.chargeNeed && !battle.skillArmed

  return (
    <div className="battle-ui">
      {/* 顶部状态条 */}
      <div className="battle-top">
        <span className="battle-level-name">{level?.name ?? ''}</span>
        {battle?.isBoss && battle.phaseName && <span className="badge badge-boss phase-badge">{battle.phaseName}</span>}
        <div className="q-pips">
          {battle &&
            Array.from({ length: battle.total }, (_, i) => (
              <i
                key={i}
                className={`pip-dot ${i < battle.questionIndex ? 'done' : i === battle.questionIndex ? 'cur' : ''}`}
              />
            ))}
        </div>
        {battle && battle.combo >= 2 && (
          <span className={`combo-tag ${battle.combo >= 3 ? 'hot' : ''}`}>COMBO ×{battle.combo}</span>
        )}
      </div>

      {/* 底部题目面板 */}
      {q && (
        <section className="panel question-panel" key={q.id}>
          <div className="question-head">
            <span className="question-count">
              {qp !== null ? qp.index + 1 : 0} <i>/</i> {qp?.total ?? 0}
            </span>
            <span className="q-type">{q.type === 'single_choice' ? '选择' : q.type === 'ordering' ? '排序' : '输入'}</span>
            {battle?.hintPenaltyActive && <span className="penalty-tag">提示惩罚 −50% 伤害</span>}
            {battle?.skillArmed && <span className="skill-tag">技能就绪 · 伤害 ×2</span>}
            <div className="head-spacer" />
            {q.hint && (
              <button className="btn btn-ghost btn-sm" disabled={locked} onClick={useHint} title="使用提示（下一击伤害减半）">
                提示
              </button>
            )}
          </div>

          <p className="question-prompt">{q.prompt}</p>

          {q.type === 'single_choice' && <SingleChoiceView q={q} locked={locked} onSubmit={submit} />}
          {q.type === 'ordering' && <OrderingView q={q} locked={locked} onSubmit={submit} />}
          {q.type === 'open_input' && <OpenInputView q={q} locked={locked} onSubmit={submit} />}

          {hint?.ok && hint.text && (
            <div className="hint-box">
              <b>提示</b> {hint.text}
            </div>
          )}

          <div className="question-foot">
            {battle && battle.chargeNeed > 0 && (
              <button
                className={`btn skill-btn ${battle.skillArmed ? 'armed' : ''} ${skillReady ? 'ready' : ''}`}
                disabled={locked || (!skillReady && !battle.skillArmed)}
                onClick={useSkill}
                title="积攒 3 次正确后释放：下一击伤害 ×2"
              >
                <span className="skill-pips">
                  {Array.from({ length: battle.chargeNeed }, (_, i) => (
                    <i key={i} className={i < battle.charge ? 'on' : ''} />
                  ))}
                </span>
                洞察 ×2
              </button>
            )}
            <span className="foot-note">答对攻击 · 答错受击 · 数字键快速作答</span>
          </div>

          {/* 解析抽屉 */}
          {resolved && !resolved.correct && !battle?.finished && (
            <div className="explain-drawer">
              <div className="explain-title">回答错误</div>
              {resolved.expected && <div className="explain-expected">{resolved.expected}</div>}
              {resolved.explanation && <p className="explain-body">{resolved.explanation}</p>}
              <button className="btn btn-primary" onClick={continueNext}>
                继续（Enter）
              </button>
            </div>
          )}
          {resolved && resolved.correct && !battle?.finished && (
            <div className="correct-flash"> Nice · 伤害 {resolved.resolution.damageToEnemy}</div>
          )}
        </section>
      )}
    </div>
  )
}

// 保持 Question 类型引用（文档价值）
export type { Question }
