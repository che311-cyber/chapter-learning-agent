import type { StatusPayload } from '../types'
import { PHASES, PHASE_LABELS } from '../types'

export default function PhaseStepper({ status }: { status: StatusPayload }) {
  const currentIdx = PHASES.indexOf(status.phase as (typeof PHASES)[number])
  const failed = status.phase === 'FAILED'
  // 失败时把 ✕ 标在最后一个出现过的阶段上
  let failedIdx = -1
  if (failed) {
    for (const ev of status.events) {
      const i = PHASES.indexOf(ev.phase as (typeof PHASES)[number])
      if (i >= 0) failedIdx = i
    }
    if (failedIdx < 0) failedIdx = 1
  }

  return (
    <div className="stepper">
      {PHASES.map((ph, i) => {
        const cls =
          failed && i === failedIdx ? 'error'
          : status.phase === 'COMPLETE' || i < currentIdx ? 'done'
          : i === currentIdx ? 'active'
          : ''
        const icon = cls === 'done' ? '✓' : cls === 'error' ? '✕' : i + 1
        return (
          <div key={ph} className={`phase ${cls}`}>
            <div className="marker">{cls === 'active' ? '' : icon}</div>
            <div className="label">
              {PHASE_LABELS[ph]}
              {cls === 'active' && '…'}
              {ph === 'LOCATE' && status.located && cls !== '' && (
                <span className="meta" style={{ marginLeft: 8 }}>
                  {status.located.file} P{status.located.start_page}–P{status.located.end_page}
                </span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
