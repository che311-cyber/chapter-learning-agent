/**
 * 进度推导 —— 纯函数，可测试。
 * 只持久化「已通过关卡」，解锁/锁定状态全部实时推导，
 * 避免冗余状态不一致（刷新后进度错误这类 Bug 的根源）。
 */
import type { LevelStatus, MapSpec, StudentState } from '../schemas/types'

export function deriveNodeStatuses(
  map: MapSpec,
  state: Pick<StudentState, 'completedLevels' | 'devUnlockAll'>,
): Record<string, LevelStatus> {
  const completed = new Set(state.completedLevels)
  const statuses: Record<string, LevelStatus> = {}

  for (const node of map.nodes) {
    if (completed.has(node.id)) {
      statuses[node.id] = 'completed'
      continue
    }
    if (state.devUnlockAll) {
      statuses[node.id] = 'unlocked'
      continue
    }
    // 解锁条件：是起点，或存在「已完成的前驱连边」
    const viaEdge =
      node.id === map.startNodeId ||
      map.nodes.some((n) => n.connections.includes(node.id) && completed.has(n.id))
    // 附加门槛：prerequisites 全部通过（如 Boss 需要主干全通）
    const prereqOk = !node.prerequisites?.length || node.prerequisites.every((p) => completed.has(p))
    statuses[node.id] = viaEdge && prereqOk ? 'unlocked' : 'locked'
  }
  return statuses
}

/** 玩家当前应站立的位置节点 */
export function resolveHeroNodeId(map: MapSpec, state: Pick<StudentState, 'position'>): string {
  return state.position ?? map.startNodeId
}
