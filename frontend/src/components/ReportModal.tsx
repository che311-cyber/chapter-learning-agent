import { useMemo, useState } from 'react'
import type { LearningPlan, QuestionPool } from '../types'
import Markdown from './Markdown'
import { buildFullReport, downloadText } from '../services/learningReport'

interface Props {
  project: string
  slug: string
  target: string
  plan: LearningPlan | null
  pool: QuestionPool | null
  onClose: () => void
}

export default function ReportModal({ project, slug, target, plan, pool, onClose }: Props) {
  const report = useMemo(
    () => buildFullReport({ project, target, plan, pool }, slug),
    [project, slug, target, plan, pool],
  )
  const [copied, setCopied] = useState(false)

  async function copyText() {
    try {
      await navigator.clipboard.writeText(report.markdown)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* 剪贴板权限被拒时静默 */
    }
  }

  return (
    <div className="report-backdrop" onClick={onClose}>
      <div className="report-modal" onClick={(e) => e.stopPropagation()}>
        <div className="report-head">
          <div>
            <div className="report-title">📥 学情报告</div>
            <div className="report-sub">{report.data.meta.chapter} ·
              生成于 {new Date(report.data.meta.generatedAt).toLocaleString('zh-CN')}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">✕</button>
        </div>

        <div className="report-summary">
          <div>
            <b>{report.data.learning.answered}</b><span>已作答</span>
          </div>
          <div>
            <b style={{ color: 'var(--green)' }}>{report.data.learning.correct}</b><span>掌握</span>
          </div>
          <div>
            <b style={{ color: report.data.learning.wrong ? 'var(--amber)' : 'var(--text-dim)' }}>
              {report.data.learning.wrong}</b><span>待巩固</span>
          </div>
          {report.data.learning.accuracy !== null && (
            <div><b>{report.data.learning.accuracy}%</b><span>正确率</span></div>
          )}
          {report.data.game.hasSave && (
            <div><b style={{ color: '#d8b36a' }}>LV.{report.data.game.level}</b><span>{report.data.game.xp} XP</span></div>
          )}
        </div>

        <div className="report-body">
          <Markdown text={report.markdown} />
        </div>

        <div className="report-foot">
          <span className="dim">导出给教师审阅（Markdown）或供系统回流（JSON）。</span>
          <div className="toolbar">
            <button className="btn small" onClick={copyText}>{copied ? '✓ 已复制' : '复制全文'}</button>
            <button className="btn small primary"
              onClick={() => downloadText(`${report.filenameBase}.md`, report.markdown, 'text/markdown')}>
              ⬇ 下载 Markdown
            </button>
            <button className="btn small"
              onClick={() => downloadText(`${report.filenameBase}.json`, report.json, 'application/json')}>
              ⬇ 导出 JSON
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
