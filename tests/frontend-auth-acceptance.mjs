import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from '../frontend/node_modules/typescript/lib/typescript.js'

Error.stackTraceLimit = 0

const storage = () => {
  const values = new Map()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  }
}
globalThis.localStorage = storage()
globalThis.sessionStorage = storage()
let rejectToken = false
const requests = []
globalThis.fetch = async (url, init = {}) => {
  requests.push({ url, ...init })
  if (rejectToken) return new Response(JSON.stringify({ detail: '教师登录已过期' }), { status: 401 })
  return new Response(JSON.stringify({ ok: true, data: { token: 'mock-teacher-token', expires_in: 43200 } }))
}

const source = fs.readFileSync(new URL('../frontend/src/services/api.ts', import.meta.url), 'utf8')
  .replace("import inlineBundle from '../generated/staticBundle.json'", 'const inlineBundle = {}')
  .replaceAll('import.meta.env', '({})')
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022,
} }).outputText
const { api, ApiError, getTeacherToken, setTeacherToken, setApiBase } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

setApiBase('http://mock.invalid')
const login = await api.teacherLogin('mock-password')
assert.equal(requests.at(-1).headers.get('X-Teacher-Token'), null)
setTeacherToken(login.token)
await api.updateQuestion('p', 'ch', 'q1', { answer: 'B' })
assert.equal(requests.at(-1).headers.get('X-Teacher-Token'), 'mock-teacher-token')
assert.deepEqual(JSON.parse(requests.at(-1).body), { patch: { answer: 'B' } })
await api.setReview('p', 'ch', 'published', undefined, undefined, true)
assert.equal(JSON.parse(requests.at(-1).body).teacher_confirmed, true)
assert.equal(requests.at(-1).headers.get('X-Teacher-Token'), 'mock-teacher-token')
await api.listLearningReports('p', 'ch')
assert.equal(requests.at(-1).headers.get('X-Teacher-Token'), 'mock-teacher-token')
rejectToken = true
await assert.rejects(api.listLearningReports('p', 'ch'), error => error instanceof ApiError && error.status === 401)
assert.equal(getTeacherToken(), '')
rejectToken = false
setTeacherToken('mock-token-for-first-backend')
setApiBase('http://other-mock.invalid')
assert.equal(getTeacherToken(), '')
// 服务已接收写操作但客户端断线时，不能自动重放造成重复数据。
setApiBase('')
let writes = 0
globalThis.fetch = async (url, init = {}) => {
  assert.ok(init.signal, '每个请求均应有等待上限')
  if (url.endsWith('/api/health')) return new Response(JSON.stringify({ ok: true, data: {} }))
  writes += 1
  throw new TypeError('Mock connection reset after submission')
}
await assert.rejects(api.createProject('Mock project'), error => error instanceof ApiError && /尚未确认/.test(error.message))
assert.equal(writes, 1)

// 自动探测到同源恢复后，GET 可以重试一次。
let reads = 0
globalThis.fetch = async (url, init = {}) => {
  assert.ok(init.signal)
  if (url.endsWith('/api/health')) return new Response(JSON.stringify({ ok: true, data: {} }))
  reads += 1
  if (reads === 1) throw new TypeError('Mock temporary disconnect')
  return new Response(JSON.stringify({ ok: true, data: [] }))
}
assert.deepEqual(await api.listProjects(), [])
assert.equal(reads, 2)

setApiBase('http://mock.invalid')
for (const response of ['<html>Proxy unavailable</html>', 'null', '[]']) {
  globalThis.fetch = async () => new Response(response)
  await assert.rejects(api.listProjects(), error => error instanceof ApiError && /不完整/.test(error.message))
}
const blocked = { getItem() { throw new Error('Storage blocked') },
  setItem() { throw new Error('Storage blocked') }, removeItem() { throw new Error('Storage blocked') } }
globalThis.localStorage = blocked
globalThis.sessionStorage = blocked
setApiBase('http://storage-disabled.invalid')
globalThis.fetch = async (url) => {
  assert.ok(url.startsWith('http://storage-disabled.invalid/'))
  return new Response(JSON.stringify({ ok: true, data: [] }))
}
assert.deepEqual(await api.listProjects(), [])
console.log('教师前后端协议验收通过：登录、请求头、确认发布、过期清理和切换后端均正常（全 Mock）。')
