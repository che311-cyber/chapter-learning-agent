import type { ProjectInfo, RunSummary, SourceFile } from '../types'
import { api } from '../services/api'
import { useState } from 'react'

interface Props {
  projects: ProjectInfo[]
  project: string
  onProject: (p: string) => void
  files: SourceFile[]
  runs: RunSummary[]
  activeSlug?: string
  onOpenRun: (slug: string) => void
  onUploaded: () => void
}

export default function Sidebar(props: Props) {
  const { projects, project, onProject, files, runs, activeSlug, onOpenRun, onUploaded } = props
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [createError, setCreateError] = useState('')

  async function handleUpload(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    setUploading(true)
    setUploadError('')
    try {
      for (const f of Array.from(fileList)) {
        await api.uploadFile(project, f)
      }
      onUploaded()
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  async function handleCreate() {
    setCreateError('')
    try {
      await api.createProject(newName)
      setCreating(false)
      setNewName('')
      window.location.reload()
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <aside className="panel panel-side">
      <div className="panel-head">项目 / 资料</div>
      <div className="panel-body">
        <div className="section-title">Select Project</div>
        <select className="select" value={project} onChange={(e) => onProject(e.target.value)}>
          {projects.length === 0 && <option value="">（暂无项目）</option>}
          {projects.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
        </select>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button className="btn small" onClick={() => setCreating(!creating)}>新建项目</button>
          <label className="btn small" style={{ flex: 1 }}>
            {uploading ? '上传中…' : '上传教材'}
            <input type="file" accept=".pdf,.txt,.md,.docx,.pptx,.markdown"
              style={{ display: 'none' }} multiple
              onChange={(e) => handleUpload(e.target.files)} />
          </label>
        </div>
        {creating && (
          <div style={{ marginTop: 8 }}>
            <input type="text" placeholder="项目名，如 linear-algebra"
              value={newName} onChange={(e) => setNewName(e.target.value)} />
            <button className="btn small block" style={{ marginTop: 6 }} onClick={handleCreate}>创建</button>
            {createError && <div className="hint" style={{ color: 'var(--red)' }}>{createError}</div>}
          </div>
        )}
        {uploadError && <div className="hint" style={{ color: 'var(--red)', marginTop: 8 }}>⚠️ {uploadError}</div>}

        <div className="section-title">教材文件（input/，只读）</div>
        {files.length === 0 && (
          <div className="upload-empty" onClick={() => document.getElementById('sidebar-upload')?.click()}>
            <div className="upload-empty-icon">📚</div>
            <div className="upload-empty-title">上传你的教材</div>
            <div className="upload-empty-desc">
              点击此处或拖入 PDF / TXT / MD / DOCX / PPTX<br />
              上传后即可指定章节，开始分析
            </div>
            <input id="sidebar-upload" type="file" accept=".pdf,.txt,.md,.docx,.pptx,.markdown"
              style={{ display: 'none' }} multiple
              onChange={(e) => handleUpload(e.target.files)} />
          </div>
        )}
        {files.map((f) => (
          <div key={f.name} className="file-item" title={f.parse_error || f.name}>
            <div className="name">{f.name}
              {f.parse_ok
                ? <span className="pill ok">可解析</span>
                : <span className="pill err">解析失败</span>}
            </div>
            <div className="meta">
              {f.ext} · {f.pages ?? '—'} 页 · {(f.size / 1024).toFixed(0)} KB
              {f.parse_error ? ` · ${f.parse_error.slice(0, 40)}` : ''}
            </div>
          </div>
        ))}

        <div className="section-title">已分析的章节</div>
        {runs.length === 0 && <div className="hint">暂无历史记录</div>}
        {runs.map((r) => (
          <div key={r.slug}
            className={`run-item ${r.slug === activeSlug ? 'active' : ''}`}
            onClick={() => onOpenRun(r.slug)}>
            <div className="name">{r.target || r.slug}
              <StatusPill status={r.status} />
            </div>
            <div className="meta">{r.status === 'COMPLETE' ? '点击查看结果' : r.error || `状态：${r.status}`}</div>
          </div>
        ))}
      </div>
    </aside>
  )
}

function StatusPill({ status }: { status: string }) {
  if (status === 'COMPLETE') return <span className="pill ok">完成</span>
  if (status === 'FAILED') return <span className="pill err">失败</span>
  if (status === 'CANCELLED') return <span className="pill warn">已取消</span>
  if (status === 'NEEDS_REVIEW') return <span className="pill warn">待复核</span>
  return <span className="pill run">{status}</span>
}
