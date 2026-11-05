import { EV, emit } from '../game/EventBus'
import { mergeRules } from '../data/rules/defaultRules'
import { useActions, useUi } from '../state/gameStore'
import { useWorldBundle } from '../hooks/useWorldBundle'
import { sfx } from '../game/audio/Sfx'

const TYPE_LABEL: Record<string, string> = { normal: '普通', elite: '精英', boss: '首领' }

export function MapInfoPanel(): React.ReactElement | null {
  const selectedId = useUi().selectedNodeId
  const actions = useActions()
  const world = useWorldBundle()
  if (!world || !selectedId) return null

  const node = world.map.nodes.find((n) => n.id === selectedId)
  const level = node ? world.levels[node.levelRef] : undefined
  if (!node || !level) return null

  const rule = mergeRules(level.rules)
  const typeCount = {
    choice: level.questions.filter((q) => q.type === 'single_choice').length,
    order: level.questions.filter((q) => q.type === 'ordering').length,
    input: level.questions.filter((q) => q.type === 'open_input').length,
  }

  const enter = () => {
    sfx.play('click')
    actions.startTravel()
    emit(EV.TRAVEL_TO, { nodeId: node.id })
  }

  return (
    <aside className="panel level-panel" role="dialog" aria-label="关卡信息">
      <div className="panel-head">
        <span className={`badge badge-${node.type}`}>{TYPE_LABEL[node.type]}</span>
        <span className="diff-pips" title={`难度 ${node.difficulty}`}>
          {Array.from({ length: node.difficulty }, (_, i) => (
            <i key={i} className="pip" />
          ))}
        </span>
        <button className="icon-btn" onClick={actions.cancelIntro} aria-label="关闭">
          ✕
        </button>
      </div>

      <h2 className="level-name">{node.name}</h2>
      <p className="level-desc">{node.description}</p>

      <div className="level-enemy">
        <span className="enemy-label">守卫者</span>
        <span className="enemy-name">{level.enemy.name}</span>
        {level.enemy.title && <span className="enemy-title">{level.enemy.title}</span>}
      </div>

      <div className="rule-grid">
        <div className="rule-item">
          <em>敌方 HP</em>
          <b>{rule.enemyHP}</b>
        </div>
        <div className="rule-item">
          <em>你的 HP</em>
          <b>{rule.playerHP}</b>
        </div>
        <div className="rule-item">
          <em>答对伤害</em>
          <b>{rule.correct.damage}</b>
        </div>
        <div className="rule-item">
          <em>答错受击</em>
          <b>{rule.wrong.playerDamage}</b>
        </div>
      </div>

      <div className="mech-row">
        {rule.combo?.enabled && (
          <span className="mech">连击 ×{rule.combo.multiplier}（{rule.combo.threshold} 连）</span>
        )}
        {rule.hint?.enabled && <span className="mech">提示（伤害 −{Math.round((1 - rule.hint.damageMultiplier) * 100)}%）</span>}
        {rule.skill?.enabled && <span className="mech">技能：{rule.skill.name} ×{rule.skill.multiplier}</span>}
        {rule.phases && <span className="mech mech-boss">{rule.phases.length + 1} 阶段 Boss</span>}
      </div>

      <div className="q-summary">
        <span>{level.questions.length} 题</span>
        {typeCount.choice > 0 && <span>选择 ×{typeCount.choice}</span>}
        {typeCount.order > 0 && <span>排序 ×{typeCount.order}</span>}
        {typeCount.input > 0 && <span>输入 ×{typeCount.input}</span>}
        {level.rewards?.xpBonus ? <span className="q-bonus">通关 +{level.rewards.xpBonus} XP</span> : null}
      </div>

      <button className="btn btn-primary btn-block" onClick={enter}>
        进入关卡
      </button>
    </aside>
  )
}
