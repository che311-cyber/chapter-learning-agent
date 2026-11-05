/**
 * 作答判定注册器 —— 每种题目类型一个 evaluator。
 * 新增题型（matching / dialogue / …）只需扩展 Question 联合 + 在此加 case。
 * 纯函数、无 Phaser、可单测。
 */
import type { Question, QuestionResponse } from '../../schemas/types'

/** 归一化文本：小写、去空白与标点，仅保留字母数字与 CJK */
export function normalizeText(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[²³]/g, (m) => (m === '²' ? '2' : '3'))
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
}

/** 解析数值答案：支持 "0.5" / "1/2" / "-3.14"，不合法返回 null */
export function parseNumeric(input: string): number | null {
  const s = input.trim()
  const frac = s.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/)
  if (frac) {
    const b = parseFloat(frac[2])
    if (b === 0) return null
    return parseFloat(frac[1]) / b
  }
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return parseFloat(s)
  return null
}

export function evaluateAnswer(q: Question, response: QuestionResponse): boolean {
  switch (q.type) {
    case 'single_choice':
      return typeof response === 'number' && response === q.answer

    case 'ordering': {
      if (!Array.isArray(response) || response.length !== q.items.length) return false
      // response 为「原始下标的排列」，正确即恒等排列
      return q.items.every((_, i) => response[i] === i)
    }

    case 'open_input': {
      if (typeof response !== 'string') return false
      if (q.numeric) {
        const rv = parseNumeric(response)
        if (rv !== null) {
          const tol = q.tolerance ?? 1e-6
          for (const a of q.answers) {
            const av = parseNumeric(a)
            if (av !== null && Math.abs(av - rv) <= tol) return true
          }
        }
      }
      const rn = normalizeText(response)
      return q.answers.some((a) => normalizeText(a) === rn)
    }
  }
}

/** 展示用洗牌（ordering 题打乱 chips），返回原始下标的随机排列 */
export function shuffledIndices(n: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
