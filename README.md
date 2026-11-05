# Chapter Learning Agent

教材章节 → 有来源的学习方案与练习 → 教师审核 → 引导学习与游戏练习。

基于 FastAPI、React、TypeScript 和原生 Tool Calling 的数学学习 Agent。支持 MiMo 与 DeepSeek；模型负责理解、设计和复核，控制器检查正文阅读证据、产物结构、阶段练习映射和发布条件。

[MIT License](LICENSE) · [系统说明](ARCHITECTURE.md) · [展示页源码](showcase/index.html) · [交互架构图](showcase/architecture.html)

## 能做什么

- 从 PDF、TXT、Markdown、DOCX、PPTX 中定位指定章节，分块读取，并按需回溯前置知识。
- 对扫描 PDF 使用 Tesseract OCR，分开记录“已返回文本”和“正文可读覆盖率”。
- 生成章节理解、分阶段学习方案、练习题、七项学习心理学原则检查和独立解题复核结果。
- 支持取消、断点续跑、缓存、受限并发和教师审核；部分通过与待复核状态保留原意。
- 提供逐步学习、选择题即时反馈、开放题自评、刷新恢复、错题补救和学情报告导出。
- 将已有章节题库映射为 EduRealm 游戏关卡；切换游戏模式不重复调用模型。

模型生成内容仍需教师复核。自评、客观作答和游戏奖励分别统计；未正式发布章节的预览学习不计入教师正式学情。

## 快速开始

需要 Python 3.10+、Node.js 22+ 和 npm。

```bash
git clone https://github.com/che311-cyber/chapter-learning-agent.git
cd chapter-learning-agent
cp .env.example .env
```

编辑 `.env`，填入自己的模型密钥。MiMo 示例：

```dotenv
DEEPSEEK_API_KEY=填写自己的密钥
DEEPSEEK_BASE_URL=https://api.xiaomimimo.com/v1
DEEPSEEK_MODEL=mimo-v2.6-pro
CHAT_MAX_TOKENS=16384
TEACHER_PASSWORD=设置自己的教师密码
```

`DEEPSEEK_*` 是兼容已有配置的变量名，MiMo 请求使用 `api-key` 请求头。接入 DeepSeek 时，将地址改为 `https://api.deepseek.com/v1`，模型改为 `deepseek-chat`。`TEACHER_PASSWORD` 留空时教师端禁用。

```bash
./start.sh
```

打开 <http://localhost:5173>，选择 `abstract-algebra`，输入示例章节 `第一章`。也可新建课程项目，上传自己有权使用的教材，再指定实际章节名称。

分开启动：

```bash
./start.sh backend
./start.sh frontend
```

手动安装与启动：

```bash
python3 -m venv backend/venv
backend/venv/bin/pip install -r backend/requirements.txt
(cd backend && ./venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000)
```

另开终端：

```bash
cd frontend
npm ci
npm run dev
```

后端 API 文档：<http://127.0.0.1:8000/docs>。前端自带一份基于自编抽象代数教材的静态示例，可独立浏览；生成新章节需要后端和自己的 API 配置。

## 扫描教材 OCR

OCR 使用本机的 `tesseract`、中文语言包和 `pdftoppm`。Ubuntu / Debian：

```bash
sudo apt-get install tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng poppler-utils
```

macOS：

```bash
brew install tesseract tesseract-lang poppler
```

OCR 置信度不足、目录定位或正文覆盖不足时，系统保留限制状态，不应把目录当作完整教学内容。公式识别结果需要人工核对。

## 测试

默认使用 Mock，不需要真实 API Key，也不发送教材到模型服务。

```bash
backend/venv/bin/python -m pytest tests -q
npm --prefix frontend run lint
npm --prefix frontend run build
node tests/frontend-acceptance.mjs
node tests/frontend-auth-acceptance.mjs
node tests/frontend-learning-acceptance.mjs
```

后端测试包含定位与阅读证据、解析与 OCR 缓存、产物校验、故障恢复、教师鉴权、审核发布和预览学情隔离。前端专项验收覆盖旧题阶段映射、教师协议、自评继续与恢复、统计口径和报告内容。平台专属测试可能跳过。

## 目录

| 路径 | 内容 |
| --- | --- |
| `backend/` | FastAPI、Agent 控制器、文档工具、解析器、质量门控和存储 |
| `frontend/` | 学习界面、教师端、报告导出和集成游戏模式 |
| `prompts/` | 定位、阅读、理解、设计、出题、QA 与独立验证提示词 |
| `tests/` | 后端 Mock 回归和前端专项验收 |
| `projects/abstract-algebra/input/` | 可公开的自编示例教材 |
| `edurealm/` | 可独立运行的早期 EduRealm 游戏引擎与测试 |
| `showcase/` | 项目介绍页、交互架构图及其数据源 |
| `deploy/`、`scripts/` | 部署模板、迁移与导出辅助脚本 |

`frontend/src/edurealm/` 是当前集成使用的游戏代码；`edurealm/` 保留独立游戏原型。独立运行方式见 [EduRealm README](edurealm/README.md)。已有架构说明和 QA 报告保留为开发记录，安装方式以本 README 为准。

## 数据与配置

课程文件存放在 `projects/<课程>/input/`，分析状态、模型会话和学情记录存放在 `workspace/`，导出结果存放在 `output/`。这些运行数据默认被 Git 忽略，只跟踪自编示例教材。

- `.env`、API Key、教师密码、学生学情、上传教材、会话日志、备份和构建产物不在公开仓库中。
- 前端公开配置只能填写后端地址；API Key 始终放在后端环境中。
- 内置静态数据用于功能演示，不代表对真实教材、真实学生或教学效果的端到端验证。
- 教师登录令牌保存在后端进程内，服务重启后需要重新登录。

## 部署

前端构建输出到 `frontend/dist/`，可部署为静态站点。完整模式需要单独运行 Python 后端；`deploy/nginx-chapter-agent.conf` 提供同源 `/api/` 反向代理模板。

```bash
npm --prefix frontend ci
npm --prefix frontend run build
./deploy/make-server-package.sh
```

部署包输出到 `dist/chapter-agent-server-upload.tar.gz`，包含源码、提示词、自编样例和环境模板，不包含真实 `.env`。解压至服务器 `/opt/upload/` 后，可按 `deploy/server-setup.sh` 配置。真实密钥写入服务器 `/opt/chapter-agent/.env`，配置后重启后端。

`deploy-pages.sh` 是可选的 Cloudflare Pages 发布脚本，需要自己的 Cloudflare 登录；服务器和云平台账号不随开源仓库提供。

## 许可证

项目代码按 [MIT](LICENSE) 协议发布。示例教材为项目开发样例；第三方依赖保留各自许可证。EduRealm 素材说明见 [ASSET_SOURCES.md](edurealm/ASSET_SOURCES.md)，交互架构图内嵌字体附有其原始 OFL 声明。
