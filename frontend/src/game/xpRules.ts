// XP / 等级规则（配置化，不在 Scene 中硬编码）。
// XP 是游戏奖励，与知识掌握度（题目结果）分离。

export const XP_RULES = {
  normal: 100,
  challenge: 150,
  elite: 200,
  boss: 300,
} as const

export type XpRuleKey = keyof typeof XP_RULES

/** 等级曲线：升到 LV.(n+1) 所需的累计 XP = BASE + n × STEP（线性，第一版够用） */
export const LEVEL_XP_BASE = 300
export const LEVEL_XP_STEP = 200

export function totalXpForLevel(level: number): number {
  // LV.1 从 0 开始；达到 totalXpForLevel(L) 即升入 LV.L
  let total = 0
  for (let l = 1; l < level; l++) total += LEVEL_XP_BASE + (l - 1) * LEVEL_XP_STEP
  return total
}

export interface LevelInfo {
  level: number
  /** 当前等级内已积累 XP */
  into: number
  /** 升入下一级还差多少 */
  remaining: number
  /** 当前等级所需总 XP（用于 340/500 式展示） */
  need: number
  progress: number // 0..1
}

export function levelInfo(totalXp: number): LevelInfo {
  let level = 1
  let rest = Math.max(0, totalXp)
  while (rest >= LEVEL_XP_BASE + (level - 1) * LEVEL_XP_STEP) {
    rest -= LEVEL_XP_BASE + (level - 1) * LEVEL_XP_STEP
    level += 1
    if (level > 999) break
  }
  const need = LEVEL_XP_BASE + (level - 1) * LEVEL_XP_STEP
  return { level, into: rest, remaining: need - rest, need, progress: Math.min(1, rest / need) }
}
