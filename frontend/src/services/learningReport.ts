// 学情报告：聚合「引导式学习」与「游戏模式」两处本地学习数据，
// 生成结构化报告（JSON，供后续 Agent/教师系统回流）与 Markdown（供教师/家长阅读）。
// 纯确定性统计，不调用任何 LLM；XP 是游戏奖励、正确率是掌握依据，两者分开呈现。
import type { LearningPlan, Question, QuestionPool } from '../types'
import { levelInfo } from '../game/xpRules'
import { loadSession } from './learning'

// ---- 本地数据读取（与 LearningSession / GameContainer 的键保持一致）----
interface SavedLearning {
  idx: number
  results: Record<string, 'correct' | 'wrong'>
  picked: Record<string, string>
  mastery: Record<string, boolean>
  selfReports?: Record<string, boolean>
  totalSteps?: number
}

function loadLearning(project: string, slug: string): SavedLearning | null {
  return loadSession(project, slug)
}

function loadGameSave(project: string, slug: string):
  { xp: number; completedLevels: string[]; levelStats: Record<string,
    { attempts: number; clears: number; bestAccuracy: number; correct: number; wrong: number; hintsUsed: number }> } | null {
  try {
    const raw = localStorage.getItem(`game_state__${project}__${slug}`)
    if (!raw) return null
    const value = JSON.parse(raw)
    if (!value || !Number.isFinite(value.xp) || value.xp < 0
      || (value.completedLevels !== undefined && (!Array.isArray(value.completedLevels)
        || value.completedLevels.some((item: unknown) => typeof item !== 'string')))) return null
    if (value.levelStats !== undefined && (!value.levelStats || typeof value.levelStats !== 'object'
      || Array.isArray(value.levelStats) || Object.values(value.levelStats).some(item =>
        !item || typeof item !== 'object' || ['attempts', 'clears', 'correct', 'wrong'].some(key => {
          const count = (item as Record<string, unknown>)[key]
          return typeof count !== 'number' || !Number.isFinite(count) || count < 0
        })))) return null
    return { xp: value.xp, completedLevels: value.completedLevels ?? [], levelStats: value.levelStats ?? {} }
  } catch {
    return null
  }
}

export interface ReportInput {
  project: string
  target: string
  plan: LearningPlan | null
  pool: QuestionPool | null
}

export interface WrongItem {
  id: string
  prompt: string
  answer: string
  explanation: string
  source_basis: string[]
  difficulty: number
  learning_objective: string
}

export interface LearningReportData {
  meta: {
    chapter: string
    target: string
    project: string
    generatedAt: string
    dataSources: string[]
  }
  learning: {
    hasSession: boolean
    selfReportedCount: number
    selfReportedCorrect: number
    answered: number
    correct: number
    wrong: number
    accuracy: number | null
    progressPct: number | null
    wrongQuestions: WrongItem[]
    objectiveWeakness: { objective: string; wrong: number; total: number }[]
    mastery: { criterion: string; checked: boolean }[]
  }
  game: {
    hasSave: boolean
    xp: number
    level: number
    levelInto: number
    levelNeed: number
    completedLevels: string[]
    levelStats: { node: string; attempts: number; clears: number; accuracy: number; correct: number; wrong: number }[]
  }
  suggestions: string[]
}

const DIFF: Record<number, string> = { 1: '基础', 2: '中等', 3: '挑战' }

