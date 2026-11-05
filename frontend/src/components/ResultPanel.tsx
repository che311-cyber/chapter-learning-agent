import { useRef, useState } from 'react'
import type { ResultPayload, StatusPayload } from '../types'
import Markdown from './Markdown'
import LearningSession from './LearningSession'
import ReportModal from './ReportModal'
import { api } from '../services/api'
import type { QuestionPool } from '../types'

interface Props {
  result: ResultPayload | null
  status: StatusPayload | null
  onRerun: () => void
  project: string
  onLearnMode?: (active: boolean) => void
  teacherMode?: boolean
  onRefresh?: () => void
}

type Tab = 'plan' | 'questions' | 'qa' | 'sources' | 'json' | 'md'

export default function ResultPanel({ result, status, onRerun, project, onLearnMode, teacherMode, onRefresh }: Props) {
  const [tab, setTab] = useState<Tab>('plan')
  const [openAnswers, setOpenAnswers] = useState<Record<string, boolean>>({})
  const [jsonSel, setJsonSel] = useState('learning_plan')
  const [learning, setLearning] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [poolOverride, setPoolOverride] = useState<QuestionPool | null>(null)
  const [noteDraft, setNoteDraft] = useState<string | null>(null)
  const [taskDraft, setTaskDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [operationError, setOperationError] = useState('')

  function startLearn() {
    setLearning(true)
    onLearnMode?.(true)
  }
  function exitLearn() {
    setLearning(false)
    onLearnMode?.(false)
  }

  // 切换章节时重置本地题库副本
  const resultKey = result ? `${project}/${result.run_id}` : ''
  const activeKey = useRef(resultKey)
  activeKey.current = resultKey
  const [poolKey, setPoolKey] = useState(resultKey)
  if (poolKey !== resultKey) {
    setPoolKey(resultKey)
    setPoolOverride(null)
    setLearning(false)
    setOpenAnswers({})
    setReportOpen(false)
    setNoteDraft(null)
    setTaskDraft('')
    setOperationError('')
    setSaving(false)
  }

  const teacherSave = async (body: { note?: string; difficulty_note?: string; task?: string }) => {
    setSaving(true)
    setOperationError('')
    const key = resultKey
    try {
      await api.teacherNote(project, result!.run_id, body)
      if (activeKey.current !== key) return false
      onRefresh?.()
      return true
    } catch (error) {
      if (activeKey.current === key) setOperationError(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      if (activeKey.current === key) setSaving(false)
    }
  }
  const teacherPublish = async (status: 'published' | 'draft' | 'approved' | 'needs_review', confirmed = false) => {
    setSaving(true)
    setOperationError('')
    const key = resultKey
    try {
      await api.setReview(project, result!.run_id, status, noteDraft ?? undefined, undefined, confirmed)
      if (activeKey.current !== key) return
      onRefresh?.()
    } catch (error) {
      if (activeKey.current === key) setOperationError(error instanceof Error ? error.message : String(error))
    } finally {
      if (activeKey.current === key) setSaving(false)
    }
  }
  const deleteQuestion = async (qid: string) => {
    if (!window.confirm(`确认删除题目 ${qid}？（学生端将不可见）`)) return
    setOperationError('')
    const key = resultKey
    try {
      await api.deleteQuestion(project, result!.run_id, qid)
      if (activeKey.current !== key) return
      setPoolOverride((p) => {
        const pool = p || result!.question_pool
        return pool ? { ...pool, questions: pool.questions.filter(q => q.id !== qid) } : null
      })
      onRefresh?.()
    } catch (error) {
      if (activeKey.current === key) setOperationError(error instanceof Error ? error.message : String(error))
    }
  }

  if (!result) {
    return (
      <section className="panel panel--result">
        <div className="panel-head">Result</div>
        <div className="empty">
          <div className="big">📘</div>
          <div>{status?.running ? 'Agent 正在工作，完成后这里会显示结果……' : '还没有结果。选择章节并开始分析，或从左侧历史记录打开已完成的分析。'}</div>
        </div>
      </section>
    )
  }

  const { learning_plan, question_pool, qa_report, chapter_context, verification } = result
  const review = result.review || { status: 'draft' as const, note: '', tasks: [] }
  const complete = result.status === 'COMPLETE'
  const effectivePool = poolOverride || question_pool
  const sourceBlocked = result.quality?.requiresReview ||
    ['STRUCTURE_ONLY', 'BLOCKED', 'UNKNOWN'].includes(result.quality?.contentStatus || '')
  const canLearn = complete && !!learning_plan && !sourceBlocked

  // 引导式学习模式：一句一句按阶段引导，替代整页静态输出
  if (learning && learning_plan) {
    return (
      <section className="panel panel--result learn-space">
        <LearningSession
          key={resultKey}
          project={project}
          slug={result.run_id}
          plan={learning_plan}
          pool={effectivePool}
          onExit={exitLearn}
        />
      </section>
    )
  }

  const tabs: [Tab, string][] = [
    ['plan', '学习方案'],
    ['questions', `练习题${effectivePool ? ` (${effectivePool.questions.length})` : ''}`],
    ['qa', 'QA (7原则)'],
    ['sources', '来源'],
    ['md', 'Markdown'],
    ['json', 'JSON'],
  ]

  return (
    <section className="panel panel--result">
      <div className="panel-head">
        <span>
          Result · {result.target}
          {!complete && <span className="pill warn">状态：{result.status}</span>}
          {complete && <span className="pill ok">COMPLETE</span>}
          <QualityBadge quality={result.quality} />
        </span>
        <span className="toolbar">
          {canLearn && (
            <button className="btn small primary" onClick={startLearn}>
              ▶ 开始学习
            </button>
          )}
          <button className="btn small" onClick={() => setReportOpen(true)}>
            📥 学情报告
          </button>
          <button className="btn small danger" onClick={onRerun}>重新运行 (Re-run)</button>
        </span>
      </div>
      {operationError && <div className="error-banner" role="alert">{operationError}</div>}
      {sourceBlocked && (
        <div className="banner-draft">⚠️ 正文来源尚未通过复核，当前内容不可学习或发布。请重新定位并读取正文后重新分析。</div>
      )}
      {(review.status === 'draft' || review.status === 'needs_review' || review.status === 'blocked') && (
        <div className="banner-draft">
          {review.status === 'blocked' && review.block_reasons
            ? <>⛔ 发布被质量门控阻止：{review.block_reasons.join('；')}。需要 OCR / 文字版教材或教师确认。</>
            : <>🔒 本章内容待教师审核发布。当前为预览模式，学习记录不计入正式学情。</>}
          {teacherMode ? '（教师可在下方批注并发布）' : ''}
        </div>
      )}
      {review.status === 'approved' && (
        <div className="banner-note">✅ 教师已审核通过，等待发布。</div>
      )}
      {review.note && (
        <div className="banner-note">🧑‍🏫 教师批注：{review.note}</div>
      )}
      {(result.tasks?.length ?? 0) > 0 && (
        <div className="banner-note">📌 教师追加任务：{result.tasks!.map((t) => t.task).join('；')}</div>
      )}
      {reportOpen && (
        <ReportModal
          project={project}
          slug={result.run_id}
          target={result.target || ''}
          plan={learning_plan}
          pool={question_pool}
          onClose={() => setReportOpen(false)}
        />
      )}
      <div className="tabs">
        {tabs.map(([key, label]) => (
          <button key={key} className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      <div className="result-body">
        {teacherMode && (
          <div className="card teacher-card">
            <h4>🧑‍🏫 教师干预</h4>
            <textarea className="teacher-note-input" placeholder="教师批注（对学生可见），例如：本班易混淆结合律与交换律，请重点完成辨析题"
              value={noteDraft ?? review.note ?? ''} onChange={(e) => setNoteDraft(e.target.value)} />
            <div className="toolbar" style={{ marginTop: 8 }}>
              <input type="text" className="teacher-task-input" placeholder="追加学习任务，如：额外完成教材 P56 习题 3、4"
                value={taskDraft} onChange={(e) => setTaskDraft(e.target.value)} />
              <button className="btn small" disabled={saving || !taskDraft.trim()}
                onClick={async () => { if (await teacherSave({ task: taskDraft })) setTaskDraft('') }}>
                ＋ 追加任务
              </button>
            </div>
            <div className="toolbar" style={{ marginTop: 10 }}>
              <button className="btn small primary" disabled={saving}
                onClick={async () => { await teacherSave({ note: noteDraft ?? review.note ?? '' }); }}>
                💾 保存批注
              </button>
              {review.status === 'published'
                ? <button className="btn small warn" disabled={saving} onClick={() => { if (window.confirm('确认撤回发布？学生端将不可见。')) teacherPublish('draft') }}>撤回发布</button>
                : null}
              {(review.status === 'draft' || review.status === 'needs_review' || review.status === 'blocked') && (
                <button className="btn small" disabled={saving}
                  onClick={() => { void teacherPublish('approved') }}>
                  ✔️ 审核通过
                </button>
              )}
              {(review.status === 'approved' || review.status === 'blocked') && (
                <button className="btn small primary" disabled={saving}
                  onClick={async () => {
                    const blocked = review.status === 'blocked'
                    if (blocked && !window.confirm('质量门控未通过（正文覆盖率/定位置信度不足）。\n确认以教师身份强制发布？该操作将留痕。')) return
                    await teacherPublish('published', blocked)
                  }}>
                  {review.status === 'blocked' ? '⚠️ 教师确认后强制发布' : '🚀 发布给学生'}
                </button>
              )}
              {result.quality?.contentStatus === 'STRUCTURE_ONLY' && (
        <div className="banner-draft">⚠️ 当前内容仅基于教材目录生成，不能代表已学习章节正文。正文缺失，不可发布或学习。</div>
      )}
      {review.status === 'draft' && (
                <button className="btn small" disabled={saving}
                  onClick={() => { void teacherPublish('needs_review') }}>
                  提交审核
                </button>
              )}
              <span className="dim">当前状态：{review.status === 'published' ? '已发布' : review.status === 'approved' ? '审核通过待发布' : review.status === 'blocked' ? '被质量门控阻止' : review.status === 'needs_review' ? '待审核' : '草稿'}</span>
            </div>
          </div>
        )}
        {tab === 'plan' && <PlanTab result={result} onStartLearn={canLearn ? startLearn : undefined} />}
        {tab === 'questions' && effectivePool && (
          <QuestionsTab pool={effectivePool} open={openAnswers} setOpen={setOpenAnswers}
            teacherMode={teacherMode} onDelete={(qid) => void deleteQuestion(qid)} />
        )}
        {tab === 'qa' && <QaTab result={result} />}
        {tab === 'sources' && <SourcesTab result={result} />}
        {tab === 'md' && <MdTab result={result} />}
        {tab === 'json' && (
          <div>
            <div className="toolbar" style={{ marginBottom: 10 }}>
              {['learning_plan', 'question_pool', 'chapter_context', 'qa_report', 'verification'].map((n) => (
                <button key={n} className={`btn small ${jsonSel === n ? 'primary' : ''}`} onClick={() => setJsonSel(n)}>
                  {n}
                </button>
              ))}
            </div>
            <pre className="json-view">{JSON.stringify(
              jsonSel === 'learning_plan' ? learning_plan
              : jsonSel === 'question_pool' ? effectivePool
              : jsonSel === 'chapter_context' ? chapter_context
              : jsonSel === 'qa_report' ? qa_report
              : verification, null, 2)}</pre>
          </div>
        )}
      </div>
    </section>
  )
}

/* ---------------- Learning Plan ---------------- */
function PlanTab({ result, onStartLearn }: { result: ResultPayload; onStartLearn?: () => void }) {
  const plan = result.learning_plan
  const ctx = result.chapter_context
  if (!plan) return <div className="hint">学习方案尚未生成。</div>
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>{plan.chapter || result.target} · 学习方案</h2>
      {onStartLearn && (
        <div className="learn-cta">
          <span>不想一大坨看？让 Agent 按学习顺序<b>一句一句引导你学</b>，边学边练、即时反馈。</span>
          <button className="btn primary" onClick={onStartLearn}>▶ 开始学习</button>
        </div>
      )}
      <div className="card">
        <h4>🎯 学习目标</h4>
        <ul className="tight">{plan.learning_objectives.map((o, i) => <li key={i}>{o}</li>)}</ul>
      </div>
      <div className="card">
        <h4>🧭 推荐学习顺序</h4>
        {(plan.learning_sequence || []).map((s) => (
          <div key={s.stage} style={{ marginBottom: 14 }}>
            <div><span className="stage-num">{s.stage}</span><strong>{s.name}</strong></div>
            <div className="dim" style={{ margin: '4px 0 6px' }}>目标：{s.goal}</div>
            <ul className="tight">{(s.content || []).map((c, i) => <li key={i}>{c}</li>)}</ul>
            {s.practice && s.practice.length > 0 && (
              <div className="dim" style={{ marginTop: 6 }}>练习：{s.practice.join('；')}</div>
            )}
            {s.psychology_note && (
              <div className="dim" style={{ marginTop: 4, fontStyle: 'italic' }}>设计意图：{s.psychology_note}</div>
            )}
          </div>
        ))}
      </div>
      <div className="card">
        <h4>✅ 掌握标准（真实进度）</h4>
        <ul className="tight">{(plan.mastery_criteria || []).map((c, i) => <li key={i}>{c}</li>)}</ul>
      </div>
      {(plan.common_failure_points?.length ?? 0) > 0 && (
        <div className="card">
          <h4>⚠️ 常见失败点与补救</h4>
          <ul className="tight">{plan.common_failure_points!.map((c, i) => <li key={i}>
            {typeof c === 'string' ? c : <>{c.failure}{c.remedy && `：${c.remedy}`}</>}
          </li>)}</ul>
        </div>
      )}
      {ctx && (ctx.core_concepts?.length ?? 0) > 0 && (
        <div className="card">
          <h4>📌 核心概念（来自教材）</h4>
          <div>{ctx.core_concepts.join(' · ')}</div>
        </div>
      )}
      {ctx && (
        <div className="card">
          <h4>📖 知识内容本身（定义 · 定理 · 例子，含教材出处）</h4>
          <div className="dim" style={{ marginBottom: 8 }}>
            学习路线是「怎么学的地图」，这里是「知识本身」。每个条目都对应教材位置，可翻书核对。
          </div>
          {(ctx.definitions || []).map((d, i) => (
            <div key={`d${i}`} className="learn-wrong">
              <div className="dim">
                定义 · <strong style={{ color: 'var(--text)' }}>{d.term}</strong>
                {d.source_file && (
                  <span className="src-file" style={{ marginLeft: 8 }}>
                    {d.source_file}{d.source_page ? ` P${d.source_page}` : ''}
                  </span>
                )}
              </div>
              <div style={{ marginTop: 4 }}>{d.content}</div>
            </div>
          ))}
          {(ctx.theorems || []).map((t, i) => (
            <div key={`t${i}`} className="learn-wrong">
              <div className="dim">
                定理 · <strong style={{ color: 'var(--text)' }}>{t.name}</strong>
                {t.source_file && (
                  <span className="src-file" style={{ marginLeft: 8 }}>
                    {t.source_file}{t.source_page ? ` P${t.source_page}` : ''}
                  </span>
                )}
              </div>
              <div style={{ marginTop: 4 }}>{t.content}</div>
            </div>
          ))}
          {(ctx.key_examples || []).map((e, i) => (
            <div key={`e${i}`} className="learn-wrong">
              <div className="dim">例子 · <strong style={{ color: 'var(--text)' }}>{e.name}</strong></div>
              {e.content && <div style={{ marginTop: 4 }}>{e.content}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------------- Questions ---------------- */
const DIFF = { 1: '基础', 2: '中等', 3: '挑战' } as const
const TYPE_ZH: Record<string, string> = {
  single_choice: '单选', multiple_choice: '多选', short_answer: '简答',
  calculation: '计算', proof: '证明', ordering: '排序', comparison: '对比',
}

function QuestionsTab({ pool, open, setOpen, teacherMode, onDelete }: {
  pool: NonNullable<ResultPayload['question_pool']>
  open: Record<string, boolean>
  setOpen: (v: Record<string, boolean>) => void
  teacherMode?: boolean
  onDelete?: (qid: string) => void
}) {
  const qs = pool.questions || []
  return (
    <div>
      <div className="dim" style={{ marginBottom: 10 }}>
        共 {qs.length} 题 · 基础 {qs.filter((q) => q.difficulty === 1).length} ·
        中等 {qs.filter((q) => q.difficulty === 2).length} ·
        挑战 {qs.filter((q) => q.difficulty === 3).length} ·
        点击「查看答案」核对
      </div>
      {qs.map((q, i) => (
        <div key={q.id} className="card">
          <div className="dim">
            <span className="pill run">{TYPE_ZH[q.type] || q.type}</span>
            <span className="pill warn">{DIFF[q.difficulty]}</span>
            {' '}Q{i + 1} · 目标：{q.learning_objective}
          </div>
          <div className="q-prompt">{q.prompt}</div>
          {teacherMode && (
            <button className="btn small danger" style={{ marginBottom: 6 }}
              onClick={() => { if (window.confirm(`确认删除本题 ${q.id}？`)) onDelete?.(q.id) }}>
              🗑 删除此题（教师）
            </button>
          )}
          {q.options && q.options.length > 0 && (
            <ul className="q-options">
              {q.options.map((opt, j) => <li key={j}><strong>{String.fromCharCode(65 + j)}.</strong> {opt}</li>)}
            </ul>
          )}
          {open[q.id] ? (
            <div className="q-answer">
              <div>答案：<span className="ans">{q.answer}</span></div>
              <div className="exp"><strong>解析：</strong>{q.explanation}</div>
              {q.source_basis?.length > 0 && <div className="src">教材依据：{q.source_basis.join('；')}</div>}
              <button className="btn small" style={{ marginTop: 8 }}
                onClick={() => setOpen({ ...open, [q.id]: false })}>收起答案</button>
            </div>
          ) : (
            <button className="btn small" onClick={() => setOpen({ ...open, [q.id]: true })}>
              查看答案
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

/* ---------------- QA ---------------- */
const QA_NAMES: [string, string][] = [
  ['clear_goal', '1. CLEAR GOAL · 目标明确'],
  ['immediate_feedback', '2. IMMEDIATE FEEDBACK · 即时反馈'],
  ['real_progress', '3. REAL PROGRESS · 真实进度'],
  ['meaningful_agency', '4. MEANINGFUL AGENCY · 有意义的选择'],
  ['small_wins', '5. SMALL WINS · 小步成功'],
  ['challenge_skill_match', '6. CHALLENGE–SKILL MATCH · 难度匹配'],
  ['curiosity', '7. CURIOSITY · 认知牵引'],
]

function QaTab({ result }: { result: ResultPayload }) {
  const qa = result.qa_report
  const ver = result.verification
  if (!qa) return <div className="hint">QA 报告尚未生成。</div>
  const itemStatus = (k: string): 'PASS' | 'PARTIAL' | 'FAIL' => {
    const it = (qa as unknown as Record<string, { pass?: boolean; partial?: boolean }>)[k]
    if (!it) return 'FAIL'
    if (it.pass) return it.partial ? 'PARTIAL' : 'PASS'
    return 'FAIL'
  }
  const passCount = QA_NAMES.filter(([k]) => itemStatus(k) === 'PASS').length
  const partialCount = QA_NAMES.filter(([k]) => itemStatus(k) === 'PARTIAL').length
  const failCount = 7 - passCount - partialCount
  const overall = failCount > 0 ? 'FAIL（存在未通过项）' : partialCount > 0 ? `PARTIAL（${passCount}/7 通过，${partialCount} 项部分应用——不能视为全部通过）` : 'PASS（7/7）'
  return (
    <div>
      <div className="dim" style={{ marginBottom: 10 }}>
        整体状态：<b style={{ color: failCount ? 'var(--red)' : partialCount ? 'var(--amber)' : 'var(--green)' }}>{overall}</b>
        {ver && ` · 发现 ${ver.issue_counts?.found ?? ver.issues.length} 项 · 修正 ${ver.issue_counts?.corrected ?? ver.corrections_applied ?? 0} 处 · 未解决 ${ver.issue_counts?.unresolved ?? ver.issues.filter(it => it.resolution_status !== 'corrected' && it.resolution_status !== 'no_change_needed').length} 项 · 无需修正 ${ver.issue_counts?.no_change_needed ?? ver.issues.filter(it => it.resolution_status === 'no_change_needed').length} 项`}
      </div>
      {QA_NAMES.map(([key, label]) => {
        const item = qa[key as keyof typeof qa]
        if (!item) return null
        return (
          <div key={key} className="qa-row">
            <div className="icon">{itemStatus(key) === 'PASS' ? '✅' : itemStatus(key) === 'PARTIAL' ? '🟡' : '❌'}</div>
            <div>
              <div className="title">{label} · {itemStatus(key)}{item.partial ? '（部分应用）' : ''}</div>
              {item.issues.length > 0 && <div className="detail">问题：{item.issues.join('；')}</div>}
              {item.changes.length > 0 && <div className="detail">修改：{item.changes.join('；')}</div>}
              {item.partial && item.justification && <div className="detail">说明：{item.justification}</div>}
            </div>
          </div>
        )
      })}
      {ver && (
        <div className="card" style={{ marginTop: 14 }}>
          <h4>🔍 最终独立验证</h4>
          <div className="dim">
            独立重解：{ver.re_solved ? '是' : '否'} · 总体结论：
            <strong style={{ color: ver.overall_pass ? 'var(--green)' : 'var(--amber)' }}>
              {ver.overall_pass ? '通过' : '未完全通过'}
            </strong>
          </div>
          {ver.issues.length > 0 && (
            <ul className="tight">
              {ver.issues.map((it, i) => (
                <li key={i}>
                  [{it.severity === 'critical' ? '严重' : '轻微'}] {it.question_id}：{it.problem}
                  {`（${it.resolution_status === 'corrected' ? '已修正' : it.resolution_status === 'no_change_needed' ? '无需修正' : '未解决'}${it.fix_applied ? `：${it.fix_applied}` : ''}）`}
                </li>
              ))}
            </ul>
          )}
          {ver.coverage_notes && <div className="dim" style={{ marginTop: 6 }}>覆盖说明：{ver.coverage_notes}</div>}
        </div>
      )}
    </div>
  )
}

/* ---------------- Sources ---------------- */
function SourcesTab({ result }: { result: ResultPayload }) {
  const ctx = result.chapter_context
  const loc = result.located
  return (
    <div>
      {loc && (
        <div className="card">
          <h4>📖 章节定位</h4>
          <div className="dim">
            {loc.file} ·「{loc.heading}」· 第 {loc.start_page}–{loc.end_page} 页
            {loc.confidence && ` · 置信度 ${loc.confidence}`}
          </div>
        </div>
      )}
      <div className="card">
        <h4>📄 来源引用（防幻觉溯源）</h4>
        {!ctx && <div className="hint">章节理解尚未生成。</div>}
        {(ctx?.definitions || []).map((d, i) => (
          <div key={`d${i}`} className="src-row">
            <span className="src-file">{d.source_file}{d.source_page ? ` P${d.source_page}` : ''}</span>
            <span>
              {d.sourceType === 'model_supplement'
                ? <span className="pill warn" title="该条内容无教材原文依据，为模型补充">模型补充</span>
                : <span className="pill ok" title="有教材原文依据">教材</span>}
              {' '}<strong>{d.term}</strong> — {d.content.slice(0, 80)}{d.content.length > 80 ? '…' : ''}
            </span>
          </div>
        ))}
        {(ctx?.source_references || []).map((r, i) => (
          <div key={`r${i}`} className="src-row">
            <span className="src-file">{r.file}{r.page ? ` P${r.page}` : ''}</span>
            <span>{r.locator || ''}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ---------------- Markdown 文件 ---------------- */
function MdTab({ result }: { result: ResultPayload }) {
  const names = Object.keys(result.markdown)
  const [sel, setSel] = useState(names[0] || 'learning_plan.md')
  if (names.length === 0) return <div className="hint">Markdown 文件尚未生成（完成后保存在 output/ 目录）。</div>
  const text = result.markdown[sel] || ''
  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 10 }}>
        {names.map((n) => (
          <button key={n} className={`btn small ${sel === n ? 'primary' : ''}`} onClick={() => setSel(n)}>
            {n}
          </button>
        ))}
      </div>
      <Markdown text={text} />
    </div>
  )
}

/* ---------------- 质量徽章（真实数据支撑的状态） ---------------- */
function QualityBadge({ quality }: { quality?: ResultPayload['quality'] }) {
  if (!quality) return null
  const cs = quality.contentStatus
  const bc = quality.bodyContentCoverage
  const bodyPct = bc !== null && bc !== undefined ? Math.round(bc * 100) : null

  if (quality.requiresReview && cs !== 'STRUCTURE_ONLY') {
    return <span className="pill warn" style={{ marginLeft: 6 }}>正文质量待复核</span>
  }

  if (cs === 'STRUCTURE_ONLY') {
    return <span className="pill err" style={{ marginLeft: 6 }}
      title="仅定位到目录页，正文内容覆盖率为 0。不可发布。">
      仅目录信息 · 正文覆盖率 0% · 不可发布</span>
  }
  if (cs === 'PARTIAL_CONTENT') {
    return <span className="pill warn" style={{ marginLeft: 6 }}
      title="正文内容部分缺失，需教师确认">
      正文部分缺失 · 覆盖率 {bodyPct !== null ? bodyPct + '%' : '未确定'}</span>
  }
  if (bc !== null && bc !== undefined) {
    const conf = quality.locationConfidence === 'high' ? '高' : quality.locationConfidence === 'low' ? '低' : '中'
    return <span className="pill ok" style={{ marginLeft: 6 }}
      title="正文可读覆盖率与章节定位置信度">正文覆盖率 {bodyPct}% · 定位{conf}置信</span>
  }
  return null
}
