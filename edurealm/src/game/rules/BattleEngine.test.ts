import { describe, expect, it } from 'vitest'
import { BattleEngine } from './BattleEngine'
import type { LevelSpec, Question } from '../../schemas/types'

const choiceQ = (id: string): Question => ({
  type: 'single_choice',
  id,
  prompt: 'q',
  options: ['a', 'b'],
  answer: 0,
})

function makeLevel(rules: LevelSpec['rules'], count = 4): LevelSpec {
  return {
    id: 'test',
    name: 'Test',
    type: 'normal',
    enemy: { name: 'Dummy', form: 'wisp' },
    rules,
    questions: Array.from({ length: count }, (_, i) => choiceQ(`q${i}`)),
  }
}

const opts = { difficulty: 'normal' as const, isGodMode: () => false }

describe('基础攻防', () => {
  it('答对造成配置伤害并获得 XP', () => {
    const e = new BattleEngine(makeLevel({}), opts)
    const r = e.submitAnswer(choiceQ('q0'), 0)
    expect(r.correct).toBe(true)
    expect(r.damageToEnemy).toBe(25)
    expect(e.enemyHP).toBe(75)
    expect(r.xpGained).toBe(10)
    expect(e.questionIndex).toBe(0)
  })

  it('答错玩家扣血且不伤敌人，combo 清零', () => {
    const e = new BattleEngine(makeLevel({}), opts)
    e.submitAnswer(choiceQ('q0'), 0)
    const r = e.submitAnswer(choiceQ('q1'), 1)
    expect(r.correct).toBe(false)
    expect(r.damageToPlayer).toBe(15)
    expect(e.playerHP).toBe(85)
    expect(e.enemyHP).toBe(75)
    expect(e.combo).toBe(0)
  })

  it('HP 永不为负', () => {
    const e = new BattleEngine(makeLevel({ playerHP: 10, wrong: { playerDamage: 99 } }), opts)
    e.submitAnswer(choiceQ('q0'), 1)
    expect(e.playerHP).toBe(0)
  })

  it('战斗结束后拒绝重复结算', () => {
    const e = new BattleEngine(makeLevel({ enemyHP: 25 }), opts)
    e.submitAnswer(choiceQ('q0'), 0)
    expect(e.finished).toBe(true)
    expect(() => e.submitAnswer(choiceQ('q1'), 0)).toThrow()
  })
})

describe('题目耗尽', () => {
  it('题目用尽仍未击杀 → exhausted 结束', () => {
    const e = new BattleEngine(makeLevel({ enemyHP: 999 }, 2), opts)
    const r1 = e.submitAnswer(choiceQ('q0'), 0)
    expect(r1.exhausted).toBe(false)
    const r2 = e.submitAnswer(choiceQ('q1'), 0)
    expect(r2.exhausted).toBe(true)
    expect(e.finished).toBe(true)
    expect(e.enemyHP).toBeGreaterThan(0)
  })
})

describe('Combo', () => {
  it('达到阈值后伤害乘以倍率', () => {
    const e = new BattleEngine(makeLevel({}), opts)
    e.submitAnswer(choiceQ('q0'), 0) // combo 1 → ×1
    e.submitAnswer(choiceQ('q1'), 0) // combo 2 → ×1
    const r3 = e.submitAnswer(choiceQ('q2'), 0) // combo 3 → ×1.5
    expect(r3.comboMultiplier).toBe(1.5)
    expect(r3.damageToEnemy).toBe(38) // round(25*1.5)
  })
})

describe('Hint', () => {
  it('提示使下一次正确伤害减半，一次性消耗', () => {
    const e = new BattleEngine(makeLevel({}), opts)
    expect(e.useHint()).toBe(true)
    const r1 = e.submitAnswer(choiceQ('q0'), 0)
    expect(r1.damageToEnemy).toBe(13) // round(12.5)
    const r2 = e.submitAnswer(choiceQ('q1'), 0) // 惩罚不应延续
    expect(r2.damageToEnemy).toBe(25)
    expect(e.hintsUsed).toBe(1)
  })
  it('答错也消耗惩罚窗口', () => {
    const e = new BattleEngine(makeLevel({}), opts)
    e.useHint()
    e.submitAnswer(choiceQ('q0'), 1)
    const r = e.submitAnswer(choiceQ('q1'), 0)
    expect(r.damageToEnemy).toBe(25)
  })
})

