/**
 * LevelSite —— 地图上的"地点本身即关卡"。
 * 每个关卡以一座建筑/地标的形式融合进世界：
 *   gate(村口木门) watchtower(林间哨塔) canyon_gate(峡谷石门) shrine(黑曜神龛)
 *   bridge(石桥) ruins(遗迹书庭) spire(秘术塔) summit_temple(雪顶神庙) citadel(黑暗王城)
 * 附带克制的状态标识：锁 / 星标（完成）/ 金色标记（可进入），以及名字木牌。
 */
import Phaser from 'phaser'
import type { LevelStatus, MapNodeSpec } from '../../schemas/types'
import { sfx } from '../audio/Sfx'
import { useGameStore } from '../../state/gameStore'

const FONT = 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif'

export class LevelSite extends Phaser.GameObjects.Container {
  readonly node: MapNodeSpec
  readonly door: Phaser.Math.Vector2 // 英雄站立点（结构入口）
  private statusValue: LevelStatus = 'locked'
  private sceneRef: Phaser.Scene
  private art!: Phaser.GameObjects.Graphics
  private glow!: Phaser.GameObjects.Image
  private badge!: Phaser.GameObjects.Container
  private badgeG!: Phaser.GameObjects.Graphics
  private badgeStar!: Phaser.GameObjects.Graphics
  private badgeLock!: Phaser.GameObjects.Graphics
  private nameplate: Phaser.GameObjects.Container
  private plateG: Phaser.GameObjects.Graphics
  private plateText: Phaser.GameObjects.Text
  private pulse?: Phaser.Tweens.Tween
  private hitW = 150
  private hitH = 130

  constructor(
    scene: Phaser.Scene,
    node: MapNodeSpec,
    x: number,
    y: number,
    onClick: (node: MapNodeSpec) => void,
  ) {
    super(scene, x, y)
    this.node = node
    this.sceneRef = scene

    // 底部光晕（解锁状态呼吸）
    this.glow = scene.add
      .image(0, 10, 'fx-soft')
      .setScale(2.6)
      .setAlpha(0)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setTint(0xffd88a)
    this.add(this.glow)

    this.art = scene.add.graphics()
    this.add(this.art)

    switch (node.structure ?? node.type) {
      case 'gate': this.drawGate(this.art); break
      case 'watchtower': this.drawWatchtower(this.art); break
      case 'canyon_gate': this.drawCanyonGate(this.art); break
      case 'shrine': this.drawShrine(this.art); break
      case 'bridge': this.drawBridge(this.art); break
      case 'ruins': this.drawRuins(this.art); break
      case 'spire': this.drawSpire(this.art); break
      case 'summit_temple': this.drawSummitTemple(this.art); break
      case 'citadel': this.drawCitadel(this.art); break
      default: this.drawWatchtower(this.art)
    }

    // 名字木牌（下方，克制）
    this.nameplate = scene.add.container(0, 58)
    this.plateG = scene.add.graphics()
    const w = Math.max(120, node.name.length * 8.4)
    this.plateG.fillStyle(0x2a2118, 0.82)
    this.plateG.fillRoundedRect(-w / 2, -13, w, 24, 5)
    this.plateG.lineStyle(1.4, 0x8a6a42, 0.9)
    this.plateG.strokeRoundedRect(-w / 2, -13, w, 24, 5)
    this.plateText = scene.add
      .text(0, 0, node.name, { fontFamily: FONT, fontSize: '12.5px', color: '#efe4c8' })
      .setOrigin(0.5)
    this.nameplate.add([this.plateG, this.plateText])
    this.add(this.nameplate)

    // 状态徽章（右上角小圆标）
    this.badge = scene.add.container(44, -66)
    this.badgeG = scene.add.graphics()
    this.badgeStar = scene.add.graphics()
    this.badgeLock = scene.add.graphics()
    this.badge.add([this.badgeG, this.badgeStar, this.badgeLock])
    this.add(this.badge)

    scene.add.existing(this)
    this.setDepth(10)

    const kind = node.structure ?? node.type
    if (kind === 'citadel') {
      this.hitW = 240
      this.hitH = 200
    } else if (kind === 'bridge' || kind === 'spire') {
      this.hitW = 180
      this.hitH = 170
    }
    this.setSize(this.hitW, this.hitH)
    this.setInteractive(
      new Phaser.Geom.Rectangle(-this.hitW / 2, -this.hitH * 0.72, this.hitW, this.hitH),
      Phaser.Geom.Rectangle.Contains,
    )

    this.door = new Phaser.Math.Vector2(x, y + 34)

    this.on('pointerover', () => {
      if (this.statusValue === 'locked') return
      sfx.play('hover')
      scene.tweens.add({ targets: this, scale: 1.045, duration: 130, ease: 'Sine.easeOut' })
      this.plateText.setColor('#ffe9b8')
    })
    this.on('pointerout', () => {
      scene.tweens.add({ targets: this, scale: 1, duration: 130, ease: 'Sine.easeIn' })
      this.plateText.setColor('#efe4c8')
    })
    // 拖拽地图时 pointerup 也会落在建筑上 → 由场景的 canClick 过滤
    this.on('pointerup', () => {
      const map = this.sceneRef as unknown as { canClick?: () => boolean }
      if (map.canClick && !map.canClick()) return
      if (this.statusValue === 'locked') {
        this.shakeDeny()
        return
      }
      if (useGameStore.getState().ui.screen !== 'map') return
      sfx.play('click')
      onClick(this.node)
    })

    this.applyStatus('locked')
  }

