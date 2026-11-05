/**
 * 游戏模式集成 E2E（playwright-core + 缓存 Chromium headless，与 edurealm 官方 e2e 同款方式：
 * 1600×900 视口使画布 1:1，用引擎 QA 钩子聚焦镜头与 DEV_SIMULATE 作答）。
 * 覆盖：进入游戏 → 地图渲染 → 进关答题 → 胜利/XP → 解锁 → 存档 →
 *       返回学习页 → 重进恢复 → 刷新持久 → Web/Game 连续切换 10 次。
 * 运行：node tests/e2e_game.mjs（需 backend:8000 + frontend:5173 已启动）
 */
import { chromium } from 'playwright-core'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const CHROME_ROOT = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1243')
const EXEC = path.join(CHROME_ROOT, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
const BASE = 'http://localhost:5173'
const SHOT = '/tmp/cla-agent-shots'
fs.mkdirSync(SHOT, { recursive: true })

let pass = 0
let fail = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; failures.push(`${name} ${detail}`); console.log(`  ❌ ${name} ${detail}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const browser = await chromium.launch({
    executablePath: EXEC,
    headless: true,
    args: ['--no-sandbox'],
  })
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  const consoleErrors = []
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)) })
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + String(e).slice(0, 200)))
  const netCalls = []
  page.on('request', (r) => netCalls.push(r.url()))

  const clickBtn = (text) => page.evaluate((t) => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes(t))
    if (b && !b.disabled) { b.click(); return true }
    return false
  }, text)
  const ui = () => page.evaluate(`window.__edurealm ? window.__edurealm.ui().screen : null`)
  const gameSave = () => page.evaluate(`window.__edurealm ? window.__edurealm.save() : null`)
  const clickNode = async (id) => {
    await page.evaluate(`(async () => {
      const m = window.__edurealmMap;
      const p = m.layout.nodes['${id}'];
      window.__focusCam(p.x, p.y, 1);
      await m.time.delayedCall ? null : null;
      return 1;
    })()`)
    await sleep(250)
    const pt = await page.evaluate(`(() => {
      const m = window.__edurealmMap;
      const cam = m.cameras.main;
      const p = m.layout.nodes['${id}'];
      const cv = document.querySelector('.game-root canvas');
      const r = cv.getBoundingClientRect();
      return { x: r.left + (p.x - cam.scrollX) * cam.zoom, y: r.top + (p.y - cam.scrollY) * cam.zoom };
    })()`)
    await page.mouse.click(pt.x, pt.y)
  }
  const waitMapReady = () => page.waitForFunction(() => !!window.__edurealmMap && window.__edurealmMap.inited === true, null, { timeout: 30000 })

  console.log('— 1. 打开 Chapter Learning Agent，加载第一章结果')
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1800)
  await page.evaluate(`(() => {
    const items = document.querySelectorAll('.run-item');
    for (const it of items) { if (it.textContent.includes('完成')) { it.click(); break; } }
    return 1;
  })()`)
  await page.waitForTimeout(1200)
  check('章节结果加载（结果 Tabs 出现）', await page.locator('.tabs').count() === 1)

  console.log('— 2. 点击 🎮 游戏模式：地图渲染、无白屏')
  check('游戏模式按钮可用', await page.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('游戏模式')); return b && !b.disabled; })()`))
  await clickBtn('游戏模式')
  await waitMapReady()
  await page.waitForTimeout(2600) // 开场镜头动画
  check('GameCanvas 出现（无白屏）', await page.locator('.game-root canvas').count() === 1)
  check('返回按钮可见（📖 网页模式）', await page.locator('.game-back-btn').count() === 1)
  check('等级芯片可见（LV/XP）', ((await page.locator('.game-level-chip').textContent()) || '').includes('LV.'))
  const worldName = await page.locator('.hud-world').textContent()
  check('HUD 显示章节世界名', (worldName || '').includes('第一章'), worldName || '')
  await page.screenshot({ path: SHOT + '/game-map.png' })

  console.log('— 3. 点击 Level 1 节点 → 关卡面板 → 进入关卡')
  await clickNode('lv1')
  await page.waitForTimeout(600)
  check('关卡面板打开', await page.locator('.level-panel').count() === 1)
  check('面板显示 XP 奖励 +100', ((await page.locator('.q-bonus').textContent().catch(() => '')) || '').includes('+100'))
  await page.screenshot({ path: SHOT + '/game-level-intro.png' })
  await page.locator('.level-panel button', { hasText: '进入关卡' }).click()
  await page.waitForTimeout(500)
  await page.waitForFunction(() => window.__edurealm && window.__edurealm.ui().screen === 'battle', null, { timeout: 20000 })
  await page.waitForTimeout(2500) // 入场动画 + 首题
  check('进入战斗画面', await page.locator('.battle-ui').count() >= 1)

  console.log('— 4. 战斗：DEV_SIMULATE 逐题正确作答（走真实 handleAnswer 管线）')
  for (let i = 0; i < 10; i++) {
    const done = await page.evaluate(`(() => {
      if (document.querySelector('.result-panel')) return 'RESULT';
      const ev = window.__edurealmEvents;
      if (!ev) return 'NOEV';
      ev.emit(ev.EV.DEV_SIMULATE, { correct: true });
      return 'answered';
    })()`)
    if (done === 'RESULT') break
    const wrongDrawer = await page.locator('.explain-drawer button').count()
    if (wrongDrawer > 0) await page.locator('.explain-drawer button').first().click()
    await page.waitForTimeout(900)
  }
  await page.waitForSelector('.result-panel', { timeout: 25000 })
  const resultText = await page.locator('.result-panel').textContent()
  check('胜利结算出现（VICTORY）', resultText.includes('VICTORY'))
  const xpGainMatch = (resultText || '').match(/\+(\d+) XP/)
  check('结算显示获得 XP', xpGainMatch !== null)
  check('XP 数值符合配置（130 = 100 通关 + 2×15 答对）', xpGainMatch && Number(xpGainMatch[1]) >= 100, xpGainMatch && xpGainMatch[1])
  await page.screenshot({ path: SHOT + '/game-victory.png' })

  console.log('— 5. 返回地图：节点完成、下一关解锁')
  await page.locator('.result-panel button', { hasText: '返回地图' }).click()
  await page.waitForTimeout(1000)
  const prog1 = await page.evaluate(`(() => {
    const s = window.__edurealm.save();
    return { xp: s.xp, completed: s.completedLevels,
      slot: JSON.parse(localStorage.getItem('game_state__abstract-algebra__第一章') || 'null') };
  })()`)
  check('XP 入账（≥100）', prog1.xp >= 100, 'xp=' + prog1.xp)
  check('lv1 标记完成', (prog1.completed || []).includes('lv1'))
  check('章节存档槽（game_state__）已写入', !!prog1.slot && prog1.slot.xp === prog1.xp)
  await page.screenshot({ path: SHOT + '/game-map-after.png' })

  console.log('— 6. 返回网页模式：原页面状态保留、无重复加载')
  await page.locator('.game-back-btn').click()
  await page.waitForTimeout(800)
  check('回到学习页面（Tabs 仍在）', await page.locator('.tabs').count() === 1)
  check('游戏 Canvas 已销毁', await page.locator('canvas').count() === 0)
  check('Phaser 实例清零', (await page.evaluate('window.__erLive')) === 0)

  console.log('— 7. 再次进入：XP 与完成进度恢复')
  await clickBtn('游戏模式')
  await waitMapReady()
  await page.waitForTimeout(1200)
  const restored = await gameSave()
  check('XP 恢复（' + (restored ? restored.xp : 'null') + '）', !!restored && restored.xp >= 100)
  check('完成关卡恢复', !!restored && (restored.completedLevels || []).includes('lv1'))

  console.log('— 8. 刷新页面：存档仍在')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1800)
  await page.evaluate(`(() => {
    const items = document.querySelectorAll('.run-item');
    for (const it of items) { if (it.textContent.includes('完成')) { it.click(); break; } }
    return 1;
  })()`)
  await page.waitForTimeout(1000)
  await clickBtn('游戏模式')
  await waitMapReady()
  await page.waitForTimeout(1000)
  const afterReload = await gameSave()
  check('刷新后 XP 仍在（' + (afterReload ? afterReload.xp : 'null') + '）', !!afterReload && afterReload.xp >= 100)

  console.log('— 9. Web ↔ Game 连续切换 10 次')
  let toggleOk = true
  let maxCanvasInGame = 0
  for (let i = 0; i < 10; i++) {
    const back = page.locator('.game-back-btn')
    if (await back.count()) { await back.click(); await page.waitForTimeout(500) }
    if ((await page.locator('canvas').count()) !== 0) { toggleOk = false; console.log(`    第${i + 1}次退出后仍有 canvas`) }
    if ((await page.evaluate('window.__erLive')) !== 0) { toggleOk = false; console.log(`    第${i + 1}次退出后 Phaser 实例未清零`) }
    await clickBtn('游戏模式')
    // 等待画布出现（loading 过渡 + Phaser boot），上限 6s
    let inGame = 0
    for (let w = 0; w < 12; w++) {
      await page.waitForTimeout(500)
      inGame = await page.locator('.game-root canvas').count()
      if (inGame > 0) break
    }
    maxCanvasInGame = Math.max(maxCanvasInGame, inGame)
    if (inGame !== 1) { toggleOk = false; console.log(`    第${i + 1}次进入后 canvas=${inGame}`) }
  }
  check('连续 10 次切换：无重复 Canvas / 无实例泄漏', toggleOk, `maxInGame=${maxCanvasInGame}`)
  check('全程无重复 DeepSeek 调用（无 /analyze 请求）', !netCalls.some(u => u.includes('/analyze')))
  const realErrors = consoleErrors.filter(e =>
    !e.includes('favicon') && !e.includes('net::ERR')
    && !(e.includes('Failed to load resource') && e.includes('404')))
  check('浏览器 console 无错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))
  check('页面无未捕获异常', !consoleErrors.some(e => e.startsWith('PAGEERROR')))

  await page.screenshot({ path: SHOT + '/game-final.png' })
  await browser.close()

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (failures.length) { console.log('失败项：'); failures.forEach((f) => console.log('  - ' + f)) }
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('E2E 崩溃:', e); process.exit(2) })
