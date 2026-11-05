/**
 * BattleEngine —— 规则引擎核心。纯逻辑、无 Phaser、可单测。
 *
 * 设计原则：
 *  - 所有数值来自 BattleRuleConfig（关卡 rules 深合并默认值），引擎零硬编码伤害。
 *  - Combo / Hint / Skill / Boss Phase 都是可配置开关，未来不同教材、
 *    不同关卡可以拥有完全不同的规则，引擎不改一行。
 *  - 状态推进（questionIndex）由 Scene 显式调用 advanceQuestion() 驱动，
 *    引擎在「战斗结束」后拒绝再次结算（防重复结算）。
 */
import type { BossPhase, Difficulty, LevelSpec, Question, QuestionResponse } from '../../schemas/types'
import { DIFFICULTY_MODIFIERS, mergeRules } from '../../data/rules/defaultRules'
import type { BattleRuleConfig } from '../../schemas/types'
import { evaluateAnswer } from './evaluators'

export interface BattleEngineOptions {
  difficulty: Difficulty
  isGodMode: () => boolean
}

export interface AnswerResolution {
  correct: boolean
  damageToEnemy: number
  damageToPlayer: number
  xpGained: number
  comboCount: number
  comboMultiplier: number
  skillEmpowered: boolean
  enemyDefeated: boolean
  playerDefeated: boolean
  /** 本次作答是否触发了 Boss 阶段切换 */
  phaseChanged: BossPhase | null
  /** 题目耗尽但仍未分出胜负 */
  exhausted: boolean
}

export class BattleEngine {
  readonly rule: BattleRuleConfig
  readonly totalQuestions: number

  enemyHP: number
  playerHP: number
  combo = 0
  maxCombo = 0
  charge = 0
  hintsUsed = 0
  correctCount = 0
  wrongCount = 0
  xpGained = 0
  questionIndex = 0
  phaseIndex = -1
  finished = false

  private pendingMultiplier = 1
  private skillArmed = false

  constructor(
    level: LevelSpec,
    private opts: BattleEngineOptions,
  ) {
    this.rule = mergeRules(level.rules)
    this.totalQuestions = level.questions.length
    this.enemyHP = this.rule.enemyHP
    this.playerHP = this.rule.playerHP
  }

  get currentPhase(): BossPhase | null {
    return this.rule.phases?.[this.phaseIndex] ?? null
  }
  get chargeNeed(): number {
    return this.rule.skill?.requiredCharge ?? 0
  }
  get skillReady(): boolean {
    return !!this.rule.skill?.enabled && this.charge >= this.chargeNeed && !this.skillArmed
  }
  get skillIsArmed(): boolean {
    return this.skillArmed
  }
  get hintPenaltyActive(): boolean {
    return this.pendingMultiplier < 1
  }
  get accuracy(): number {
    const total = this.correctCount + this.wrongCount
    return total === 0 ? 0 : this.correctCount / total
  }

  /** 使用提示：下一次作答（若正确）伤害按惩罚倍率折减。每题至多一次由 Scene 控制。 */
  useHint(): boolean {
    const h = this.rule.hint
    if (!h?.enabled) return false
    this.hintsUsed++
    this.pendingMultiplier *= h.damageMultiplier
    return true
  }

  /** 释放技能：消耗充能，下一次正确答案伤害 ×multiplier */
  activateSkill(): boolean {
    const s = this.rule.skill
    if (!s?.enabled || this.skillArmed || this.charge < s.requiredCharge) return false
    this.charge -= s.requiredCharge
    this.skillArmed = true
    this.pendingMultiplier *= s.multiplier
    return true
  }

