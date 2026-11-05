import { useEffect, useState } from 'react'
import type { MapSpec, LevelSpec } from '../schemas/types'
import { loadWorld, type WorldBundle } from '../services/contentService'

export interface WorldInfo {
  map: MapSpec
  levels: Record<string, LevelSpec>
}

const listeners = new Set<(w: WorldInfo | null) => void>()
let cachedInfo: WorldInfo | null = null

void loadWorld().then((b: WorldBundle) => {
  cachedInfo = { map: b.map, levels: b.levels }
  listeners.forEach((fn) => fn(cachedInfo))
})

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
