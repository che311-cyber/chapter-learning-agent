# ASSET_SOURCES — 素材与字体来源

## 原则

V0 **零第三方美术/音频素材**。所有视觉与声音均为程序化生成，
无版权风险，且便于 AI 未来按主题重绘。

## 视觉

| 资产 | 来源 | License |
| --- | --- | --- |
| 世界地图地形（星空/山脉/河流/森林/遗迹/路径） | `src/game/map/MapTerrain.ts` — Phaser Graphics 程序化绘制，种子随机保证一致性 | 项目自有 |
| 关卡节点 / 图标 / 锁 / 检记 | `src/game/map/LevelNodeView.ts` — Graphics 绘制 | 项目自有 |
| 英雄角色（兜帽学者 + 法杖） | `src/game/entities/Hero.ts` — Graphics 分层绘制 + 补间动画 | 项目自有 |
| 敌人 4 形态（wisp / golem / phantom / colossus） | `src/game/entities/EnemyFactory.ts` — Graphics 分层绘制 | 项目自有 |
| 粒子纹理（柔光/火花/尘埃/圆环） | `src/game/fx/textures.ts` — 运行时 generateTexture | 项目自有 |
| 血条 / 伤害数字 / 阶段横幅 | 运行时 Graphics / Text | 项目自有 |
| Favicon | `public/favicon.svg` — 手写 SVG（菱形符文） | 项目自有 |
| UI 面板 / 按钮 / 排版 | `src/styles.css` — 纯 CSS（玻璃拟态暗色奇幻风） | 项目自有 |

## 字体

| 字体 | 用途 | 来源 | License |
| --- | --- | --- | --- |
| Cinzel (600/700/900) | 标题 / 结算横幅 / 世界名 | Google Fonts（index.html 引入） | SIL Open Font License 1.1 |
| Inter (400–700) | 正文 / UI | Google Fonts（index.html 引入） | SIL Open Font License 1.1 |

> 字体经 `document.fonts.ready` 等待加载，离线环境 2.5s 后降级到系统字体，不影响运行。
> 中文字形回退到系统 `PingFang SC / Microsoft YaHei`。

## 音频

| 资产 | 来源 | License |
| --- | --- | --- |
| 全部音效（点击/正确/错误/受击/解锁/胜利/失败/Boss/技能/提示/脚步） | `src/game/audio/Sfx.ts` — WebAudio 振荡器实时合成 | 项目自有 |

## 若未来引入第三方素材（模板）

引入任何素材前在此登记，禁止使用版权不明资产：

| 资产 | 文件 | 来源与链接 | License | 引入日期 |
| --- | --- | --- | --- | --- |
| （示例） | assets/… | … | CC0 / OFL / 商用授权 | — |
