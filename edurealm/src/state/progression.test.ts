import { describe, expect, it } from 'vitest'
import { deriveNodeStatuses, resolveHeroNodeId } from './progression'
import type { MapSpec } from '../schemas/types'

const map: MapSpec = {
  worldId: 'w',
  worldName: 'W',
  theme: { environment: 'fantasy-academic' },
  startNodeId: 'a',
  nodes: [
    { id: 'a', name: 'A', type: 'normal', difficulty: 1, levelRef: 'a', connections: ['b', 'e'] },
    { id: 'b', name: 'B', type: 'normal', difficulty: 1, levelRef: 'b', connections: ['c'] },
    { id: 'c', name: 'C', type: 'normal', difficulty: 1, levelRef: 'c', connections: ['d'] },
    { id: 'd', name: 'Boss', type: 'boss', difficulty: 5, levelRef: 'd', connections: [], prerequisites: ['c', 'e'] },
    { id: 'e', name: 'Elite', type: 'elite', difficulty: 3, levelRef: 'e', connections: ['d'] },
  ],
}

const state = (completed: string[], devUnlockAll = false) => ({
  completedLevels: completed,
  devUnlockAll,
})

describe('deriveNodeStatuses', () => {
  it('初始：仅起点解锁', () => {
    const s = deriveNodeStatuses(map, state([]))
    expect(s.a).toBe('unlocked')
    expect(s.b).toBe('locked')
    expect(s.d).toBe('locked')
  })

  it('通过 a 后：b 与 e（支线）解锁，Boss 因前置不足仍锁定', () => {
    const s = deriveNodeStatuses(map, state(['a']))
    expect(s.b).toBe('unlocked')
    expect(s.e).toBe('unlocked')
    expect(s.c).toBe('locked')
    expect(s.d).toBe('locked') // prerequisites c+e 未满足
  })

  it('完成 prerequisites 全部后 Boss 解锁', () => {
    const s = deriveNodeStatuses(map, state(['a', 'b', 'c', 'e']))
    expect(s.d).toBe('unlocked')
  })

  it('只完成主线不完成支线时 Boss 仍锁定', () => {
    const s = deriveNodeStatuses(map, state(['a', 'b', 'c']))
    expect(s.d).toBe('locked')
  })

  it('已完成关卡保持 completed', () => {
    const s = deriveNodeStatuses(map, state(['a', 'b']))
    expect(s.a).toBe('completed')
    expect(s.b).toBe('completed')
  })

  it('devUnlockAll 覆盖一切', () => {
    const s = deriveNodeStatuses(map, state([], true))
    expect(Object.values(s).every((v) => v === 'unlocked' || v === 'completed')).toBe(true)
  })

  it('重复通过是幂等的（不会破坏状态）', () => {
    const s1 = deriveNodeStatuses(map, state(['a']))
    const s2 = deriveNodeStatuses(map, state(['a', 'a']))
    expect(s1).toEqual(s2)
  })
})

describe('resolveHeroNodeId', () => {
  it('无进度时回到起点', () => {
    expect(resolveHeroNodeId(map, { position: null })).toBe('a')
  })
  it('有进度时停留在位置节点', () => {
    expect(resolveHeroNodeId(map, { position: 'c' })).toBe('c')
  })
})
