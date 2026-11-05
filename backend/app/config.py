"""全局配置：路径、环境变量。API Key 只从 .env 读取，禁止硬编码。"""
import os
from pathlib import Path

from dotenv import load_dotenv

# chapter-agent/ 根目录（backend/app/config.py -> 上两级）
ROOT_DIR = Path(__file__).resolve().parents[2]
load_dotenv(ROOT_DIR / ".env")

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "").strip()
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1").rstrip("/")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat").strip()

PROJECTS_DIR = ROOT_DIR / "projects"
PROMPTS_DIR = ROOT_DIR / "prompts"

# LLM 调用参数
CHAT_TEMPERATURE = float(os.getenv("CHAT_TEMPERATURE", "0.3"))
CHAT_MAX_TOKENS = int(os.getenv("CHAT_MAX_TOKENS", "8192"))
API_TIMEOUT_SECONDS = int(os.getenv("API_TIMEOUT_SECONDS", "300"))
API_MAX_RETRIES = int(os.getenv("API_MAX_RETRIES", "4"))
MAX_CONCURRENT_RUNS = max(1, int(os.getenv("MAX_CONCURRENT_RUNS", "2")))

# Agent 循环上限（防无限循环）
MAX_TOOL_ITERATIONS_PER_PHASE = int(os.getenv("MAX_TOOL_ITERATIONS_PER_PHASE", "30"))
MAX_QA_REVISION_ROUNDS = int(os.getenv("MAX_QA_REVISION_ROUNDS", "3"))
MAX_VERIFY_ROUNDS = int(os.getenv("MAX_VERIFY_ROUNDS", "2"))
MAX_NUDGES_PER_PHASE = 3

# 单次工具返回给模型的最大字符数（防止大文件撑爆上下文）
TOOL_RESULT_MAX_CHARS = int(os.getenv("TOOL_RESULT_MAX_CHARS", "26000"))
# 章节阅读分块大小（字符）
READ_CHUNK_CHARS = int(os.getenv("READ_CHUNK_CHARS", "6000"))
# 文本类教材的虚拟页大小（字符）：页是 PDF 的天然单位，TXT/MD 按此切分为虚拟页
TEXT_PAGE_CHARS = int(os.getenv("TEXT_PAGE_CHARS", "2200"))

# 上传限制
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(80 * 1024 * 1024)))
ALLOWED_UPLOAD_EXTS = {".pdf", ".txt", ".md", ".markdown", ".docx", ".pptx"}


def ensure_dirs() -> None:
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    PROMPTS_DIR.mkdir(parents=True, exist_ok=True)
