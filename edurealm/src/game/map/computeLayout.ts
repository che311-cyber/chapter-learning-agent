/**
 * 地图布局算法：
 *  - 节点有 position 提示（0..1）→ 直接映射到世界坐标
 *  - 无提示 → 蛇形自动排布（4 列一行，奇数行反向）
 * AI 未来只需给拓扑，不必算像素坐标。
 */
import type { MapSpec } from '../../schemas/types'

export interface NodeLayout {
  x: number
  y: number
}

export interface WorldLayout {
  nodes: Record<string, NodeLayout>
  width: number
  height: number
}

export function computeLayout(map: MapSpec, width: number, height: number): WorldLayout {
  const nodes: Record<string, NodeLayout> = {}
  const marginX = width * 0.09
  const marginY = height * 0.16
  const perRow = 4

  map.nodes.forEach((n, i) => {
    if (n.position) {
      nodes[n.id] = {
        x: marginX + n.position.x * (width - marginX * 2),
        y: marginY + n.position.y * (height - marginY * 2),
      }
      return
    }
    const row = Math.floor(i / perRow)
    let col = i % perRow
    if (row % 2 === 1) col = perRow - 1 - col // 蛇形
    nodes[n.id] = {
      x: marginX + (col / (perRow - 1)) * (width - marginX * 2),
      y: marginY + (row / Math.max(1, Math.ceil(map.nodes.length / perRow) - 1)) * (height - marginY * 2),
    }
  })

  return { nodes, width, height }
}
