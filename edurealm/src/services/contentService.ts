/**
 * 内容服务 —— 游戏与内容的唯一入口。
 * 今天：读取本地 mock 注册表。
 * 未来：把实现换成 fetch(AI API)，返回同样的 WorldBundle —— 游戏零改动。
 */
import type { LevelSpec, MapSpec } from '../schemas/types'
import { DEFAULT_WORLD_ID, LEVEL_SPECS, MAP_SPECS } from '../data/registry'
import { validateLevelSpec, validateMapSpec } from '../schemas/validate'

export interface WorldBundle {
  map: MapSpec
  levels: Record<string, LevelSpec>
}

let cache: WorldBundle | null = null

export async function loadWorld(worldId: string = DEFAULT_WORLD_ID): Promise<WorldBundle> {
  if (cache && cache.map.worldId === worldId) return cache

  // ── 未来 AI 接入点 ──────────────────────────────────────────────
  // const res = await fetch(`${AI_API}/worlds/${worldId}`)
  // const { map, levels } = await res.json()
  const map = MAP_SPECS[worldId]
  if (!map) throw new Error(`[contentService] 未找到世界 "${worldId}"`)

  const mv = validateMapSpec(map)
  if (!mv.ok)
    throw new Error(`[contentService] MapSpec 校验失败(${worldId}):\n  - ${mv.errors.join('\n  - ')}`)

  const levels: Record<string, LevelSpec> = {}
  for (const node of map.nodes) {
    const spec = LEVEL_SPECS[node.levelRef]
    if (!spec) throw new Error(`[contentService] 节点 ${node.id} 引用了缺失的 LevelSpec "${node.levelRef}"`)
    const lv = validateLevelSpec(spec)
    if (!lv.ok)
      throw new Error(`[contentService] LevelSpec 校验失败(${spec.id}):\n  - ${lv.errors.join('\n  - ')}`)
    levels[node.levelRef] = spec
  }

  cache = { map, levels }
  return cache
}

export function getCachedWorld(): WorldBundle {
  if (!cache) throw new Error('[contentService] world 尚未加载，请先 await loadWorld()')
  return cache
}
