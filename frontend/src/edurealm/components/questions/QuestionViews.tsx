import { useEffect, useMemo, useState } from 'react'
import type { OpenInputQuestion, OrderingQuestion, QuestionResponse, SingleChoiceQuestion } from '../../schemas/types'
import { shuffledIndices } from '../../game/rules/evaluators'

const CHOICE_KEYS = ['A', 'B', 'C', 'D', 'E', 'F']

export function SingleChoiceView({
  q,
  locked,
  onSubmit,
}: {
  q: SingleChoiceQuestion
  locked: boolean
  onSubmit: (r: QuestionResponse) => void
}): React.ReactElement {
  return (
    <div className="choice-list" role="listbox">
      {q.options.map((opt, i) => (
        <button
          key={i}
          className="choice-item"
          disabled={locked}
          onClick={() => onSubmit(i)}
        >
          <span className="choice-key">{CHOICE_KEYS[i] ?? i + 1}</span>
          <span className="choice-text">{opt}</span>
        </button>
      ))}
    </div>
  )
}

export function OrderingView({
  q,
  locked,
  onSubmit,
}: {
  q: OrderingQuestion
  locked: boolean
  onSubmit: (r: QuestionResponse) => void
}): React.ReactElement {
  // 依赖整个题目对象：每道新题重新洗牌一次
  const displayOrder = useMemo(() => shuffledIndices(q.items.length), [q])
  const [picked, setPicked] = useState<number[]>([])
  useEffect(() => setPicked([]), [q.id])

  const remaining = displayOrder.filter((i) => !picked.includes(i))
  const complete = picked.length === q.items.length

  return (
    <div className="ordering">
      <div className="order-slots">
        {picked.length === 0 && <span className="order-hint">依序点击下方步骤，构建正确顺序 →</span>}
        {picked.map((idx, pos) => (
          <button
            key={`${q.id}-${pos}-${idx}`}
            className="order-chip placed"
            disabled={locked}
            onClick={() => setPicked((p) => p.filter((_, k) => k !== pos))}
            title="点击移回"
          >
            <i>{pos + 1}</i>
            {q.items[idx]}
          </button>
        ))}
      </div>
      <div className="order-pool">
        {remaining.map((idx) => (
          <button
            key={`${q.id}-pool-${idx}`}
            className="order-chip"
            disabled={locked}
            onClick={() => setPicked((p) => [...p, idx])}
          >
            {q.items[idx]}
          </button>
        ))}
      </div>
      <button className="btn btn-primary" disabled={locked || !complete} onClick={() => onSubmit(picked)}>
        确认顺序
      </button>
    </div>
  )
}

export function OpenInputView({
  q,
  locked,
  onSubmit,
}: {
  q: OpenInputQuestion
  locked: boolean
  onSubmit: (r: QuestionResponse) => void
}): React.ReactElement {
  const [value, setValue] = useState('')
  useEffect(() => setValue(''), [q.id])
  const canSubmit = value.trim().length > 0

  return (
    <div className="open-input">
      <input
        type="text"
        value={value}
        disabled={locked}
        placeholder={q.numeric ? '输入数值（支持 1/2 形式）…' : '输入你的答案…'}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
      />
      <button className="btn btn-primary" disabled={locked || !canSubmit} onClick={() => onSubmit(value)}>
        提交
      </button>
    </div>
  )
}