  /**
   * 结算一次作答。战斗结束后调用将抛错（调用方 Scene 需自行 guard）。
   * @param question 当前题目
   * @param response 玩家作答载荷
   */
  submitAnswer(question: Question, response: QuestionResponse): AnswerResolution {
    if (this.finished) throw new Error('[BattleEngine] 战斗已结束，拒绝重复结算')

    const correct = evaluateAnswer(question, response)
    let damageToEnemy = 0
    let damageToPlayer = 0
    let xpThisAnswer = 0
    let comboMultiplier = 1
    const skillEmpowered = this.skillArmed

    if (correct) {
      this.correctCount++
      this.combo++
      this.maxCombo = Math.max(this.maxCombo, this.combo)

      const c = this.rule.combo
      if (c?.enabled && this.combo >= c.threshold) comboMultiplier = c.multiplier

      damageToEnemy = Math.max(1, Math.round(this.rule.correct.damage * this.pendingMultiplier * comboMultiplier))
      this.enemyHP = Math.max(0, this.enemyHP - damageToEnemy)
      xpThisAnswer = Math.max(
        1,
        Math.round(this.rule.correct.xp * DIFFICULTY_MODIFIERS[this.opts.difficulty].xpGain),
      )
      this.xpGained += xpThisAnswer

      const s = this.rule.skill
      if (s?.enabled) this.charge = Math.min(this.charge + s.chargePerCorrect, s.requiredCharge * 2)
      this.skillArmed = false
    } else {
      this.wrongCount++
      this.combo = 0
      const phaseMult = this.currentPhase?.enemyDamageMultiplier ?? 1
      damageToPlayer = this.opts.isGodMode()
        ? 0
        : Math.max(
            1,
            Math.round(
              this.rule.wrong.playerDamage *
                phaseMult *
                DIFFICULTY_MODIFIERS[this.opts.difficulty].damageTaken,
            ),
          )
      this.playerHP = Math.max(0, this.playerHP - damageToPlayer)
    }
    // 一次性倍率（Hint / Skill）无论对错都消耗
    this.pendingMultiplier = 1

    // Boss 阶段推进：只向更高阶段跳转，且只在敌人存活时
    let phaseChanged: BossPhase | null = null
    const phases = this.rule.phases ?? []
    if (this.enemyHP > 0) {
      for (let i = phases.length - 1; i > this.phaseIndex; i--) {
        if (this.enemyHP / this.rule.enemyHP <= phases[i].atEnemyHpPercent) {
          this.phaseIndex = i
          phaseChanged = phases[i]
          break
        }
      }
    }

    const enemyDefeated = this.enemyHP <= 0
    const playerDefeated = this.playerHP <= 0
    // 自包含的耗尽判定：已作答数 vs 总题数（不依赖外部推进调用）
    const answered = this.correctCount + this.wrongCount
    const exhausted = !enemyDefeated && !playerDefeated && answered >= this.totalQuestions
    if (enemyDefeated || playerDefeated || exhausted) this.finished = true

    return {
      correct,
      damageToEnemy,
      damageToPlayer,
      xpGained: xpThisAnswer,
      comboCount: this.combo,
      comboMultiplier,
      skillEmpowered,
      enemyDefeated,
      playerDefeated,
      phaseChanged,
      exhausted,
    }
  }

  /** 前进到下一题；没有更多题时返回 false（此时 finished 应已为 true） */
  advanceQuestion(): boolean {
    if (this.questionIndex + 1 < this.totalQuestions) {
      this.questionIndex++
      return true
    }
    return false
  }

  // ── 开发菜单专用 ────────────────────────────────────────────────
  devHealPlayer(amount: number): void {
    if (this.finished) return
    this.playerHP = Math.min(this.rule.playerHP, this.playerHP + amount)
  }
  devDamageEnemy(amount: number): void {
    if (this.finished) return
    this.enemyHP = Math.max(0, this.enemyHP - amount)
    if (this.enemyHP === 0) this.finished = true
  }

  /** 结果快照（供结算面板/存档） */
  snapshot() {
    return {
      accuracy: this.accuracy,
      maxCombo: this.maxCombo,
      hintsUsed: this.hintsUsed,
      correct: this.correctCount,
      wrong: this.wrongCount,
      xpGained: this.xpGained,
      phase: this.currentPhase?.name,
    }
  }
}
