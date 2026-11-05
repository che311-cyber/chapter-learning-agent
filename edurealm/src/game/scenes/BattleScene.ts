/**
 * 战斗 Scene：
 * 入场（普通/Boss 专属）→ 出题（React 面板渲染）→ 结算动画
 * → 攻防反馈 / Combo / Hint / Skill / Boss 多阶段 → 胜负结算。
 * 规则全部来自 BattleEngine（数据驱动），本文件不含任何具体题目内容。
 */
import Phaser from 'phaser'
import type {
  BattleResult,
  LevelSpec,
  Question,
  QuestionResponse,
} from '../../schemas/types'
import { getCachedWorld } from '../../services/contentService'
import {
  EV,
  EventBus,
  type AnswerResolvedPayload,
  type BattleQuestionPayload,
  type BattleStatePayload,
  type HintResultPayload,
} from '../EventBus'
import { useGameStore } from '../../state/gameStore'
import { BattleEngine } from '../rules/BattleEngine'
import { Hero } from '../entities/Hero'
import { createEnemy, EnemyView } from '../entities/EnemyFactory'
import { createEmitters, damageNumber, impactBurst, type EmitterSet } from '../fx/Effects'
import { getPalette, type WorldPalette } from '../palette'
import { sfx } from '../audio/Sfx'

const FONT = 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif'
const DISPLAY_FONT = 'Cinzel, "Times New Roman", serif'
const HERO_POS = { x: 430, y: 600 }
const ENEMY_POS = { x: 1170, y: 590 }

interface BattleSceneData {
  levelId: string
  nodeId: string
}

export class BattleScene extends Phaser.Scene {
  private levelId!: string
  private nodeId!: string
  private level!: LevelSpec
  private engine!: BattleEngine
  private hero!: Hero
  private enemy!: EnemyView
  private fx!: EmitterSet
  private pal!: WorldPalette
  private isBoss = false
  private currentQuestion: Question | null = null
  private hintUsedThisQuestion = false
  private resolving = false
  private over = false
  private eventBinds: Array<[string, (p: unknown) => void]> = []

  private enemyProxy = { v: 0 }
  private playerProxy = { v: 0 }
  private enemyBarG!: Phaser.GameObjects.Graphics
  private enemyHpText!: Phaser.GameObjects.Text
  private playerBarG!: Phaser.GameObjects.Graphics
  private playerHpText!: Phaser.GameObjects.Text

  constructor() {
    super('BattleScene')
  }

  init(data: BattleSceneData): void {
    this.levelId = data.levelId
    this.nodeId = data.nodeId
  }

  create(): void {
    this.resolving = false
    this.over = false
    this.currentQuestion = null
    this.eventBinds = []
    this.cameras.main.setZoom(1)

    const bundle = getCachedWorld()
    const level = bundle.levels[this.levelId]
    if (!level) throw new Error(`[BattleScene] 缺少 LevelSpec: ${this.levelId}`)
    this.level = level
    this.isBoss = level.type === 'boss'
    this.pal = getPalette(bundle.map.theme.environment)

    const { difficulty } = useGameStore.getState().save.settings
    this.engine = new BattleEngine(level, {
      difficulty,
      isGodMode: () => useGameStore.getState().ui.godMode,
    })
    this.enemyProxy = { v: this.engine.rule.enemyHP }
    this.playerProxy = { v: this.engine.rule.playerHP }

    this.buildArena()
    this.fx = createEmitters(this, this.isBoss ? 0xff8d76 : this.pal.teal)
    this.hero = new Hero(this, HERO_POS.x, HERO_POS.y, 'battle', this.fx)
    this.enemy = createEnemy(this, level.enemy, ENEMY_POS.x, ENEMY_POS.y, this.fx)
    this.buildBars()

    this.bindEvent(EV.SUBMIT_ANSWER, (p) => void this.handleAnswer(p as QuestionResponse))
    this.bindEvent(EV.BATTLE_CONTINUE, () => this.nextQuestion())
    this.bindEvent(EV.USE_HINT, () => this.handleHint())
    this.bindEvent(EV.USE_SKILL, () => this.handleSkill())
    this.bindEvent(EV.EXIT_BATTLE, () => this.exitToMap())
    this.bindEvent(EV.RETRY_BATTLE, () => this.scene.restart({ levelId: this.levelId, nodeId: this.nodeId }))
    this.bindEvent(EV.DEV_SIMULATE, (p) => this.devSimulate((p as { correct: boolean }).correct))
    this.bindEvent(EV.DEV_BATTLE, (p) => {
      const { action, amount } = p as { action: string; amount?: number }
      if (action === 'heal') {
        this.engine.devHealPlayer(amount ?? 40)
        this.updateBars()
        this.emitState()
      }
    })

    this.events.once('shutdown', () => {
      this.eventBinds.forEach(([n, f]) => EventBus.off(n, f))
      this.eventBinds = []
    })

    void this.playEntrance().then(() => {
      this.emitState()
      this.presentQuestion()
    })
  }

