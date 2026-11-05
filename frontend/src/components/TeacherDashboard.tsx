// 教师端看板：双视图
//   📋 内容审核：预览学习方案（目标/阶段/内容条目）与题目（含答案/解析/教材来源），
//      审核流转 DRAFT→NEEDS_REVIEW→APPROVED→PUBLISHED，支持发布/撤回（后端质量门控强制）
//   📈 学情分析：学生学情报告、共性薄弱点聚合（真实提交数据；不足时明确提示，不虚构）
import { useEffect, useMemo, useState } from 'react'
import { api, ApiError, getTeacherToken, setTeacherToken } from '../services/api'
import type { LearningReportSummary, ResultPayload, RunSummary } from '../types'

interface Props {
  project: string
  onClose: () => void
  onUpdated: () => void
}

interface Row {
  run: RunSummary
  result: ResultPayload | null
  reports: LearningReportSummary[]
}

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  needs_review: '待审核',
  approved: '审核通过',
  published: '已发布',
  blocked: '被门控阻止',
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === 'published' ? 'ok' : status === 'blocked' ? 'err'
    : status === 'approved' ? 'ok' : 'warn'
  return <span className={`pill ${cls}`} style={{ marginLeft: 8 }}>{STATUS_LABEL[status] || status}</span>
}

