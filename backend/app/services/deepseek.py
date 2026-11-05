"""OpenAI 兼容 API 客户端（DeepSeek / MiMo + tool calling）。

- 重试：429/5xx/网络错误 指数退避重试；401/402/400 属于致命错误立即抛出。
- DEEPSEEK_BASE_URL 可指向测试用 mock 服务器。
- 任何日志都不打印 API Key。
"""
from __future__ import annotations

import json
import time
from email.utils import parsedate_to_datetime
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import httpx

from .. import config


class DeepSeekError(Exception):
    """LLM 调用失败。fatal=True 表示重试无意义（Key 无效/欠费/参数错误等）。"""

    def __init__(self, message: str, fatal: bool = False, status: int = 0,
                 retry_after: Optional[float] = None):
        super().__init__(message)
        self.fatal = fatal
        self.status = status
        self.retry_after = retry_after


class DeepSeekCancelled(Exception):
    """在请求回合或重试等待期间收到取消，不再重试。"""


class DeepSeekClient:
    def __init__(self, api_key: Optional[str] = None, base_url: Optional[str] = None,
                 model: Optional[str] = None, timeout: Optional[int] = None):
        self.api_key = (api_key or config.DEEPSEEK_API_KEY).strip()
        self.base_url = (base_url or config.DEEPSEEK_BASE_URL).rstrip("/")
        self.model = (model or config.DEEPSEEK_MODEL).strip()
        self.timeout = timeout or config.API_TIMEOUT_SECONDS
        self.is_mimo = urlparse(self.base_url).hostname == "api.xiaomimimo.com"
        self.provider = "MiMo" if self.is_mimo else "DeepSeek"
        self.cancel_event = None
        self.on_retry = None
        if not self.api_key:
            raise DeepSeekError("未配置 DEEPSEEK_API_KEY：请在项目根目录 .env 中设置后重启服务", fatal=True)

    # ------------------------------------------------------------------
    def chat(self, messages: List[Dict[str, Any]], tools: Optional[List[Dict]] = None,
             temperature: Optional[float] = None, max_tokens: Optional[int] = None) -> Dict[str, Any]:
        """返回 assistant message dict，保留工具调用所需的推理字段。"""
        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": messages,
        }
        if self.is_mimo:
            # MiMo 的输出预算包含推理；启用推理时不接受自定义温度。
            payload["max_completion_tokens"] = max_tokens or config.CHAT_MAX_TOKENS
            payload["thinking"] = {"type": "enabled"}
        else:
            payload["temperature"] = config.CHAT_TEMPERATURE if temperature is None else temperature
            payload["max_tokens"] = max_tokens or config.CHAT_MAX_TOKENS
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        last_err: Optional[Exception] = None
        attempts = max(1, config.API_MAX_RETRIES)
        for attempt in range(attempts):
            if self.cancel_event is not None and self.cancel_event.is_set():
                raise DeepSeekCancelled()
            try:
                result = self._request_once(payload)
                if self.cancel_event is not None and self.cancel_event.is_set():
                    raise DeepSeekCancelled()
                return result
            except DeepSeekError as e:
                if e.fatal:
                    raise
                last_err = e
            except (httpx.TimeoutException, httpx.TransportError) as e:
                last_err = e
            if attempt + 1 < attempts:
                wait = min(20.0, (2 ** attempt) + 0.5)
                if isinstance(last_err, DeepSeekError) and last_err.retry_after is not None:
                    wait = max(wait, min(60.0, last_err.retry_after))
                if self.on_retry:
                    self.on_retry(attempt + 2, wait)
                if self.cancel_event is not None:
                    if self.cancel_event.wait(wait):
                        raise DeepSeekCancelled()
                else:
                    time.sleep(wait)
        raise DeepSeekError(f"{self.provider} API 连续 {attempts} 次调用失败: {last_err}",
                            status=last_err.status if isinstance(last_err, DeepSeekError) else 0)

    def _error_message(self, resp: httpx.Response) -> str:
        try:
            data = resp.json()
            error = data.get("error", data.get("message")) if isinstance(data, dict) else None
            message = error.get("message") if isinstance(error, dict) else error
        except ValueError:
            message = None
        return str(message or resp.text).replace(self.api_key, "[REDACTED]")[:300]

    # ------------------------------------------------------------------
    def _request_once(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        headers = {"Content-Type": "application/json"}
        if self.is_mimo:
            headers["api-key"] = self.api_key
        else:
            headers["Authorization"] = f"Bearer {self.api_key}"
        url = f"{self.base_url}/chat/completions"
        try:
            with httpx.Client(timeout=self.timeout) as client:
                resp = client.post(url, headers=headers,
                                   json=json.loads(json.dumps(payload, ensure_ascii=False)))
        except (httpx.TimeoutException, httpx.TransportError) as e:
            raise DeepSeekError(f"网络错误: {type(e).__name__}: {e}")

        if resp.status_code == 401:
            raise DeepSeekError(f"{self.provider} API Key 无效（401 Unauthorized）。请检查 .env 中的 DEEPSEEK_API_KEY", fatal=True, status=401)
        if resp.status_code == 402:
            msg = self._error_message(resp)
            raise DeepSeekError(f"{self.provider} 账户余额不足或已过期（402）{(': ' + msg) if msg else ''}", fatal=True, status=402)
        if resp.status_code == 422 or resp.status_code == 400:
            msg = self._error_message(resp)
            raise DeepSeekError(f"{self.provider} 请求被拒绝（{resp.status_code}）: {msg}", fatal=True, status=resp.status_code)
        if resp.status_code == 429:
            retry_after = None
            retry_header = resp.headers.get("Retry-After", "")
            try:
                retry_after = float(retry_header)
            except ValueError:
                try:
                    retry_after = parsedate_to_datetime(retry_header).timestamp() - time.time()
                except (ValueError, TypeError, OverflowError):
                    pass
            raise DeepSeekError(f"{self.provider} 限流（429），将自动重试", status=429,
                                retry_after=retry_after)
        if resp.status_code >= 500:
            raise DeepSeekError(f"{self.provider} 服务端错误（{resp.status_code}），将自动重试", status=resp.status_code)
        if resp.status_code != 200:
            raise DeepSeekError(f"{self.provider} 意外响应 {resp.status_code}: {self._error_message(resp)}", fatal=True, status=resp.status_code)

        try:
            data = resp.json()
        except ValueError:
            raise DeepSeekError(f"{self.provider} 返回了无法解析的响应（非 JSON）")

        choices = data.get("choices") if isinstance(data, dict) else None
        if (not isinstance(choices, list) or not choices or not isinstance(choices[0], dict)
                or not isinstance(choices[0].get("message"), dict)):
            raise DeepSeekError(f"{self.provider} 返回中没有有效的 choices/message，将自动重试")
        msg = choices[0].get("message") or {}
        if msg.get("content") is not None and not isinstance(msg["content"], str):
            raise DeepSeekError(f"{self.provider} 返回的正文格式无效，将自动重试")
        if msg.get("tool_calls") is not None and not isinstance(msg["tool_calls"], list):
            raise DeepSeekError(f"{self.provider} 返回的工具调用格式无效，将自动重试")
        call_ids = set()
        for call in msg.get("tool_calls") or []:
            function = call.get("function") if isinstance(call, dict) else None
            call_id = call.get("id") if isinstance(call, dict) else None
            if (not isinstance(function, dict) or not isinstance(function.get("name"), str)
                    or not function["name"] or not isinstance(function.get("arguments"), str)
                    or not isinstance(call_id, str) or not call_id or call_id in call_ids):
                raise DeepSeekError(f"{self.provider} 返回的工具调用内容无效，将自动重试")
            call_ids.add(call_id)
        finish = choices[0].get("finish_reason")
        usage = data.get("usage", {})

        result = {
            "role": "assistant",
            "content": msg.get("content") or "",
            "finish_reason": finish,
            "usage": usage,
        }
        tool_calls = msg.get("tool_calls")
        if "reasoning_content" in msg:
            result["reasoning_content"] = msg["reasoning_content"]
        if tool_calls:
            result["tool_calls"] = tool_calls
        if finish == "length":
            result["truncated"] = True
        return result


def describe_model() -> Dict[str, str]:
    return {"model": config.DEEPSEEK_MODEL, "base_url": config.DEEPSEEK_BASE_URL,
            "key_configured": bool(config.DEEPSEEK_API_KEY)}
