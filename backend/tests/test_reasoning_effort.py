import json

import httpx
import pytest
from pydantic import ValidationError

from app.config import Settings
from app.llm.client import LlmClient


@pytest.mark.parametrize('effort', ['', 'low', 'high', 'max'])
async def test_reasoning_effort_is_explicit_opt_in(monkeypatch, effort):
    actual_client = httpx.AsyncClient
    def handle(request):
        body = json.loads(request.content)
        if effort:
            assert body['reasoning_effort'] == effort
        else:
            assert 'reasoning_effort' not in body
        assert body.get('thinking', {}).get('type') != 'disabled'
        assert body['tools'][0]['function']['name'] == 'test'
        return httpx.Response(200, text='data: [DONE]\n\n')
    monkeypatch.setattr('app.llm.client.httpx.AsyncClient',
                        lambda **kwargs: actual_client(transport=httpx.MockTransport(handle), **kwargs))
    settings = Settings(_env_file=None, llm_base_url='http://localhost/v1', llm_reasoning_effort=effort)
    events = [e async for e in LlmClient(settings).stream(
        [{'role': 'user', 'content': 'test'}],
        [{'type': 'function', 'function': {'name': 'test', 'parameters': {'type': 'object'}}}])]
    assert events[-1].type == 'done'


def test_invalid_reasoning_effort_fails_configuration():
    with pytest.raises(ValidationError):
        Settings(_env_file=None, llm_reasoning_effort='typo')
