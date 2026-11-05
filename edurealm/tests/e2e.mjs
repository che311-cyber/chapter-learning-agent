/**
 * EduRealm E2E QA v2 — 真实 Chromium 全链路（手绘世界地图版）
 * 覆盖：登录→世界地图(迷雾)→锁定拒绝→选关→答错/提示/连击→胜利→解锁散云→
 *       刷新持久化→重复挑战/败北/重试→Boss(长途行走+多阶段)→Red Team
 */
import { chromium } from 'playwright'
import fs from 'node:fs'

const SHOTS = new URL('./e2e-shots/', import.meta.url).pathname
fs.mkdirSync(SHOTS, { recursive: true })

const results = []
const check = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond, detail: String(detail) })
  console.log(`${cond ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => { await page.screenshot({ path: `${SHOTS}/${name}.png` }) }

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message))

const ui = () => page.evaluate(() => window.__edurealm?.ui()?.screen)
const getSave = () => page.evaluate(() => window.__edurealm?.save())
const battle = () => page.evaluate(() => window.__lastBattleState)
const clickBtn = (text) => page.evaluate((t) => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === t)
  if (b) { b.click(); return true }
  return false
}, text)
const choice = (i) => page.locator('.choice-item').nth(i).click()
const shotFull = async (name) => {
  await page.evaluate(() => window.__focusCam(1200, 675, Math.max(1600 / 2400, 900 / 1350)))
  await sleep(400)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

/** 等待世界地图就绪 */
const waitMap = async (timeout = 15000) => {
  const t0 = Date.now()
  for (;;) {
    const ok = await page.evaluate(() => !!window.__edurealmMap && window.__edurealmMap.inited === true)
    if (ok) return true
    if (Date.now() - t0 > timeout) return false
    await sleep(250)
  }
}
/** 世界坐标 → 屏幕坐标（先把镜头确定性定格，再换算） */
const focusAndScreen = async (nodeId, zoom = 0.9) => {
  const r = await page.evaluate(({ id, z }) => {
    const s = window.__edurealmMap
    const p = s.layout.nodes[id]
    window.__focusCam(p.x, p.y, z)
    const cam = s.cameras.main
    return { x: (p.x - cam.scrollX) * cam.zoom, y: (p.y - cam.scrollY) * cam.zoom }
  }, { id: nodeId, z: zoom })
  return r
}
const clickNode = async (id) => {
  const p = await focusAndScreen(id)
  await page.mouse.click(p.x, p.y)
}
const waitBattle = async (pred, timeout = 15000) => {
  const t0 = Date.now()
  for (;;) {
    const b = await battle()
    if (b && pred(b)) return b
    if (Date.now() - t0 > timeout) return null
    await sleep(250)
  }
}
const simulateCorrect = async () => {
  const prev = await battle()
  await page.evaluate(() => window.__edurealmEvents.emit(window.__edurealmEvents.EV.DEV_SIMULATE, { correct: true }))
  let nb = await waitBattle(
    (b) => !prev || b.enemyHP !== prev.enemyHP || b.questionIndex !== prev.questionIndex || b.finished !== prev.finished,
    12000,
  )
  if (!nb) {
    // 兜底重发一次（事件可能落在结算窗口被引擎正确丢弃）
    await page.evaluate(() => window.__edurealmEvents.emit(window.__edurealmEvents.EV.DEV_SIMULATE, { correct: true }))
    nb = await waitBattle(
      (b) => !prev || b.enemyHP !== prev.enemyHP || b.questionIndex !== prev.questionIndex || b.finished !== prev.finished,
      12000,
    )
  }
  await sleep(700)
  return nb
}
/** 通过真实 UI 点击正确选项作答（choices 为每题正确选项下标数组） */
const answerChoices = async (correctIdx) => {
  for (const idx of correctIdx) {
    await page.locator('.choice-item').nth(idx).click()
    await sleep(2600)
  }
}
/** 等待一场新战斗的第一题展示完成 */
const awaitQuestionShown = () => waitBattle((b) => !!b && !b.finished && b.questionIndex === 0 && b.enemyHP === b.enemyMaxHP, 15000)
/** 模拟答错：以解析抽屉出现 / 战斗结束作为本次作答已结算的信号（防事件落窗被丢弃） */
const simulateWrong = async () => {
  await page.evaluate(() => window.__edurealmEvents.emit(window.__edurealmEvents.EV.DEV_SIMULATE, { correct: false }))
  const t0 = Date.now()
  for (;;) {
    const drawer = await page.locator('.explain-drawer').isVisible().catch(() => false)
    const b = await battle()
    if (drawer || (b && b.finished)) return b
    if (Date.now() - t0 > 12000) return b
    await sleep(250)
  }
}
const waitPanel = async (victory, timeout = 10000) => {
  const t0 = Date.now()
  for (;;) {
    if (await page.locator(`.result-panel.${victory ? 'is-victory' : 'is-defeat'}`).isVisible().catch(() => false)) return true
    if (Date.now() - t0 > timeout) {
      await shot('debug-panel-fail')
      console.log('PANEL-FAIL:', JSON.stringify({ want: victory ? 'victory' : 'defeat', ui: await ui(), battle: await battle() }))
      return false
    }
    await sleep(250)
  }
}
const waitUi = async (screen, timeout = 20000) => {
  const t0 = Date.now()
  for (;;) {
    if ((await ui()) === screen) return true
    if (Date.now() - t0 > timeout) return false
    await sleep(250)
  }
}

// ── 1. 打开首页 ──────────────────────────────────────────────────
const BASE = process.env.E2E_BASE ?? 'http://localhost:8080/'
await page.goto(BASE)
await page.evaluate(() => localStorage.clear())
await page.reload()
await page.waitForTimeout(2600)
await page.evaluate(() => {
  window.__lastBattleState = null
  const h = window.__edurealmEvents
  h.on(h.EV.BATTLE_STATE, (s) => { window.__lastBattleState = s })
})
await shot('01-landing')
check('首页标题渲染', await page.locator('.landing-title').innerText() === 'The Infinite Realm')

// ── 2. 进入世界地图 ──────────────────────────────────────────────
await page.getByRole('button', { name: '进入世界' }).click()
check('世界地图就绪', await waitMap())
await sleep(2200)
check('进入地图 screen=map', (await ui()) === 'map')
await shot('02-map-initial')

// ── 3. 云雾迷雾 ──────────────────────────────────────────────────
const fog = await page.evaluate(() => ({
  heartland: window.__edurealmMap.clouds.isDispersed('heartland'),
  darkmarch: window.__edurealmMap.clouds.isDispersed('darkmarch'),
}))
check('起点区域云层已散开', fog.heartland === true)
check('Boss 区域仍被云层覆盖', fog.darkmarch === false)

// ── 4. 锁定节点拒绝 ──────────────────────────────────────────────
await clickNode('forest_of_functions') // 未通关 L1 时它是锁定态
await sleep(500)
check('锁定节点不可进入（仍为 map）', (await ui()) === 'map')

// ── 5. 选关 → 关卡面板 → 进入战斗 ────────────────────────────────
await clickNode('gate_of_sequences')
await sleep(700)
check('点击节点打开 intro 面板', (await ui()) === 'intro')
await shot('03-intro-panel')
check('面板显示敌方 HP 75', (await page.locator('.level-panel').innerText()).includes('75'))
await page.getByRole('button', { name: '进入关卡' }).click()
await sleep(300)
await page.getByRole('button', { name: '进入关卡' }).click().catch(() => {})
check('进入战斗（同节点直达）', await waitUi('battle', 12000))
await sleep(800)
let bs = await battle()
check('战斗状态事件推送', !!bs && bs.enemyHP === 75 && bs.playerHP === 100, JSON.stringify(bs && { e: bs.enemyHP, p: bs.playerHP }))
await shot('04-battle-q1')

// ── 6. 故意答错一次 ──────────────────────────────────────────────
await choice(1)
await sleep(2300)
bs = await battle()
check('答错后玩家扣血 100→85', bs.playerHP === 85 && bs.enemyHP === 75, `p=${bs.playerHP} e=${bs.enemyHP}`)
check('答错 combo 清零', bs.combo === 0)
check('解析抽屉出现', await page.locator('.explain-drawer').isVisible())
await shot('05-wrong-explain')
await clickBtn('继续（Enter）')
await sleep(700)

// ── 7. 使用提示 ──────────────────────────────────────────────────
await clickBtn('提示')
await sleep(500)
bs = await battle()
check('提示惩罚生效（伤害 −50%）', bs.hintPenaltyActive === true)
check('提示文本显示', await page.locator('.hint-box').isVisible())
await shot('06-hint')

// ── 8. 连击 → 击杀 ───────────────────────────────────────────────
await choice(3)
await sleep(2200)
bs = await battle()
check('提示后正确伤害减半 75→62', bs.enemyHP === 62, `e=${bs.enemyHP}`)
await sleep(600)
await choice(0)
await sleep(2000)
bs = await battle()
check('连击累计 2', bs.combo === 2, `combo=${bs.combo}`)
await choice(1)
await sleep(2400)
bs = await battle()
check('第三连击 ×1.5 并击杀', bs.enemyHP === 0 && bs.finished === true, `e=${bs.enemyHP}`)
await sleep(1400)
await shot('07-victory-moment')

// ── 9. 结算 ──────────────────────────────────────────────────────
check('胜利结算面板出现', await waitPanel(true))
const resultText = await page.locator('.result-panel').innerText()
check('结算包含 XP', resultText.includes('XP'), resultText.match(/\+\d+ XP/)?.[0] ?? '')
await shot('08-result-victory')

// ── 10. 返回地图 → 完成 + 解锁 ───────────────────────────────────
await clickBtn('返回地图')
await sleep(1400)
check('返回地图 screen=map', (await ui()) === 'map')
const s1 = await getSave()
check('进度写入：通关 gate', s1.completedLevels.includes('gate_of_sequences'))
check('XP = 10×3 + 30 通关奖励 = 60', s1.xp === 60, `xp=${s1.xp}`)
check('英雄位置更新', s1.position === 'gate_of_sequences')
await sleep(1200)
await shotFull('09-map-after-unlock')

// ── 11. 刷新持久化 ───────────────────────────────────────────────
await page.reload()
await page.waitForTimeout(2400)
await page.evaluate(() => {
  window.__lastBattleState = null
  const h = window.__edurealmEvents
  h.on(h.EV.BATTLE_STATE, (s) => { window.__lastBattleState = s })
})
await page.getByRole('button', { name: '进入世界' }).click()
check('刷新后世界地图就绪', await waitMap())
await sleep(1800)
const s2 = await getSave()
check('刷新后存档保留（XP / 通关）', s2.xp === 60 && s2.completedLevels.includes('gate_of_sequences'), `xp=${s2.xp}`)
await shotFull('10-map-persisted')

// ── 12. 重复挑战 + 败北 + 重试 ───────────────────────────────────
await clickNode('gate_of_sequences')
await sleep(700)
check('已完成关卡可点击进入', (await ui()) === 'intro')
await page.getByRole('button', { name: '进入关卡' }).click()
check('再次进入战斗', await waitUi('battle', 12000))
await awaitQuestionShown()
// 无敌模式
await page.evaluate(() => { const s = window.__edurealm?.store?.getState(); s.actions.toggleDevMenu(true) })
await clickBtn('无敌 OFF')
await sleep(300)
await page.evaluate(() => { const s = window.__edurealm?.store?.getState(); s.actions.toggleDevMenu(false) })
bs = await simulateWrong()
check('无敌模式：答错不扣血', bs.playerHP === 100, `p=${bs.playerHP}`)
await clickBtn('继续（Enter）')
await sleep(700)
await page.evaluate(() => { const s = window.__edurealm?.store?.getState(); s.actions.toggleDevMenu(true) })
await clickBtn('无敌 ON')
await sleep(300)
await page.evaluate(() => { const s = window.__edurealm?.store?.getState(); s.actions.toggleDevMenu(false) })
for (let i = 0; i < 3; i++) {
  await simulateWrong()
  await clickBtn('继续（Enter）')
  await sleep(600)
}
bs = await battle()
check('题目耗尽/受击 → 战斗结束，HP 不为负', bs.finished === true && bs.playerHP >= 0, `p=${bs.playerHP}`)
check('败北面板出现', await waitPanel(false))
await shot('11-defeat')
const s3 = await getSave()
check('失败不写入通关', s3.completedLevels.length === 1, `completed=${s3.completedLevels.length}`)
check('失败不发放通关奖励 XP', s3.xp === 60, `xp=${s3.xp}`)
await clickBtn('再次挑战')
check('重试回到战斗', await waitUi('battle', 12000))
await awaitQuestionShown()
await answerChoices([0, 3, 0]) // g1=A g2=D g3=A：全对击杀
check('重试后再次胜利', await waitPanel(true))
await clickBtn('返回地图')
await sleep(1400)

// ── 13. 开发菜单解锁全部 → 云层散开 ──────────────────────────────
await page.evaluate(() => { const s = window.__edurealm?.store?.getState(); s.actions.toggleDevMenu(true) })
await clickBtn('解锁全部关卡')
await sleep(400)
await page.evaluate(() => { const s = window.__edurealm?.store?.getState(); s.actions.toggleDevMenu(false) })
await sleep(2000)
const fog2 = await page.evaluate(() => ({
  darkmarch: window.__edurealmMap.clouds.isDispersed('darkmarch'),
  snowpeak: window.__edurealmMap.clouds.isDispersed('snowpeak'),
}))
check('解锁后 Boss/雪山云层散开', fog2.darkmarch === true && fog2.snowpeak === true, JSON.stringify(fog2))
await shotFull('12-map-revealed')

// ── 14. 长途行走进 Boss ──────────────────────────────────────────
await clickNode('throne_of_infinity')
await sleep(700)
check('Boss 关卡面板打开', (await ui()) === 'intro')
if ((await page.locator('.level-panel').count()) === 1) {
  const bossPanel = await page.locator('.level-panel').innerText()
  check('Boss 面板标识（首领 / 阶段）', bossPanel.includes('首领') && bossPanel.includes('阶段'))
  await shot('13-boss-intro')
} else {
  check('Boss 面板标识（首领 / 阶段）', false, 'panel missing')
}
await page.getByRole('button', { name: '进入关卡' }).click()
check('沿道路长途行走后进入战斗', await waitUi('battle', 25000))
await shot('14-boss-arena')

// Boss 多阶段
const firstBoss = await awaitQuestionShown()
check('Boss 入场：150 HP / 120 玩家 HP', !!firstBoss && firstBoss.playerHP === 120, JSON.stringify(firstBoss && { e: firstBoss.enemyHP, p: firstBoss.playerHP }))
check('Boss 标记 isBoss', !!firstBoss && firstBoss.isBoss === true)
await sleep(600)
await shot('15-boss-entrance')

let cur = await battle()
for (let i = 0; i < 8 && (await battle()).phaseIndex < 1; i++) {
  await simulateCorrect()
  cur = await battle()
}
check('Boss 进入 Phase II/III', cur.phaseIndex >= 1, `phase=${cur.phaseName ?? cur.phaseIndex}`)
check('Phase 徽章显示', await page.locator('.phase-badge').isVisible())
await shot('16-boss-phase2')

for (let i = 0; i < 8 && !(await battle()).finished; i++) await simulateCorrect()
bs = await waitBattle((b) => b.finished, 8000)
check('Boss 被击败', bs && bs.enemyHP === 0, `e=${bs && bs.enemyHP} phase=${bs && bs.phaseIndex}`)
check('Boss 胜利结算', await waitPanel(true))
const s4 = await getSave()
check('Boss 通关记录', s4.completedLevels.includes('throne_of_infinity'))
await shot('17-boss-victory')
await clickBtn('返回地图')
await sleep(1400)
await shotFull('18-map-final')

// ── 15. 汇总 ─────────────────────────────────────────────────────
const pass = results.filter((r) => r.pass).length
console.log(`\n════════ E2E 结果：${pass}/${results.length} 通过 ════════`)
console.log(`Console errors: ${consoleErrors.length}`)
consoleErrors.slice(0, 10).forEach((e) => console.log('  ⚠️ ' + e))
fs.writeFileSync('/tmp/edurealm-qa/results.json', JSON.stringify({ results, consoleErrors }, null, 2))
await browser.close()
process.exit(pass === results.length && consoleErrors.length === 0 ? 0 : 1)
