import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from '../frontend/node_modules/typescript/lib/typescript.js'

const source = fs.readFileSync(new URL('../frontend/src/services/learning.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText
const { buildDeck } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/legacy_acceptance.json', import.meta.url), 'utf8')).multivariable
const assignments = [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6]
const pool = structuredClone(fixture.question_pool)
pool.questions.forEach((q, i) => { q.stage_index = assignments[i] })
let deck = buildDeck(fixture.learning_plan, pool)
assert.deepEqual(deck.stages.map(s => s.questions.length), [3, 3, 3, 3, 3, 2])
assert.equal(deck.stages[0].questions[0].id, 'q1')
assert.equal(deck.consolidation.length, 0)
assert.equal(deck.unassigned.length, 0)
pool.questions[0].stage_index = '1'
delete pool.questions[1].stage_index
pool.questions[1].source_stage_index = 1
deck = buildDeck(fixture.learning_plan, pool)
assert.equal(deck.stages[0].questions.length, 3)
pool.questions[0].stage_index = 99
deck = buildDeck(fixture.learning_plan, pool)
assert.equal(deck.unassigned[0].id, 'q1')
pool.questions[0].question_category = 'consolidation_question'
deck = buildDeck(fixture.learning_plan, pool)
assert.equal(deck.consolidation[0].id, 'q1')
assert.equal(deck.stages[0].questions.some(q => q.id === 'q7'), false)
console.log('前端阶段映射验收通过：17 题、6 阶段；旧字段、无效阶段与综合题分类正常。')