export function buildReport(input: ReportInput, slug: string, session?: SavedLearning): LearningReportData {
  const { project, target, plan, pool } = input
  const learning = session ?? loadLearning(project, slug)
  const game = loadGameSave(project, slug)
  const questions: Question[] = pool?.questions || []

  // ---- 网页学习会话 ----
  const results = learning?.results ?? {}
  const selfReports = learning?.selfReports ?? {}
  const byId = new Map(questions.map((q) => [q.id, q]))
  const answeredQids = Object.keys(results).filter(id => byId.has(id))
  const correct = answeredQids.filter((id) => results[id] === 'correct').length
  const wrong = answeredQids.length - correct
  const wrongQuestions: WrongItem[] = answeredQids
    .filter((id) => results[id] === 'wrong' && byId.has(id))
    .map((id) => {
      const q = byId.get(id)!
      return {
        id, prompt: q.prompt, answer: q.answer, explanation: q.explanation,
        source_basis: q.source_basis || [], difficulty: q.difficulty,
        learning_objective: q.learning_objective,
      }
    })

  // 薄弱点聚合：按 learning_objective 统计错误率
  const objMap = new Map<string, { wrong: number; total: number }>()
  for (const id of answeredQids) {
    const q = byId.get(id)
    if (!q) continue
    const key = q.learning_objective || '未标注目标'
    const e = objMap.get(key) ?? { wrong: 0, total: 0 }
    e.total += 1
    if (results[id] === 'wrong') e.wrong += 1
    objMap.set(key, e)
  }
  const objectiveWeakness = [...objMap.entries()]
    .map(([objective, v]) => ({ objective, ...v }))
    .filter((v) => v.wrong > 0)
    .sort((a, b) => b.wrong - a.wrong)

  const mastery = (plan?.mastery_criteria || []).map((criterion, i) => ({
    criterion, checked: !!(learning?.mastery?.[String(i)]),
  }))

  // 进度百分比：LearningSession 的 idx 对应阶段步骤数（此处用已作答比例近似 + idx 不读组件态）
  const progressPct = learning?.totalSteps
    ? Math.round(Math.min(1, learning.idx / learning.totalSteps) * 100) : null

  // ---- 游戏模式 ----
  const lv = levelInfo(game?.xp ?? 0)
  const gamePart = {
    hasSave: !!game,
    xp: game?.xp ?? 0,
    level: lv.level,
    levelInto: lv.into,
    levelNeed: lv.need,
    completedLevels: game?.completedLevels ?? [],
    levelStats: Object.entries(game?.levelStats ?? {}).map(([node, s]) => ({
      node, attempts: s.attempts, clears: s.clears,
      accuracy: s.correct + s.wrong > 0 ? Math.round((s.correct / (s.correct + s.wrong)) * 100) / 100 : 0,
      correct: s.correct, wrong: s.wrong,
    })),
  }

  // ---- 建议（确定性规则）----
  const suggestions: string[] = []
  if (wrong > 0) {
    suggestions.push(`有 ${wrong} 道题待巩固，建议从下方错题回顾开始，优先复习每题标注的教材依据章节。`)
    if (objectiveWeakness.length > 0) {
      suggestions.push(`薄弱点集中在：${objectiveWeakness.slice(0, 3).map((o) => o.objective).join('；')}。`)
    }
  } else if (answeredQids.length > 0) {
    suggestions.push('本轮作答全部正确——可进入下一阶段学习，或挑战更高难度（difficulty 3）题目。')
  }
  const unchecked = mastery.filter((m) => !m.checked).length
  if (mastery.length > 0) {
    suggestions.push(unchecked === 0
      ? '掌握标准自查已全部确认，达到本章掌握要求。'
      : `掌握标准尚有 ${unchecked}/${mastery.length} 项未确认，建议对照教材复核后再勾选。`)
  }
  if (game && game.completedLevels.length > 0) {
    suggestions.push(`游戏模式已完成 ${game.completedLevels.length} 个关卡（LV.${lv.level}，${game.xp} XP）。`)
  }
  if (Object.keys(selfReports).length > 0) {
    suggestions.push(
      `自评掌握 ${Object.values(selfReports).filter(Boolean).length}/${Object.keys(selfReports).length} 项（自评结果不计入客观正确率，建议以客观作答为准）。`
    )
  }
  if (answeredQids.length === 0 && !game) {
    suggestions.push('暂无作答记录：完成「开始学习」引导流程或游戏模式关卡后，这里会给出针对性建议。')
  }

  const sources: string[] = []
  if (learning) sources.push('网页引导式学习（作答与掌握自查）')
  if (game) sources.push('游戏模式（关卡与战斗统计）')

  return {
    meta: {
      chapter: plan?.chapter || target,
      target, project, generatedAt: new Date().toISOString(),
      dataSources: sources,
    },
    learning: {
      hasSession: !!learning,
      selfReportedCount: Object.keys(selfReports).filter(id => byId.has(id)).length,
      selfReportedCorrect: Object.entries(selfReports).filter(([id, correct]) => byId.has(id) && correct).length,
      answered: answeredQids.length,
      correct, wrong,
      accuracy: answeredQids.length > 0 ? Math.round((correct / answeredQids.length) * 100) : null,
      progressPct,
      wrongQuestions,
      objectiveWeakness,
      mastery,
    },
    game: gamePart,
    suggestions,
  }
}