  // ── 各类建筑绘制（Graphics 手绘，绘本风） ─────────────────────

  private drawGate(g: Phaser.GameObjects.Graphics): void {
    // 影
    g.fillStyle(0x2a3a20, 0.3)
    g.fillEllipse(4, 34, 110, 26)
    // 石基
    g.fillStyle(0x9a938a)
    g.fillRect(-52, 18, 104, 16)
    g.fillStyle(0x847d74)
    g.fillRect(-52, 28, 104, 6)
    // 两侧门柱（石）
    g.fillStyle(0xa89d8f)
    g.fillRect(-46, -34, 22, 56)
    g.fillRect(24, -34, 22, 56)
    g.fillStyle(0x8b8073)
    g.fillRect(-46, -34, 8, 56)
    g.fillRect(24, -34, 8, 56)
    // 拱木梁
    g.fillStyle(0x6e4f33)
    g.fillRect(-52, -44, 104, 14)
    g.fillStyle(0x5d4026)
    g.fillRect(-52, -33, 104, 4)
    // 木门（半开）
    g.fillStyle(0x7a5636)
    g.fillRect(-20, -18, 40, 40)
    g.fillStyle(0x8a6238)
    g.fillRect(-20, -18, 18, 40)
    g.lineStyle(1.6, 0x4d3822, 1)
    g.lineBetween(-20, -6, 20, -6)
    g.lineBetween(-20, 8, 20, 8)
    // 铰链与符文圆盘
    g.fillStyle(0xc9a26b)
    g.fillCircle(0, -30, 9)
    g.fillStyle(0x57c8b4)
    g.fillCircle(0, -30, 4.4)
    // 火把
    g.fillStyle(0x6e4f33)
    g.fillRect(-50, -18, 4, 14)
    g.fillRect(46, -18, 4, 14)
    g.fillStyle(0xf2a541)
    g.fillCircle(-48, -22, 4)
    g.fillCircle(48, -22, 4)
    // 门柱小旗
    g.fillStyle(0x57a3b8)
    g.fillTriangle(-46, -58, -46, -44, -62, -51)
    g.fillStyle(0x6e4f33)
    g.fillRect(-47, -62, 2.4, 20)
  }

  private drawWatchtower(g: Phaser.GameObjects.Graphics): void {
    g.fillStyle(0x2a3a20, 0.3)
    g.fillEllipse(4, 36, 96, 24)
    // 支撑架
    g.lineStyle(7, 0x6e4f33, 1)
    g.lineBetween(-22, 34, -12, -34)
    g.lineBetween(22, 34, 12, -34)
    g.lineStyle(4, 0x5d4026, 1)
    g.lineBetween(-18, 12, 18, 4)
    g.lineBetween(-16, -12, 16, -18)
    // 塔屋
    g.fillStyle(0x7a5636)
    g.fillRect(-26, -66, 52, 36)
    g.fillStyle(0x8a6238)
    g.fillRect(-26, -66, 52, 8)
    // 窗
    g.fillStyle(0x2c2418)
    g.fillRect(-8, -56, 16, 14)
    g.fillStyle(0xf2c469, 1)
    g.fillRect(-6, -54, 12, 10)
    // 屋顶
    g.fillStyle(0x9e4f3f)
    g.fillTriangle(-34, -64, 34, -64, 0, -92)
    g.fillStyle(0x8a4234)
    g.fillTriangle(-34, -64, -6, -64, -16, -84)
    // 旗
    g.fillStyle(0x6e4f33)
    g.fillRect(-1, -104, 2.4, 16)
    g.fillStyle(0xd8b36a)
    g.fillTriangle(1, -104, 18, -99, 1, -94)
  }

