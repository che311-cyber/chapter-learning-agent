// 引导式学习的准备逻辑：把题目按学习方案阶段分组（文本相似度匹配），
// 并把学习进度持久化到 localStorage（刷新/关页不丢，对应 REAL PROGRESS 原则）。
import type { LearningPlan, PlanStage, Question, QuestionPool } from '../types'

export interface MappedStage {
  stage: PlanStage
  questions: Question[]
}

export type QuestionCategory = 'stage_question' | 'consolidation_question' | 'unassigned_question'

export interface LearningDeck {
  stages: MappedStage[]
  consolidation: Question[]  // 明确标记为跨阶段综合题
  unassigned: Question[]     // 无法识别 stage 或 objective 的题，不向学生展示
}

function norm(s: string): string {
  return (s || '')
    .replace(/[\s，。；、：（）()[\]【】“”"'‘’：:·—\-｜|]/g, '')
    .toLowerCase()
}

function bigrams(s: string): Set<string> {
  const t = norm(s)
  const set = new Set<string>()
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2))
  return set
}

function similarity(a: string, b: string): number {
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  A.forEach((x) => { if (B.has(x)) inter++ })
  return (2 * inter) / (A.size + B.size)
}

/**
 * 题目四分类：
 * A. stage_question — 有 stage_index 且 objective 匹配阶段 → 进入对应阶段
 * B. consolidation_question — 显式标记为跨阶段综合 → 综合巩固
 * C. unassigned_question — 无法识别 stage 或 objective → 不向学生展示
 */
export function buildDeck(plan: LearningPlan | null, pool: QuestionPool | null): LearningDeck {
  const stages = plan?.learning_sequence || []
  const questions = pool?.questions || []
  const buckets: Question[][] = stages.map(() => [])
  const consolidation: Question[] = []
  const unassigned: Question[] = []

  for (const q of questions) {
    const qAny = q

    // 综合题必须有明确分类，旧 source_stage_index 是所属阶段的兼容字段。
    if (qAny.question_category === 'consolidation_question' ||
        (qAny.stage_index == null && qAny.source_stage_index == null && qAny.placement_reason?.includes('综合'))) {
      consolidation.push(q)
      continue
    }

    // A. stage_question：有 stage_index
    const stageIndex = qAny.stage_index ?? qAny.source_stage_index
    if (stageIndex != null && String(stageIndex).trim() !== '') {
      const bi = stages.findIndex((s) => s.stage === Number(stageIndex))
      if (bi >= 0) {
        buckets[bi].push(q)
        continue
      }
    }

    // B. consolidation_question：显式标记为综合/跨阶段
    if (stageIndex != null || qAny.question_category === 'unassigned_question') {
      unassigned.push(q)
      continue
    }

    // C. 尝试按 objective 相似度匹配（严格阈值）
    if (q.learning_objective) {
      let best = -1
      let bestScore = 0
      stages.forEach((s, i) => {
        const texts = [s.goal, s.name, ...(s.content || [])]
        for (const t of texts) {
          const sc = similarity(q.learning_objective, t)
          if (sc > bestScore) { bestScore = sc; best = i }
        }
      })
      if (best >= 0 && bestScore >= 0.45) {
        buckets[best].push(q)
        continue
      }
    }

    // D. unassigned_question
    unassigned.push(q)
  }

  buckets.forEach((b) => b.sort((x, y) => (x.difficulty || 2) - (y.difficulty || 2)))
  return { stages: stages.map((stage, i) => ({ stage, questions: buckets[i] })), consolidation, unassigned }
}

// ---------------- 进度持久化 ----------------
export interface SavedSession {
  idx: number
  results: Record<string, 'correct' | 'wrong'>
  picked: Record<string, string>
  mastery: Record<string, boolean>
  selfReports?: Record<string, boolean>
  totalSteps?: number
}

const keyOf = (project: string, slug: string) => `cla-learning:${project}:${slug}`

export function loadSession(project: string, slug: string): SavedSession | null {
  try {
    const raw = localStorage.getItem(keyOf(project, slug))
    if (!raw) return null
    const v = JSON.parse(raw)
    if (!v || !Number.isInteger(v.idx) || v.idx < 0) return null
    if (v.totalSteps !== undefined && (!Number.isInteger(v.totalSteps) || v.totalSteps < 1 || v.idx > v.totalSteps)) return null
    const validMap = (value: unknown, allowed: (item: unknown) => boolean) =>
      value != null && typeof value === 'object' && !Array.isArray(value)
      && Object.values(value).every(allowed)
    if (!validMap(v.results, item => item === 'correct' || item === 'wrong')
      || !validMap(v.picked, item => typeof item === 'string')
      || !validMap(v.mastery, item => typeof item === 'boolean')
      || (v.selfReports !== undefined && !validMap(v.selfReports, item => typeof item === 'boolean'))) return null
    return v as SavedSession
  } catch {
    return null
  }
}

export function saveSession(project: string, slug: string, data: SavedSession): void {
  try {
    localStorage.setItem(keyOf(project, slug), JSON.stringify(data))
  } catch {
    /* 隐私模式等场景下失败可忽略 */
  }
}

export function clearSession(project: string, slug: string): void {
  try {
    localStorage.removeItem(keyOf(project, slug))
  } catch {
    /* ignore */
  }
}