// ---- Markdown 渲染 ----
export function reportToMarkdown(d: LearningReportData): string {
  const L: string[] = []
  L.push(`# 学情报告：${d.meta.chapter}`)
  L.push('')
  L.push(`- **目标章节**：${d.meta.target}（项目：${d.meta.project}）`)
  L.push(`- **生成时间**：${new Date(d.meta.generatedAt).toLocaleString('zh-CN')}`)
  if (d.meta.dataSources.length > 0) L.push(`- **数据来源**：${d.meta.dataSources.join('；')}`)
  L.push('')

  L.push('## 一、总体表现')
  L.push('')
  if (d.learning.answered > 0) {
    L.push(`- 练习作答：${d.learning.answered} 题，掌握 ${d.learning.correct} 题，待巩固 ${d.learning.wrong} 题`
      + (d.learning.accuracy !== null ? `（正确率 ${d.learning.accuracy}%）` : ''))
  } else {
    L.push('- 练习作答：暂无记录')
  }
  if (d.game.hasSave) {
    L.push(`- 游戏模式：LV.${d.game.level}（${d.game.levelInto}/${d.game.levelNeed} XP），`
      + `完成关卡 ${d.game.completedLevels.length} 个`)
  }
  L.push('')

  L.push('## 二、薄弱点分析')
  L.push('')
  if (d.learning.objectiveWeakness.length > 0) {
    for (const o of d.learning.objectiveWeakness) {
      L.push(`- ${o.objective}（错 ${o.wrong}/${o.total}）`)
    }
  } else if (d.learning.answered > 0) {
    L.push('- 本轮未发现明显薄弱点。')
  } else {
    L.push('- 暂无作答数据。')
  }
  L.push('')

  L.push('## 三、错题回顾')
  L.push('')
  if (d.learning.wrongQuestions.length === 0) {
    L.push('（无错题）')
  } else {
    d.learning.wrongQuestions.forEach((q, i) => {
      const diff = DIFF[q.difficulty] ?? q.difficulty
      L.push(`### ${i + 1}. ${q.learning_objective}【${diff}】`)
      L.push('')
      L.push(`**题目**：${q.prompt}`)
      L.push('')
      L.push(`**正确答案**：${q.answer}`)
      L.push('')
      L.push(`**解析**：${q.explanation}`)
      if (q.source_basis.length > 0) {
        L.push('')
        L.push(`**教材依据**：${q.source_basis.join('；')}`)
      }
      L.push('')
    })
  }

  if (d.game.levelStats.length > 0) {
    L.push('## 四、游戏模式战绩（游戏奖励进度，非掌握度）')
    L.push('')
    for (const s of d.game.levelStats) {
      L.push(`- ${s.node}：挑战 ${s.attempts} 次，通关 ${s.clears} 次，`
        + `作答 ${s.correct + s.wrong} 题对 ${s.correct} 题（${Math.round(s.accuracy * 100)}%）`)
    }
    L.push('')
  }

  if (d.learning.mastery.length > 0) {
    L.push('## 五、掌握标准自查')
    L.push('')
    for (const m of d.learning.mastery) {
      L.push(`- [${m.checked ? 'x' : ' '}] ${m.criterion}`)
    }
    L.push('')
  }

  L.push('## 六、学习建议')
  L.push('')
  for (const s of d.suggestions) L.push(`- ${s}`)
  L.push('')
  L.push('---')
  L.push('')
  L.push('*由 Chapter Learning Agent 学情报告系统生成（本地学习数据聚合）。*')
  return L.join('\n')
}

export interface BuiltReport {
  data: LearningReportData
  markdown: string
  json: string
  filenameBase: string
}

export function buildFullReport(input: ReportInput, slug: string, session?: SavedLearning): BuiltReport {
  const data = buildReport(input, slug, session)
  const stamp = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stampStr = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`
  const filenameBase = `学情报告_${data.meta.chapter}_${stampStr}`
  return {
    data,
    markdown: reportToMarkdown(data),
    json: JSON.stringify(data, null, 2),
    filenameBase,
  }
}

export function downloadText(filename: string, text: string, mime = 'text/markdown'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}