describe('Skill', () => {
  it('3 次正确充满，释放后下一击 ×2（与 combo 叠乘）', () => {
    const e = new BattleEngine(makeLevel({}), opts)
    e.submitAnswer(choiceQ('q0'), 0)
    e.submitAnswer(choiceQ('q1'), 0)
    expect(e.skillReady).toBe(false)
    e.submitAnswer(choiceQ('q2'), 0)
    expect(e.skillReady).toBe(true)
    expect(e.activateSkill()).toBe(true)
    expect(e.skillIsArmed).toBe(true)
    const r = e.submitAnswer(choiceQ('q3'), 0)
    expect(r.skillEmpowered).toBe(true)
    // 第 4 连击：25 × combo1.5 × skill2 = 75
    expect(r.comboMultiplier).toBe(1.5)
    expect(r.damageToEnemy).toBe(75)
  })
  it('充能不足时无法释放', () => {
    const e = new BattleEngine(makeLevel({}), opts)
    expect(e.activateSkill()).toBe(false)
  })
})

describe('Boss 阶段', () => {
  const bossRules = {
    enemyHP: 100,
    correct: { damage: 30, xp: 10 },
    wrong: { playerDamage: 10 },
    phases: [{ atEnemyHpPercent: 0.5, name: 'P2', enemyDamageMultiplier: 2 }],
  }

  it('血量跨过阈值触发阶段', () => {
    const e = new BattleEngine(makeLevel(bossRules, 4), opts)
    const r1 = e.submitAnswer(choiceQ('q0'), 0) // 100→70，未触发
    expect(r1.phaseChanged).toBeNull()
    const r2 = e.submitAnswer(choiceQ('q1'), 0) // 70→40（40%）→ 触发
    expect(r2.phaseChanged?.name).toBe('P2')
    expect(e.currentPhase?.name).toBe('P2')
  })

  it('阶段提升敌人伤害倍率', () => {
    const e = new BattleEngine(makeLevel(bossRules, 4), opts)
    e.submitAnswer(choiceQ('q0'), 0)
    e.submitAnswer(choiceQ('q1'), 0) // 进入 P2
    const r = e.submitAnswer(choiceQ('q2'), 1) // 答错
    expect(r.damageToPlayer).toBe(20) // 10 × 2
  })

  it('击杀时不再触发阶段', () => {
    const e = new BattleEngine(
      makeLevel(
        {
          enemyHP: 50,
          correct: { damage: 40, xp: 10 },
          wrong: { playerDamage: 10 },
          phases: [{ atEnemyHpPercent: 0.3, name: 'P2', enemyDamageMultiplier: 2 }],
        },
        4,
      ),
      opts,
    )
    const r1 = e.submitAnswer(choiceQ('q0'), 0) // 50→10（20% ≤ 30%）→ 触发
    expect(r1.phaseChanged?.name).toBe('P2')
    const r2 = e.submitAnswer(choiceQ('q1'), 0) // 10→0 → 死亡，阶段判定跳过
    expect(r2.enemyDefeated).toBe(true)
    expect(r2.phaseChanged).toBeNull()
  })
})

describe('难度与无敌', () => {
  it('困难模式受伤 ×1.5', () => {
    const e = new BattleEngine(makeLevel({}), { difficulty: 'hard', isGodMode: () => false })
    const r = e.submitAnswer(choiceQ('q0'), 1)
    expect(r.damageToPlayer).toBe(23) // round(15*1.5)
  })
  it('无敌模式受伤为 0', () => {
    const e = new BattleEngine(makeLevel({}), { difficulty: 'normal', isGodMode: () => true })
    const r = e.submitAnswer(choiceQ('q0'), 1)
    expect(r.damageToPlayer).toBe(0)
    expect(e.playerHP).toBe(e.rule.playerHP)
  })
})

describe('dev 工具', () => {
  it('回血不超过上限', () => {
    const e = new BattleEngine(makeLevel({}), opts)
    e.submitAnswer(choiceQ('q0'), 1)
    e.devHealPlayer(999)
    expect(e.playerHP).toBe(e.rule.playerHP)
  })
  it('斩杀后 finished', () => {
    const e = new BattleEngine(makeLevel({}), opts)
    e.devDamageEnemy(999)
    expect(e.enemyHP).toBe(0)
    expect(e.finished).toBe(true)
  })
})
