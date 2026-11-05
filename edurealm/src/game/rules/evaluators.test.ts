import { describe, expect, it } from 'vitest'
import { evaluateAnswer, normalizeText, parseNumeric } from './evaluators'
import type { OpenInputQuestion, OrderingQuestion, SingleChoiceQuestion } from '../../schemas/types'

const choice: SingleChoiceQuestion = {
  type: 'single_choice',
  id: 'c1',
  prompt: 'q',
  options: ['a', 'b', 'c'],
  answer: 1,
}

const order: OrderingQuestion = {
  type: 'ordering',
  id: 'o1',
  prompt: 'q',
  items: ['步骤一', '步骤二', '步骤三'],
}

const numeric: OpenInputQuestion = {
  type: 'open_input',
  id: 'n1',
  prompt: 'q',
  answers: ['0.5'],
  numeric: true,
}

const text: OpenInputQuestion = {
  type: 'open_input',
  id: 't1',
  prompt: 'q',
  answers: ['e^2'],
}

describe('single_choice', () => {
  it('正确选项通过', () => {
    expect(evaluateAnswer(choice, 1)).toBe(true)
  })
  it('错误选项不通过', () => {
    expect(evaluateAnswer(choice, 0)).toBe(false)
    expect(evaluateAnswer(choice, 2)).toBe(false)
  })
  it('非数字响应不通过', () => {
    expect(evaluateAnswer(choice, '1')).toBe(false)
    expect(evaluateAnswer(choice, [1])).toBe(false)
  })
})

describe('ordering', () => {
  it('恒等排列通过', () => {
    expect(evaluateAnswer(order, [0, 1, 2])).toBe(true)
  })
  it('错误排列不通过', () => {
    expect(evaluateAnswer(order, [2, 0, 1])).toBe(false)
  })
  it('长度不符不通过', () => {
    expect(evaluateAnswer(order, [0, 1])).toBe(false)
    expect(evaluateAnswer(order, [0, 1, 2, 3])).toBe(false)
  })
})

describe('open_input numeric', () => {
  it('数值相等（含分数与空格）', () => {
    expect(evaluateAnswer(numeric, '0.5')).toBe(true)
    expect(evaluateAnswer(numeric, ' 1/2 ')).toBe(true)
    expect(evaluateAnswer(numeric, '0.500000')).toBe(true)
  })
  it('数值不等', () => {
    expect(evaluateAnswer(numeric, '0.6')).toBe(false)
    expect(evaluateAnswer(numeric, '2')).toBe(false)
  })
  it('文本回退：数值解析失败时做归一化文本比较', () => {
    expect(evaluateAnswer(text, 'e^2')).toBe(true)
    expect(evaluateAnswer(text, ' E² ')).toBe(true)
    expect(evaluateAnswer(text, 'e2')).toBe(true)
    expect(evaluateAnswer(text, 'e3')).toBe(false)
  })
})

describe('normalizeText / parseNumeric', () => {
  it('归一化去空白标点', () => {
    expect(normalizeText('  E ^2 ')).toBe('e2')
    expect(normalizeText('，极限！')).toBe('极限')
  })
  it('解析分数与小数', () => {
    expect(parseNumeric('1/2')).toBe(0.5)
    expect(parseNumeric('-3.14')).toBe(-3.14)
    expect(parseNumeric('abc')).toBeNull()
    expect(parseNumeric('1/0')).toBeNull()
  })
})