  private drawCanyonGate(g: Phaser.GameObjects.Graphics): void {
    g.fillStyle(0x2a2f22, 0.32)
    g.fillEllipse(0, 34, 140, 26)
    // 两侧巨岩
    g.fillStyle(0x8b8073)
    g.fillPoints(
      [new Phaser.Geom.Point(-70, 36), new Phaser.Geom.Point(-52, 36), new Phaser.Geom.Point(-58, -38), new Phaser.Geom.Point(-72, -20)],
      true,
    )
    g.fillStyle(0xa89d8f)
    g.fillPoints(
      [new Phaser.Geom.Point(-70, 36), new Phaser.Geom.Point(-62, 36), new Phaser.Geom.Point(-66, -24), new Phaser.Geom.Point(-70, -6)],
      true,
    )
    g.fillStyle(0x6b6156)
    g.fillPoints(
      [new Phaser.Geom.Point(48, 36), new Phaser.Geom.Point(68, 36), new Phaser.Geom.Point(74, -26), new Phaser.Geom.Point(54, -44)],
      true,
    )
    g.fillStyle(0x8b8073)
    g.fillPoints(
      [new Phaser.Geom.Point(52, 36), new Phaser.Geom.Point(62, 36), { ...new Phaser.Geom.Point(66, -18) }, new Phaser.Geom.Point(54, -40)],
      true,
    )
    // 连接拱石
    g.fillStyle(0x9a938a)
    g.fillRect(-40, -50, 80, 16)
    g.fillStyle(0x847d74)
    g.fillRect(-40, -38, 80, 5)
    // 符文刻痕
    g.lineStyle(2, 0x57c8b4, 0.85)
    g.lineBetween(-12, -46, -12, -38)
    g.lineBetween(0, -48, 0, -36)
    g.lineBetween(12, -46, 12, -38)
    // 谷底小径
    g.fillStyle(0xc19a63, 1)
    g.fillEllipse(0, 30, 44, 10)
  }

  private drawShrine(g: Phaser.GameObjects.Graphics): void {
    g.fillStyle(0x1c1826, 0.4)
    g.fillEllipse(4, 34, 110, 24)
    // 黑曜石台阶
    g.fillStyle(0x39324a)
    g.fillRect(-46, 22, 92, 12)
    g.fillStyle(0x443c58)
    g.fillRect(-38, 12, 76, 12)
    // 双柱
    g.fillStyle(0x2f2940)
    g.fillRect(-34, -44, 16, 58)
    g.fillRect(18, -44, 16, 58)
    g.fillStyle(0x3a3350)
    g.fillRect(-34, -44, 6, 58)
    g.fillRect(18, -44, 6, 58)
    // 顶梁
    g.fillStyle(0x2f2940)
    g.fillRect(-42, -56, 84, 14)
    g.fillStyle(0x8d7fe0, 1)
    g.fillCircle(-30, -49, 2.6)
    g.fillCircle(0, -49, 2.6)
    g.fillCircle(30, -49, 2.6)
    // 悬浮晶体
    g.fillStyle(0xa88fe8)
    g.fillPoints(
      [new Phaser.Geom.Point(0, -34), new Phaser.Geom.Point(9, -22), new Phaser.Geom.Point(0, -10), new Phaser.Geom.Point(-9, -22)],
      true,
    )
    g.fillStyle(0xd6c9ff, 1)
    g.fillPoints(
      [new Phaser.Geom.Point(0, -32), new Phaser.Geom.Point(4, -24), new Phaser.Geom.Point(0, -18), new Phaser.Geom.Point(-4, -24)],
      true,
    )
    // 紫色地面符环
    g.lineStyle(2.4, 0x8d7fe0, 0.7)
    g.strokeEllipse(0, 28, 74, 18)
  }

