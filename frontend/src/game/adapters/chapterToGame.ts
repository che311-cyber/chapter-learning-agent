// chapterToGame 适配器：把 Chapter Agent 已生成的产物（learning_plan / question_pool /
// chapter_context）映射为 EduRealm 引擎的 WorldBundle（MapSpec + LevelSpec）。
// 不调用 DeepSeek，不做任何内容再生成——只做确定性的结构转换与分组。
import type { LevelSpec, MapNodeSpec, MapSpec, Question as GameQuestion } from '../../edurealm/schemas/types'
import type { ChapterContext, LearningPlan, Question, QuestionPool, ResultPayload } from '../../types'
import { XP_RULES, type XpRuleKey } from '../xpRules'

// 与 learning.ts 相同的中文文本相似度（此处独立实现避免跨层依赖 UI 模块）
function norm(s: string): string {
  return (s || '').replace(/[\s，。；、：（）()[\]【】“”"'‘’：:·—\-｜|]/g, '').toLowerCase()
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

/** 引擎支持的题型转换：single_choice 直接映射；简答题答案极短时转 open_input */
function convertQuestion(q: Question, i: number): GameQuestion | null {
  const id = `gq${i}_${q.id}`
  if (q.type === 'single_choice' && Array.isArray(q.options) && q.options.length >= 2) {
    const ansLetter = (q.answer || 'A').trim().toUpperCase().replace(/[^A-Z]/g, '')[0] || 'A'
    const idx = ansLetter.charCodeAt(0) - 65
    if (idx < 0 || idx >= q.options.length) return null
    return {
      id, type: 'single_choice', prompt: q.prompt, options: q.options,
      answer: idx, difficulty: q.difficulty,
      hint: q.explanation ? `提示：${q.explanation.slice(0, 60)}…` : undefined,
      explanation: `【答案 ${ansLetter}】${q.explanation}（依据：${(q.source_basis || []).join('；')}）`,
    }
  }
  // 简短答案的简答/计算题 → 开放输入（答案完全匹配；并提供常见等价写法）
  if ((q.type === 'short_answer' || q.type === 'calculation') && q.answer.length <= 16) {
    const variants = new Set<string>([q.answer.trim(), q.answer.replace(/[[\]]/g, '').trim()])
    return {
      id, type: 'open_input', prompt: q.prompt,
      answers: [...variants].filter((x) => x.length > 0), difficulty: q.difficulty,
      hint: q.explanation ? `提示：${q.explanation.slice(0, 60)}…` : undefined,
      explanation: `【答案 ${q.answer}】${q.explanation}（依据：${(q.source_basis || []).join('；')}）`,
    }
  }
  // multiple_choice / proof / 长答案：引擎暂不支持，游戏模式跳过（网页学习模式仍完整可用）
  return null
}

/** 兜底题目：当某阶段没有任何可转换题目时，用 chapter_context 的定义合成概念选择题
 *  （确定性生成，不调用 LLM；内容 100% 来自教材理解产物）。 */
function synthesizeQuestions(ctx: ChapterContext, levelId: string, count: number): GameQuestion[] {
  const defs = (ctx?.definitions || []).filter((d) => d.term && d.content)
  const out: GameQuestion[] = []
  for (let k = 0; k < defs.length && out.length < count; k++) {
    const correct = defs[k]
    const distractors = defs.filter((_, j) => j !== k).slice(0, 3)
    if (distractors.length < 1) break
    const options = [correct.content, ...distractors.map((d) => d.content)]
    // 确定性打乱（按字符和），让正确答案位置不固定
    const order = options
      .map((o, j) => ({ o, j, key: (o.length * 31 + j * 7) % 97 }))
      .sort((a, b) => a.key - b.key)
      .map((x) => x.o)
    out.push({
      id: `${levelId}-syn${k}`,
      type: 'single_choice',
      prompt: `「${correct.term}」的准确定义是？`,
      options: order,
      answer: order.indexOf(correct.content),
      difficulty: 1,
      explanation: `${correct.term}：${correct.content}` +
        (correct.source_file ? `（${correct.source_file}${correct.source_page ? ` P${correct.source_page}` : ''}）` : ''),
    })
  }
  return out
}

export interface ChapterGameBundle {
  map: MapSpec
  levels: Record<string, LevelSpec>
  worldId: string
  /** 每个节点的通关 XP 奖励（来自 XP_RULES 配置） */
  nodeXp: Record<string, number>
}

const STRUCTURES = ['gate', 'watchtower', 'canyon_gate', 'ruins', 'bridge', 'summit_temple'] as const
const BIOMES = ['forest', 'mountain', 'lake', 'snow'] as const
const ENEMIES = [
  { name: '概念之影', form: 'wisp' as const },
  { name: '定义傀儡', form: 'golem' as const },
  { name: '律令幻灵', form: 'phantom' as const },
  { name: '综合巨像', form: 'colossus' as const },
]

function shortName(name: string, max = 9): string {
  const s = name.replace(/[（(].*$/, '').trim()
  return s.length > max ? s.slice(0, max) : s
}

export function buildChapterWorld(
  project: string,
  result: ResultPayload,
): ChapterGameBundle {
  // STRUCTURE_ONLY：正文缺失，不能构建游戏世界
  if (result.quality?.contentStatus === 'STRUCTURE_ONLY') {
    throw new Error('正文内容缺失（STRUCTURE_ONLY）：仅基于目录结构，无法生成游戏关卡。')
  }

  const plan: LearningPlan | null = result.learning_plan
  const pool: QuestionPool | null = result.question_pool
  const ctx: ChapterContext | null = result.chapter_context
  const slug = result.run_id
  const worldId = `chapter__${project}__${slug}`

  const stages = plan?.learning_sequence || []
  const questions = pool?.questions || []

  // ---- 题目按阶段分组（复用学习模式的相似度思想）----
  const buckets: Question[][] = stages.map(() => [])
  const leftovers: Question[] = []
  for (const q of questions) {
    let best = -1
    let bestScore = 0
    stages.forEach((s, si) => {
      for (const t of [s.goal, s.name, ...(s.content || []), ...(s.practice || [])]) {
        const sc = similarity(q.learning_objective, t)
        if (sc > bestScore) { bestScore = sc; best = si }
      }
    })
    if (best >= 0 && bestScore >= 0.32) buckets[best].push(q)
    else leftovers.push(q)
  }

  // ---- 转换为引擎题型 ----
  const converted: GameQuestion[][] = buckets.map((b) =>
    b.map((q, i) => convertQuestion(q, i)).filter((x): x is GameQuestion => x !== null))
  const convertedLeft = leftovers
    .map((q, i) => convertQuestion(q, 100 + i))
    .filter((x): x is GameQuestion => x !== null)

  // ---- Boss 题库： leftovers + 各阶段难度3题 ----
  const bossPool: GameQuestion[] = [...convertedLeft]
  converted.forEach((arr, si) => arr.forEach((gq, i) => {
    const src = buckets[si]?.[i]
    if (src && src.difficulty === 3) bossPool.push(gq)
  }))
  // 去重（同 id）
  const seen = new Set<string>()
  const bossQuestions = bossPool.filter((q) => !seen.has(q.id) && seen.add(q.id)).slice(0, 6)

  // ---- 节点规划：每个阶段一个节点，最后一个阶段后接 Boss ----
  const stageCount = stages.length
  const nodes: MapNodeSpec[] = []
  const levels: Record<string, LevelSpec> = {}

  // 给“最有挑战”的中间阶段授 elite（有难度3题最多的阶段；否则第 4 个阶段）
  let eliteIdx = -1
  let eliteScore = 0
  stages.forEach((_s, i) => {
    const hard = (buckets[i] || []).filter((q) => q.difficulty === 3).length
    if (hard > eliteScore) { eliteScore = hard; eliteIdx = i }
  })
  if (eliteIdx === -1 && stageCount >= 4) eliteIdx = 3
  if (eliteIdx >= stageCount - 1) eliteIdx = -1 // 最后阶段留给 Boss 前主干

  stages.forEach((s, i) => {
    const isElite = i === eliteIdx
    const nodeId = `lv${i + 1}`
    let qs = converted[i]
    if (qs.length === 0) qs = synthesizeQuestions(ctx ?? { chapter: '', source_files: [], core_concepts: [], definitions: [], theorems: [], source_references: [] }, nodeId, 3)
    // 引擎题目用尽未杀敌 = 失败；敌血量按题数配置，全对必胜
    const n = Math.max(1, qs.length)
    const type: 'normal' | 'elite' = isElite ? 'elite' : 'normal'
    const enemy = ENEMIES[i % (ENEMIES.length - 1)]
    levels[nodeId] = {
      id: nodeId,
      name: `${i + 1}. ${shortName(s.name)}`,
      type,
      description: s.goal,
      enemy: {
        name: isElite ? `${enemy.name}·精粹` : enemy.name,
        title: isElite ? '精锐守卫' : '知识守卫',
        form: enemy.form,
        size: isElite ? 1.1 : 1,
      },
      rules: {
        enemyHP: Math.max(50, n * 25 - 15),
        playerHP: 100,
      },
      rewards: { xpBonus: XP_RULES[isElite ? 'elite' : 'normal'] },
      questions: qs,
    }
    nodes.push({
      id: nodeId,
      name: shortName(s.name),
      type,
      difficulty: Math.min(5, 1 + Math.round((i / Math.max(1, stageCount - 1)) * 2)),
      description: s.goal,
      levelRef: nodeId,
      connections: [],
      position: {
        x: 0.14 + (i / Math.max(1, stageCount)) * 0.72,
        y: 0.62 - 0.16 * Math.sin((i / Math.max(1, stageCount - 1)) * Math.PI),
      },
      biome: BIOMES[i % BIOMES.length],
      region: `zone${i}`,
      structure: STRUCTURES[i % STRUCTURES.length],
    })
  })

  // ---- Boss：综合挑战 ----
  const bossId = 'boss_final'
  const bossQs = bossQuestions.length > 0
    ? bossQuestions
    : synthesizeQuestions(ctx ?? { chapter: '', source_files: [], core_concepts: [], definitions: [], theorems: [], source_references: [] }, bossId, 4)
  levels[bossId] = {
    id: bossId,
    name: '综合试炼',
    type: 'boss',
    description: '汇聚本章全部核心概念的综合挑战。击败它，完成这一章的远征。',
    enemy: { name: '混沌巨像', title: '章末守卫', form: 'colossus', size: 1.35 },
    rules: {
      enemyHP: Math.max(60, bossQs.length * 25 - 10),
      playerHP: 110,
      phases: [
        { atEnemyHpPercent: 45, name: '狂怒', enemyDamageMultiplier: 1.5, message: '巨像进入狂怒！' },
      ],
    },
    rewards: { xpBonus: XP_RULES.boss },
    questions: bossQs,
  }
  nodes.push({
    id: bossId,
    name: '综合试炼',
    type: 'boss',
    difficulty: 5,
    description: '汇聚本章全部核心概念的综合挑战。',
    levelRef: bossId,
    connections: [],
    prerequisites: stages.map((_, i) => `lv${i + 1}`),
    position: { x: 0.9, y: 0.2 },
    biome: 'dark',
    region: 'zboss',
    structure: 'citadel',
  })

  // 线性主干连边
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connections.push(nodes[i + 1].id)

  const map: MapSpec = {
    worldId,
    worldName: `${result.target || result.chapter_context?.chapter || '章节'} · 学者之地`,
    subtitle: 'Chapter Agent · 章节世界',
    theme: {
      environment: 'fantasy-academic',
      accent: '#d8b36a',
      description: '由 Chapter Agent 从你的教材章节生成的学习世界。',
    },
    startNodeId: nodes[0]?.id ?? bossId,
    regions: [
      ...stages.map((_, i) => ({ id: `zone${i}` })),
      { id: 'zboss', label: '综合暗域' },
    ],
    nodes,
  }

  const nodeXp: Record<string, number> = {}
  for (const n of nodes) {
    const key: XpRuleKey = n.type === 'boss' ? 'boss' : n.type === 'elite' ? 'elite' : 'normal'
    nodeXp[n.id] = XP_RULES[key]
  }

  return { map, levels, worldId, nodeXp }
}
