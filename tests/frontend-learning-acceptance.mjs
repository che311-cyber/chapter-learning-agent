import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from '../frontend/node_modules/esbuild/lib/main.js'
import React from '../frontend/node_modules/react/index.js'
import { renderToStaticMarkup } from '../frontend/node_modules/react-dom/server.node.js'

Error.stackTraceLimit = 0
const root = fileURLToPath(new URL('../frontend/', import.meta.url))
const source = fs.readFileSync(root + 'src/components/LearningSession.tsx', 'utf8')
const output = await build({
  stdin: { contents: source + '\nexport { QuestionCard, StageDone, buildFullReport };', resolveDir: root + 'src/components', loader: 'tsx' },
  bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'], define: { 'import.meta.env': '{}' },
})
const code = output.outputFiles[0].text
  .replaceAll('"react"', JSON.stringify(pathToFileURL(root + 'node_modules/react/index.js').href))
  .replaceAll('"react/jsx-runtime"', JSON.stringify(pathToFileURL(root + 'node_modules/react/jsx-runtime.js').href))
const { QuestionCard, StageDone, buildFullReport, default: LearningSession } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

const values = new Map()
globalThis.localStorage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: key => values.delete(key),
}
const question = { id: 'proof-1', type: 'proof', difficulty: 2, stage_index: 1,
  prompt: '证明有限等比求和公式', answer: '错位相减，q≠1。', explanation: '分情况讨论。',
  learning_objective: '证明公式', source_basis: ['lecture.md P1'] }
const props = { q: question, indexInStage: 1, totalInStage: 1,
  onPick() {}, onSelfAssess() {}, onNext() {} }
for (const assessment of [true, false]) {
  const html = renderToStaticMarkup(React.createElement(QuestionCard, { ...props, selfAssessment: assessment }))
  assert.match(html, /已记录自评/)
  assert.match(html, /不计入客观正确率/)
  const next = html.match(/<button[^>]*>下一题 →<\/button>/)?.[0]
  assert.ok(next && !next.includes('disabled'), '证明题自评后必须能继续，包括“没答上”')
}
const unanswered = renderToStaticMarkup(React.createElement(QuestionCard, props))
assert.match(unanswered.match(/<button[^>]*>下一题 →<\/button>/)?.[0] || '', /disabled/)

const plan = { chapter: '测试章节', learning_objectives: ['证明公式'], mastery_criteria: ['能独立证明'],
  learning_sequence: [{ stage: 1, name: '证明', goal: '证明公式', content: [] }] }
values.set('cla-learning:p:ch', JSON.stringify({ idx: 2, totalSteps: 4, results: {},
  picked: {}, mastery: {}, selfReports: { 'proof-1': false } }))
const restored = renderToStaticMarkup(React.createElement(LearningSession, {
  project: 'p', slug: 'ch', plan, pool: { chapter: '测试章节', questions: [question] }, onExit() {},
}))
assert.match(restored, /已记录自评/)
assert.doesNotMatch(restored.match(/<button[^>]*>下一题 →<\/button>/)?.[0] || 'disabled', /disabled/)
const current = buildFullReport({ project: 'p', target: plan.chapter, plan,
  pool: { chapter: plan.chapter, questions: [question] } }, 'ch', {
  idx: 4, totalSteps: 4, results: {}, picked: {}, mastery: { 0: true }, selfReports: { 'proof-1': true },
})
assert.equal(current.data.learning.progressPct, 100)
assert.equal(current.data.learning.selfReportedCorrect, 1)
assert.equal(current.data.learning.mastery[0].checked, true)
assert.match(current.markdown, /\[x\] 能独立证明/)
values.set('game_state__p__ch', JSON.stringify({ xp: 20 }))
const legacyGame = buildFullReport({ project: 'p', target: plan.chapter, plan, pool: null }, 'ch')
assert.equal(legacyGame.data.game.xp, 20)
assert.deepEqual(legacyGame.data.game.completedLevels, [])
const summary = renderToStaticMarkup(React.createElement(StageDone, {
  deck: { stages: [{ stage: { stage: 2, name: '本阶段' }, questions: [{ id: 'choice' }, question] },
    { stage: { stage: 5, name: '下一阶段' }, questions: [] }] }, si: 0,
  results: { choice: 'correct' }, selfReports: { 'proof-1': false }, isLast: false,
  onNext() {}, onReviewWrong() {},
}))
assert.match(summary, /客观作答：1\/1 题答对/)
assert.match(summary, /自评：0\/1 题已掌握，1 题需要复习/)
assert.match(summary, /进入阶段 5/)
assert.doesNotMatch(summary, /1\/2 题掌握/)
console.log('学习流程验收通过：自评继续与恢复、客观统计分离、导出使用最新进度与自查（无真实 API）。')
