import { useEffect, useState } from 'react'
import type { MapSpec, LevelSpec } from '../schemas/types'
import { loadWorld } from '../services/contentService'

export interface WorldInfo {
  map: MapSpec
  levels: Record<string, LevelSpec>
}

const listeners = new Set<(w: WorldInfo | null) => void>()
let cachedInfo: WorldInfo | null = null

async function reload(): Promise<void> {
  const b = await loadWorld()
  cachedInfo = { map: b.map, levels: b.levels }
  listeners.forEach((fn) => fn(cachedInfo))
}

void reload()

/** 世界内容被外部替换（如注册章节世界）后调用，通知所有订阅者。 */
export function refreshWorld(): Promise<void> {
  return reload()
}

/** 全局世界内容（加载完成后全 App 共享） */
export function useWorldBundle(): WorldInfo | null {
  const [info, setInfo] = useState<WorldInfo | null>(cachedInfo)
  useEffect(() => {
    listeners.add(setInfo)
    return () => {
      listeners.delete(setInfo)
    }
  }, [])
  return info
}