  private bindEvent(name: string, fn: (p: unknown) => void): void {
    this.eventBinds.push([name, fn])
    EventBus.on(name, fn)
  }

  private wait(ms: number): Promise<void> {
    return new Promise((res) => this.time.delayedCall(ms, () => res()))
  }

  // ── 场景搭建 ─────────────────────────────────────────────────────

  private buildArena(): void {
    const W = this.scale.width
    const H = this.scale.height
    const bg = this.add.graphics().setDepth(-10)
    bg.fillGradientStyle(this.pal.battleBg0, this.pal.battleBg0, this.pal.battleBg1, this.pal.battleBg1, 1)
    bg.fillRect(0, 0, W, H)

    const far = this.add.graphics().setDepth(-9)
    far.fillStyle(this.isBoss ? 0x1c1026 : 0x121830, 1)
    far.beginPath()
    far.moveTo(0, 470)
    for (let i = 0; i <= 6; i++) {
      const x = (i / 6) * W
      far.lineTo(x, 470 - (i % 2 === 0 ? 130 : 55) - ((i * 17) % 40))
    }
    far.lineTo(W, H)
    far.lineTo(0, H)
    far.closePath()
    far.fillPath()

    const floor = this.add.graphics().setDepth(-8)
    floor.fillStyle(this.isBoss ? 0x160e20 : 0x101628, 1)
    floor.fillRect(0, 560, W, H - 560)
    floor.lineStyle(1, 0x2a3352, 0.5)
    floor.lineBetween(0, 560, W, 560)

    const plat = this.add.graphics().setDepth(-7)
    const drawPlatform = (cx: number, cy: number, rx: number) => {
      plat.fillStyle(0x0c1120, 0.92)
      plat.fillEllipse(cx, cy, rx * 2, 52)
      plat.lineStyle(2, this.isBoss ? 0x5a3a48 : 0x2e4a5e, 0.7)
      plat.strokeEllipse(cx, cy, rx * 2, 52)
    }
    drawPlatform(HERO_POS.x, HERO_POS.y + 42, 120)
    drawPlatform(ENEMY_POS.x, ENEMY_POS.y + 40, this.isBoss ? 175 : 132)

    if (this.isBoss) {
      const rune = this.add.graphics().setPosition(ENEMY_POS.x, ENEMY_POS.y + 28).setDepth(-6)
      rune.lineStyle(2, 0xe06a55, 0.28)
      rune.strokeCircle(0, 0, 200)
      rune.strokeCircle(0, 0, 164)
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2
        rune.lineBetween(Math.cos(a) * 170, Math.sin(a) * 170, Math.cos(a) * 184, Math.sin(a) * 184)
      }
      this.tweens.add({ targets: rune, angle: 360, duration: 32000, repeat: -1 })
    }
  }

  private buildBars(): void {
    const style = {
      fontFamily: FONT,
      fontSize: '13px',
      color: '#c8d0e2',
      stroke: '#05070d',
      strokeThickness: 3,
    }
    const title = {
      ...style,
      fontSize: '15px',
      color: '#e9e7df',
      fontStyle: 'bold',
    }

    this.add
      .text(ENEMY_POS.x, 296, `${this.level.enemy.name}${this.level.enemy.title ? ` · ${this.level.enemy.title}` : ''}`, title)
      .setOrigin(0.5)
      .setDepth(500)
    this.enemyBarG = this.add.graphics().setDepth(500)
    this.enemyHpText = this.add.text(ENEMY_POS.x + 160, 318, '', style).setOrigin(0, 0.5).setDepth(500)

    this.add.text(HERO_POS.x - 130, 470, '行者 · YOU', style).setOrigin(0, 0.5).setDepth(500)
    this.playerBarG = this.add.graphics().setDepth(500)
    this.playerHpText = this.add.text(HERO_POS.x + 134, 492, '', style).setOrigin(0, 0.5).setDepth(500)

    this.drawEnemyBar()
    this.drawPlayerBar()
  }

  private drawEnemyBar(): void {
    const g = this.enemyBarG
    const bx = ENEMY_POS.x - 150
    const by = 316
    const bw = 300
    const bh = 14
    const ratio = Phaser.Math.Clamp(this.enemyProxy.v / this.engine.rule.enemyHP, 0, 1)
    g.clear()
    g.fillStyle(0x0a0e1a, 0.9)
    g.fillRoundedRect(bx - 3, by - 3, bw + 6, bh + 6, 6)
    g.lineStyle(1, 0x3a4470, 0.9)
    g.strokeRoundedRect(bx - 3, by - 3, bw + 6, bh + 6, 6)
    const color = ratio > 0.66 ? 0x57c8b4 : ratio > 0.33 ? 0xd8b36a : 0xe06a55
    if (ratio > 0) {
      g.fillStyle(color, 0.95)
      g.fillRoundedRect(bx, by, Math.max(6, bw * ratio), bh, 4)
    }
    // Boss 阶段刻度
    if (this.engine.rule.phases) {
      g.lineStyle(2, 0x0a0e1a, 0.9)
      for (const ph of this.engine.rule.phases) {
        const x = bx + bw * ph.atEnemyHpPercent
        g.lineBetween(x, by - 2, x, by + bh + 2)
      }
    }
    this.enemyHpText.setText(`${Math.round(this.enemyProxy.v)} / ${this.engine.rule.enemyHP}`)
  }

  private drawPlayerBar(): void {
    const g = this.playerBarG
    const bx = HERO_POS.x - 130
    const by = 490
    const bw = 260
    const bh = 12
    const ratio = Phaser.Math.Clamp(this.playerProxy.v / this.engine.rule.playerHP, 0, 1)
    g.clear()
    g.fillStyle(0x0a0e1a, 0.9)
    g.fillRoundedRect(bx - 3, by - 3, bw + 6, bh + 6, 6)
    g.lineStyle(1, 0x3a4470, 0.9)
    g.strokeRoundedRect(bx - 3, by - 3, bw + 6, bh + 6, 6)
    const color = ratio > 0.5 ? 0x8fd7c4 : ratio > 0.25 ? 0xd8b36a : 0xe06a55
    if (ratio > 0) {
      g.fillStyle(color, 0.95)
      g.fillRoundedRect(bx, by, Math.max(5, bw * ratio), bh, 4)
    }
    this.playerHpText.setText(`${Math.round(this.playerProxy.v)} / ${this.engine.rule.playerHP}`)
  }

  private updateBars(): void {
    this.tweens.add({
      targets: this.enemyProxy,
      v: this.engine.enemyHP,
      duration: 420,
      ease: 'Cubic.easeOut',
      onUpdate: () => this.drawEnemyBar(),
    })
    this.tweens.add({
      targets: this.playerProxy,
      v: this.engine.playerHP,
      duration: 420,
      ease: 'Cubic.easeOut',
      onUpdate: () => this.drawPlayerBar(),
    })
  }

  // ── 入场 ─────────────────────────────────────────────────────────

  private async playEntrance(): Promise<void> {
    const W = this.scale.width
    const H = this.scale.height
    this.hero.container.setAlpha(0).setPosition(HERO_POS.x - 90, HERO_POS.y)
    this.enemy.container.setAlpha(0)

    if (this.isBoss) {
      this.cameras.main.setZoom(1.16)
      const veil = this.add.rectangle(W / 2, H / 2, W, H, 0x05070d, 0.94).setDepth(950)
      const banner = this.add
        .text(W / 2, H / 2 - 44, this.level.enemy.name, {
          fontFamily: DISPLAY_FONT,
          fontSize: '56px',
          color: '#e8c98f',
        })
        .setOrigin(0.5)
        .setAlpha(0)
        .setDepth(960)
      const sub = this.add
        .text(W / 2, H / 2 + 26, this.level.enemy.title ?? this.level.name, {
          fontFamily: FONT,
          fontSize: '18px',
          color: '#9fb0c8',
        })
        .setOrigin(0.5)
        .setAlpha(0)
        .setDepth(960)
      sfx.play('boss')
      this.tweens.add({ targets: [banner, sub], alpha: 1, duration: 420 })
      this.tweens.add({ targets: veil, fillAlpha: 0.35, duration: 650 })

      this.enemy.container.setAlpha(1).setY(ENEMY_POS.y - 300)
      await this.wait(500)
      await new Promise<void>((res) => {
        this.tweens.add({
          targets: this.enemy.container,
          y: ENEMY_POS.y,
          duration: 640,
          ease: 'Bounce.easeOut',
          onComplete: () => res(),
        })
      })
      sfx.play('hit')
      this.cameras.main.shake(260, 0.008)
      impactBurst(this, this.fx, ENEMY_POS.x, ENEMY_POS.y + 20, 24)

      this.cameras.main.zoomTo(1, 750, 'Sine.easeInOut')
      this.tweens.add({ targets: veil, fillAlpha: 0, duration: 750 })
      this.tweens.add({ targets: [banner, sub], alpha: 0, y: '-=30', duration: 700 })
      await this.wait(780)
      veil.destroy()
      banner.destroy()
      sub.destroy()
    } else {
      this.tweens.add({ targets: this.hero.container, alpha: 1, x: HERO_POS.x, duration: 420, ease: 'Sine.easeOut' })
      this.tweens.add({
        targets: this.enemy.container,
        alpha: 1,
        scale: { from: 0.65, to: 1 },
        duration: 480,
        ease: 'Back.easeOut',
      })
      await this.wait(560)
    }
  }

  // ── 题目流转 ─────────────────────────────────────────────────────

  private presentQuestion(): void {
    const q = this.level.questions[this.engine.questionIndex]
    if (!q) return
    this.currentQuestion = q
    this.hintUsedThisQuestion = false
    EventBus.emit(EV.BATTLE_QUESTION, {
      index: this.engine.questionIndex,
      total: this.engine.totalQuestions,
      question: q,
    } satisfies BattleQuestionPayload)
    this.emitState()
  }

  private async handleAnswer(response: QuestionResponse): Promise<void> {
    if (!this.currentQuestion || this.resolving || this.over) return
    this.resolving = true
    const q = this.currentQuestion
    let res
    try {
      res = this.engine.submitAnswer(q, response)
    } catch {
      this.resolving = false
      return
    }

    if (res.correct) {
      sfx.play('correct')
      if (res.skillEmpowered) {
        await this.hero.castProjectile(this.enemy.container.x - 30, this.enemy.container.y - 40, 0xffd27a)
      } else {
        await this.hero.dashAttack(this.enemy.container.x, this.enemy.container.y)
      }
      this.enemy.hurt()
      impactBurst(this, this.fx, this.enemy.container.x - 26, this.enemy.container.y - 30, res.skillEmpowered ? 26 : 15)
      sfx.play('hit')
      this.cameras.main.shake(130, 0.0035)
      const style = res.skillEmpowered ? 'crit' : res.comboMultiplier > 1 ? 'combo' : 'enemyHit'
      const label =
        res.comboMultiplier > 1 && !res.skillEmpowered
          ? `×${res.comboMultiplier}  -${res.damageToEnemy}`
          : `-${res.damageToEnemy}`
      damageNumber(this, this.enemy.container.x - 20, this.enemy.container.y - 96, label, style)
      this.updateBars()
    } else {
      sfx.play('wrong')
      await this.enemy.attack(this.hero.container.x, this.hero.container.y)
      this.hero.hurt()
      sfx.play('hit')
      this.cameras.main.shake(220, 0.006)
      damageNumber(this, this.hero.container.x, this.hero.container.y - 74, `-${res.damageToPlayer}`, 'playerHit')
      this.updateBars()
    }

    if (res.phaseChanged) {
      await this.wait(260)
      this.enemy.phaseEnrage()
      this.showBanner(res.phaseChanged.name, res.phaseChanged.message)
      this.cameras.main.shake(320, 0.005)
    }

    EventBus.emit(EV.ANSWER_RESOLVED, {
      correct: res.correct,
      resolution: res,
      explanation: q.explanation,
      expected: res.correct ? undefined : formatExpected(q),
      questionId: q.id,
    } satisfies AnswerResolvedPayload)
    this.emitState()

    if (res.enemyDefeated) {
      await this.victorySequence()
      return
    }
    if (res.playerDefeated) {
      await this.defeatSequence('hp')
      return
    }
    if (res.exhausted) {
      await this.defeatSequence('exhausted')
      return
    }
    if (res.correct) {
      this.time.delayedCall(640, () => this.nextQuestion())
    }
    // 答错：等待 React 的 BATTLE_CONTINUE（展示解析后继续）
  }

  private nextQuestion(): void {
    if (this.over || !this.resolving) return
    if (!this.engine.advanceQuestion()) return
    this.resolving = false
    this.presentQuestion()
  }

  private handleHint(): void {
    if (this.over || this.resolving || !this.currentQuestion) return
    const q = this.currentQuestion
    if (this.hintUsedThisQuestion || !q.hint) {
      EventBus.emit(EV.HINT_RESULT, { ok: false } satisfies HintResultPayload)
      return
    }
    const applied = this.engine.useHint()
    this.hintUsedThisQuestion = true
    sfx.play('hint')
    EventBus.emit(EV.HINT_RESULT, { ok: applied, text: q.hint } satisfies HintResultPayload)
    this.emitState()
  }

  private handleSkill(): void {
    if (this.over || this.resolving) return
    const ok = this.engine.activateSkill()
    if (ok) {
      sfx.play('skill')
      this.fx.trail.emitParticleAt(this.hero.container.x + 21, this.hero.container.y - 40, 14)
      damageNumber(this, this.hero.container.x, this.hero.container.y - 70, 'SKILL READY', 'label')
    }
    this.emitState()
  }

  private devSimulate(correct: boolean): void {
    if (this.over || this.resolving || !this.currentQuestion) return
    const q = this.currentQuestion
    const response = correct ? correctResponseFor(q) : wrongResponseFor(q)
    void this.handleAnswer(response)
  }

  // ── 胜负 ─────────────────────────────────────────────────────────

  private showBanner(title: string, message?: string): void {
    const W = this.scale.width
    const strip = this.add.rectangle(W / 2, 200, W, 96, 0x05070d, 0.74).setDepth(940).setAlpha(0)
    const t1 = this.add
      .text(W / 2, message ? 182 : 200, title, {
        fontFamily: DISPLAY_FONT,
        fontSize: '34px',
        color: '#ffd8a0',
      })
      .setOrigin(0.5)
      .setDepth(941)
      .setAlpha(0)
    const parts: Phaser.GameObjects.GameObject[] = [strip, t1]
    if (message) {
      const t2 = this.add
        .text(W / 2, 224, message, { fontFamily: FONT, fontSize: '15px', color: '#c8d0e2' })
        .setOrigin(0.5)
        .setDepth(941)
        .setAlpha(0)
      parts.push(t2)
    }
    this.tweens.add({ targets: parts, alpha: 1, duration: 260 })
    this.time.delayedCall(2100, () => {
      this.tweens.add({
        targets: parts,
        alpha: 0,
        duration: 420,
        onComplete: () => parts.forEach((p) => (p as Phaser.GameObjects.Shape).destroy()),
      })
    })
  }

  private async victorySequence(): Promise<void> {
    this.over = true
    this.resolving = false
    await this.enemy.die()
    this.cameras.main.flash(320, 255, 240, 205)
    sfx.play('victory')
    damageNumber(this, ENEMY_POS.x, ENEMY_POS.y - 130, `+${this.engine.xpGained} XP`, 'xp')
    this.hero.celebrate()
    await this.wait(1450)
    this.finishBattle(true)
  }

  private async defeatSequence(reason: 'hp' | 'exhausted'): Promise<void> {
    this.over = true
    this.resolving = false
    if (reason === 'hp') {
      this.hero.fall()
      sfx.play('defeat')
    } else {
      this.showBanner('The Trial Endures', '题目已用尽——回顾解析，再次挑战。')
      sfx.play('defeat')
    }
    await this.wait(1350)
    this.finishBattle(false, reason)
  }

  private finishBattle(victory: boolean, reason?: 'hp' | 'exhausted'): void {
    const snap = this.engine.snapshot()
    const result: BattleResult = {
      nodeId: this.nodeId,
      levelId: this.level.id,
      levelName: this.level.name,
      enemyName: this.level.enemy.name,
      victory,
      defeatReason: victory ? undefined : reason,
      xpGained: snap.xpGained + (victory ? this.level.rewards?.xpBonus ?? 0 : 0),
      accuracy: snap.accuracy,
      maxCombo: snap.maxCombo,
      hintsUsed: snap.hintsUsed,
      correct: snap.correct,
      wrong: snap.wrong,
      total: this.engine.totalQuestions,
      phaseReached: snap.phase,
    }
    EventBus.emit(EV.BATTLE_OVER, result)
  }

  private exitToMap(): void {
    this.scene.stop()
    this.scene.resume('WorldMapScene')
  }

  // ── 帧更新 / 状态广播 ────────────────────────────────────────────

  override update(_time: number, delta: number): void {
    this.enemy?.update(delta)
  }

  private emitState(): void {
    const e = this.engine
    EventBus.emit(EV.BATTLE_STATE, {
      enemyHP: e.enemyHP,
      enemyMaxHP: e.rule.enemyHP,
      playerHP: e.playerHP,
      playerMaxHP: e.rule.playerHP,
      combo: e.combo,
      charge: e.charge,
      chargeNeed: e.chargeNeed,
      skillArmed: e.skillIsArmed,
      hintPenaltyActive: e.hintPenaltyActive,
      phaseName: e.currentPhase?.name ?? null,
      phaseIndex: e.phaseIndex,
      questionIndex: e.questionIndex,
      total: e.totalQuestions,
      isBoss: this.isBoss,
      finished: e.finished,
    } satisfies BattleStatePayload)
  }
}

// ── 题目类型相关的小工具 ────────────────────────────────────────────

function formatExpected(q: Question): string {
  switch (q.type) {
    case 'single_choice':
      return `正确答案：${q.options[q.answer]}`
    case 'ordering':
      return `正确顺序：${q.items.map((it, i) => `${i + 1}. ${it}`).join(' → ')}`
    case 'open_input':
      return `正确答案：${q.answers[0]}`
  }
}

function correctResponseFor(q: Question): QuestionResponse {
  switch (q.type) {
    case 'single_choice':
      return q.answer
    case 'ordering':
      return q.items.map((_, i) => i)
    case 'open_input':
      return q.answers[0]
  }
}

function wrongResponseFor(q: Question): QuestionResponse {
  switch (q.type) {
    case 'single_choice':
      return (q.answer + 1) % q.options.length
    case 'ordering':
      return q.items.map((_, i) => q.items.length - 1 - i)
    case 'open_input':
      return '???'
  }
}
