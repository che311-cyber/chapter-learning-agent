/**
 * 程序化音效（WebAudio 合成，零素材、零版权风险）。
 * 首次用户手势时初始化 AudioContext（浏览器自动播放策略）。
 */
import { useGameStore } from '../../state/gameStore'

export type SfxName =
  | 'hover'
  | 'click'
  | 'correct'
  | 'wrong'
  | 'hit'
  | 'slash'
  | 'unlock'
  | 'victory'
  | 'defeat'
  | 'boss'
  | 'phase'
  | 'step'
  | 'skill'
  | 'hint'

class Sfx {
  private ctx: AudioContext | null = null

  private ensureCtx(): AudioContext | null {
    if (useGameStore.getState().save.settings.muted) return null
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext()
      } catch {
        return null
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  /** 解锁音频上下文（任意首次点击时调用） */
  unlock(): void {
    this.ensureCtx()
  }

  private tone(
    freq: number,
    dur: number,
    opts: { type?: OscillatorType; gain?: number; delay?: number; slideTo?: number } = {},
  ): void {
    const ctx = this.ctx
    if (!ctx) return
    const t0 = ctx.currentTime + (opts.delay ?? 0)
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = opts.type ?? 'sine'
    osc.frequency.setValueAtTime(freq, t0)
    if (opts.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.slideTo), t0 + dur)
    const peak = opts.gain ?? 0.06
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    osc.connect(g).connect(ctx.destination)
    osc.start(t0)
    osc.stop(t0 + dur + 0.05)
  }

  play(name: SfxName): void {
    if (!this.ensureCtx()) return
    switch (name) {
      case 'hover':
        this.tone(880, 0.05, { gain: 0.015 })
        break
      case 'click':
        this.tone(520, 0.07, { type: 'triangle', gain: 0.03 })
        break
      case 'correct':
        this.tone(523, 0.1, { type: 'triangle' })
        this.tone(659, 0.12, { type: 'triangle', delay: 0.07 })
        this.tone(784, 0.16, { type: 'triangle', delay: 0.14 })
        break
      case 'wrong':
        this.tone(196, 0.22, { type: 'sawtooth', gain: 0.045, slideTo: 130 })
        break
      case 'hit':
        this.tone(140, 0.12, { type: 'square', gain: 0.05, slideTo: 70 })
        break
      case 'slash':
        this.tone(1200, 0.08, { type: 'sawtooth', gain: 0.02, slideTo: 300 })
        break
      case 'unlock':
        this.tone(660, 0.14)
        this.tone(880, 0.14, { delay: 0.09 })
        this.tone(1320, 0.22, { delay: 0.18, gain: 0.05 })
        break
      case 'victory':
        ;[523, 659, 784, 1047].forEach((f, i) =>
          this.tone(f, 0.22, { type: 'triangle', delay: i * 0.11, gain: 0.06 }),
        )
        break
      case 'defeat':
        ;[392, 330, 262, 196].forEach((f, i) =>
          this.tone(f, 0.3, { type: 'triangle', delay: i * 0.16, gain: 0.05 }),
        )
        break
      case 'boss':
        this.tone(65, 0.9, { type: 'sawtooth', gain: 0.08, slideTo: 55 })
        this.tone(98, 0.9, { type: 'square', gain: 0.03, delay: 0.1, slideTo: 82 })
        break
      case 'phase':
        this.tone(220, 0.35, { type: 'sawtooth', gain: 0.05, slideTo: 440 })
        break
      case 'step':
        this.tone(300, 0.04, { type: 'triangle', gain: 0.012 })
        break
      case 'skill':
        this.tone(440, 0.2, { type: 'triangle', slideTo: 880, gain: 0.05 })
        break
      case 'hint':
        this.tone(700, 0.12, { type: 'sine', gain: 0.03 })
        break
    }
  }
}

export const sfx = new Sfx()
