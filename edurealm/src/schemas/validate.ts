/**
 * 运行时校验：AI 未来生成的 JSON 可能不合法，
 * 引擎在加载时给出可读错误，而不是渲染时神秘崩溃。
 * 故意不引入 zod —— 保持依赖最小，规则完全可控。
 */
import type { LevelSpec, MapSpec, Question } from './types'

export interface ValidationResult {
  ok: boolean
  errors: string[]
}

const ok = (): ValidationResult => ({ ok: true, errors: [] })
const fail = (errors: string[]): ValidationResult => ({ ok: false, errors })

function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

export function validateMapSpec(m: unknown): ValidationResult {
  if (typeof m !== 'object' || m === null) return fail(['MapSpec 必须是对象'])
  const s = m as MapSpec
  const errors: string[] = []
  if (!isStr(s.worldId)) errors.push('worldId 缺失')
  if (!isStr(s.worldName)) errors.push('worldName 缺失')
  if (typeof s.theme !== 'object' || s.theme === null || !isStr(s.theme.environment))
    errors.push('theme.environment 缺失')
  if (!Array.isArray(s.nodes) || s.nodes.length === 0) return fail([...errors, 'nodes 必须是非空数组'])

  const ids = new Set<string>()
  for (const n of s.nodes) {
    if (!isStr(n.id)) errors.push('存在缺失 id 的节点')
    else ids.add(n.id)
  }
  if (!ids.has(s.startNodeId)) errors.push(`startNodeId "${s.startNodeId}" 不在 nodes 中`)

  for (const n of s.nodes) {
    const tag = `node[${n.id ?? '?'}]`
    if (!isStr(n.name)) errors.push(`${tag}: name 缺失`)
    if (n.type !== 'normal' && n.type !== 'elite' && n.type !== 'boss')
      errors.push(`${tag}: type 必须是 normal|elite|boss`)
    if (!isStr(n.levelRef)) errors.push(`${tag}: levelRef 缺失`)
    if (!Array.isArray(n.connections)) errors.push(`${tag}: connections 必须是数组`)
    else
      for (const c of n.connections)
        if (!ids.has(c)) errors.push(`${tag}: connections 引用了不存在的节点 "${c}"`)
    if (n.prerequisites)
      for (const p of n.prerequisites)
        if (!ids.has(p)) errors.push(`${tag}: prerequisites 引用了不存在的节点 "${p}"`)
    if (n.position) {
      const { x, y } = n.position
      if (typeof x !== 'number' || typeof y !== 'number' || x < 0 || x > 1 || y < 0 || y > 1)
        errors.push(`${tag}: position 必须是 0..1 的归一化坐标`)
    }
    if (n.biome && !['forest', 'mountain', 'lake', 'snow', 'dark'].includes(n.biome))
      errors.push(`${tag}: biome 必须是 forest|mountain|lake|snow|dark`)
    if (n.region && typeof n.region !== 'string') errors.push(`${tag}: region 必须是字符串`)
    if (n.structure && !['gate', 'watchtower', 'canyon_gate', 'shrine', 'bridge', 'ruins', 'spire', 'summit_temple', 'citadel'].includes(n.structure))
      errors.push(`${tag}: structure 不是已知的建筑形态`)
  }
  if (s.regions) {
    const regionIds = new Set(s.regions.map((r) => r.id))
    for (const n of s.nodes) {
      if (n.region && !regionIds.has(n.region))
        errors.push(`node[${n.id}]: region "${n.region}" 未在 regions 中定义`)
    }
  }
  return errors.length ? fail(errors) : ok()
}

function validateQuestion(q: Question, tag: string): string[] {
  const errors: string[] = []
  if (!isStr(q.id)) errors.push(`${tag}: id 缺失`)
  if (!isStr(q.prompt)) errors.push(`${tag}: prompt 缺失`)
  switch (q.type) {
    case 'single_choice':
      if (!Array.isArray(q.options) || q.options.length < 2) errors.push(`${tag}: options 至少 2 项`)
      else if (typeof q.answer !== 'number' || q.answer < 0 || q.answer >= q.options.length)
        errors.push(`${tag}: answer 下标越界`)
      break
    case 'ordering':
      if (!Array.isArray(q.items) || q.items.length < 2) errors.push(`${tag}: items 至少 2 项`)
      break
    case 'open_input':
      if (!Array.isArray(q.answers) || q.answers.length === 0) errors.push(`${tag}: answers 不能为空`)
      break
    default:
      errors.push(`${tag}: 未知题目类型 ${(q as { type: string }).type}`)
  }
  return errors
}

export function validateLevelSpec(l: unknown): ValidationResult {
  if (typeof l !== 'object' || l === null) return fail(['LevelSpec 必须是对象'])
  const s = l as LevelSpec
  const errors: string[] = []
  if (!isStr(s.id)) errors.push('id 缺失')
  if (!isStr(s.name)) errors.push('name 缺失')
  if (s.type !== 'normal' && s.type !== 'elite' && s.type !== 'boss')
    errors.push('type 必须是 normal|elite|boss')
  if (typeof s.enemy !== 'object' || s.enemy === null || !isStr(s.enemy.name))
    errors.push('enemy.name 缺失')
  if (typeof s.rules !== 'object' || s.rules === null) errors.push('rules 缺失（可为空对象）')
  if (!Array.isArray(s.questions) || s.questions.length === 0) errors.push('questions 不能为空')
  else s.questions.forEach((q, i) => errors.push(...validateQuestion(q, `question[${i}]`)))
  return errors.length ? fail(errors) : ok()
}
