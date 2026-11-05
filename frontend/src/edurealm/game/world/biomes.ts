/**
 * 生态区（biome）调色 —— 统一的手绘奇幻色调。
 * 每个区域有自己的主色，但共享同一套明度/饱和度关系，保证整个世界统一。
 */

export interface BiomeStyle {
  /** 地面主色（大色块） */
  ground: string
  /** 地面亮部（笔触高光） */
  groundLight: string
  /** 地面暗部（边缘/阴影） */
  groundDark: string
  /** 阔叶树冠三阶 */
  treeDark: string
  treeMid: string
  treeLight: string
  /** 是否使用针叶树 */
  pine?: boolean
  /** 枯树（暗域） */
  dead?: boolean
  /** 地表细节颜色（草茎/碎石/雪花/余烬） */
  detail: string
  detailAlt: string
}

export const BIOMES: Record<string, BiomeStyle> = {
  forest: {
    ground: '#8fbf5a',
    groundLight: '#a3cd6e',
    groundDark: '#6da24a',
    treeDark: '#3f7c3b',
    treeMid: '#579649',
    treeLight: '#74b35c',
    detail: '#5c9040',
    detailAlt: '#e8d97a', // 野花
  },
  mountain: {
    ground: '#96a478',
    groundLight: '#a9b58a',
    groundDark: '#75855f',
    treeDark: '#3d6e46',
    treeMid: '#52875a',
    treeLight: '#6ba371',
    pine: true,
    detail: '#7d8894', // 碎石
    detailAlt: '#675e54',
  },
  lake: {
    ground: '#93bd6a',
    groundLight: '#a6cc7c',
    groundDark: '#74a354',
    treeDark: '#417f3f',
    treeMid: '#58984d',
    treeLight: '#77b560',
    detail: '#5c9040',
    detailAlt: '#c2b071', // 芦苇
  },
  snow: {
    ground: '#e9f0f4',
    groundLight: '#f7fbfd',
    groundDark: '#c3d3de',
    treeDark: '#2f5d51',
    treeMid: '#3f7666',
    treeLight: '#578f7d',
    pine: true,
    detail: '#b9cdd9',
    detailAlt: '#ffffff',
  },
  dark: {
    ground: '#4c4458',
    groundLight: '#5b5268',
    groundDark: '#383244',
    treeDark: '#37304a',
    treeMid: '#453d58',
    treeLight: '#544a68',
    dead: true,
    detail: '#c97b4a', // 余烬
    detailAlt: '#8d7fe0', // 符文光
  },
}

/** 水系统（全图统一） */
export const WATER = {
  deep: '#3d7ea6',
  mid: '#5b9cc0',
  light: '#8fc3dc',
  foam: '#d9eef5',
  shadow: '#2f6486',
}

/** 道路 / 桥梁 */
export const ROAD = {
  edge: '#8a6a42',
  mid: '#c19a63',
  light: '#d8b87e',
  stone: '#9a938a',
  stoneEdge: '#6f695f',
  plank: '#8a6238',
  plankDark: '#6e4c2a',
}