  private drawBridge(g: Phaser.GameObjects.Graphics): void {
    // 跨水石桥（横贯画面感）
    g.fillStyle(0x2a3a30, 0.3)
    g.fillEllipse(0, 30, 190, 30)
    // 桥面
    g.fillStyle(0xa89d8f)
    g.fillRect(-96, -14, 192, 30)
    g.fillStyle(0x948a7c)
    g.fillRect(-96, 6, 192, 10)
    // 石栏
    g.fillStyle(0xb5aea2)
    g.fillRect(-96, -22, 192, 8)
    for (let x = -88; x <= 88; x += 22) {
      g.fillStyle(0xb5aea2)
      g.fillRect(x - 3, -30, 7, 10)
    }
    // 桥洞（两拱）
    g.fillStyle(0x3d7ea6)
    g.fillEllipse(-44, 16, 44, 30)
    g.fillEllipse(44, 16, 44, 30)
    g.fillStyle(0x2f6486)
    g.fillEllipse(-44, 20, 34, 22)
    g.fillEllipse(44, 20, 34, 22)
    // 桥头堡
    g.fillStyle(0xb5aea2)
    g.fillRect(-104, -44, 18, 58)
    g.fillRect(86, -44, 18, 58)
    g.fillStyle(0x847d74)
    g.fillRect(-104, -44, 6, 58)
    g.fillStyle(0x9e4f3f)
    g.fillTriangle(-108, -42, -82, -42, -95, -62)
    g.fillTriangle(82, -42, 108, -42, 95, -62)
    // 中栏旗帜
    g.fillStyle(0xd8b36a)
    g.fillTriangle(-1, -30, 14, -26, -1, -21)
  }

  private drawRuins(g: Phaser.GameObjects.Graphics): void {
    g.fillStyle(0x2a3a26, 0.32)
    g.fillEllipse(0, 32, 130, 26)
    // 台基
    g.fillStyle(0xa89d8f)
    g.fillRect(-58, 18, 116, 14)
    g.fillStyle(0x948a7c)
    g.fillRect(-50, 8, 100, 12)
    // 立柱（两完整一断裂）
    g.fillStyle(0xc9bfa8)
    g.fillRect(-44, -42, 14, 52)
    g.fillRect(30, -42, 14, 52)
    g.fillStyle(0xd8cdb4)
    g.fillRect(-44, -42, 5, 52)
    g.fillRect(30, -42, 5, 52)
    g.fillStyle(0xb0a58c)
    g.fillRect(-16, -18, 12, 28) // 断柱
    g.fillStyle(0xc9bfa8)
    g.fillRect(-19, -24, 18, 7)
    // 楣梁残段
    g.fillStyle(0xc9bfa8)
    g.fillRect(-50, -52, 100, 12)
    g.fillStyle(0xb0a58c)
    g.fillRect(-50, -44, 100, 4)
    // 书卷与符文（知识庭院感）
    g.fillStyle(0x8d6f9e)
    g.fillCircle(0, -46, 7)
    g.fillStyle(0xe8d97a)
    g.fillCircle(0, -46, 3)
    g.lineStyle(1.6, 0x57c8b4, 0.8)
    g.lineBetween(-30, 2, -22, 2)
    g.lineBetween(24, 2, 32, 2)
    // 藤蔓
    g.lineStyle(2, 0x5c9040, 0.9)
    g.lineBetween(-46, -20, -42, -8)
    g.lineBetween(42, -16, 38, -4)
  }

