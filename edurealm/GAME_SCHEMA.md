# GAME_SCHEMA — AI 内容生成契约（下一棒必读）

> 本文档说明引擎读取的全部数据结构。
> **未来 DeepSeek 的唯一职责：为每本教材生成一份 `MapSpec` + 一组 `LevelSpec`。**
> 引擎代码中没有任何教材内容 —— 换掉这两个 JSON，就是一个新的学习游戏。

## 0. 总览

```
AI 生成 ──▶ MapSpec（世界地图：节点/连边/主题）   ──┐
AI 生成 ──▶ LevelSpec[]（每关：敌人/规则/题目）  ──┤──▶ contentService.loadWorld()
                                                    │   （运行时校验，失败给出可读错误）
存档自动 ──▶ StudentState（引擎自己维护）          ──┘
```

加载入口：`src/services/contentService.ts → loadWorld(worldId)`。
当前从 `src/data/registry.ts` 读 mock；**接 AI 时只需把这里换成 fetch，返回结构不变**。

---

## 1. MapSpec — 世界地图

```jsonc
{
  "worldId": "infinite_realm",              // 唯一 ID
  "worldName": "The Infinite Realm",        // 地图/Landing 标题（英文奇幻风）
  "subtitle": "数学分析 · 极限王国",          // 副标题（中文科目）
  "theme": {
    "environment": "fantasy-academic",      // 调色板键 → game/palette.ts
    "description": "当一门学科被理解之后，它就成为一个世界。"
  },
  "startNodeId": "gate_of_sequences",       // 起点节点（初始解锁）
  "nodes": [ /* MapNodeSpec，见下 */ ]
}
```

### MapNodeSpec（每个节点 = 一关的入口）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | ✓ | 节点唯一 ID（进度存档以它为键） |
| `name` | string | ✓ | 地图上显示的关卡名（英文奇幻风） |
| `type` | `"normal" \| "elite" \| "boss"` | ✓ | 决定图标/颜色/血条/Boss 入场 |
| `difficulty` | 1–5 | ✓ | 展示用菱形数量 |
| `description` | string | | 关卡面板中的一句话描述 |
| `levelRef` | string | ✓ | 指向 LevelSpec.id（允许 ≠ id，引擎分别传递） |
| `connections` | string[] | ✓ | **前向边**：本关通过后解锁哪些节点 |
| `prerequisites` | string[]? | | 附加门槛：这些节点**全部**通过才解锁（Boss 用） |
| `position` | `{x,y}`? | | **0..1 归一化坐标提示**，缺省时蛇形自动排布（AI 不必算像素） |

**拓扑规则（校验器强制）**：
- 所有 `connections` / `prerequisites` 引用的 id 必须存在；
- `startNodeId` 必须在 nodes 中；
- 解锁判定（实时推导，不存储）：`起点 或 任一前驱连边已完成，且 prerequisites 全部完成`。

**AI 设计建议**：主干 4–6 关线性递进；1–2 条精英支线（绕路但奖励更高）；
Boss 节点用 `prerequisites` 锁住主干关键关。

---

## 2. LevelSpec — 单个关卡

```jsonc
{
  "id": "gate_of_sequences",
  "name": "The First Gate",
  "type": "normal",                        // 与节点一致
  "description": "用最基础的数列极限唤醒石门。",
  "enemy": {
    "name": "Rune Wisp",                   // 敌人名（英文）
    "title": "符文之灵",                    // 敌人称号（中文）
    "form": "wisp",                        // 视觉形态: wisp | golem | phantom | colossus(Boss)
    "size": 1                              // 视觉缩放
  },
  "rules": { /* Partial<BattleRuleConfig>，只写差异项，见第 3 节 */ },
  "rewards": { "xpBonus": 30 },            // 通关奖励 XP（答对 XP 之外）
  "questions": [ /* Question[]，见第 4 节 */ ]
}
```

**数值配平经验**（当前 mock 采用）：
`enemyHP ≈ 答对伤害 × 题数`（全对可击杀），并留出约 1 次答错 + 1 次提示的容错
（靠 Combo ×1.5 补回）。例如 4 题关卡：enemyHP 75–80；Boss：题数×伤害 × ~0.86。

---

## 3. BattleRuleConfig — 规则（完全数据驱动）

关卡 `rules` 与 `DEFAULT_BATTLE_RULE`（`src/data/rules/defaultRules.ts`）**深合并**，只写差异：

```jsonc
{
  "playerHP": 100,
  "enemyHP": 75,
  "correct": { "damage": 25, "xp": 10 },   // 答对：对敌伤害 / 获得 XP
  "wrong":   { "playerDamage": 15 },       // 答错：自己受伤
  "combo":   { "enabled": true, "threshold": 3, "multiplier": 1.5 },
  "hint":    { "enabled": true, "damageMultiplier": 0.5 },  // 提示后下一击伤害折减
  "skill":   { "enabled": true, "name": "Insight", "description": "…",
               "chargePerCorrect": 1, "requiredCharge": 3, "multiplier": 2 },
  "phases": [                              // Boss 专属，可省略
    { "atEnemyHpPercent": 0.66, "name": "Phase II · 星核苏醒",
      "enemyDamageMultiplier": 1.4, "message": "巨像的星核开始旋转…" },
    { "atEnemyHpPercent": 0.33, "name": "Phase III · 湮灭形态",
      "enemyDamageMultiplier": 1.8 }
  ]
}
```

