import { useEffect, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import { api, apiBase, setApiBase, enterStaticMode, isStaticMode, ApiError } from './services/api'
import type {
  Health, ProjectInfo, ResultPayload, RunSummary, SourceFile, StatusPayload,
} from './types'
import Sidebar from './components/Sidebar'
import PhaseStepper from './components/PhaseStepper'
import LogConsole from './components/LogConsole'
import ResultPanel from './components/ResultPanel'
import TeacherDashboard from './components/TeacherDashboard'

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [project, setProject] = useState<string>('')
  const [files, setFiles] = useState<SourceFile[]>([])
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [target, setTarget] = useState('')
  const activeProject = useRef('')
  const selectionVersion = useRef(0)
  const knownFiles = useRef(new Set<string>())
  const [analyzing, setAnalyzing] = useState(false)
  const [status, setStatus] = useState<StatusPayload | null>(null)
  const [result, setResult] = useState<ResultPayload | null>(null)
  const [pageError, setPageError] = useState('')
  const [notice, setNotice] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [learnMode, setLearnMode] = useState(false)
  const [gameMode, setGameMode] = useState(false)
  const [gameLoading, setGameLoading] = useState(false)
  const [GameView, setGameView] = useState<ComponentType<{
    project: string; result: ResultPayload; onExit: () => void
  }> | null>(null)
  const [selectedFiles, setSelectedFiles] = useState<string[]>([])
  const [teacherMode, setTeacherMode] = useState(() => {
    try { return localStorage.getItem('cla-teacher') === '1' } catch { return false }
  })

  // 游戏模式条件：当前章节已有完整分析结果（学习方案 + 题库）且非 STRUCTURE_ONLY
  const gameReady = !!(result && result.status === 'COMPLETE'
    && result.learning_plan && result.question_pool
    && !result.quality?.requiresReview
    && !['STRUCTURE_ONLY', 'BLOCKED', 'UNKNOWN'].includes(result.quality?.contentStatus || ''))

  async function openGame() {
    if (!gameReady || gameLoading) return
    if (GameView) { setGameMode(true); return }
    const version = selectionVersion.current
    setGameLoading(true)
    try {
      const module = await import('./game/GameContainer')
      setGameView(() => module.default)
      if (version === selectionVersion.current) setGameMode(true)
    } catch {
      setPageError('游戏资源暂时加载失败，请检查网络后重试。学习方案和练习仍可正常使用。')
    } finally {
      setGameLoading(false)
    }
  }

  async function refreshResult() {
    if (!project || !result) return
    try { setResult(await api.result(project, result.run_id)) } catch { /* keep */ }
  }

  // ---------- 初始加载：优先连后端，连不上则进入静态演示模式 ----------
  useEffect(() => {
    ;(async () => {
      const health = await api.health().catch(() => null)
      if (health) {
        setHealth(health)
      } else if (await enterStaticMode()) {
        setHealth(await api.health())
      } else {
        setPageError('后端未连接，且未找到内置演示数据。'
          + '本地使用：./start.sh 启动后端；纯线上访问：静态数据缺失（部署异常）。')
        return
      }
      api.listProjects().then((ps) => {
        setProjects(ps)
        if (ps.length === 0) return
        // 默认选择：优先记住上次的；否则选有教材的项目（避免默认进到空项目）
        let stored: string | null = null
        try { stored = localStorage.getItem('cla-project') } catch { /* 受限存储仍可浏览 */ }
        const preferred = (stored && ps.find((x) => x.name === stored))
          || [...ps].filter((x) => x.file_count > 0)
            .sort((a, b) => (b.last_activity || 0) - (a.last_activity || 0))[0]
          || ps[0]
        setProject((p) => p || preferred.name)
      }).catch((e) => setPageError(e.message))
      // 静态演示模式：自动展示内置的已完成章节
      if (isStaticMode()) {
        const s = await api.status('abstract-algebra', '第一章').catch(() => null)
        if (s) setStatus(s)
        const r = await api.result('abstract-algebra', '第一章').catch(() => null)
        if (r) setResult(r)
      }
    })()
    // 刷新徽章文字（地址探测是异步的，探测完成后徽章可能变化）
    const t = setInterval(() => setTick((x) => x + 1), 2500)
    return () => clearInterval(t)
  }, [])
  const [, setTick] = useState(0)

  // ---------- 项目切换 ----------
  useEffect(() => {
    if (!project) return
    activeProject.current = project
    refreshProject(project)
  }, [project])

  function refreshProject(p: string) {
    api.listFiles(p).then((fs) => {
      if (activeProject.current !== p) return
      setFiles(fs)
      const names = fs.filter((f) => f.parse_ok).map((f) => f.name)
      const added = names.filter((name) => !knownFiles.current.has(name))
      knownFiles.current = new Set(names)
      // 默认检索范围 = 全部可解析文件；新上传的文件自动纳入
      setSelectedFiles((prev) => {
        const stillValid = prev.filter((n) => names.includes(n))
        return stillValid.concat(added)
      })
    }).catch((e) => { if (activeProject.current === p) setPageError(e.message) })
    api.listRuns(p).then((rs) => {
      if (activeProject.current !== p) return
      setRuns(rs)
      const ready = rs.find((run) => run.status === 'COMPLETE')
      if (ready) setTarget((current) => current || ready.target || ready.slug)
    }).catch(() => { if (activeProject.current === p) setRuns([]) })
  }

  function handleProjectChange(next: string) {
    if (next === project) return
    activeProject.current = next
    selectionVersion.current += 1
    knownFiles.current = new Set()
    setProject(next)
    setFiles([])
    setRuns([])
    setSelectedFiles([])
    setTarget('')
    setStatus(null)
    setResult(null)
    setAnalyzing(false)
    setPageError('')
    setNotice('')
    setGameMode(false)
    setLearnMode(false)
    try { localStorage.setItem('cla-project', next) } catch { /* ignore */ }
  }

  // ---------- 轮询 ----------
  const runSlug = status?.run_id
  useEffect(() => {
    if (!analyzing || !project || !runSlug) return
    let alive = true
    let polling = false
    let failures = 0
    const timer = setInterval(async () => {
      if (polling) return
      polling = true
      const version = selectionVersion.current
      try {
        const s = await api.status(project, runSlug)
        if (!alive || version !== selectionVersion.current) return
        if (failures) setNotice('连接已恢复，继续更新分析进度。')
        failures = 0
        setStatus(s)
        if (!s.running && s.phase !== 'COMPLETE') {
          setAnalyzing(false)
          refreshProject(project)
        }
        if (s.phase === 'COMPLETE') {
          const r = await api.result(project, runSlug)
          if (!alive || version !== selectionVersion.current) return
          setAnalyzing(false)
          setResult(r)
          refreshProject(project)
          setNotice('分析完成')
        }
      } catch {
        failures += 1
        if (alive && version === selectionVersion.current && failures >= 3) {
          setNotice('连接暂时中断，正在恢复进度；后台任务会继续运行。')
        }
      } finally {
        polling = false
      }
    }, 1200)
    return () => { alive = false; clearInterval(timer) }
  }, [analyzing, project, runSlug])

  // ---------- 动作 ----------
  async function handleAnalyze(force: boolean, chapter = target) {
    setPageError('')
    setNotice('')
    if (!project) { setPageError('请先选择一个项目'); return }
    if (!chapter.trim()) { setPageError('请输入教材中实际存在的章节或小节名称'); return }
    const scope = files.filter((f) => selectedFiles.includes(f.name)).map((f) => f.name)
    if (!isStaticMode() && files.length > 1 && scope.length === 0) {
      setPageError('检索范围至少勾选一个教材文件（或全部勾选）'); return
    }
    if (force && !isStaticMode() && !window.confirm(`确定要重新分析「${chapter}」吗？\n已有结果将被重新生成（消耗 API 额度）。`)) return
    const version = ++selectionVersion.current
    try {
      const r = await api.analyze(project, chapter.trim(), force, scope)
      if (selectionVersion.current !== version) return
      if (r.action === 'cached') {
        setNotice(isStaticMode()
          ? `演示模式：「${chapter}」的完整分析已呈现（内置成果，含 Agent 工作日志）。`
          : `「${chapter}」已有分析结果（缓存）。如需重新生成请点击「重新运行」。`)
        const res = await api.result(project, r.run_id)
        if (selectionVersion.current !== version) return
        setResult(res)
        const s = await api.status(project, r.run_id)
        if (selectionVersion.current !== version) return
        setStatus(s)
        return
      }
      setResult(null)
      const s = await api.status(project, r.run_id)
      if (selectionVersion.current !== version) return
      setStatus(s)
      setAnalyzing(true)
      setNotice(r.action === 'resumed' ? '检测到未完成任务，正在续跑……' : '')
    } catch (e: any) {
      if (selectionVersion.current !== version) return
      if (e instanceof ApiError && e.status === 409) {
        // 已有同章节运行中：用后端返回的真实 run_id 接上进度
        const detail = (e.body as { detail?: { run_id?: string } } | undefined)?.detail
        const slug = detail?.run_id || chapter.trim()
        try {
          const s = await api.status(project, slug)
          if (selectionVersion.current !== version) return
          setStatus(s)
          setAnalyzing(true)
          setNotice('该章节正在分析中，已接入当前进度。')
        } catch { setPageError(e.message as string) }
      } else {
        setPageError(e instanceof Error ? e.message : String(e))
      }
    }
  }

  async function handleCancel() {
    if (!project || !status) return
    try {
      await api.cancel(project, status.run_id)
      setNotice('已发送取消请求，等待当前步骤结束…')
    } catch (e) {
      setPageError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleOpenRun(slug: string) {
    const version = ++selectionVersion.current
    setPageError('')
    setNotice('')
    try {
      const s = await api.status(project, slug)
      if (selectionVersion.current !== version) return
      setStatus(s)
      setTarget(s.target || slug)
      if (s.running) {
        setAnalyzing(true)
        setResult(null)
      } else if (['COMPLETE', 'NEEDS_REVIEW', 'INCOMPLETE'].includes(s.phase)) {
        const loaded = await api.result(project, slug)
        if (selectionVersion.current !== version) return
        setAnalyzing(false)
        setResult(loaded)
      } else {
        setResult(null)
      }
    } catch (e) {
      if (selectionVersion.current !== version) return
      setPageError(e instanceof Error ? e.message : String(e))
    }
  }

  const activeSlug = status?.run_id
  const runningNow = analyzing && status?.running
  const quickTargets = [...new Set(runs.filter((run) => run.status === 'COMPLETE')
    .map((run) => run.target || run.slug))].slice(0, 3)

  return (
    <div className="app">
      <header className="topbar">
        <div className="logo">Chapter <span>Learning</span> Agent</div>
        <div className="sub">{learnMode ? '专注学习空间' : '教材章节 → 学习方案 + 练习 · AI 教学助手'}</div>
        <div className="spacer" />
        {learnMode && <span className="badge learn-badge">🧘 专注模式</span>}
        <button
          className={`btn small sb-toggle ${sidebarOpen ? '' : 'accent'}`}
          title={sidebarOpen ? '收起资料栏' : '展开资料栏'}
          onClick={() => setSidebarOpen((v) => !v)}
          disabled={learnMode}
        >
          {sidebarOpen ? '⇤ 收起资料栏' : '☰ 展开资料栏'}
        </button>
        {!isStaticMode() && (
          <button className={`btn small ${teacherMode ? 'accent' : ''}`} onClick={() => {
            const v = !teacherMode
            setTeacherMode(v)
            try { localStorage.setItem('cla-teacher', v ? '1' : '0') } catch { /* ignore */ }
          }}>
            {teacherMode ? '退出教师端' : '🧑‍🏫 教师端'}
          </button>
        )}
        <button
          className="btn small game-toggle"
          title={gameReady
            ? `进入「${result?.target}」的游戏世界（地图 / 战斗 / XP）`
            : '需要先完成当前章节的分析（学习方案 + 题库），才能生成游戏关卡'}
          onClick={() => { void openGame() }}
          disabled={!gameReady || gameLoading}
        >
          {gameLoading ? '游戏加载中…' : '🎮 游戏模式'}
        </button>
        <button
          className="badge badge-click"
          title={isStaticMode()
            ? '静态演示模式：内置「抽象代数·第一章」完整成果，学习/练习/游戏全可用。'
              + '\n分析新章节需在本机运行 ./start.sh，然后点击此徽章连接后端。'
            : `后端 API 地址：${apiBase() || (health ? '自动探测成功' : '探测中…')}`
              + `\n本机后端：./start.sh backend（访问 http://localhost:8000）`
              + `\n远程访问：./start.sh tunnel 后把 trycloudflare.com 地址填到这里`
              + `\n（点击修改）`}
          onClick={() => {
            const next = window.prompt(
              '后端 API 地址（留空 = 自动探测：同源 → 本机 8000 端口；'
              + '在其他设备上访问时填隧道的 trycloudflare.com 地址）：',
              apiBase(),
            )
            if (next === null) return
            setApiBase(next)
            setPageError('')
            setNotice('')
            window.location.reload()
          }}
        >
          <span className={`dot ${health?.key_configured ? 'ok' : ''}`} />
          {isStaticMode()
            ? '📦 静态演示模式 · 学习功能可用'
            : health
              ? `${health.model} · ${health.key_configured ? 'API 就绪' : '未配置 API Key'}`
              : '⚠ 后端未连接 · 点击设置'}
        </button>
      </header>

      {gameMode && result && GameView && (
        <GameView project={project} result={result} onExit={() => setGameMode(false)} />
      )}
      {teacherMode && (
        <TeacherDashboard project={project} onClose={() => {
          setTeacherMode(false)
          try { localStorage.setItem('cla-teacher', '0') } catch { /* ignore */ }
        }}
          onUpdated={async () => {
            if (!project) return
            const rs = await api.listRuns(project).catch(() => [])
            setRuns(rs)
            // 同步刷新当前打开的章节结果（保持教师发布状态一致）
            if (result) {
              const r = await api.result(project, result.run_id).catch(() => null)
              if (r) setResult(r)
            }
          }} />
      )}

      <div className={`columns ${learnMode ? 'learn-mode' : ''} ${sidebarOpen ? '' : 'sb-hidden'}`}>
        <Sidebar
          projects={projects}
          project={project}
          onProject={handleProjectChange}
          files={files}
          runs={runs}
          activeSlug={activeSlug}
          onOpenRun={handleOpenRun}
          onUploaded={() => refreshProject(project)}
        />

        {/* 中栏：目标 + 进度 + 日志 */}
        <section className="panel panel-center">
          <div className="panel-head">Analyze Chapter</div>
          <div className="panel-body">
            <div className="target-row">
              <input
                type="text"
                value={target}
                placeholder="例如：第一章 / 8.3 一致收敛"
                onChange={(e) => setTarget(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !runningNow) handleAnalyze(false) }}
              />
              <button className="btn primary" disabled={runningNow || !project || !target.trim()}
                onClick={() => handleAnalyze(false)}>
                {runningNow ? '分析中…' : isStaticMode() ? '开始分析（演示）' : '开始分析'}
              </button>
            </div>
            {!isStaticMode() && files.length > 1 && (
              <div className="scope-row">
                <span className="scope-label">📚 检索范围：</span>
                <div className="scope-files">
                  {files.map((f) => (
                    <label key={f.name} className="scope-file">
                      <input
                        type="checkbox"
                        checked={selectedFiles.includes(f.name)}
                        onChange={(e) => {
                          setSelectedFiles((prev) =>
                            e.target.checked ? [...prev, f.name] : prev.filter((n) => n !== f.name))
                        }}
                      />
                      <span>{f.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="hint">
              {isStaticMode()
                ? <>📦 演示模式：内置示例教材《抽象代数》第一章的完整分析成果——输入「第一章」点上方按钮，
                  立即呈现 Agent 的完整分析过程与结果（学习模式 / 练习 / 游戏模式全部可用）。<br />
                  分析新章节：在本机运行 <code>./start.sh</code>，然后点右上角徽章连接后端。</>
                : <>{quickTargets.length > 0 && <>已完成章节：{quickTargets.map((t) => (
                  <a key={t} href="#t" onClick={(e) => { e.preventDefault(); setTarget(t) }}
                    style={{ color: 'var(--accent)', marginRight: 8 }}>{t}</a>
                ))}<br /></>}
                  请填写教材中实际存在的章节或小节名称。<br />
                  Agent 只会读取目标章节及必要的少量前置内容，不会扫描整本书。</>}
            </div>

            {runningNow && (
              <div className="toolbar" style={{ marginTop: 12 }}>
                <button className="btn small danger" onClick={handleCancel}>取消任务</button>
              </div>
            )}

            {status && <PhaseStepper status={status} />}

            {status?.error && (
              <div className="error-banner">⚠️ {status.error}</div>
            )}
            {pageError && <div className="error-banner">⚠️ {pageError}</div>}
            {notice && !pageError && <div className="info-banner">{notice}</div>}

            {status && <LogConsole events={status.events} />}
            {!status && (
              <div className="hint" style={{ marginTop: 20 }}>
                输入目标章节并点击「开始分析」。Agent 将依次：定位章节 → 完整阅读 →
                生成章节理解 → 设计学习方案 → 生成练习 → 心理学 QA → 独立验证 → 保存。
              </div>
            )}
          </div>
        </section>

        {/* 右栏：结果 / 学习空间 */}
        <ResultPanel
          result={result}
          status={status}
          onRerun={() => handleAnalyze(true, result?.target || target)}
          project={project}
          onLearnMode={setLearnMode}
          teacherMode={teacherMode}
          onRefresh={refreshResult}
        />
      </div>
    </div>
  )
}
