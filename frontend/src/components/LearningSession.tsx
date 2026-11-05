// 引导式学习会话：按学习方案的阶段顺序，一句一句揭示内容、逐题练习、即时反馈。
// 对应 7 条心理学原则：
//   CLEAR GOAL        每阶段开场先展示本阶段目标
//   SMALL WINS        阶段完成时刻 + 进度条实时推进
//   IMMEDIATE FEEDBACK 选择题点击即判分，简答/证明自评后立即给解析
//   MEANINGFUL AGENCY 阶段开场可选「先学内容」或「跳过内容直接练习」
//   CHALLENGE–SKILL   阶段内题目按难度 1→2→3 排列
//   REAL PROGRESS     只统计真实作答结果；结束页列出未掌握题与掌握标准自查
import { useEffect, useMemo, useState } from 'react'
import type { LearningPlan, Question, QuestionPool } from '../types'
import {
  buildDeck, clearSession, loadSession, saveSession,
} from '../services/learning'
import { buildFullReport, downloadText, type BuiltReport } from '../services/learningReport'
import { api, isStaticMode } from '../services/api'

interface Props {
  project: string
  slug: string
  plan: LearningPlan
  pool: QuestionPool | null
  onExit: () => void
  teacherNote?: string
  tasks?: string[]
}

type Step =
  | { kind: 'stage-intro'; si: number }
  | { kind: 'diagnostic'; si: number }
  | { kind: 'content'; si: number; ci: number }
  | { kind: 'practice'; si: number }
  | { kind: 'question'; si: number; q: Question }
  | { kind: 'remediation'; si: number; q: Question }
  | { kind: 'stage-done'; si: number }
  | { kind: 'leftovers' }

const DIFF: Record<number, string> = { 1: '基础', 2: '中等', 3: '挑战' }
const TYPE_ZH: Record<string, string> = {
  single_choice: '单选', multiple_choice: '多选', short_answer: '简答',
  calculation: '计算', proof: '证明', ordering: '排序', comparison: '对比',
}

function buildSteps(deck: ReturnType<typeof buildDeck>): Step[] {
  const steps: Step[] = []
  deck.stages.forEach((ms, si) => {
    steps.push({ kind: 'stage-intro', si })
    if (ms.questions.length > 0) steps.push({ kind: 'diagnostic', si })
    ms.stage.content.forEach((_, ci) => steps.push({ kind: 'content', si, ci }))
    if (ms.stage.practice && ms.stage.practice.length > 0) steps.push({ kind: 'practice', si })
    ms.questions.forEach((q) => steps.push({ kind: 'question', si, q }))
    steps.push({ kind: 'stage-done', si })
  })
  if (deck.consolidation.length > 0) steps.push({ kind: 'leftovers' })
  return steps
}

const normAns = (s: string) => (s || '').toUpperCase().replace(/[^A-Z]/g, '').split('').sort().join('')

