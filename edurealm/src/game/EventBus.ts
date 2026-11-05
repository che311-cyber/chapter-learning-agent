/**
 * React ↔ Phaser 事件桥（官方 template-react-ts 的 EventBus 模式）。
 * 约定：Event = 命令/动画触发；Store = 数据事实源。
 * 场景必须在 shutdown 时 off 掉自己的监听（防重复监听泄漏）。
 */
import Phaser from 'phaser'
import type { Question } from '../schemas/types'
import type { AnswerResolution } from './rules/BattleEngine'

export const EV = {
  // map → react
  NODE_SELECTED: 'node-selected',
  ARRIVED: 'arrived',
  // react → map
  TRAVEL_TO: 'travel-to',
  MAP_REFRESH: 'map-refresh',
  // battle ↔ react
  BATTLE_QUESTION: 'battle-question',
  SUBMIT_ANSWER: 'submit-answer',
  BATTLE_CONTINUE: 'battle-continue',
  ANSWER_RESOLVED: 'answer-resolved',
  USE_HINT: 'use-hint',
  HINT_RESULT: 'hint-result',
  USE_SKILL: 'use-skill',
  BATTLE_STATE: 'battle-state',
  BATTLE_OVER: 'battle-over',
  EXIT_BATTLE: 'exit-battle',
  RETRY_BATTLE: 'retry-battle',
  // dev
  DEV_SIMULATE: 'dev-simulate',
  DEV_BATTLE: 'dev-battle',
} as const

export const EventBus = new Phaser.Events.EventEmitter()

// QA / 自动化测试钩子：允许测试驱动层直接发射与监听游戏内部事件
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__edurealmEvents = {
    emit: (name: string, payload?: unknown) => EventBus.emit(name, payload),
    on: (name: string, fn: (p: unknown) => void) => EventBus.on(name, fn),
    off: (name: string, fn: (p: unknown) => void) => EventBus.off(name, fn),
    EV,
  }
}

export function on(name: string, fn: (payload: unknown) => void): () => void {
  EventBus.on(name, fn)
  return () => EventBus.off(name, fn)
}
export function emit(name: string, payload?: unknown): void {
  EventBus.emit(name, payload)
}

// ── 类型化载荷 ──────────────────────────────────────────────────────

export interface NodeSelectedPayload {
  nodeId: string
  levelRef: string
}

export interface BattleQuestionPayload {
  index: number
  total: number
  question: Question
}

export interface BattleStatePayload {
  enemyHP: number
  enemyMaxHP: number
  playerHP: number
  playerMaxHP: number
  combo: number
  charge: number
  chargeNeed: number
  skillArmed: boolean
  hintPenaltyActive: boolean
  phaseName: string | null
  phaseIndex: number
  questionIndex: number
  total: number
  isBoss: boolean
  finished: boolean
}

export interface AnswerResolvedPayload {
  correct: boolean
  resolution: AnswerResolution
  explanation?: string
  expected?: string
  questionId: string
}

export interface HintResultPayload {
  ok: boolean
  text?: string
}