export default function TeacherDashboard({ project, onClose, onUpdated }: Props) {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [authenticated, setAuthenticated] = useState(() => !!getTeacherToken())
  const [password, setPassword] = useState('')
  const [loggingIn, setLoggingIn] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [view, setView] = useState<'review' | 'analytics'>('review')

  useEffect(() => {
    if (!authenticated || !project) return
    let alive = true
    ;(async () => {
      setLoading(true)
      try {
        const runs = await api.listRuns(project)
        const out: Row[] = []
        for (const r of runs) {
          try {
            const result = await api.result(project, r.slug)
            const reports = await api.listLearningReports(project, r.slug)
            out.push({ run: r, result, reports })
          } catch (e) {
            if (e instanceof ApiError && e.status === 401) throw e
            out.push({ run: r, result: null, reports: [] })
          }
        }
        if (alive) setRows(out)
      } catch (e) {
        if (alive) {
          setError(e instanceof Error ? e.message : String(e))
          if (e instanceof ApiError && e.status === 401) setAuthenticated(false)
        }
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [project, authenticated])

  async function login() {
    if (!password || loggingIn) return
    setLoggingIn(true)
    setError('')
    try {
      const result = await api.teacherLogin(password)
      setTeacherToken(result.token)
      setPassword('')
      setAuthenticated(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoggingIn(false)
    }
  }

  const refreshRow = async (slug: string) => {
    const result = await api.result(project, slug).catch(() => null)
    setRows((rs) => rs.map((x) => (x.run.slug === slug ? { ...x, result } : x)))
    onUpdated()
  }

  async function transition(slug: string, status: 'needs_review' | 'approved' | 'published' | 'draft',
                            teacherConfirmed = false) {
    if (status === 'published' && !teacherConfirmed
      && !window.confirm('确认发布给学生？（发布前需审核通过；质量门控不通过时会被阻止）')) return
    setError('')
    try {
      await api.setReview(project, slug, status, undefined, undefined, teacherConfirmed)
      await refreshRow(slug)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      if (e instanceof ApiError && e.status === 401) setAuthenticated(false)
    }
  }

  const totalReports = useMemo(() => rows.reduce((a, r) => a + r.reports.length, 0), [rows])

  // 学情聚合（学情分析视图）：跨报告聚合薄弱点
  const analytics = useMemo(() => {
    const weak: Record<string, { wrong: number; total: number; students: number }> = {}
    let reportCount = 0
    for (const row of rows) {
      for (const rp of row.reports) {
        reportCount += 1
        for (const w of rp.weak_objectives || []) {
          const e = weak[w.objective] || { wrong: 0, total: 0, students: 0 }
          e.wrong += w.wrong
          e.total += w.total
          e.students += 1
          weak[w.objective] = e
        }
      }
    }
    const weakList = Object.entries(weak)
      .map(([objective, v]) => ({ objective, ...v }))
      .sort((a, b) => b.wrong - a.wrong)
    return { reportCount, weakList }
  }, [rows])

  return (
    <div className="report-backdrop" onClick={onClose}>
      <div className="report-modal" onClick={(e) => e.stopPropagation()}>
        <div className="report-head">
          <div>
            <div className="report-title">🧑‍🏫 教师端 · {project}</div>
            <div className="report-sub">
              {view === 'review'
                ? '内容审核：预览学习方案与题目，审核通过后发布（未审核不能发布）'
                : '学情分析：学生报告与共性薄弱点（真实提交数据）'}
              {' '}· {rows.length} 章节 / {totalReports} 份学情报告
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        <div className="tabs" style={{ flex: '0 0 auto' }}>
          <button className={`tab ${view === 'review' ? 'active' : ''}`} onClick={() => setView('review')}>📋 内容审核</button>
          <button className={`tab ${view === 'analytics' ? 'active' : ''}`} onClick={() => setView('analytics')}>📈 学情分析</button>
        </div>
        <div className="report-body">
          {error && <div className="error-banner" role="alert">{error}</div>}
          {!authenticated && (
            <form className="card" onSubmit={(event) => { event.preventDefault(); void login() }}>
              <h3>教师登录</h3>
              <p className="dim">登录后可审核、修改、发布章节内容，并查看学生学情。</p>
              <label htmlFor="teacher-password">教师密码</label>
              <div className="target-row">
                <input id="teacher-password" type="password" autoComplete="current-password"
                  value={password} onChange={(event) => setPassword(event.target.value)} required />
                <button className="btn primary" type="submit" disabled={loggingIn || !password}>
                  {loggingIn ? '登录中…' : '登录'}
                </button>
              </div>
            </form>
          )}
          {authenticated && !project && <div className="dim">请先选择一个项目。</div>}
          {loading && <div className="dim">加载中……</div>}
          {authenticated && !loading && rows.length === 0 && <div className="dim">暂无章节。</div>}

          {(authenticated ? rows : []).map((row) => {
            if (view === 'analytics' && row.reports.length === 0) return null
            const result = row.result
            const review = result?.review
            const status = review?.status || 'draft'
            const expandedThis = expanded === row.run.slug
            const quality = result?.quality
            const qn = result?.question_pool?.questions?.length ?? 0
            return (
              <div key={row.run.slug} className="card teacher-row">
                <div className="teacher-row-head">
                  <div>
                    <b>{result?.target || row.run.target || row.run.slug}</b>
                    <StatusBadge status={status} />
                    {result?.status !== 'COMPLETE' && <span className="pill err">{result?.status === 'NEEDS_REVIEW' ? '正文质量待复核' : '结果缺失'}</span>}
                    {qn > 0 && <span className="dim" style={{ marginLeft: 8 }}>{qn} 题</span>}
                    {quality?.readableCoverage !== undefined && (
                      <span className={`pill ${quality.readableCoverage < 0.6 ? 'err' : 'ok'}`} style={{ marginLeft: 6 }}
                        title={quality.readableCoverage < 0.6 ? '正文不可靠读取：需要OCR/文字版/教师确认' : '正文可读覆盖率'}>
                        正文覆盖 {Math.round(quality.readableCoverage * 100)}%
                        {quality.ocrConfidence != null && ` · OCR ${quality.ocrConfidence}`}
                      </span>
                    )}
                    {review?.status === 'blocked' && review.block_reasons && (
                      <span className="pill err" style={{ marginLeft: 6 }} title={review.block_reasons.join('；')}>⛔ 门控</span>
                    )}
                  </div>
                  <div className="toolbar">
                    {view === 'review' && result?.status === 'COMPLETE' && (
                      <>
                        {status === 'draft' && (
                          <button className="btn small" onClick={() => void transition(row.run.slug, 'needs_review')}>提交审核</button>
                        )}
                        {(status === 'needs_review' || status === 'blocked') && (
                          <button className="btn small" onClick={() => void transition(row.run.slug, 'approved')}>✔️ 审核通过</button>
                        )}
                        {(status === 'approved' || status === 'blocked') && (
                          <button className="btn small primary" onClick={() => {
                            const blocked = status === 'blocked'
                            if (blocked && !window.confirm('质量门控未通过。确认以教师身份强制发布？将留痕。')) return
                            void transition(row.run.slug, 'published', blocked)
                          }}>🚀 发布给学生</button>
                        )}
                        {status === 'published' && (
                          <button className="btn small warn" onClick={() => {
                            if (window.confirm('确认撤回发布？学生端将不可见。')) void transition(row.run.slug, 'draft')
                          }}>撤回</button>
                        )}
                      </>
                    )}
                    <button className="btn small"
                      onClick={() => setExpanded(expandedThis ? null : row.run.slug)}>
                      {expandedThis ? '收起' : (view === 'review' ? '预览内容' : '详情')}
                    </button>
                  </div>
                </div>

                {review?.note && <div className="dim" style={{ marginTop: 6 }}>教师批注：{review.note}</div>}
                {(result?.tasks?.length ?? 0) > 0 && (
                  <div className="dim" style={{ marginTop: 4 }}>
                    追加任务：{result!.tasks!.map((t) => t.task).join('；')}
                  </div>
                )}

                {expandedThis && view === 'review' && result && (
                  <div style={{ marginTop: 10 }}>
                    <b style={{ fontSize: 13 }}>学习目标</b>
                    <ul className="tight">{(result.learning_plan?.learning_objectives || []).map((o, i) => <li key={i}>{o}</li>)}</ul>
                    <b style={{ fontSize: 13 }}>学习阶段与内容（{result.learning_plan?.learning_sequence?.length || 0} 个阶段）</b>
                    {(result.learning_plan?.learning_sequence || []).map((st) => (
                      <div key={st.stage} className="learn-wrong">
                        <div><span className="stage-num">{st.stage}</span><strong>{st.name}</strong></div>
                        <div className="dim">目标：{st.goal}</div>
                        <ul className="tight">{(st.content || []).map((c, i) => <li key={i}>{c}</li>)}</ul>
                      </div>
                    ))}
                    <b style={{ fontSize: 13 }}>题目（{qn}）— 教师可删除，删除即时生效并留痕</b>
                    {(result.question_pool?.questions || []).map((q) => (
                      <div key={q.id} className="learn-wrong">
                        <div className="dim">
                          [{q.type}·难度{q.difficulty}] {q.id} · {q.learning_objective}
                          <button className="btn small danger" style={{ marginLeft: 8, padding: '2px 8px' }}
                            onClick={async () => {
                              if (!window.confirm(`确认删除题目 ${q.id}？`)) return
                              try {
                                await api.deleteQuestion(project, row.run.slug, q.id)
                                await refreshRow(row.run.slug)
                              } catch (e) {
                                setError(e instanceof Error ? e.message : String(e))
                                if (e instanceof ApiError && e.status === 401) setAuthenticated(false)
                              }
                            }}>删除</button>
                        </div>
                        <div style={{ marginTop: 4, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                          <span style={{ flex: 1 }}>{q.prompt}</span>
                          <EditBtn onSave={async (v) => { await api.updateQuestion(project, row.run.slug, q.id, { prompt: v }); refreshRow(row.run.slug) }} initial={q.prompt} multiline />
                        </div>
                        {q.options && q.options.length > 0 && (
                          <div className="dim">{q.options.map((o, j) => `${String.fromCharCode(65 + j)}. ${o}`).join('  ')}</div>
                        )}
                        <div style={{ marginTop: 4, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                          <span style={{ flex: 1 }}><b>答案：</b>{q.answer} · {q.explanation?.slice(0, 80)}</span>
                          <EditBtn onSave={async (v) => { await api.updateQuestion(project, row.run.slug, q.id, { answer: v }); refreshRow(row.run.slug) }} initial={q.answer} />
                        </div>
                        <div className="dim" style={{ fontSize: 11 }}>教材依据：{(q.source_basis || []).join('；')}</div>
                      </div>
                    ))}
                  </div>
                )}

                {expandedThis && view === 'analytics' && (
                  <div style={{ marginTop: 10 }}>
                    <div className="dim" style={{ marginBottom: 6 }}>学情报告 {row.reports.length} 份（按时间倒序）</div>
                    {row.reports.length === 0 && <div className="hint">还没有学生学情报告回流。学生完成学习后自动提交。</div>}
                    {row.reports.map((rp, i) => (
                      <div key={i} className="learn-wrong">
                        <div className="dim">
                          {new Date((rp.submitted_at || 0) * 1000).toLocaleString('zh-CN')} ·
                          作答 {rp.answered} · 掌握 {rp.correct} · 待巩固 {rp.wrong}
                          {rp.accuracy != null ? ` · 正确率 ${rp.accuracy}%` : ''}
                          {rp.game_level ? ` · 游戏 LV.${rp.game_level}` : ''}
                        </div>
                        {(rp.weak_objectives || []).length > 0 && (
                          <div style={{ marginTop: 4 }}>
                            薄弱点：{rp.weak_objectives!.map((w) => `${w.objective}（错${w.wrong}/${w.total}）`).join('；')}
                          </div>
                        )}
                        {(rp.wrong_questions || []).length > 0 && (
                          <ul className="tight" style={{ marginTop: 6 }}>
                            {rp.wrong_questions!.map((q, j) => <li key={j}>{q.prompt?.slice(0, 50)}… → {q.answer}</li>)}
                          </ul>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}

          {view === 'analytics' && analytics.reportCount === 0 && (
            <div className="hint">还没有学生学情报告回流。学生完成学习后自动提交；此处不展示虚构数据。</div>
          )}
          {view === 'analytics' && analytics.weakList.length > 0 && (
            <div className="card">
              <h4>🔥 共性薄弱点（按错误次数排序）</h4>
              {analytics.weakList.map((w) => (
                <div key={w.objective} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 13 }}>
                    {w.objective} <span className="dim">— 错 {w.wrong}/{w.total} · 出现在 {w.students} 份报告</span>
                  </div>
                  <div className="learn-bar" style={{ height: 6 }}>
                    <div style={{ width: `${Math.min(100, (w.wrong / Math.max(1, w.total)) * 100)}%`,
                      background: 'linear-gradient(90deg,var(--amber),var(--red))' }} />
                  </div>
                </div>
              ))}
              <div className="dim" style={{ marginTop: 8 }}>
                建议干预：对薄弱点对应的阶段使用「追加任务」布置针对性练习；必要时撤回相关内容重新生成。
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}


function EditBtn({ onSave, initial, multiline }: {
  onSave: (v: string) => Promise<void>
  initial: string
  multiline?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  if (!editing) {
    return <button className="btn small" style={{ padding: '2px 8px', fontSize: 11, flexShrink: 0 }}
      onClick={() => { setValue(initial); setError(''); setEditing(true) }}>编辑</button>
  }
  return (
    <div style={{ marginTop: 4 }}>
      {multiline
        ? <textarea className="teacher-note-input" style={{ minHeight: 48 }} value={value}
            onChange={(e) => setValue(e.target.value)} />
        : <input type="text" className="teacher-task-input" style={{ width: '100%' }} value={value}
            onChange={(e) => setValue(e.target.value)} />}
      <div className="toolbar" style={{ marginTop: 4 }}>
        <button className="btn small primary" disabled={saving} onClick={async () => {
          setSaving(true)
          setError('')
          try { await onSave(value); setEditing(false) }
          catch (e) { setError(e instanceof Error ? e.message : String(e)) }
          finally { setSaving(false) }
        }}>{saving ? '保存中…' : '保存'}</button>
        <button className="btn small" disabled={saving} onClick={() => { setValue(initial); setEditing(false) }}>取消</button>
      </div>
      {error && <div className="error-banner" role="alert">{error}</div>}
    </div>
  )
}