  private drawSpire(g: Phaser.GameObjects.Graphics): void {
    g.fillStyle(0x241d33, 0.38)
    g.fillEllipse(4, 40, 96, 24)
    // 岩基
    g.fillStyle(0x6f6779)
    g.fillEllipse(0, 32, 76, 22)
    // 塔身（锥形）
    g.fillStyle(0x5d5a78)
    g.fillPoints(
      [new Phaser.Geom.Point(-26, 34), new Phaser.Geom.Point(26, 34), new Phaser.Geom.Point(14, -64), new Phaser.Geom.Point(-14, -64)],
      true,
    )
    g.fillStyle(0x6d6a8a)
    g.fillPoints(
      [new Phaser.Geom.Point(-26, 34), new Phaser.Geom.Point(-6, 34), new Phaser.Geom.Point(-11, -64), new Phaser.Geom.Point(-14, -64)],
      true,
    )
    // 砖缝
    g.lineStyle(1.2, 0x4c4966, 0.8)
    for (let i = 0; i < 5; i++) {
      const y = 24 - i * 12
      g.lineBetween(-24 + i * 2.2, y, 24 - i * 2.2, y)
    }
    // 高窗（发光）
    g.fillStyle(0x8d7fe0, 1)
    g.fillEllipse(0, -18, 9, 14)
    g.fillEllipse(0, 6, 8, 12)
    // 塔顶
    g.fillStyle(0x4c4966)
    g.fillPoints(
      [new Phaser.Geom.Point(-20, -62), new Phaser.Geom.Point(20, -62), new Phaser.Geom.Point(0, -84)],
      true,
    )
    // 悬浮水晶
    g.fillStyle(0xa88fe8)
    g.fillPoints(
      [new Phaser.Geom.Point(0, -102), new Phaser.Geom.Point(8, -92), new Phaser.Geom.Point(0, -82), new Phaser.Geom.Point(-8, -92)],
      true,
    )
    g.fillStyle(0xe4dbff)
    g.fillCircle(0, -92, 3)
  }

  private drawSummitTemple(g: Phaser.GameObjects.Graphics): void {
    g.fillStyle(0x9db0bc, 0.4)
    g.fillEllipse(0, 32, 120, 24)
    // 雪台
    g.fillStyle(0xe9f0f4)
    g.fillRect(-52, 18, 104, 14)
    g.fillStyle(0xc3d3de)
    g.fillRect(-52, 26, 104, 6)
    // 石阶
    g.fillStyle(0xb5c5d1)
    g.fillRect(-34, 8, 68, 10)
    // 神庙主体
    g.fillStyle(0x8f9aa5)
    g.fillRect(-30, -34, 60, 42)
    g.fillStyle(0xa5b1bc)
    g.fillRect(-30, -34, 12, 42)
    // 柱廊
    g.fillStyle(0xd7e1e8)
    for (let i = 0; i < 4; i++) g.fillRect(-26 + i * 14, -30, 7, 34)
    // 金顶
    g.fillStyle(0xd8b36a)
    g.fillPoints(
      [new Phaser.Geom.Point(-36, -32), new Phaser.Geom.Point(36, -32), new Phaser.Geom.Point(0, -62)],
      true,
    )
    g.fillStyle(0xf0d9a2)
    g.fillPoints(
      [new Phaser.Geom.Point(-36, -32), new Phaser.Geom.Point(-8, -32), { ...new Phaser.Geom.Point(-12, -48) }, new Phaser.Geom.Point(-24, -36)],
      true,
    )
    // 顶饰
    g.fillStyle(0xf0d9a2)
    g.fillCircle(0, -66, 4)
    // 两侧雪松
    this.drawMiniPine(g, -58, 20, 1)
    this.drawMiniPine(g, 56, 22, 0.85)
    // 风雪旗
    g.fillStyle(0x6e4f33)
    g.fillRect(-2, -80, 2.4, 18)
    g.fillStyle(0x57a3b8)
    g.fillTriangle(0, -80, 18, -74, 0, -69)
  }

  private drawMiniPine(g: Phaser.GameObjects.Graphics, x: number, y: number, s: number): void {
    g.fillStyle(0x2f5d51, 1)
    g.fillPoints(
      [new Phaser.Geom.Point(x - 10 * s, y), new Phaser.Geom.Point(x + 10 * s, y), new Phaser.Geom.Point(x, y - 24 * s)],
      true,
    )
    g.fillStyle(0xe9f0f4, 1)
    g.fillPoints(
      [new Phaser.Geom.Point(x - 5 * s, y - 13 * s), new Phaser.Geom.Point(x + 5 * s, y - 15 * s), new Phaser.Geom.Point(x, y - 24 * s)],
      true,
    )
  }

