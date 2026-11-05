# EduRealm — 数据驱动教育冒险游戏引擎 V0

> 教材 → AI 理解 → `MapSpec` / `LevelSpec` / `BattleRule` → **本引擎** → 可玩的学习游戏世界
>
> 当前版本内置 mock 世界《The Infinite Realm · 极限王国》（数学分析·极限模块）：
> **6 普通关 + 2 精英支线 + 1 多阶段 Boss**，3 种交互题型，全部内容来自可替换的 JSON 配置。

![tech](https://img.shields.io/badge/React_19-TS-blue) ![tech](https://img.shields.io/badge/Phaser_3.87-game_engine-green) ![tech](https://img.shields.io/badge/Vite-build-orange)

---

## 快速开始

```bash
npm install
npm run build      # 构建生产包到 dist/
npm run start      # 以生产模式运行 → http://localhost:8080（--host 局域网可访问）
```

```bash
npm run dev        # 开发模式（HMR）→ http://localhost:5173
npm run preview    # 预览生产包 → http://localhost:4173
npm test           # 单元测试（规则引擎 / 进度推导 / 作答判定）
npm run lint       # ESLint
```

> **演示 / 试玩请用 `npm run start`（8080 端口的生产构建）。**
> 5173 只是开发热更端口，不是部署地址。运行上述命令后，可在本机 8080 端口预览。

端到端测试（需要先 `npm i -D playwright && npx playwright install chromium`，并保持 dev server 运行）：

```bash
npm run test:e2e   # 真实 Chromium 全链路：40 项断言 + 截图
```

## 世界地图（V2 · 手绘奇幻战役地图）

地图是一个 **2400×1350 的完整世界**（明显大于屏幕）：

- **生态区（biome）**：翠风林地（森林）→ 裂隙高地（山地/峡谷/黑曜岩丘）→ 镜湖之滨（湖泊/湿地）→ 霜顶山径（雪原）→ 无尽暗域（枯木/方尖碑/黑曜王城）
- **关卡即地点**：村口木门、林间哨塔、峡谷石门、黑曜神龛、跨湖石桥、遗迹书庭、秘术之塔、雪顶神庙、黑暗王城 —— 建筑本身融入地貌，状态只用小徽章（锁/星标/任务标记）表达
- **真实道路系统**：土路/石路/木板桥（自动在道路渡水处架桥），分叉汇合绕山穿林
- **云雾战争迷雾**：未解锁区域被成团云层覆盖（Boss 区域为紫云），通关后云层错落散开、新区域显现
- **环境动画**：水面波光、瀑布、风车旋转、火把闪烁、树冠摆动、鸟群、Boss 区域低压紫雾
- **镜头**：拖拽平移、滚轮缩放、开局聚焦英雄所在关卡、沿道路行走时镜头跟随

地图由 `worldPainter` 依据 `MapSpec`（节点锚点 + biome + region + structure）一次性手绘进 Canvas 纹理，
装饰物（村庄/农田/石阵/小船/营地）由种子随机生成 —— **AI 更换 MapSpec 即可获得全新世界，无需改代码**。

## 操作方式

| 操作 | 说明 |
| --- | --- |
| 拖拽地图 | 平移镜头 |
| 滚轮 | 缩放（聚焦指针位置） |
| 点击建筑 | 打开关卡面板（仅解锁地点可进入） |
| 点击选项 / 数字键 1–4 | 选择题作答（选中即提交） |
| 点击步骤 / 点击已排步骤撤回 | 排序题 |
| 文本框输入 + Enter | 填空题（支持 `0.5`、`1/2`、`e^2` 等） |
| `提示` 按钮 | 显示提示，**下一击伤害 −50%**（真实规则代价） |
| `洞察 ×2` 技能 | 连续答对 3 次充能，下一击伤害 ×2 |
| `` ` ``（Backquote）或 DEV 按钮 | 开发菜单 |

## 开发菜单（作弊面板）

- 解锁全部关卡 / 重置存档（二次确认）
- XP ±50
- 模拟答对 / 模拟答错（走真实结算链路）
- 回血 +40 / 无敌模式
- 难度切换：轻松 / 标准 / 严苛（影响受伤与收益倍率）
- 查看 `MapSpec` / `LevelSpec` / `StudentState` 当前 JSON

## 内置 mock 世界一览

| 关卡 | 类型 | 交互 | 敌人 |
| --- | --- | --- | --- |
| The First Gate | 普通 | 选择 | Rune Wisp |
| Forest of Functions | 普通 | 选择 | Thicket Golem |
| Obsidian Shrine | **精英（支线）** | 排序+输入+选择 | Obsidian Twin |
| Canyon of Continuity | 普通 | 选择+**排序** | Canyon Sentinel |
| Bridge of Limits | 普通 | **数值输入** | Bridge Phantom |
| Aether Spire | **精英（支线）** | 混合 | Spire Arcanist |
| Library of Proof | 普通 | 排序+选择 | Ink Warden |
| Summit Ascent | 普通 | 混合复习 | Storm Herald |
| The Infinite Throne | **Boss（3 阶段）** | 混合 | Aether Colossus |

地图为分支拓扑：主线路线 + 两条精英支线 + Boss（需主干 + 支线全通，见 `prerequisites`）。

## 项目结构

```
src/
  schemas/        # MapSpec / LevelSpec / BattleRule / StudentState 类型 + 运行时校验
  data/           # mock 内容（worlds / levels / rules）—— 唯一会被 AI 替换的部分
  services/       # contentService：游戏与内容的唯一入口（未来换成 fetch 即可）
  state/          # zustand 存档（localStorage 持久化）+ 进度推导纯函数
  game/
    scenes/       # Boot / WorldMap / Battle 三个 Phaser 场景
    world/        # 世界地图引擎：worldPainter(手绘 canvas) / LevelSite(建筑即关卡)
                  #   CloudLayer(云雾迷雾) / ambient(环境动画) / biomes / shapes
    map/          # 布局算法（归一化锚点 → 世界坐标）
    entities/     # 英雄 / 敌人工厂（全程序化绘制，4 种敌人形态）
    rules/        # BattleEngine 规则引擎 + 作答判定（纯逻辑、可单测）
    fx/           # 伤害数字 / 粒子 / 程序化纹理
    audio/        # WebAudio 程序化音效
  components/     # React UI 层（Landing / HUD / 题目面板 / 结算 / DevMenu）
tests/            # e2e.mjs 真实浏览器全链路测试
```

## 文档

- [ARCHITECTURE.md](./ARCHITECTURE.md) — 架构、事件目录、扩展指南
- [GAME_SCHEMA.md](./GAME_SCHEMA.md) — **AI 应生成什么 JSON**（下一棒必读）
- [ASSET_SOURCES.md](./ASSET_SOURCES.md) — 素材与字体来源 / License
- [QA_REPORT.md](./QA_REPORT.md) — 测试覆盖、已修复 Bug、遗留问题
