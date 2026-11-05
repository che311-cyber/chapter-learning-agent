// GameContainer —— 游戏模式的集成外壳。
// 职责：
//   1. 把 Chapter Agent 当前章节产物注册为 EduRealm 动态世界（不调用 DeepSeek）
//   2. 玩家存档按章节隔离（game_state__<project>__<slug>），进出游戏不丢进度
//   3. 玩家等级（LV / XP 进度）与 LEVEL UP 动画（XP 是游戏奖励，与掌握度分离）
//   4. Phaser 生命周期：挂载创建、卸载 destroy，杜绝双 Canvas / 重复监听
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ResultPayload } from '../types'
import { buildChapterWorld } from './adapters/chapterToGame'
import { levelInfo } from './xpRules'
import EdurealmApp from '../edurealm/components/EdurealmApp'
import { registerWorldBundle, clearDynamicWorld } from '../edurealm/services/contentService'
import { refreshWorld } from '../edurealm/hooks/useWorldBundle'
import { useGameStore } from '../edurealm/state/gameStore'
import '../edurealm/edurealm.css'

const saveKeyOf = (project: string, slug: string) => `game_state__${project}__${slug}`

interface Props {
  project: string
  result: ResultPayload
  onExit: () => void
}

export default function GameContainer({ project, result, onExit }: Props) {
  const slug = result.run_id
  const saveKey = saveKeyOf(project, slug)

  const bundle = useMemo(
    () => buildChapterWorld(project, result),
    [project, result],
  )

  const [booting, setBooting] = useState(true)
  const [save, setSave] = useState(useGameStore.getState().save)
  const prevLevelRef = useRef<number | null>(null)
  const [levelUpTo, setLevelUpTo] = useState<number | null>(null)

  // ---- 进入游戏：注册世界 + 按章节水合存档 + 直达地图 ----
  useEffect(() => {
    const store = useGameStore
    const persisted = (() => {
      try {
        const raw = localStorage.getItem('edurealm-save-v1')
        return raw ? (JSON.parse(raw)?.state?.save ?? null) : null
      } catch {
        return null
      }
    })()

    let chapterSave = null
    try {
      const raw = localStorage.getItem(saveKey)
      chapterSave = raw ? JSON.parse(raw) : null
    } catch {
      chapterSave = null
    }

    const hydrated = {
      ...(persisted ?? store.getState().save),
      ...(chapterSave ?? {}),
      worldId: bundle.worldId,
    }
    // 避免把上一个世界的完成记录带进本章
    if (!chapterSave) {
      hydrated.completedLevels = []
      hydrated.position = null
      hydrated.levelStats = {}
      hydrated.xp = 0
    }
    store.setState({ save: hydrated, ui: { ...store.getState().ui, screen: 'map', result: null } })

    // 订阅存档变化 → 写回本章存档槽
    let last = ''
    const unsub = store.subscribe((s) => {
      const json = JSON.stringify(s.save)
      if (json === last) return
      last = json
      try {
        localStorage.setItem(saveKey, json)
      } catch {
        /* ignore */
      }
    })

    registerWorldBundle({ map: bundle.map, levels: bundle.levels })
    void refreshWorld().then(() => {
      // 引擎场景就绪需要一点时间；短暂过渡后淡入（1 秒左右的整体体验）
      setTimeout(() => setBooting(false), 500)
    })

    return () => {
      unsub()
      // 离开时把共享存档槽恢复为进入前的内容（保护 mock 世界的存档）
      if (persisted) {
        store.setState({ save: persisted })
      }
      try {
        localStorage.setItem(saveKey, JSON.stringify(store.getState().save === hydrated
          ? hydrated
          : JSON.parse(localStorage.getItem(saveKey) ?? 'null') ?? store.getState().save))
      } catch {
        /* ignore */
      }
      clearDynamicWorld()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, slug])

  // ---- 等级跟踪（LEVEL UP 检测）----
  useEffect(() => {
    const unsub = useGameStore.subscribe((s) => setSave(s.save))
    setSave(useGameStore.getState().save)
    return unsub
  }, [])

  const li = levelInfo(save.xp)
  useEffect(() => {
    if (prevLevelRef.current === null) {
      prevLevelRef.current = li.level
      return
    }
    if (li.level > prevLevelRef.current) {
      setLevelUpTo(li.level)
      const t = setTimeout(() => {
        setLevelUpTo(null)
        prevLevelRef.current = li.level
      }, 2200)
      return () => clearTimeout(t)
    }
    prevLevelRef.current = li.level
  }, [li.level])

  return (
    <div className="game-root" data-testid="game-root">
      {booting && (
        <div className="game-loading">
          <div className="game-loading-inner">
            <div className="game-loading-rune" />
            <div>正在进入学习世界……</div>
            <div className="dim">{result.target} · {bundle.map.nodes.length} 个关卡已就绪</div>
          </div>
        </div>
      )}
      {/* 引擎组件：Phaser Canvas + React Overlay（地图/HUD/战斗/结算） */}
      {!booting && <EdurealmApp skipLanding />}

      {/* 玩家等级芯片（LV / XP —— 游戏奖励进度，与掌握度分离） */}
      <div className="game-level-chip" title="经验值与等级（游戏奖励）">
        <b>LV.{li.level}</b>
        <div className="game-level-bar">
          <div style={{ width: `${Math.round(li.progress * 100)}%` }} />
        </div>
        <span>{li.into}/{li.need} XP</span>
      </div>

      {/* 返回学习（保存由上面的订阅自动完成） */}
      <button className="game-back-btn" onClick={onExit} title="保存并返回网页学习模式">
        📖 网页模式
      </button>

      {levelUpTo !== null && (
        <div className="levelup-overlay">
          <div className="levelup-card">
            <div className="levelup-glyph">✦</div>
            <div className="levelup-title">LEVEL UP</div>
            <div className="levelup-sub">LV.{levelUpTo - 1} → LV.{levelUpTo}</div>
            <div className="levelup-note">学者之力提升了！</div>
          </div>
        </div>
      )}
    </div>
  )
}
