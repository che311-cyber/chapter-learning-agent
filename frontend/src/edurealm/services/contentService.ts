/**
 * 内容服务 —— 游戏与内容的唯一入口。
 * 默认：本地 mock 注册表（infinite_realm）。
 * 集成模式：registerWorldBundle() 把 Chapter Agent 生成的章节世界注入进来，
 * 引擎其余部分零改动。
 */
import type { LevelSpec, MapSpec } from '../schemas/types'
import { DEFAULT_WORLD_ID, LEVEL_SPECS, MAP_SPECS } from '../data/registry'
import { validateLevelSpec, validateMapSpec } from '../schemas/validate'

export interface WorldBundle {
  map: MapSpec
  levels: Record<string, LevelSpec>
}

let cache: WorldBundle | null = null
let dynamicBundle: WorldBundle | null = null

/** 注册动态世界（如由 chapterToGame 适配器生成），优先级高于静态注册表。 */
export function registerWorldBundle(bundle: WorldBundle): void {
  validateMapSpec(bundle.map).errors.forEach((e) => {
    throw new Error(`[contentService] 动态 MapSpec 校验失败:\n  - ${e}`)
  })
  for (const spec of Object.values(bundle.levels)) {
    const lv = validateLevelSpec(spec)
    if (!lv.ok) throw new Error(`[contentService] 动态 LevelSpec(${spec.id}) 校验失败:\n  - ${lv.errors.join('\n  - ')}`)
  }
  dynamicBundle = bundle
  cache = bundle
  // QA / 自动化测试钩子（只读）
  if (typeof window !== 'undefined') {
    ;(window as unknown as Record<string, unknown>).__edurealmWorld = bundle
  }
}

/** 清除动态世界，恢复默认 mock 世界。 */
export function clearDynamicWorld(): void {
  dynamicBundle = null
  cache = null
}

export async function loadWorld(worldId: string = (dynamicBundle ?? cache)?.map.worldId ?? DEFAULT_WORLD_ID): Promise<WorldBundle> {
  if (dynamicBundle && worldId === dynamicBundle.map.worldId) return dynamicBundle
  if (cache && cache.map.worldId === worldId) return cache

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
