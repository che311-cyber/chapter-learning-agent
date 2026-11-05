/**
 * ─────────────────────────────────────────────────────────────────────
 *  EduRealm Content Schema
 *  未来由 AI（DeepSeek）生成、引擎只读的结构化数据。
 *  详见 GAME_SCHEMA.md — 引擎代码中不允许出现任何具体教材内容。
 * ─────────────────────────────────────────────────────────────────────
 */

// ── World / Map ──────────────────────────────────────────────────────

export type LevelType = 'normal' | 'elite' | 'boss'
export type LevelStatus = 'locked' | 'unlocked' | 'completed'
export type Difficulty = 'easy' | 'normal' | 'hard'

/** 生态区：决定该节点周围的地貌绘制（森林/山地/湖泊/雪原/暗域） */
export type Biome = 'forest' | 'mountain' | 'lake' | 'snow' | 'dark'

/** 关卡建筑形态：地图上的"地点本身"就是关卡 */
export type StructureKind =
  | 'gate'        // 村口木门
  | 'watchtower'  // 林间哨塔
  | 'canyon_gate' // 峡谷石门
  | 'shrine'      // 黑曜神龛（精英）
  | 'bridge'      // 石桥
  | 'ruins'       // 遗迹图书馆
  | 'spire'       // 秘术之塔（精英）
  | 'summit_temple' // 雪顶山神庙
  | 'citadel'     // 黑暗城堡（Boss）

/** 归一化坐标提示 0..1，可选；缺省时由布局算法自动排布 */
export interface PositionHint {
  x: number
  y: number
}

export interface MapNodeSpec {
  id: string
  name: string
  type: LevelType
  /** 1..5，仅用于展示 */
  difficulty: number
  description?: string
  /** 指向 LevelSpec 注册表的键 */
  levelRef: string
  /** 前向边：本关通过后解锁这些节点 */
  connections: string[]
  /** 额外门槛：全部通过才解锁（在连边之外） */
  prerequisites?: string[]
  position?: PositionHint
  /** 生态区（影响周围地貌绘制），缺省 forest */
  biome?: Biome
  /** 所属区域（云雾战争迷雾的分组单位） */
  region?: string
  /** 关卡建筑形态，缺省按 type 推断 */
  structure?: StructureKind
}

/** 区域：迷雾分组 + 地图上的地名标签 */
export interface MapRegionSpec {
  id: string
  label?: string
}

export interface MapSpec {
  worldId: string
  worldName: string
  subtitle?: string
  theme: {
    /** 调色板键，如 'fantasy-academic'，映射到 game/palette.ts */
    environment: string
    accent?: string
    description?: string
  }
  startNodeId: string
  nodes: MapNodeSpec[]
  /** 区域定义（迷雾分组 + 地名），缺省时每个节点自成区域 */
  regions?: MapRegionSpec[]
}

// ── Questions（V0 实现 3 类，其余为文档化扩展位）────────────────────
// 未来扩展：'multiple_choice' | 'matching' | 'dialogue' | 'drag_and_drop'
// 新增类型 = 扩展本联合 + evaluators.ts 加 evaluator + components/questions 加渲染器

export type QuestionType = 'single_choice' | 'ordering' | 'open_input'

interface QuestionBase {
  id: string
  prompt: string
  difficulty?: number
  hint?: string
  explanation?: string
}

export interface SingleChoiceQuestion extends QuestionBase {
  type: 'single_choice'
  options: string[]
  /** 正确选项的下标 */
  answer: number
}

export interface OrderingQuestion extends QuestionBase {
  type: 'ordering'
  /** 按正确顺序排列；运行时由 UI 打乱展示 */
  items: string[]
}

export interface OpenInputQuestion extends QuestionBase {
  type: 'open_input'
  /** 任一匹配即正确 */
  answers: string[]
  /** 数值模式：支持 "0.5" / "1/2" / 科学计数，按容差比较 */
  numeric?: boolean
  tolerance?: number
}

export type Question = SingleChoiceQuestion | OrderingQuestion | OpenInputQuestion

/** 玩家的作答载荷：选项下标 | 排序的原始下标序列 | 文本 */
export type QuestionResponse = number | number[] | string

// ── Battle Rules（规则引擎配置，可被关卡部分覆盖）────────────────────

export interface BossPhase {
  /** 敌人血量百分比 ≤ 该值时进入此阶段 */
  atEnemyHpPercent: number
  name: string
  /** 敌人造成伤害的倍率 */
  enemyDamageMultiplier: number
  message?: string
}

export interface BattleRuleConfig {
  playerHP: number
  enemyHP: number
  correct: { damage: number; xp: number }
  wrong: { playerDamage: number }
  combo?: {
    enabled: boolean
    threshold: number
    multiplier: number
  }
  hint?: {
    enabled: boolean
    /** 使用提示后，下一次正确答案的伤害倍率（<1 为惩罚） */
    damageMultiplier: number
  }
  skill?: {
    enabled: boolean
    name: string
    description: string
    chargePerCorrect: number
    requiredCharge: number
    multiplier: number
  }
  /** Boss 专属：多阶段 */
  phases?: BossPhase[]
}

// ── Level ────────────────────────────────────────────────────────────

export type EnemyForm = 'wisp' | 'golem' | 'phantom' | 'colossus'

export interface EnemySpec {
  name: string
  title?: string
  /** 视觉形态，映射到 entities/EnemyFactory */
  form: EnemyForm
  /** 视觉缩放，默认 1 */
  size?: number
  palette?: string
}

export interface LevelSpec {
  id: string
  name: string
  type: LevelType
  description?: string
  enemy: EnemySpec
  /** 部分规则，运行时与 DEFAULT_BATTLE_RULE 深合并 */
  rules: Partial<BattleRuleConfig>
  questions: Question[]
  rewards?: { xpBonus?: number }
}

// ── Student State（玩家进度，localStorage 持久化）────────────────────

export interface LevelStat {
  attempts: number
  clears: number
  bestAccuracy: number
  correct: number
  wrong: number
  hintsUsed: number
}

export interface StudentState {
  version: 1
  worldId: string
  xp: number
  completedLevels: string[]
  /** 玩家当前停留的节点 id */
  position: string | null
  levelStats: Record<string, LevelStat>
  settings: {
    difficulty: Difficulty
    muted: boolean
  }
  /** 开发菜单：解锁全部关卡 */
  devUnlockAll: boolean
}

// ── 战斗结算（Scene → Store）────────────────────────────────────────

export interface BattleResult {
  /** 关卡节点 id（MapNodeSpec.id，存档与进度推导使用） */
  nodeId: string
  /** LevelSpec id（内容键，与 nodeId 可不同） */
  levelId: string
  levelName: string
  enemyName: string
  victory: boolean
  /** 'hp' = 玩家血量耗尽；'exhausted' = 题目耗尽仍未能击败敌人 */
  defeatReason?: 'hp' | 'exhausted'
  xpGained: number
  accuracy: number
  maxCombo: number
  hintsUsed: number
  correct: number
  wrong: number
  total: number
  phaseReached?: string
}
