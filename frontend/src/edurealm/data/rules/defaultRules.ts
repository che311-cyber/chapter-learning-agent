/**
 * 默认战斗规则 + 难度修正。
 * 关卡的 rules 只需写差异部分，运行时与这里深合并 —— 规则完全数据驱动。
 */
import type { BattleRuleConfig, Difficulty } from '../../schemas/types'

export const DEFAULT_BATTLE_RULE: BattleRuleConfig = {
  playerHP: 100,
  enemyHP: 100,
  correct: { damage: 25, xp: 10 },
  wrong: { playerDamage: 15 },
  combo: { enabled: true, threshold: 3, multiplier: 1.5 },
  hint: { enabled: true, damageMultiplier: 0.5 },
  skill: {
    enabled: true,
    name: 'Insight',
    description: '凝聚 3 次正确回答，下一击伤害 ×2',
    chargePerCorrect: 1,
    requiredCharge: 3,
    multiplier: 2,
  },
}

export const DIFFICULTY_MODIFIERS: Record<Difficulty, { damageTaken: number; xpGain: number }> = {
  easy: { damageTaken: 0.6, xpGain: 0.8 },
  normal: { damageTaken: 1, xpGain: 1 },
  hard: { damageTaken: 1.5, xpGain: 1.3 },
}

/** 深合并：关卡只需声明差异字段 */
export function mergeRules(partial?: Partial<BattleRuleConfig>): BattleRuleConfig {
  const d = DEFAULT_BATTLE_RULE
  if (!partial) {
    return {
      ...d,
      correct: { ...d.correct },
      wrong: { ...d.wrong },
      combo: { ...d.combo! },
      hint: { ...d.hint! },
      skill: { ...d.skill! },
    }
  }
  return {
    playerHP: partial.playerHP ?? d.playerHP,
    enemyHP: partial.enemyHP ?? d.enemyHP,
    correct: { ...d.correct, ...partial.correct },
    wrong: { ...d.wrong, ...partial.wrong },
    combo: { ...d.combo!, ...partial.combo },
    hint: { ...d.hint!, ...partial.hint },
    skill: { ...d.skill!, ...partial.skill },
    phases: partial.phases,
  }
}
