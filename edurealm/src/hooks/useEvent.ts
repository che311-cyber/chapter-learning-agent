import { useEffect, useRef } from 'react'
import { EventBus } from '../game/EventBus'

/** 订阅 EventBus，自动随组件卸载取消（无重复监听泄漏） */
export function useEvent<T = unknown>(name: string, handler: (payload: T) => void): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    const fn = (p: unknown) => ref.current(p as T)
    EventBus.on(name, fn)
    return () => {
      EventBus.off(name, fn)
    }
  }, [name])
}
