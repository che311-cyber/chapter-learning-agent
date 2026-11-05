import type {
  Health, LearningReportSummary, ProjectInfo, ResultPayload, RunSummary, SourceFile,
  StatusPayload,
} from '../types'
import inlineBundle from '../generated/staticBundle.json'

/**
 * 后端 API 地址解析：
 * 1. 用户在徽章里显式设置的地址（localStorage，含"强制同源"的空串标记）
 * 2. 构建期 VITE_API_BASE
 * 3. 自动探测：同源 /api → http://localhost:8000 → http://127.0.0.1:8000
 *    探测成功的地址缓存在内存/会话中，网络失败时自动重探。
 */
const SET_KEY = 'cla-api-base'
const DETECTED_KEY = 'cla-api-detected'
const TEACHER_TOKEN_KEY = 'cla-teacher-token'
let teacherSessionToken = ''
const memorySettings = new Map<string, string>()

function readSetting(area: 'local' | 'session', key: string): string | null {
  try { return (area === 'local' ? localStorage : sessionStorage).getItem(key) }
  catch { return memorySettings.get(`${area}:${key}`) ?? null }
}

function writeSetting(area: 'local' | 'session', key: string, value: string | null): void {
  const name = `${area}:${key}`
  if (value === null) memorySettings.delete(name)
  else memorySettings.set(name, value)
  try {
    const storage = area === 'local' ? localStorage : sessionStorage
    if (value === null) storage.removeItem(key)
    else storage.setItem(key, value)
  } catch { /* 禁用存储时当前页面仍可连接后端 */ }
}

export function getTeacherToken(): string {
  try { return teacherSessionToken || sessionStorage.getItem(TEACHER_TOKEN_KEY) || '' }
  catch { return teacherSessionToken }
}

export function setTeacherToken(token: string): void {
  teacherSessionToken = token
  try {
    if (token) sessionStorage.setItem(TEACHER_TOKEN_KEY, token)
    else sessionStorage.removeItem(TEACHER_TOKEN_KEY)
  } catch { /* 浏览器禁用存储时保留本次页面会话 */ }
}

export function apiBase(): string {
  const stored = readSetting('local', SET_KEY)
  if (stored !== null) return stored.replace(/\/+$/, '')
  if (import.meta.env.VITE_API_BASE) return import.meta.env.VITE_API_BASE.replace(/\/+$/, '')
  return (resolved ?? readSetting('session', DETECTED_KEY))?.replace(/\/+$/, '') ?? ''
}

export function setApiBase(url: string): void {
  setTeacherToken('')
  const v = url.trim()
  writeSetting('local', SET_KEY, v || null)
  writeSetting('session', DETECTED_KEY, null)
  resolved = null
}

let resolved: string | null = null

function candidates(): string[] {
  const env = import.meta.env.VITE_API_BASE ? [import.meta.env.VITE_API_BASE] : []
  return [...env, '', 'http://localhost:8000', 'http://127.0.0.1:8000']
}

async function probe(base: string): Promise<boolean> {
  try {
    const r = await fetch(base + '/api/health', { signal: AbortSignal.timeout(4000) })
    if (!r.ok) return false
    const j = await r.json()
    return j?.ok === true
  } catch {
    return false
  }
}

/** 依次探测候选地址，返回第一个可用的；全部失败返回 null。 */
export async function detectApiBase(): Promise<string | null> {
  if (resolved !== null) return resolved
  for (const c of candidates()) {
    if (await probe(c)) {
      resolved = c
      writeSetting('session', DETECTED_KEY, c)
      return c
    }
  }
  return null
}

export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

// ---------------- 静态演示模式（无后端） ----------------
// Cloudflare Pages 独立部署：内置已完成的章节分析成果，学习功能全可用；
// 新章节分析 / 上传需要本机后端，在静态模式下给出明确提示。
interface StaticBundle {
  generated_at: string
  note: string
  projects: ProjectInfo[]
  files: SourceFile[]
  runs: RunSummary[]
  status: StatusPayload
  result: ResultPayload
}

let staticBundle: StaticBundle | null = null
export function isStaticMode(): boolean {
  return staticBundle !== null
}

