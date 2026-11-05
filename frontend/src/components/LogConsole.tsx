import { useEffect, useRef } from 'react'
import type { AgentEvent } from '../types'

export default function LogConsole({ events }: { events: AgentEvent[] }) {
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [events.length])

  return (
    <div className="logconsole" ref={boxRef}>
      {events.length === 0 && <span className="log-empty">等待 Agent 开始工作…</span>}
      {events.map((ev) => (
        <div key={ev.seq} className={`log-line ${ev.level}`}>
          <span className="log-time">{new Date(ev.ts * 1000).toLocaleTimeString('zh-CN', { hour12: false })}</span>
          <span className="log-msg">{ev.message}</span>
        </div>
      ))}
    </div>
  )
}
