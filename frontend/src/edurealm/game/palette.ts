/**
 * 世界主题调色板 —— MapSpec.theme.environment → 具体颜色。
 * 新世界主题 = 在这里加一个键，不改任何引擎代码。
 */
export interface WorldPalette {
  sky0: number
  sky1: number
  star: number
  mountainFar: number
  mountainNear: number
  river: number
  riverCore: number
  forest: number
  pathUnlit: number
  pathLit: number
  nodeLocked: number
  nodeUnlocked: number
  nodeCompleted: number
  nodeBoss: number
  gold: number
  teal: number
  danger: number
  text: number
  battleBg0: number
  battleBg1: number
}

export const PALETTES: Record<string, WorldPalette> = {
  'fantasy-academic': {
    sky0: 0x0a0d1c,
    sky1: 0x131a30,
    star: 0xcfd8ff,
    mountainFar: 0x161d33,
    mountainNear: 0x1c2440,
    river: 0x1d3b52,
    riverCore: 0x2b6e80,
    forest: 0x18283a,
    pathUnlit: 0x2a3150,
    pathLit: 0x57c8b4,
    nodeLocked: 0x4a5478,
    nodeUnlocked: 0x57c8b4,
    nodeCompleted: 0xd8b36a,
    nodeBoss: 0xe06a55,
    gold: 0xd8b36a,
    teal: 0x57c8b4,
    danger: 0xe06a55,
    text: 0xe9e7df,
    battleBg0: 0x0a0e1a,
    battleBg1: 0x171f38,
  },
}

export function getPalette(environment: string): WorldPalette {
  return PALETTES[environment] ?? PALETTES['fantasy-academic']
}