export default function LearningSession({ project, slug, plan, pool, onExit, teacherNote, tasks }: Props) {
  const deck = useMemo(() => buildDeck(plan, pool), [plan, pool])
  const steps = useMemo(() => buildSteps(deck), [deck])
  const saved = useMemo(() => {
    const value = loadSession(project, slug)
    return value && value.idx <= steps.length ? value : null
  }, [project, slug, steps.length])

  const [idx, setIdx] = useState(saved?.idx ?? 0)
  const [results, setResults] = useState<Record<string, 'correct' | 'wrong'>>(saved?.results ?? {})
  const [selfReports, setSelfReports] = useState<Record<string, boolean>>(saved?.selfReports ?? {})
  const [picked, setPicked] = useState<Record<string, string>>(saved?.picked ?? {})
  const [mastery, setMastery] = useState<Record<string, boolean>>(saved?.mastery ?? {})
  const [restored, setRestored] = useState(!!saved && (saved.idx ?? 0) > 0)
  const [submitState, setSubmitState] = useState<'idle' | 'sending' | 'ok' | 'local'>('idle')
  const [remediationStep, setRemediationStep] = useState<{ si: number; qid: string } | null>(null)

  useEffect(() => {
    saveSession(project, slug, { idx, results, picked, mastery, selfReports, totalSteps: steps.length })
  }, [project, slug, idx, results, picked, mastery, selfReports, steps.length])

  const step: Step | null = idx < steps.length ? steps[idx] : null
  const finished = idx >= steps.length
  const report = useMemo(
    () => buildFullReport({ project, target: plan.chapter, plan, pool }, slug,
      { idx, results, picked, mastery, selfReports, totalSteps: steps.length }),
    [project, slug, plan, pool, idx, results, picked, mastery, selfReports, steps.length],
  )

  // 完成后自动把学情提交给教师（静态部署无后端时跳过，仍可手动导出）
  useEffect(() => {
    if (!finished || isStaticMode()) return
    if (submitState !== 'idle') return
    setSubmitState('sending')
    api.submitLearningReport(project, slug, report.data)
      .then(() => setSubmitState('ok'))
      .catch(() => setSubmitState('local'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished])
  const progress = Math.min(100, Math.round((idx / Math.max(1, steps.length)) * 100))

  const go = (i: number) => { setRestored(false); setIdx(Math.max(0, Math.min(i, steps.length))) }
  const next = () => go(idx + 1)

  function restart() {
    clearSession(project, slug)
    setIdx(0); setResults({}); setPicked({}); setMastery({}); setSelfReports({}); setRestored(false)
    setSubmitState('idle')
  }

  // 客观判分（选择题/输入题自动判分）→ 计入正确率
  function record(q: Question, ok: boolean, pick?: string) {
    setResults((r) => ({ ...r, [q.id]: ok ? 'correct' : 'wrong' }))
    if (pick !== undefined) setPicked((p) => ({ ...p, [q.id]: pick }))
  }
  // 学生自评（"我答对了/没答上"）→ 单独存储，不计入客观正确率
  function recordSelfReport(q: Question, ok: boolean) {
    setSelfReports((r) => ({ ...r, [q.id]: ok }))
  }

  function skipToQuestions(si: number) {
    const i = steps.findIndex((s) => s.kind === 'question' && s.si === si)
    go(i === -1 ? steps.findIndex((s) => s.kind === 'stage-done' && s.si === si) + 1 : i)
  }

  const answered = Object.keys(results).length
  const correct = Object.values(results).filter((r) => r === 'correct').length
  const wrongQs = (pool?.questions || []).filter((q) => results[q.id] === 'wrong')

  // 阶段旅程导航：当前所在阶段
  const curSi = step ? (step as { si: number }).si : deck.stages.length

  // 键盘快捷键：Enter/→ 继续；A–D（或 1–4）单选作答；Esc 退出
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toLowerCase()
      if (e.key === 'Escape') { onExit(); return }
      if (tag === 'input' || tag === 'textarea') return
      if (e.key === 'Enter' && (tag === 'button' || tag === 'a')) return
      if (e.key === 'Enter' || e.key === 'ArrowRight') {
        e.preventDefault()
        if (!step) return
        if (step.kind === 'question' && !results[step.q.id] && selfReports[step.q.id] === undefined) return
        next()
        return
      }
      if (step?.kind === 'question' && !results[step.q.id] && step.q.type === 'single_choice') {
        const m = /^([a-dA-D1-4])$/.exec(e.key)
        if (!m) return
        const letter = /[1-4]/.test(m[1])
          ? String.fromCharCode(65 + parseInt(m[1], 10) - 1)
          : m[1].toUpperCase()
        const optIdx = letter.charCodeAt(0) - 65
        if (optIdx < 0 || optIdx >= (step.q.options?.length || 0)) return
        const ok = letter === normAns(step.q.answer) ||
          step.q.answer.trim().toUpperCase().startsWith(letter)
        record(step.q, ok, letter)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, results, selfReports])

  return (
    <div className="learn">
      <div className="learn-head">
        <div className="learn-title">🎯 {plan.chapter}</div>
        <div className="learn-dots" title="学习旅程">
          {deck.stages.map((ms, i) => (
            <span key={i}
              className={`sdot ${i < curSi ? 'done' : i === curSi ? 'active' : ''}`}
              title={`阶段 ${ms.stage.stage} · ${ms.stage.name}`} />
          ))}
        </div>
        <div className="learn-progress">
          <div className="learn-bar"><div style={{ width: `${progress}%` }} /></div>
          <span className="learn-pct">{progress}%</span>
        </div>
        <button className="btn small" onClick={onExit}>退出学习 (Esc)</button>
      </div>

      {step && step.kind !== 'stage-intro' && (
        <div className="learn-subhead">
          阶段 {deck.stages[curSi]?.stage.stage} · {deck.stages[curSi]?.stage.name}
        </div>
      )}

      {restored && !finished && (
        <div className="info-banner learn-restore">
          已恢复上次学习进度（{progress}%）。
          <a href="#r" onClick={(e) => { e.preventDefault(); restart() }}>从头开始</a>
        </div>
      )}

      <div className="learn-body">
        <div className="learn-step-wrap">
          {remediationStep && (
            <RemediationCard deck={deck} si={remediationStep.si}
              wrongQ={deck.stages[remediationStep.si].questions.find((x) => x.id === remediationStep.qid) || deck.stages[remediationStep.si].questions[0]}
              onNext={() => { setRemediationStep(null); go(idx + 1) }} />
          )}
          {!remediationStep && (
          <>
          {step === null && (
            <FinalReport
              plan={plan} deck={deck} answered={answered} correct={correct}
              wrongQs={wrongQs} results={results}
              mastery={mastery} setMastery={setMastery}
              onRestart={restart} onExit={onExit}
              report={report} teacherNote={teacherNote} tasks={tasks}
              submitState={submitState} selfReports={selfReports}
            />
          )}
          {step?.kind === 'stage-intro' && (
            <StageIntro deck={deck} si={step.si} onStart={next} onSkip={() => skipToQuestions(step.si)} />
          )}
          {step?.kind === 'diagnostic' && (
          <DiagnosticCard deck={deck} si={step.si} results={results} onNext={next} />
        )}
        {step?.kind === 'remediation' && (
          <RemediationCard deck={deck} si={step.si}
            wrongQ={(deck.stages[step.si].questions.find((x) => results[x.id] === 'wrong')) || step.q}
            onNext={next} />
        )}
        {step?.kind === 'content' && (
            <ContentStep deck={deck} si={step.si} ci={step.ci} total={deck.stages[step.si].stage.content.length} onNext={next} />
          )}
          {step?.kind === 'practice' && (
            <PracticeStep deck={deck} si={step.si} hasNextQ={(deck.stages[step.si].questions.length > 0)} onNext={next} />
          )}
          {step?.kind === 'question' && (
            <QuestionCard
              key={step.q.id}
              q={step.q} indexInStage={deck.stages[step.si].questions.indexOf(step.q) + 1}
              totalInStage={deck.stages[step.si].questions.length}
              picked={picked[step.q.id]} result={results[step.q.id]} selfAssessment={selfReports[step.q.id]}
              onPick={(letter, ok) => record(step.q, ok, letter)}
              onSelfAssess={(ok) => recordSelfReport(step.q, ok)}
              onNext={next}
            />
          )}
          {step?.kind === 'stage-done' && (
            <StageDone
              deck={deck} si={step.si} results={results} selfReports={selfReports}
              isLast={step.si === deck.stages.length - 1 && deck.consolidation.length === 0}
              onNext={next}
              onReviewWrong={() => {
                const question = deck.stages[step.si].questions.find(q => results[q.id] === 'wrong')
                if (question) setRemediationStep({ si: step.si, qid: question.id })
              }}
            />
          )}
          {step?.kind === 'leftovers' && (
            <div className="card">
              <h4>🧩 综合巩固（跨阶段题目，共 {deck.consolidation.length} 题）</h4>
              <div className="dim" style={{ marginBottom: 8 }}>
                这些题考查跨阶段目标或未归入单一阶段的内容，作答结果计入最终报告。
              </div>
              {deck.consolidation.map((q) => (
                <QuestionCard key={q.id}
                  q={q} indexInStage={deck.consolidation.indexOf(q) + 1}
                  totalInStage={deck.consolidation.length}
                  picked={picked[q.id]} result={results[q.id]} selfAssessment={selfReports[q.id]}
                  onPick={(letter, ok) => record(q, ok, letter)}
                  onSelfAssess={(ok) => recordSelfReport(q, ok)}
                  onNext={() => { if (deck.consolidation.indexOf(q) === deck.consolidation.length - 1) go(steps.length); else next() }}
                />
              ))}
            </div>
          )}
          </>
          )}
        </div>
      </div>

      <div className="learn-hintbar">
        <kbd>Enter</kbd> 继续 · <kbd>A</kbd>–<kbd>D</kbd> 选择 · <kbd>Esc</kbd> 退出学习
      </div>
    </div>
  )
}

/* ---------------- 阶段开场（CLEAR GOAL + AGENCY） ---------------- */
function StageIntro({ deck, si, onStart, onSkip }: {
  deck: ReturnType<typeof buildDeck>; si: number; onStart: () => void; onSkip: () => void
}) {
  const ms = deck.stages[si]
  const nq = ms.questions.length
  return (
    <div className="card learn-center">
      <div className="learn-stage-tag">阶段 {ms.stage.stage} / {deck.stages.length}</div>
      <h3 style={{ margin: '8px 0' }}>{ms.stage.name}</h3>
      <div className="learn-goal">🎯 本阶段目标：{ms.stage.goal}</div>
      <div className="dim" style={{ marginTop: 10 }}>
        内容 {ms.stage.content.length} 条 · 练习题 {nq} 题
      </div>
      {ms.stage.psychology_note && (
        <blockquote className="learn-note">设计意图：{ms.stage.psychology_note}</blockquote>
      )}
      <div className="learn-btns">
        <button className="btn primary" onClick={onStart}>开始学习本阶段</button>
        {nq > 0 && <button className="btn" onClick={onSkip}>跳过内容，直接练习 ({nq}题)</button>}
      </div>
    </div>
  )
}

/* ---------------- 内容逐条揭示（一句一句） ---------------- */
function ContentStep({ deck, si, ci, total, onNext }: {
  deck: ReturnType<typeof buildDeck>; si: number; ci: number; total: number; onNext: () => void
}) {
  const ms = deck.stages[si]
  const isLast = ci === total - 1
  const hasNext = !isLast || (ms.stage.practice?.length ?? 0) > 0 || ms.questions.length > 0
  return (
    <div className="card">
      <div className="dim">阶段 {ms.stage.stage} · {ms.stage.name} — 内容 {ci + 1}/{total}</div>
      <p className="learn-content">{ms.stage.content[ci]}</p>
      <div className="learn-btns">
        <span className="dim" style={{ alignSelf: 'center' }}>
          {ci + 1 < total ? '还有下一条内容' : isLast ? '本阶段内容到此结束' : ''}
        </span>
        <button className="btn primary" onClick={onNext}>
          {ci + 1 < total ? '继续 ↓' : hasNext ? '下一步' : '完成本阶段'}
        </button>
      </div>
    </div>
  )
}

/* ---------------- 阶段练习说明 ---------------- */
function PracticeStep({ deck, si, hasNextQ, onNext }: {
  deck: ReturnType<typeof buildDeck>; si: number; hasNextQ: boolean; onNext: () => void
}) {
  const ms = deck.stages[si]
  return (
    <div className="card">
      <div className="dim">阶段 {ms.stage.stage} · {ms.stage.name} — 本阶段练习安排</div>
      <ul className="tight">
        {(ms.stage.practice || []).map((p, i) => <li key={i}>{p}</li>)}
      </ul>
      <div className="learn-btns">
        <button className="btn primary" onClick={onNext}>
          {hasNextQ ? '进入练习题' : '完成本阶段'}
        </button>
      </div>
    </div>
  )
}

/* ---------------- 题目（IMMEDIATE FEEDBACK） ---------------- */
function QuestionCard({ q, indexInStage, totalInStage, picked, result, selfAssessment, onPick, onSelfAssess, onNext }: {
  q: Question; indexInStage: number; totalInStage: number
  picked?: string; result?: 'correct' | 'wrong'
  selfAssessment?: boolean
  onPick: (letter: string, ok: boolean) => void
  onSelfAssess: (ok: boolean) => void
  onNext: () => void
}) {
  const isMulti = q.type === 'multiple_choice'
  const isChoice = q.type === 'single_choice' || isMulti
  const [localPicks, setLocalPicks] = useState<string[]>([])
  const [revealed, setRevealed] = useState(false)
  const [inputValue, setInputValue] = useState('')

  const shownPicks = picked ?? (isMulti ? localPicks.slice().sort().join('') : localPicks[0])
  const graded = !!result
  const assessed = selfAssessment !== undefined

  function pickChoice(letter: string) {
    if (graded) return
    if (isMulti) {
      setLocalPicks((p) => (p.includes(letter) ? p.filter((x) => x !== letter) : [...p, letter]))
      return
    }
    setLocalPicks([letter])
    onPick(letter, letter === normAns(q.answer) || q.answer.trim().toUpperCase().startsWith(letter))
  }

  function submitMulti() {
    if (!isMulti || graded || localPicks.length === 0) return
    const mine = normAns(localPicks.join(''))
    onPick(mine, mine === normAns(q.answer))
  }

  return (
    <div className="card">
      <div className="dim">
        <span className="pill run">{TYPE_ZH[q.type] || q.type}</span>
        <span className="pill warn">{DIFF[q.difficulty]}</span>
        {' '}本阶段第 {indexInStage}/{totalInStage} 题 · 目标：{q.learning_objective}
      </div>
      <div className="q-prompt">{q.prompt}</div>

      {isChoice && (
        <ul className="q-options learn-options">
          {(q.options || []).map((opt, j) => {
            const letter = String.fromCharCode(65 + j)
            const isPicked = isMulti
              ? (localPicks.includes(letter) || (shownPicks || '').includes(letter))
              : shownPicks === letter
            const isAnswer = normAns(q.answer).includes(letter)
            let cls = 'learn-opt'
            if (graded) {
              if (isAnswer) cls += ' right'
              else if (isPicked) cls += ' wrong'
            } else if (isPicked) cls += ' picked'
            return (
              <li key={letter}>
                <button className={cls} onClick={() => pickChoice(letter)} disabled={graded}>
                  <b>{letter}.</b> {opt}
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {isMulti && !graded && (
        <button className="btn primary" disabled={localPicks.length === 0} onClick={submitMulti}>
          提交答案
        </button>
      )}

      {!isChoice && (q.type === 'calculation' || q.type === 'short_answer') && !graded && !assessed && !revealed && (
        <div className="open-input" style={{ marginTop: 8 }}>
          <input type="text" value={inputValue} placeholder="输入你的计算结果…"
            onChange={(e) => setInputValue(e.target.value)} />
          <button className="btn primary" disabled={!inputValue.trim()}
            onClick={() => {
              const studentAns = inputValue.trim().replace(/\s+/g, '')
              const correctAns = q.answer.trim().replace(/\s+/g, '')
              const ok = studentAns === correctAns
              if (ok) onPick(studentAns, true)
              else setRevealed(true)
            }}>
            提交答案
          </button>
        </div>
      )}
      {!isChoice && q.type !== 'calculation' && q.type !== 'short_answer' && !revealed && !graded && !assessed && (
        <button className="btn" onClick={() => setRevealed(true)}>先作答，查看答案</button>
      )}

      {(!isChoice && (revealed || assessed)) && !graded && (
        <div className="q-answer">
          {inputValue && <div>你的作答：{inputValue}</div>}
          <div>参考答案：<span className="ans">{q.answer}</span></div>
          {inputValue && <div className="dim">表达方式可能不同，请核对数学含义后自评；系统不把文本差异直接判为错误。</div>}
          <div className="exp"><strong>解析：</strong>{q.explanation}</div>
          <div className="dim" style={{ marginTop: 8 }}>对照答案，你刚才独立做出来了吗？</div>
          <div className="learn-btns" style={{ marginTop: 8 }}>
            <button className="btn" disabled={assessed} onClick={() => onSelfAssess(true)}>✓ 我答对了</button>
            <button className="btn" disabled={assessed} onClick={() => onSelfAssess(false)}>✗ 没答上</button>
          </div>
          {assessed && <div className="dim">已记录自评：{selfAssessment ? '已掌握' : '需要复习'}，不计入客观正确率。</div>}
        </div>
      )}

      {graded && (
        <div className={`q-answer ${result === 'correct' ? '' : 'q-answer-wrong'}`}>
          <div>{result === 'correct' ? '✅ 回答正确！' : '❌ 未答对。正确答案：'}
            {result === 'wrong' && <span className="ans">{q.answer}</span>}
          </div>
          <div className="exp"><strong>解析：</strong>{q.explanation}</div>
          {q.source_basis?.length > 0 && (
            <div className="src">教材依据：{q.source_basis.join('；')}</div>
          )}
        </div>
      )}

      <div className="learn-btns" style={{ marginTop: 10 }}>
        <button className="btn primary" disabled={!graded && !assessed} onClick={onNext}>
          下一题 →
        </button>
        {!graded && !assessed && <span className="dim" style={{ alignSelf: 'center' }}>作答后继续</span>}
      </div>
    </div>
  )
}

/* ---------------- 阶段完成（SMALL WIN） ---------------- */
function StageDone({ deck, si, results, selfReports, isLast, onNext, onReviewWrong }: {
  deck: ReturnType<typeof buildDeck>; si: number
  results: Record<string, 'correct' | 'wrong'>
  selfReports: Record<string, boolean>
  isLast: boolean; onNext: () => void; onReviewWrong: () => void
}) {
  const ms = deck.stages[si]
  const qs = ms.questions
  const ok = qs.filter((q) => results[q.id] === 'correct').length
  const stageWrong = qs.filter((q) => results[q.id] === 'wrong').length
  const assessed = qs.filter((q) => !results[q.id] && selfReports[q.id] !== undefined)
  const selfCorrect = assessed.filter((q) => selfReports[q.id]).length
  return (
    <div className="card learn-center">
      <div className="learn-big">✓</div>
      <h3>阶段 {ms.stage.stage} 完成：{ms.stage.name}</h3>
      {qs.length > 0 ? (
        <div className="dim">
          <div>{ok + stageWrong > 0 ? `客观作答：${ok}/${ok + stageWrong} 题答对` : '本阶段暂无客观判分'}</div>
          {assessed.length > 0 && <div>自评：{selfCorrect}/{assessed.length} 题已掌握，{assessed.length - selfCorrect} 题需要复习（不计入客观正确率）</div>}
          {ok + stageWrong + assessed.length < qs.length && <div>尚有 {qs.length - ok - stageWrong - assessed.length} 题未作答</div>}
          {stageWrong > 0 && <div>客观错题已记入结尾的错题回顾</div>}
        </div>
      ) : (
        <div className="dim">本阶段为纯内容学习，无练习题。</div>
      )}
      <div className="learn-btns">
        <button className="btn primary" onClick={onNext}>
          {isLast ? '查看学习报告' : `进入阶段 ${deck.stages[si + 1]?.stage.stage} →`}
        </button>
        {stageWrong > 0 && <button className="btn" onClick={onReviewWrong}>先看看错题</button>}
      </div>
    </div>
  )
}

/* ---------------- 最终报告（REAL PROGRESS） ---------------- */
function FinalReport({ plan, deck, answered, correct, wrongQs, results, mastery, setMastery,
  onRestart, onExit, report, teacherNote, tasks, submitState, selfReports = {} }: {
  plan: LearningPlan
  deck: ReturnType<typeof buildDeck>
  answered: number; correct: number
  wrongQs: Question[]
  results: Record<string, 'correct' | 'wrong'>
  mastery: Record<string, boolean>
  setMastery: (f: (m: Record<string, boolean>) => Record<string, boolean>) => void
  onRestart: () => void; onExit: () => void
  report: BuiltReport
  teacherNote?: string
  tasks?: string[]
  submitState?: 'idle' | 'sending' | 'ok' | 'local'
  selfReports?: Record<string, boolean>
}) {
  const acc = answered > 0 ? Math.round((correct / answered) * 100) : 0
  const leftovers = deck.consolidation
  return (
    <div>
      {teacherNote && (
        <div className="banner-note" style={{ marginBottom: 10 }}>🧑‍🏫 教师批注：{teacherNote}</div>
      )}
      {(tasks?.length ?? 0) > 0 && (
        <div className="banner-note" style={{ marginBottom: 10 }}>
          📌 教师追加任务：{tasks!.join('；')}
        </div>
      )}
      <div className="card learn-center">
        <div className="learn-big">🎉</div>
        <h3>学习完成：{plan.chapter}</h3>
        <div className="learn-stats">
          <div><b>{deck.stages.length}</b><span>学习阶段</span></div>
          <div><b>{answered}</b><span>客观作答</span></div>
          <div><b style={{ color: 'var(--green)' }}>{correct}</b><span>答对</span></div>
          <div><b style={{ color: wrongQs.length ? 'var(--amber)' : 'var(--green)' }}>{wrongQs.length}</b><span>客观错题</span></div>
          {answered > 0 && <div><b>{acc}%</b><span>客观正确率</span></div>}
          {Object.keys(selfReports).length > 0 && (
            <div><b>{Object.values(selfReports).filter(Boolean).length}</b><span>自评掌握</span></div>
          )}
        </div>
      </div>

      {wrongQs.length > 0 && (
        <div className="card">
          <h4>📌 错题回顾（真实进度：这些还没掌握）</h4>
          {wrongQs.map((q) => (
            <div key={q.id} className="learn-wrong">
              <div className="q-prompt" style={{ fontSize: 13 }}>{q.prompt}</div>
              <div>正确答案：<span className="ans">{q.answer}</span></div>
              <div className="exp dim">解析：{q.explanation}</div>
            </div>
          ))}
        </div>
      )}

      {leftovers.length > 0 && (
        <div className="card">
          <h4>🧩 综合巩固（跨阶段题目，共 {leftovers.length} 题）</h4>
          {leftovers.map((q) => (
            <div key={q.id} className="learn-wrong">
              <div className="dim">[{TYPE_ZH[q.type] || q.type}·{DIFF[q.difficulty]}] {q.learning_objective} ·
                {results[q.id] === 'correct' ? ' ✅ 已掌握' : results[q.id] === 'wrong' ? ' ❌ 未掌握' : ' 未作答'}
              </div>
              <div className="q-prompt" style={{ fontSize: 13 }}>{q.prompt}</div>
              <div>答案：<span className="ans">{q.answer}</span> <span className="exp dim">— {q.explanation}</span></div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h4>✅ 掌握标准自查（对照教材要求，诚实勾选）</h4>
        <ul className="tight learn-mastery">
          {(plan.mastery_criteria || []).map((c, i) => (
            <li key={i}>
              <label>
                <input type="checkbox" checked={!!mastery[String(i)]}
                  onChange={(e) => setMastery((m) => ({ ...m, [String(i)]: e.target.checked }))} />
                <span style={{ marginLeft: 8 }}>{c}</span>
              </label>
            </li>
          ))}
        </ul>
        <div className="dim" style={{ marginTop: 8 }}>
          全部勾选 = 达到本章掌握标准。没把握的可以点「重新学习」再过一遍。
        </div>
      </div>

      <div className="card learn-center">
        <h4>📥 导出学情报告</h4>
        <div className="dim" style={{ marginBottom: 10 }}>
          汇总本会化作答、错题回顾与游戏战绩，生成可交给老师的 Markdown 报告（JSON 供系统回流）。
          {submitState === 'ok' && <div style={{ color: 'var(--green)', marginTop: 6 }}>✅ 学情已自动提交给教师。</div>}
          {submitState === 'sending' && <div style={{ marginTop: 6 }}>正在提交学情……</div>}
          {submitState === 'local' && <div style={{ color: 'var(--amber)', marginTop: 6 }}>学情尚未提交，仅保存在本机；可手动导出。预览内容发布后才能计入正式学情。</div>}
        </div>
        <div className="learn-btns" style={{ marginTop: 0 }}>
          <button className="btn primary"
            onClick={() => downloadText(`${report.filenameBase}.md`, report.markdown, 'text/markdown')}>
            ⬇ 下载学情报告 (Markdown)
          </button>
          <button className="btn"
            onClick={() => downloadText(`${report.filenameBase}.json`, report.json, 'application/json')}>
            ⬇ 导出 JSON
          </button>
        </div>
      </div>

      <div className="learn-btns" style={{ justifyContent: 'center' }}>
        <button className="btn primary" onClick={onRestart}>重新学习</button>
        <button className="btn" onClick={onExit}>退出到结果页</button>
      </div>
    </div>
  )
}

/* ---------------- 阶段诊断（已掌握可跳过） ---------------- */
function DiagnosticCard({ deck, si, results, onNext }: {
  deck: ReturnType<typeof buildDeck>; si: number
  results: Record<string, 'correct' | 'wrong'>; onNext: () => void
}) {
  const q = deck.stages[si].questions[0]
  const [picked, setPicked] = useState<string | undefined>(undefined)
  const [graded, setGraded] = useState(!!results[q.id])
  const isChoice = q.type === 'single_choice' || q.type === 'multiple_choice'

  function pick(letter: string) {
    if (graded) return
    setPicked(letter); setGraded(true)
    const ok = letter === normAns(q.answer) || q.answer.trim().toUpperCase().startsWith(letter)
    results[q.id] = ok ? 'correct' : 'wrong'
    saveSessionSilent(q.id, ok)
  }
  function saveSessionSilent(_id: string, _ok: boolean) { /* 结果由组件级 results 状态承载 */ }

  return (
    <div className="card">
      <div className="dim">📊 阶段诊断 · {deck.stages[si].stage.name} —— 先试一道题，答对可跳过本阶段内容</div>
      <div className="q-prompt">{q.prompt}</div>
      {isChoice && (
        <ul className="q-options learn-options">
          {(q.options || []).map((opt, j) => {
            const letter = String.fromCharCode(65 + j)
            const cls = graded
              ? (normAns(q.answer).includes(letter) ? 'learn-opt right' : picked === letter ? 'learn-opt wrong' : 'learn-opt')
              : 'learn-opt'
            return (
              <li key={letter}>
                <button className={cls} disabled={graded} onClick={() => pick(letter)}>
                  <b>{letter}.</b> {opt}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {!isChoice && !graded && (
        <button className="btn" onClick={() => setGraded(true)}>
          我已掌握该阶段（跳过内容）
        </button>
      )}
      {graded && (
        <div className={(picked === normAns(q.answer)) ? 'q-answer' : 'q-answer q-answer-wrong'}>
          {isChoice
            ? <>{picked === normAns(q.answer)
                ? '✅ 诊断通过：你可能已掌握本阶段内容。'
                : '❌ 未答对：建议完整学习本阶段。'}</>
            : '已记录为已掌握。如实际未掌握，用「重新学习」重置。'}
          <div className="exp dim">诊断依据：{q.explanation?.slice(0, 120)}</div>
        </div>
      )}
      <div className="learn-btns">
        <button className="btn primary" disabled={!graded} onClick={onNext}>
          {(graded && picked === normAns(q.answer)) || (!isChoice && graded) ? '跳过本阶段内容 →' : '开始学习本阶段 →'}
        </button>
      </div>
    </div>
  )
}

/* ---------------- 补救讲解 + 同目标再测 ---------------- */
function RemediationCard({ deck, si, wrongQ, onNext }: {
  deck: ReturnType<typeof buildDeck>; si: number; wrongQ: Question; onNext: () => void
}) {
  const stage = deck.stages[si]
  const remediation = (stage.stage as { remediation?: string[] }).remediation || []
  const nextSame = stage.questions[stage.questions.indexOf(wrongQ) + 1] || stage.questions[0]
  const [picked, setPicked] = useState<string | undefined>(undefined)
  const [graded, setGraded] = useState(false)
  const isChoice = nextSame.type === 'single_choice' || nextSame.type === 'multiple_choice'

  return (
    <div className="card">
      <div className="dim">🛟 补救学习 · {stage.stage.name} —— 针对答错的点重新讲解，再用同类题检验</div>
      {remediation.length > 0 && <ul className="tight">{remediation.map((r, i) => <li key={i}>{r}</li>)}</ul>}
      <div className="q-answer q-answer-wrong" style={{ marginTop: 8 }}>
        <div className="dim">你之前答错的题：</div>
        <div style={{ fontSize: 13 }}>{wrongQ.prompt}</div>
        <div>正确答案：<span className="ans">{wrongQ.answer}</span></div>
        <div className="exp">{wrongQ.explanation}</div>
      </div>
      <div className="dim" style={{ marginTop: 10 }}>📝 同目标再测：</div>
      <div className="q-prompt">{nextSame.prompt}</div>
      {isChoice && (
        <ul className="q-options learn-options">
          {(nextSame.options || []).map((opt, j) => {
            const letter = String.fromCharCode(65 + j)
            const cls = graded
              ? (normAns(nextSame.answer).includes(letter) ? 'learn-opt right' : picked === letter ? 'learn-opt wrong' : 'learn-opt')
              : 'learn-opt'
            return (
              <li key={letter}>
                <button className={cls} disabled={graded}
                  onClick={() => { setPicked(letter); setGraded(true) }}>
                  <b>{letter}.</b> {opt}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {graded && (
        <div className={picked === normAns(nextSame.answer) ? 'q-answer' : 'q-answer q-answer-wrong'}>
          {picked === normAns(nextSame.answer) ? '✅ 补救后再测通过！' : '仍未通过——建议回到教材对应章节再学。'}
        </div>
      )}
      <div className="learn-btns">
        <button className="btn primary" disabled={isChoice && !graded} onClick={onNext}>继续 →</button>
      </div>
    </div>
  )
}
