/**
 * 全局状态（zustand）：
 *  - save: StudentState —— 持久化到 localStorage（唯一的数据事实源）
 *  - ui:   界面状态 —— 不持久化
 *  数据逻辑与 UI/Scene 分离；Phaser 通过 getState() 读取。
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  BattleResult,
  Difficulty,
  LevelStat,
  StudentState,
} from '../schemas/types'
import { DEFAULT_WORLD_ID } from '../data/registry'

export type Screen = 'landing' | 'map' | 'intro' | 'travel' | 'battle' | 'result'
export type JsonView = 'map' | 'level' | 'state' | null

export interface UiState {
  screen: Screen
  selectedNodeId: string | null
  result: BattleResult | null
  devMenuOpen: boolean
  jsonView: JsonView
  godMode: boolean
  toast: { id: number; text: string } | null
}

const emptyStat = (): LevelStat => ({
  attempts: 0,
  clears: 0,
  bestAccuracy: 0,
  correct: 0,
  wrong: 0,
  hintsUsed: 0,
})

const freshSave = (): StudentState => ({
  version: 1,
  worldId: DEFAULT_WORLD_ID,
  xp: 0,
  completedLevels: [],
  position: null,
  levelStats: {},
  settings: { difficulty: 'normal', muted: false },
  devUnlockAll: false,
})

interface GameActions {
  beginGame: () => void
  selectNode: (nodeId: string) => void
  cancelIntro: () => void
  startTravel: () => void
  arriveAtBattle: () => void
  battleOver: (result: BattleResult) => void
  closeResult: () => void
  leaveToMap: () => void
  devUnlockAll: () => void
  devResetSave: () => void
  devAddXp: (delta: number) => void
  setDifficulty: (d: Difficulty) => void
  toggleMute: () => void
  toggleDevMenu: (open?: boolean) => void
  setGodMode: (on: boolean) => void
  openJson: (view: JsonView) => void
  showToast: (text: string) => void
  clearToast: (id: number) => void
}

interface GameStore {
  save: StudentState
  ui: UiState
  actions: GameActions
}

const initialUi: UiState = {
  screen: 'landing',
  selectedNodeId: null,
  result: null,
  devMenuOpen: false,
  jsonView: null,
  godMode: false,
  toast: null,
}

export const useGameStore = create<GameStore>()(
  persist(
    (set, get) => {
      const patchUi = (p: Partial<UiState>) => set((s) => ({ ui: { ...s.ui, ...p } }))
      const patchSave = (p: Partial<StudentState>) => set((s) => ({ save: { ...s.save, ...p } }))

      const actions: GameActions = {
        beginGame: () => patchUi({ screen: 'map' }),

        selectNode: (nodeId) => patchUi({ selectedNodeId: nodeId, screen: 'intro' }),
        cancelIntro: () => patchUi({ screen: 'map', selectedNodeId: null }),
        startTravel: () => patchUi({ screen: 'travel' }),
        arriveAtBattle: () => patchUi({ screen: 'battle' }),

        battleOver: (result) => {
          const { save } = get()
          // nodeId 是地图节点 id（completedLevels/position 与进度推导同键）
          const nodeKey = result.nodeId
          const next: StudentState = {
            ...save,
            xp: save.xp + result.xpGained,
            completedLevels:
              result.victory && !save.completedLevels.includes(nodeKey)
                ? [...save.completedLevels, nodeKey]
                : save.completedLevels,
            position: result.victory ? nodeKey : save.position,
            levelStats: (() => {
              const prev = save.levelStats[nodeKey] ?? emptyStat()
              const acc = result.total > 0 ? result.correct / result.total : 0
              return {
                ...save.levelStats,
                [nodeKey]: {
                  attempts: prev.attempts + 1,
                  clears: prev.clears + (result.victory ? 1 : 0),
                  bestAccuracy: Math.max(prev.bestAccuracy, acc),
                  correct: prev.correct + result.correct,
                  wrong: prev.wrong + result.wrong,
                  hintsUsed: prev.hintsUsed + result.hintsUsed,
                },
              }
            })(),
          }
          set({ save: next, ui: { ...get().ui, screen: 'result', result, selectedNodeId: null } })
        },

        closeResult: () => patchUi({ screen: 'battle', result: null }),
        leaveToMap: () => patchUi({ screen: 'map', result: null }),

        devUnlockAll: () => {
          patchSave({ devUnlockAll: true })
          actions.showToast('DEV · 已解锁全部关卡')
        },
        devResetSave: () => {
          const { settings } = get().save
          set({ save: { ...freshSave(), settings } })
          actions.showToast('存档已重置')
        },
        devAddXp: (delta) => {
          const { save } = get()
          patchSave({ xp: Math.max(0, save.xp + delta) })
        },
        setDifficulty: (d) => {
          const { save } = get()
          patchSave({ settings: { ...save.settings, difficulty: d } })
          actions.showToast(`难度已切换：${d.toUpperCase()}（下一场战斗生效）`)
        },
        toggleMute: () => {
          const { save } = get()
          patchSave({ settings: { ...save.settings, muted: !save.settings.muted } })
        },
        toggleDevMenu: (open) =>
          patchUi({ devMenuOpen: open ?? !get().ui.devMenuOpen }),
        setGodMode: (on) => patchUi({ godMode: on }),
        openJson: (view) => patchUi({ jsonView: view }),
        showToast: (text) => patchUi({ toast: { id: Date.now(), text } }),
        clearToast: (id) => {
          if (get().ui.toast?.id === id) patchUi({ toast: null })
        },
      }

      return { save: freshSave(), ui: initialUi, actions }
    },
    {
      name: 'edurealm-save-v1',
      version: 1,
      partialize: (s) => ({ save: s.save }),
    },
  ),
)

// 便捷选择器
export const useSave = () => useGameStore((s) => s.save)
export const useUi = () => useGameStore((s) => s.ui)
export const useActions = () => useGameStore((s) => s.actions)

// QA / 自动化测试钩子（无副作用，仅暴露只读状态与动作）
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__edurealm = {
    store: useGameStore,
    save: () => useGameStore.getState().save,
    ui: () => useGameStore.getState().ui,
  }
}
