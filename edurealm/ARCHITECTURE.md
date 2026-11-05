# ARCHITECTURE — EduRealm 游戏引擎 V0

## 1. 总体架构

```
┌────────────────────────────  React 层（DOM UI）────────────────────────────┐
│  Landing   HUD   MapInfoPanel   BattlePanels(题目/解析/技能)   Result      │
│                        DevMenu / JsonModal / Toast                        │
└──────────────△───────────────────────────△───────────────────────────────┘
               │ useEvent(EventBus)         │ useGameStore(zustand)
               │                            │
┌──────────────┴───────────────────────────┴───────────────────────────────┐
│                             全局状态（唯一事实源）                          │
│   save: StudentState（persist → localStorage）   ui: 界面状态（不持久化）   │
│   progression.ts: deriveNodeStatuses(map, save) —— 解锁状态全部实时推导      │
└──────────────△───────────────────────────△───────────────────────────────┘
               │ getState()                 │ EV.* 事件（命令/动画）
┌──────────────┴───────────────────────────┴───────────────────────────────┐
│                             Phaser 层（游戏世界）                          │
│  BootScene ──▶ WorldMapScene ──launch/pause──▶ BattleScene                │
│  world/: worldPainter(整世界 canvas 手绘) · LevelSite(建筑即关卡)           │
│          CloudLayer(云雾迷雾) · ambient(环境动画) · biomes · shapes        │
│  map/:   computeLayout(归一化锚点 → 世界坐标)                              │
│  entities/: Hero · EnemyFactory(4 形态)      rules/: BattleEngine(纯逻辑)  │
│  fx/: 粒子/伤害数字/程序化纹理                audio/: WebAudio 合成音效       │
└───────────────────────────△──────────────────────────────────────────────┘
                             │ loadWorld() / loadLevel()
┌───────────────────────────┴──────────────────────────────────────────────┐
│  contentService（内容唯一入口）→ validate（运行时校验）→ data/（mock 内容）  │
│  未来：fetch(AI API) 返回同样的 WorldBundle —— 游戏零改动                    │
└───────────────────────────────────────────────────────────────────────────┘
```

**分工原则**

| 关注点 | 归属 | 说明 |
| --- | --- | --- |
| 数据事实源 | `state/gameStore.ts` | 通关/XP/统计/设置；只有它写 localStorage |
| 解锁逻辑 | `state/progression.ts` | 纯函数；只持久化"已通关"，解锁状态实时推导 |
| 规则计算 | `game/rules/BattleEngine.ts` | 纯逻辑、无 Phaser、可单测；数值全部来自 RuleConfig |
| 作答判定 | `game/rules/evaluators.ts` | 每题型一个 evaluator 的注册器 |
| 场景编排/动画 | `game/scenes/*` | 只消费规则引擎结果，不含任何具体题目内容 |
| UI 渲染 | `components/*` | 只消费 store 与 EventBus 载荷 |
| 内容 | `data/*` | 引擎零硬编码内容；AI 未来只改这里 |

**React ↔ Phaser 桥**（官方 template-react-ts 的 EventBus 模式）：

- **Event = 命令 / 动画触发**（`SUBMIT_ANSWER`、`TRAVEL_TO`、`DEV_SIMULATE`…）
- **Store = 状态**（screen、save、result）
- 场景在 `create()` 绑定事件、`shutdown` 时统一解绑（`eventBinds` 数组），杜绝重复监听。

## 2. 场景生命周期

```
BootScene: 生成程序化纹理 → 等待字体 → scene.start(WorldMapScene)

WorldMapScene（V2 手绘战役地图，世界 2400×1350 > 屏幕）:
  create → loadWorld().then(initWorld)
  initWorld:
    computeLayout（锚点 → 世界坐标，供画师与站点共用，保证对齐）
    paintWorld → 一次性手绘整张世界纹理（底色→生态区→水系→远山→山脉/峡谷
                 →道路/木桥→细节→树木→村庄/学院/风车→暗域装饰→暗角）
    LevelSite ×N（建筑即关卡，附着在地貌上，含名字木牌/状态徽章）
    CloudLayer（按 region 聚团的云雾；区域内有可进入关卡即散开）
    createAmbient（水光/瀑布/风车/火光/树冠摆动/鸟群/Boss 紫雾）
    镜头：拖拽平移 + 滚轮缩放 + 开场逐帧 centerOn 拉远（防边界漂移）
  点击建筑 → NODE_SELECTED → React 关卡面板
  面板"进入关卡" → TRAVEL_TO → BFS 寻路 → 英雄沿道路采样折线匀速行走（镜头跟随）
  到达 → ARRIVED → pause 自己 + launch BattleScene
  BattleScene 退出 → resume → 状态刷新 + 云层散开动画 + 英雄归位

BattleScene:
  create → buildArena → Hero/Enemy → 血条 → 入场动画（Boss 专属）→ 出题
  SUBMIT_ANSWER → engine.submitAnswer（规则引擎）→ 攻/防动画 → ANSWER_RESOLVED
  答错 → React 解析抽屉 → BATTLE_CONTINUE → 下一题
  敌死/玩家死/题尽 → 胜负动画 → BATTLE_OVER → Store 落账 → 结算面板
  RETRY_BATTLE → scene.restart     EXIT_BATTLE → stop + resume 地图
```

关键实现点：

- **世界绘制**：全部静态地貌绘制进一张 2400×1350 Canvas 纹理（2D API 的渐变/阴影/
  裁剪/笔触远比 Graphics 丰富），运行时只有一张 draw call；动态元素独立成层。
