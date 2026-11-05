"""MiMo 请求协议与推理工具调用回合的离线兼容测试。"""
import json

import httpx
import pytest

from app.agent.loop import PhaseRunner
from app.services import deepseek


def mock_transport(monkeypatch, handler):
    client_class = httpx.Client
    monkeypatch.setattr(
        deepseek.httpx, "Client",
        lambda **kwargs: client_class(transport=httpx.MockTransport(handler), **kwargs),
    )


@pytest.mark.parametrize("base_url,budget_field,auth_header", [
    ("https://api.xiaomimimo.com/v1", "max_completion_tokens", "api-key"),
    ("https://api.deepseek.com/v1", "max_tokens", "authorization"),
])
def test_provider_request_contract(monkeypatch, base_url, budget_field, auth_header):
    def respond(request):
        payload = json.loads(request.content)
        assert str(request.url) == base_url + "/chat/completions"
        assert payload[budget_field] == 2048
        assert payload["tool_choice"] == "auto"
        assert auth_header in request.headers
        if auth_header == "api-key":
            assert request.headers["api-key"] == "mock-key"
            assert "authorization" not in request.headers
            assert payload["thinking"] == {"type": "enabled"}
            assert "max_tokens" not in payload
            assert "temperature" not in payload
        else:
            assert request.headers["authorization"] == "Bearer mock-key"
            assert payload["temperature"] == 0.2
            assert "thinking" not in payload
            assert "max_completion_tokens" not in payload
        return httpx.Response(200, json={"choices": [{
            "message": {"role": "assistant", "content": "OK"},
            "finish_reason": "stop",
        }]})

    mock_transport(monkeypatch, respond)
    client = deepseek.DeepSeekClient(api_key="mock-key", base_url=base_url, model="test-model")
    result = client.chat([{"role": "user", "content": "Test"}],
                         tools=[{"type": "function", "function": {"name": "echo"}}],
                         max_tokens=2048, temperature=0.2)
    assert result["content"] == "OK"
    assert "reasoning_content" not in PhaseRunner._assistant_message(result)


@pytest.mark.parametrize("reasoning", ["Need to call the tool first.", ""])
def test_reasoning_survives_tool_round_trip(monkeypatch, reasoning):
    calls = []
    tool_call = {"id": "call_1", "type": "function", "function": {
        "name": "echo", "arguments": "{}",
    }}

    def respond(request):
        payload = json.loads(request.content)
        calls.append(payload)
        if len(calls) == 1:
            message = {"role": "assistant", "content": None,
                       "reasoning_content": reasoning, "tool_calls": [tool_call]}
            finish = "tool_calls"
        else:
            # MiMo 拒绝缺失 reasoning_content 的工具回合；验证实际发出的消息。
            assistant = payload["messages"][-2]
            assert assistant["reasoning_content"] == reasoning
            assert assistant["tool_calls"] == [tool_call]
            assert "usage" not in assistant
            assert payload["messages"][-1]["tool_call_id"] == "call_1"
            message = {"role": "assistant", "content": "MIMO_OK"}
            finish = "stop"
        return httpx.Response(200, json={"choices": [{
            "message": message, "finish_reason": finish,
        }]})

    mock_transport(monkeypatch, respond)
    client = deepseek.DeepSeekClient(api_key="mock-key",
                                    base_url="https://api.xiaomimimo.com/v1", model="mimo-v2.6-pro")
    messages = [{"role": "user", "content": "Use echo."}]
    first = client.chat(messages)
    messages.append(PhaseRunner._assistant_message(first))
    messages.append({"role": "tool", "tool_call_id": "call_1", "content": "MIMO_OK"})
    assert client.chat(messages)["content"] == "MIMO_OK"
    assert len(calls) == 2