export async function enterStaticMode(): Promise<boolean> {
  if (staticBundle) return true
  // 优先 fetch（Pages 部署时数据可独立更新）；失败（如 file:// 离线包）回退到构建时内联副本
  try {
    const r = await fetch(import.meta.env.BASE_URL + 'static-data/abstract-algebra.json')
    if (r.ok) {
      const b = (await r.json()) as StaticBundle
      if (b?.result?.learning_plan) {
        staticBundle = b
        return true
      }
    }
  } catch {
    /* 走内联副本 */
  }
  try {
    const b = inlineBundle as unknown as StaticBundle
    if (b?.result?.learning_plan) {
      staticBundle = b
      return true
    }
  } catch {
    return false
  }
  return false
}

const STATIC_MSG = '静态演示模式：内置的是「抽象代数·第一章」的完整分析成果。'
  + '如需分析新章节或上传教材，请在本机运行 ./start.sh 后，点右上角徽章连接本机后端。'

async function staticRequest<T>(path: string): Promise<T> {
  const b = staticBundle!
  if (path.startsWith('/health')) {
    return {
      ok: true, model: 'static-demo', base_url: '内置演示数据',
      key_configured: true,
    } as unknown as T
  }
  if (path === '/projects') return b.projects as unknown as T
  if (path === '/projects/abstract-algebra/files') return b.files as unknown as T
  if (path === '/projects/abstract-algebra/runs') return b.runs as unknown as T
  if (path.includes('/status')) return b.status as unknown as T
  if (path.includes('/result')) return b.result as unknown as T
  if (path.includes('/cancel')) return { cancelled: false } as unknown as T
  throw new ApiError(0, STATIC_MSG)
}

async function rawFetch(path: string, init?: RequestInit): Promise<Response> {
  let base = apiBase()
  // 未显式配置且未探测过 → 先探测
  if (!base && readSetting('local', SET_KEY) === null && !import.meta.env.VITE_API_BASE) {
    base = (await detectApiBase()) ?? ''
  }
  const readOnly = !init?.method || init.method.toUpperCase() === 'GET'
  const timeout = path.endsWith('/files') ? (readOnly ? 120000 : 180000) : 20000
  const send = (destination: string, options = init) => fetch(destination + '/api' + path, {
    ...options, signal: options?.signal ?? AbortSignal.timeout(timeout),
  })
  try {
    return await send(base)
  } catch {
    // 写请求可能已经在服务器执行，网络失败不能盲目重放上传、发布或学情提交。
    if (!readOnly) {
      throw new ApiError(0, '连接中断或等待超时，操作结果尚未确认。请刷新查看保存结果后再重试。')
    }
    // 网络失败且不是显式配置：清缓存重新探测一次
    if (readSetting('local', SET_KEY) === null && !import.meta.env.VITE_API_BASE) {
      resolved = null
      writeSetting('session', DETECTED_KEY, null)
      const detected = await detectApiBase()
      if (detected !== null) {
        let retryInit = init
        if (detected !== base) {
          setTeacherToken('')
          const headers = new Headers(init?.headers)
          headers.delete('X-Teacher-Token')
          retryInit = { ...init, headers }
        }
        try { return await send(detected, retryInit) } catch { /* 统一给出可恢复提示 */ }
      }
      throw new ApiError(0, '无法连接后端服务：请确认本机后端已启动（./start.sh backend）；'
        + '远程访问请点右上角徽章填写后端地址')
    }
    throw new ApiError(0, '无法连接后端服务：请点击右上角徽章检查后端 API 地址')
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (staticBundle) {
    // 静态演示模式：点「开始分析」= 立即呈现已完成的分析（回放数据已在 status 中）
    if (path.endsWith('/analyze') && init?.method === 'POST') {
      let target = ''
      try {
        target = String((JSON.parse(String(init.body || '{}')) as { target?: string }).target || '')
      } catch { /* ignore */ }
      const norm = target.replace(/\s+/g, '')
      if (norm === '第一章' || norm === '第1章' || norm.startsWith('第一章')
        || norm.startsWith('第1章')) {
        return { run_id: '第一章', action: 'cached' } as unknown as T
      }
      throw new ApiError(400, `演示版仅内置「第一章」的完整分析成果（输入"第一章"可查看）。`
        + `如需分析任意章节，请在本机运行完整版 ./start.sh。`)
    }
    return staticRequest<T>(path)
  }
  const headers = new Headers(init?.headers)
  const token = getTeacherToken()
  if (token && path !== '/teacher/login') headers.set('X-Teacher-Token', token)
  const resp = await rawFetch(path, { ...init, headers })
  if (resp.status === 401 && path !== '/teacher/login') setTeacherToken('')
  let body: Record<string, unknown> = {}
  try {
    const parsed: unknown = await resp.json()
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>
    }
  } catch {
    /* 非 JSON 响应 */
  }
  if (!resp.ok || body.ok === false) {
    // 后端错误有两种形态：业务错误 {error} 与 FastAPI HTTPException {detail}
    const detail = body.detail as { message?: string } | string | undefined
    const msg =
      (typeof body.error === 'string' && body.error) ||
      (typeof detail === 'string' && detail) ||
      (detail && typeof detail === 'object' && detail.message) ||
      `请求失败（HTTP ${resp.status}）`
    throw new ApiError(resp.status, msg as string, body)
  }
  if (body.ok !== true || !Object.prototype.hasOwnProperty.call(body, 'data')) {
    throw new ApiError(resp.status, '服务返回的数据不完整，请稍后刷新重试。', body)
  }
  return body.data as T
}