- **树木避让**：树木以拒绝采样散布——避开道路折线（30px）、水域圆链、建筑（96px）、
  村庄/农田矩形，保证道路永远可读。
- **桥梁自动生成**：道路采样点落入水域圆链即在该段绘制木板桥（含栏杆/桥桩/板缝）。
- **建筑即关卡**：`LevelSite` 按 `structure` 字段绘制 9 种建筑（Graphics），
  命中区手动指定并匹配显示原点；`door` 点供英雄停靠。
- **迷雾规则**：`region` 内出现 unlocked/completed 节点 → 整片云层错落散开（含区域地名浮现）；
  云朵围绕区域节点聚团（避免向邻区扩散），Boss 区域云为紫色。
- **镜头稳定性**：所有镜头动画的每帧都以 `centerOn`/follow 重申目标，
  防止边界钳制导致聚焦漂移（曾导致点击坐标错位的根因）。
- **幂等刷新**：`LevelSite.setStatus` 状态未变化时零操作，避免 resume 后重复播放动画。
- **HP 条**：引擎值 → 代理对象 tween → `onUpdate` 重绘 Graphics；Boss 血条带阶段刻度。

## 3. 事件目录（EventBus）

| 事件 | 方向 | 载荷 | 说明 |
| --- | --- | --- | --- |
| `NODE_SELECTED` | Map → React | `{nodeId, levelRef}` | 玩家点击了可进入的节点 |
| `TRAVEL_TO` | React → Map | `{nodeId}` | 面板确认进入，英雄开始行走 |
| `ARRIVED` | Map → React | `{nodeId}` | 到达，React 切 battle 屏幕 |
| `MAP_REFRESH` | Dev → Map | — | 存档变化后刷新地图状态/解锁动画 |
| `BATTLE_QUESTION` | Battle → React | `{index,total,question}` | 出题 |
| `SUBMIT_ANSWER` | React → Battle | `QuestionResponse` | 作答（Scene 有 resolving 防抖） |
| `ANSWER_RESOLVED` | Battle → React | `{correct,resolution,explanation,expected}` | 结算结果，答错时弹解析抽屉 |
| `BATTLE_CONTINUE` | React → Battle | — | 答错查看解析后继续 |
| `USE_HINT` / `HINT_RESULT` | 双向 | `{ok,text}` | 提示（规则引擎生效） |
| `USE_SKILL` | React → Battle | — | 释放技能（规则引擎生效） |
| `BATTLE_STATE` | Battle → React | 完整战斗快照 | HP/combo/充能/阶段/进度，驱动 UI |
| `BATTLE_OVER` | Battle → React(Store) | `BattleResult` | 结算落账 |
| `EXIT_BATTLE` / `RETRY_BATTLE` | React → Battle | — | 退出 / 重开 |
| `DEV_SIMULATE` / `DEV_BATTLE` | Dev → Battle | — | 模拟答对/答错 / 回血 |

## 4. 状态与持久化

- 存档键：`edurealm-save-v1`（zustand persist，`partialize` 只存 `save`）。
- 只持久化：`worldId / xp / completedLevels / position / levelStats / settings / devUnlockAll`。
- `levelStats`：每关 `{attempts, clears, bestAccuracy, correct, wrong, hintsUsed}`。
- `battleOver` 落账规则：胜利 → `completedLevels` 幂等追加 + `position` 前移 + 通关奖励 XP；失败 → 只累计作答 XP 与统计。

## 5. 扩展指南

**新增题目类型（如 matching）— 4 步：**
1. `schemas/types.ts`：扩展 `QuestionType` 联合 + 新增 Question 接口与 Response 形态；
2. `game/rules/evaluators.ts`：`evaluateAnswer` 加一个 case（纯函数）；
3. `components/questions/`：新增渲染器并在 `BattlePanels` 注册；
4. `schemas/validate.ts`：补校验。引擎与场景零改动。

**新增规则字段（如时限加成）— 3 步：**
1. `BattleRuleConfig` 加字段（含默认值）；
2. `BattleEngine` 在结算处消费；
3. `BattlePanels`/面板按需展示。UI 可完全无感。

**新增世界主题：** `game/palette.ts` 加一个调色板键，`MapSpec.theme.environment` 引用即可。

**接入 AI（最短路径）：** 重写 `services/contentService.ts` 的 `loadWorld()` 为
`fetch()` + 校验 + 返回 `WorldBundle`。store、scenes、components 全部不动。
详细 JSON 契约见 [GAME_SCHEMA.md](./GAME_SCHEMA.md)。

## 6. 技术选型记录

| 选项 | 结论 | 理由 |
| --- | --- | --- |
| Phaser 3.87（v3 终版，MIT） | ✅ 采用 | 场景/输入/补间/粒子/相机一应俱全；生态与文档最厚实；Phaser 4 已成主线但为稳妥起见 V0 锁 v3 终版，升级面集中在 `createGame.ts` 与渲染器细节 |
| PixiJS | ❌ | 需自建场景管理/输入/补间，等于重造 Phaser |
| 纯 DOM/Canvas | ❌ | 地图行走进场等游戏感成本过高 |
| zustand | ✅ | 极轻；可在 React 外 `getState()`，Phaser 直接读 |
| 依赖清单 | — | 运行时仅 `react / react-dom / phaser / zustand`，无 UI 库、无 zod（校验手写 100 行） |
