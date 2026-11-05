import { useEffect } from 'react'
import { useActions, useUi } from '../state/gameStore'

export function Toast(): React.ReactElement | null {
  const toast = useUi().toast
  const actions = useActions()

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => actions.clearToast(toast.id), 2400)
    return () => window.clearTimeout(t)
  }, [toast, actions])

  if (!toast) return null
  return (
    <div className="toast" key={toast.id}>
      {toast.text}
    </div>
  )
}