export const api = {
  health: () => request<Health>('/health'),

  listProjects: () => request<ProjectInfo[]>('/projects'),

  createProject: (name: string) =>
    request<ProjectInfo>('/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),

  listFiles: (project: string) => request<SourceFile[]>(`/projects/${enc(project)}/files`),

  uploadFile: (project: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<{ name: string; pages: number }>(`/projects/${enc(project)}/files`, {
      method: 'POST',
      body: form,
    })
  },

  listRuns: (project: string) => request<RunSummary[]>(`/projects/${enc(project)}/runs`),

  analyze: (project: string, target: string, force: boolean, files?: string[]) =>
    request<{ run_id: string; action: string }>(`/projects/${enc(project)}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, force, files: files && files.length ? files : undefined }),
    }),

  status: (project: string, slug: string) =>
    request<StatusPayload>(`/projects/${enc(project)}/runs/${enc(slug)}/status`),

  result: (project: string, slug: string) =>
    request<ResultPayload>(`/projects/${enc(project)}/runs/${enc(slug)}/result`),

  cancel: (project: string, slug: string) =>
    request<{ cancelled: boolean }>(`/projects/${enc(project)}/runs/${enc(slug)}/cancel`, {
      method: 'POST',
    }),

  // ---- 教师闭环 ----
  setReview: (project: string, slug: string,
              status: 'published' | 'draft' | 'needs_review' | 'approved' | 'blocked',
              note?: string, difficulty_note?: string, teacher_confirmed?: boolean) =>
    request<unknown>(`/projects/${enc(project)}/runs/${enc(slug)}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, note, difficulty_note, teacher_confirmed }),
    }),

  teacherNote: (project: string, slug: string, body:
    { note?: string; difficulty_note?: string; task?: string }) =>
    request<unknown>(`/projects/${enc(project)}/runs/${enc(slug)}/teacher-note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  deleteQuestion: (project: string, slug: string, qid: string) =>
    request<unknown>(`/projects/${enc(project)}/runs/${enc(slug)}/questions/${enc(qid)}`, {
      method: 'DELETE',
    }),

  updateQuestion: (project: string, slug: string, qid: string, patch: Record<string, unknown>) =>
    request<unknown>(`/projects/${enc(project)}/runs/${enc(slug)}/questions/${enc(qid)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch }),
    }),

  submitLearningReport: (project: string, slug: string, data: unknown) =>
    request<{ saved: string }>(`/projects/${enc(project)}/runs/${enc(slug)}/learning-reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    }),

  listLearningReports: (project: string, slug: string) =>
    request<LearningReportSummary[]>(`/projects/${enc(project)}/runs/${enc(slug)}/learning-reports`),

  updateLearningPlan: (project: string, slug: string, patch: Record<string, unknown>,
                       teacherToken?: string) =>
    request<unknown>(`/projects/${enc(project)}/runs/${enc(slug)}/learning-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Teacher-Token': teacherToken || '' },
      body: JSON.stringify({ patch, teacher_token: teacherToken }),
    }),

  teacherLogin: (password: string) =>
    request<{ token: string; expires_in: number }>('/teacher/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }),
}

function enc(s: string): string {
  return encodeURIComponent(s)
}
