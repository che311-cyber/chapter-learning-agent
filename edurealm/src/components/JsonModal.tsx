import { useState } from 'react'
import { useActions, useSave, useUi } from '../state/gameStore'
import { useWorldBundle } from '../hooks/useWorldBundle'

export function JsonModal(): React.ReactElement | null {
  const view = useUi().jsonView
  const selectedNodeId = useUi().selectedNodeId
  const save = useSave()
  const actions = useActions()
  const world = useWorldBundle()
  const [copied, setCopied] = useState(false)

  if (!view || !world) return null

  let title = ''
  let body = ''
  if (view === 'map') {
    title = 'MapSpec（世界配置）'
    body = JSON.stringify(world.map, null, 2)
  } else if (view === 'level') {
    const ref = selectedNodeId ? world.map.nodes.find((n) => n.id === selectedNodeId)?.levelRef : undefined
    const level = ref ? world.levels[ref] : Object.values(world.levels)[0]
    title = `LevelSpec（关卡配置）${level ? ` · ${level.id}` : ''}`
    body = level ? JSON.stringify(level, null, 2) : '// 无关卡'
  } else {
    title = 'StudentState（当前存档）'
    body = JSON.stringify(save, null, 2)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={actions.openJson.bind(null, null)}>
      <div className="panel json-modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <b>{title}</b>
          <div>
            <button className="btn btn-ghost btn-sm" onClick={copy}>
              {copied ? '已复制' : '复制'}
            </button>
            <button className="icon-btn" onClick={() => actions.openJson(null)} aria-label="关闭">
              ✕
            </button>
          </div>
        </div>
        <pre className="json-body">{body}</pre>
      </div>
    </div>
  )
}
