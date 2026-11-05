/**
 * 内容注册表：worldId → MapSpec，levelRef → LevelSpec。
 * 未来接 AI 时只需让 fetch 结果经过同样的注册/校验入口。
 */
import type { LevelSpec, MapSpec } from '../schemas/types'
import { INFINITE_REALM } from './worlds/infinite_realm'
import { INFINITE_REALM_LEVELS } from './levels/infinite_realm_levels'

export const DEFAULT_WORLD_ID = INFINITE_REALM.worldId

export const MAP_SPECS: Record<string, MapSpec> = {
  [INFINITE_REALM.worldId]: INFINITE_REALM,
}

export const LEVEL_SPECS: Record<string, LevelSpec> = Object.fromEntries(
  INFINITE_REALM_LEVELS.map((l) => [l.id, l]),
)