**引擎语义（已单测覆盖）**：
- 乘区：`伤害 = correct.damage ×(提示折减)×(combo 倍率)×(技能倍率)`，连击/技能可叠乘；
- Hint / Skill 的倍率是一次性窗口，下一次作答后无论对错都消耗；
- `phases` 只向更高阶段跳转；敌人在跨阈值瞬间死亡则不再触发；
- 全局难度再乘一层：轻松受伤 ×0.6/XP ×0.8，严苛受伤 ×1.5/XP ×1.3；
- 战斗结束后拒绝重复结算（`finished` 守卫，防 Boss 双死/重复计分）；
- 题目耗尽仍未击杀 → `exhausted` 判负（自包含判定，不依赖外部推进）。

**未来不同教材/关卡完全可以给出不同的规则组合**（关闭提示、高连击倍率、双阶段 Boss…），引擎不改一行。

---

## 4. Question — 三种已实现题型 + 扩展位

### 4.1 single_choice（选择）
```jsonc
{
  "id": "g1", "type": "single_choice",
  "prompt": "数列 1, 1/2, 1/3, … 当 n → ∞ 时的极限是？",
  "options": ["0", "1", "不存在", "∞"],
  "answer": 0,                    // 正确选项下标
  "hint": "分母越来越大…",         // 可选；无 hint 字段则面板不显示提示按钮
  "explanation": "n → ∞ 时 1/n → 0…", // 可选；答错时展示
  "difficulty": 1
}
```

### 4.2 ordering（排序/步骤题）
```jsonc
{
  "id": "c2", "type": "ordering",
  "prompt": "用 ε-δ 定义证明 lim f(x) = A。请按正确顺序排列证明步骤：",
  "items": [            // ← 按【正确顺序】给出；运行时 UI 自动打乱
    "任意给定 ε > 0", "寻找（构造）δ > 0",
    "当 0 < |x − x₀| < δ 时", "都有 |f(x) − A| < ε 成立"
  ],
  "hint": "…", "explanation": "…"
}
```

### 4.3 open_input（开放输入/计算题）
```jsonc
{
  "id": "b1", "type": "open_input",
  "prompt": "lim(x→∞) (2x² + 1)/(x² − 3) = ?",
  "answers": ["2"],           // 任一匹配即正确
  "numeric": true,            // 数值模式：支持 "0.5" / "1/2"，容差比较
  "tolerance": 0.000001,      // 可选
  "hint": "…", "explanation": "…"
}
```
文本模式（`numeric` 省略）：答案做归一化比较（忽略大小写/空白/标点，`e^2` ≡ `e2` ≡ `E²`）。

### 4.4 未来扩展（schema 已预留方向，见 ARCHITECTURE §5）
`multiple_choice` / `matching` / `dialogue`（AI 对话） / `drag_and_drop`。
新增 = Question 联合 + evaluator + 渲染器三处，引擎零改动。

---

## 5. StudentState — 玩家存档（引擎自动维护，AI 不生成）

```jsonc
{
  "version": 1,
  "worldId": "infinite_realm",
  "xp": 60,
  "completedLevels": ["gate_of_sequences"],
  "position": "gate_of_sequences",       // 英雄站立的节点
  "levelStats": {
    "gate_of_sequences": { "attempts": 2, "clears": 1, "bestAccuracy": 0.75,
                            "correct": 3, "wrong": 1, "hintsUsed": 1 }
  },
  "settings": { "difficulty": "normal", "muted": false },
  "devUnlockAll": false
}
```
持久化：localStorage `edurealm-save-v1`。解锁状态**不存储**，由 `progression.ts` 每次推导。

---

## 6. AI 生成 Checklist

- [ ] 每本教材一份 MapSpec：节点数 6–10，含 ≥1 条支线与 1 个 Boss
- [ ] 每个 MapNodeSpec 的 `levelRef` 都有对应 LevelSpec，且 `id` 一致
- [ ] Boss 节点配置 `prerequisites`（主干关键关）
- [ ] 题目类型混配：不要 9 关全选择题；排序题适合"证明步骤/流程"，open_input 适合计算
- [ ] 每题尽量给 `hint` 与 `explanation`（游戏性 + 教学价值的核心）
- [ ] 数值配平按第 2 节经验；`rules` 只写与默认的差异
- [ ] 中文题面 + 英文奇幻风命名（世界/关卡/敌人）
- [ ] 内容经 `validateMapSpec` / `validateLevelSpec` 校验通过（错误信息会精确到字段）

## 7. 一个最小可玩示例（2 关 + Boss）

见 `src/data/worlds/infinite_realm.ts` 与 `src/data/levels/infinite_realm_levels.ts`
—— 即本仓库的运行中 mock，直接照抄结构替换内容即可。