  private drawCitadel(g: Phaser.GameObjects.Graphics): void {
    // 大体量黑暗王城
    g.fillStyle(0x120e1c, 0.45)
    g.fillEllipse(10, 62, 300, 52)
    // 后方尖塔
    this.citadelTower(g, -96, -20, 0.8)
    this.citadelTower(g, 96, -26, 0.9)
    // 主体
    g.fillStyle(0x2c2537)
    g.fillRect(-74, -64, 148, 118)
    g.fillStyle(0x383049)
    g.fillRect(-74, -64, 40, 118)
    // 城齿
    g.fillStyle(0x2c2537)
    for (let x = -74; x < 74; x += 24) g.fillRect(x, -76, 16, 14)
    g.fillStyle(0x453c58)
    for (let x = -74; x < 74; x += 24) g.fillRect(x, -76, 6, 14)
    // 大门（拱形，紫光）
    g.fillStyle(0x191423)
    g.fillRect(-20, 6, 40, 48)
    g.fillStyle(0x8d7fe0, 0.85)
    g.fillEllipse(0, 12, 26, 32)
    g.fillStyle(0x191423)
    g.fillRect(-8, 6, 16, 48)
    // 窗
    g.fillStyle(0x8d7fe0, 0.75)
    for (const [wx, wy] of [[-52, -40], [-28, -40], [28, -40], [52, -40], [-52, -8], [52, -8]] as [number, number][]) {
      g.fillEllipse(wx, wy, 8, 13)
    }
    // 中央高塔
    g.fillStyle(0x383049)
    g.fillRect(-22, -134, 44, 72)
    g.fillStyle(0x453c58)
    g.fillRect(-22, -134, 14, 72)
    g.fillStyle(0x2c2537)
    for (let x = -22; x < 22; x += 12) g.fillRect(x, -144, 8, 12)
    g.fillStyle(0x8d7fe0, 0.9)
    g.fillEllipse(0, -108, 12, 18)
    // 王冠尖顶
    g.fillStyle(0x191423)
    g.fillPoints(
      [new Phaser.Geom.Point(-26, -142), new Phaser.Geom.Point(-14, -166), new Phaser.Geom.Point(-2, -142)],
      true,
    )
    g.fillPoints(
      [new Phaser.Geom.Point(-4, -142), new Phaser.Geom.Point(10, -174), new Phaser.Geom.Point(22, -142)],
      true,
    )
    // 旗帜（暗紫）
    for (const fx of [-96, 0, 96]) {
      g.fillStyle(0x453c58)
      g.fillRect(fx - 1.2, -186, 2.4, 18)
      g.fillStyle(0x8d7fe0, 0.9)
      g.fillTriangle(fx, -186, fx + 16, -180, fx, -174)
    }
    // 门前阶梯
    g.fillStyle(0x453c58)
    g.fillRect(-34, 52, 68, 8)
    g.fillStyle(0x383049)
    g.fillRect(-28, 60, 56, 6)
  }

  private citadelTower(g: Phaser.GameObjects.Graphics, x: number, y: number, s: number): void {
    g.fillStyle(0x241d33)
    g.fillRect(x - 16 * s, y, 32 * s, 84 * s)
    g.fillStyle(0x2f2840)
    g.fillRect(x - 16 * s, y, 10 * s, 84 * s)
    for (let bx = x - 16 * s; bx < x + 16 * s; bx += 9 * s) g.fillRect(bx, y - 8 * s, 6 * s, 9 * s)
    g.fillStyle(0x8d7fe0, 0.7)
    g.fillEllipse(x, y + 22 * s, 7 * s, 11 * s)
    g.fillStyle(0x191423)
    g.fillPoints(
      [
        new Phaser.Geom.Point(x - 18 * s, y - 6 * s),
        new Phaser.Geom.Point(x + 18 * s, y - 6 * s),
        new Phaser.Geom.Point(x, y - 34 * s),
      ],
      true,
    )
  }

  // ── 状态 ───────────────────────────────────────────────────────

  /** 幂等：状态未变化时不做任何事 */
  setStatus(status: LevelStatus, animate = true): void {
    if (status === this.statusValue) return
    const prev = this.statusValue
    this.statusValue = status
    this.applyStatus(status, animate, prev)
  }

