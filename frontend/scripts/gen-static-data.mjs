/**
 * 重新生成 public/static-data/abstract-algebra.json（静态部署的内置演示数据）。
 * 数据来源：projects/abstract-algebra/ 的真实分析产物（workspace + output + input 元信息）。
 * 运行：node scripts/gen-static-data.mjs（在 frontend/ 下），然后 npm run build && wrangler pages deploy dist
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')
// 演示项目名与内容一致性：使用与数据实际匹配的项目（abstract-algebra 的示例教材配套数据）
const WS = path.join(ROOT, 'projects/abstract-algebra/workspace/第一章')
const OUT = path.join(ROOT, 'projects/abstract-algebra/output/第一章')
const INPUT = path.join(ROOT, 'projects/abstract-algebra/input/sample_abstract_algebra.md')
const read = (f) => JSON.parse(fs.readFileSync(path.join(WS, f), 'utf8'))

const events = fs.readFileSync(path.join(WS, 'events.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l))
const state = read('state.json')
const stat = fs.statSync(INPUT)

const bundle = {
  generated_at: new Date().toISOString(),
  note: '静态演示模式内置数据：示例教材《抽象代数》第一章（Chapter Agent 真实运行产物）',
  projects: [{ name: 'abstract-algebra', file_count: 1 }],
  files: [{
    name: 'sample_abstract_algebra.md', size: stat.size, ext: '.md',
    pages: 3, parse_ok: true, mtime: Math.round(stat.mtimeMs / 1000),
  }],
  runs: [{ slug: '第一章', target: '第一章', status: 'COMPLETE', error: null,
    updated_at: Math.round(Date.now() / 1000) }],
  status: {
    run_id: '第一章', project: 'abstract-algebra', target: state.target,
    phase: state.status, running: false, flags: state.flags,
    error: null, located: state.located,
    events_total: events.length, events,
  },
  result: {
    run_id: '第一章', status: state.status, target: state.target, located: state.located,
    chapter_context: read('chapter_context.json'),
    learning_plan: read('learning_plan.json'),
    question_pool: read('question_pool.json'),
    qa_report: read('qa_report.json'),
    verification: read('verification.json'),
    markdown: {
      'learning_plan.md': fs.readFileSync(path.join(OUT, 'learning_plan.md'), 'utf8'),
      'questions.md': fs.readFileSync(path.join(OUT, 'questions.md'), 'utf8'),
      'final_report.md': fs.readFileSync(path.join(OUT, 'final_report.md'), 'utf8'),
    },
    files: {
      workspace: ['chapter_context.json', 'learning_plan.json', 'question_pool.json',
        'qa_report.json', 'verification.json', 'state.json'],
      output: ['learning_plan.md', 'questions.md', 'final_report.md'],
    },
  },
}

const dest = path.join(import.meta.dirname, '../public/static-data/abstract-algebra.json')
fs.writeFileSync(dest, JSON.stringify(bundle, null, 1))
const srcOut = path.join(import.meta.dirname, '../src/generated/staticBundle.json')
fs.mkdirSync(path.dirname(srcOut), { recursive: true })
fs.writeFileSync(srcOut, JSON.stringify(bundle))
console.log('written', dest, Math.round(fs.statSync(dest).size / 1024) + 'KB',
  '+ inlined', Math.round(fs.statSync(srcOut).size / 1024) + 'KB')