  private applyStatus(status: LevelStatus, animate = true, prev: LevelStatus = 'locked'): void {
    this.badgeG.clear()
    this.badgeStar.clear()
    this.badgeLock.clear()
    if (this.pulse) {
      this.pulse.stop()
      this.pulse = undefined
    }
    this.sceneRef.tweens.add({ targets: this.glow, alpha: 0, duration: 200 })

    if (status === 'locked') {
      this.badgeG.fillStyle(0x1c202e, 0.85)
      this.badgeG.fillCircle(0, 0, 12)
      this.badgeG.lineStyle(1.4, 0x4a5478, 1)
      this.badgeG.strokeCircle(0, 0, 12)
      this.badgeLock.lineStyle(2, 0x8a93b0, 1)
      this.badgeLock.strokeCircle(0, -2.4, 4)
      this.badgeLock.fillStyle(0x8a93b0, 1)
      this.badgeLock.fillRect(-5, -1, 10, 8)
      this.glow.setAlpha(0)
      this.nameplate.setAlpha(0.55)
    } else if (status === 'unlocked') {
      const tint = this.node.type === 'boss' ? 0xe08a76 : 0xffd88a
      this.glow.setTint(tint)
      this.glow.setScale(this.node.type === 'boss' ? 3.4 : 2.6)
      this.pulse = this.sceneRef.tweens.add({
        targets: this.glow,
        alpha: { from: 0.16, to: 0.4 },
        scale: this.glow.scale * 1.12,
        duration: 1200,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      })
      this.badgeG.fillStyle(0x2a2118, 0.92)
      this.badgeG.fillCircle(0, 0, 12)
      this.badgeG.lineStyle(1.6, tint, 1)
      this.badgeG.strokeCircle(0, 0, 12)
      // 金色任务标记
      this.badgeStar.fillStyle(tint, 1)
      this.badgeStar.fillPoints(
        Array.from({ length: 4 }, (_, i) => {
          const a = (i / 4) * Math.PI * 2 + Math.PI / 4
          return new Phaser.Geom.Point(Math.cos(a) * 5.4, Math.sin(a) * 5.4)
        }),
        true,
      )
      this.badgeStar.fillStyle(0xfff3d0, 1)
      this.badgeStar.fillCircle(0, 0, 2.2)
      this.nameplate.setAlpha(1)
    } else {
      // completed：小星标
      this.badgeG.fillStyle(0x2a2118, 0.92)
      this.badgeG.fillCircle(0, 0, 12)
      this.badgeG.lineStyle(1.4, 0xd8b36a, 1)
      this.badgeG.strokeCircle(0, 0, 12)
      this.badgeStar.lineStyle(2.4, 0xf0d9a2, 1)
      this.badgeStar.beginPath()
      for (let i = 0; i < 5; i++) {
        const aOut = -Math.PI / 2 + (i / 5) * Math.PI * 2
        const aIn = aOut + Math.PI / 5
        const px = Math.cos(aOut) * 6.4
        const py = Math.sin(aOut) * 6.4
        if (i === 0) this.badgeStar.moveTo(px, py)
        else this.badgeStar.lineTo(px, py)
        this.badgeStar.lineTo(Math.cos(aIn) * 2.8, Math.sin(aIn) * 2.8)
      }
      this.badgeStar.closePath()
      this.badgeStar.strokePath()
      this.nameplate.setAlpha(0.8)
    }

    if (animate) {
      if (prev === 'locked' && status === 'unlocked') this.playUnlockFx()
    }
  }

  /** 解锁动画：金环 + 光尘 + 建筑弹跳 */
  playUnlockFx(): void {
    const { scene } = this
    sfx.play('unlock')
    const ring = scene.add
      .image(this.x, this.y, 'fx-ring')
      .setTint(0xffd88a)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(0.5)
      .setAlpha(0.95)
      .setDepth(150)
    scene.tweens.add({
      targets: ring,
      scale: 2.4,
      alpha: 0,
      duration: 640,
      ease: 'Cubic.easeOut',
      onComplete: () => ring.destroy(),
    })
    const burst = scene.add
      .particles(this.x, this.y - 20, 'fx-spark', {
        speed: { min: 60, max: 210 },
        lifespan: 640,
        scale: { start: 1, end: 0 },
        tint: 0xffd88a,
        blendMode: 'ADD',
        emitting: false,
      })
      .setDepth(150)
    burst.explode(18)
    scene.time.delayedCall(720, () => burst.destroy())
    scene.tweens.add({
      targets: this,
      scale: { from: 0.82, to: 1 },
      duration: 480,
      ease: 'Back.easeOut',
    })
  }

  shakeDeny(): void {
    sfx.play('wrong')
    const { scene, x } = this
    useGameStore.getState().actions.showToast('尚未解锁 · 先沿道路通过前面的关卡')
    scene.tweens.add({
      targets: this,
      x: { from: x - 5, to: x + 5 },
      duration: 45,
      yoyo: true,
      repeat: 3,
      onComplete: () => this.setX(x),
    })
  }
}
