# -*- coding: utf-8 -*-
"""静书房统一 AI 配置与请求级 provider 解析。"""
from __future__ import annotations

import hashlib
import json
import re
import threading
from urllib.parse import urlsplit, urlunsplit

from .omm_host import shared_dir
from .providers.deepseek import DeepSeekProvider
from .providers.ollama import OllamaProvider
from .providers.openai_compat import OpenAICompatibleProvider
from .types import ModelSpec, ProviderSpec

_DEFAULT_BASE = {
    'deepseek': 'https://api.deepseek.com',
    'openai': 'https://api.openai.com/v1',
    'openrouter': 'https://openrouter.ai/api/v1',
    'zhipu': 'https://open.bigmodel.cn/api/paas/v4',
    'opencode_go': 'http://127.0.0.1:4096/v1',
    'ollama': 'http://127.0.0.1:11434',
    'custom': '',
}
_DEFAULT_MODEL = {
    'deepseek': 'deepseek-chat',
    'openai': 'gpt-4o-mini',
    'openrouter': 'openai/gpt-4o-mini',
    'zhipu': 'glm-4-flash',
    'opencode_go': 'opencode-go',
    'ollama': 'qwen3.5:9b',
    'custom': 'gpt-4o-mini',
}
_PROVIDER_CAPABILITIES = frozenset({'tools', 'ask_user', 'vision', 'title'})
_PROVIDER_LOCK = threading.RLock()


def load_shared_ai_config() -> dict:
    """读取 shared.json；apiKey 只由服务端请求路径使用，不进入公开响应。"""
    try:
        cfg = json.loads((shared_dir() / 'shared.json').read_text(encoding='utf-8-sig'))
    except (OSError, ValueError, TypeError):
        cfg = {}
    ai = cfg.get('ai') if isinstance(cfg, dict) and isinstance(cfg.get('ai'), dict) else {}
    return {
        'provider': str(ai.get('provider') or '').strip().lower(),
        'baseUrl': str(ai.get('baseUrl') or ai.get('apiBase') or '').strip(),
        'model': str(ai.get('apiModel') or '').strip(),
        'apiKey': str(ai.get('apiKey') or ''),
        'system': str(ai.get('system') or ''),
    }


def public_ai_config() -> dict:
    """返回浏览器可安全消费的非敏感配置。"""
    ai = load_shared_ai_config()
    provider = ai['provider'] or 'deepseek'
    return {
        'ok': True,
        'configured': bool(ai['apiKey']) or provider in ('ollama', 'complete'),
        'provider': provider,
        'baseUrl': ai['baseUrl'],
        'model': ai['model'],
        'system': ai['system'],
    }


def normalize_base_url(base_url: str, provider: str = 'custom') -> str:
    """规范化 URL；等价写法得到同一个稳定 provider ID。"""
    raw = str(base_url or '').strip()
    if not raw:
        return ''
    if not re.match(r'^https?://', raw, re.I):
        raw = 'http://' + raw
    try:
        parsed = urlsplit(raw)
        if parsed.scheme.lower() not in ('http', 'https') or not parsed.hostname or parsed.username:
            return ''
        hostname = parsed.hostname.lower()
        if ':' in hostname:
            hostname = '[' + hostname + ']'
        port = parsed.port
        if port and not ((parsed.scheme.lower() == 'http' and port == 80) or
                         (parsed.scheme.lower() == 'https' and port == 443)):
            hostname += ':' + str(port)
        path = re.sub(r'/{2,}', '/', parsed.path).rstrip('/')
        if path.endswith('/chat/completions'):
            path = path[:-len('/chat/completions')]
        normalized = urlunsplit((parsed.scheme.lower(), hostname, path, '', ''))
    except (TypeError, ValueError):
        return ''
    if provider == 'deepseek' and normalized:
        normalized += '/chat/completions'
    return normalized


class OMMOllamaProvider(OllamaProvider):
    """Ollama 的地址只来自本次规范化配置，绝不借用 AI 插件页的 host URL。"""

    def _base(self, request_or_host=None) -> str:
        requested = request_or_host.get('base_url') if isinstance(request_or_host, dict) else ''
        return str(requested or self.spec.base_url or _DEFAULT_BASE['ollama']).rstrip('/')


def _custom_provider(identifier: str, target: str, base_url: str, model: str):
    chosen_model = model or _DEFAULT_MODEL.get(identifier, 'gpt-4o-mini')
    if identifier == 'ollama':
        provider = OMMOllamaProvider()
        spec = ProviderSpec(
            id=target,
            label_key='omm.provider.' + target,
            notes_key='omm.providerNote.' + target,
            protocol='ollama',
            base_url=base_url,
            models=(ModelSpec(chosen_model, chosen_model),),
            requires_key=False,
            local_only=True,
            capabilities=frozenset({'tools', 'ask_user', 'thinking'}),
        )
    elif identifier == 'deepseek':
        provider = DeepSeekProvider()
        known = {item.id: item for item in provider.spec.models}
        selected = known.get(chosen_model, ModelSpec(chosen_model, chosen_model))
        model_spec = ModelSpec(selected.id, selected.label, selected.max_context,
                               selected.capabilities | frozenset({'ask_user'}))
        spec = ProviderSpec(
            id=target,
            label_key='omm.provider.' + target,
            notes_key='omm.providerNote.' + target,
            protocol='deepseek',
            base_url=base_url,
            models=(model_spec,),
            requires_key=True,
            capabilities=provider.spec.capabilities | _PROVIDER_CAPABILITIES,
        )
    else:
        provider = OpenAICompatibleProvider()
        spec = ProviderSpec(
            id=target,
            label_key='omm.provider.' + target,
            notes_key='omm.providerNote.' + target,
            protocol='openai',
            base_url=base_url,
            models=(ModelSpec(chosen_model, chosen_model),),
            requires_key=identifier != 'opencode_go',
            capabilities=_PROVIDER_CAPABILITIES,
        )
    provider.spec = spec
    return provider


def _register_custom_provider(ws, identifier: str, base_url: str, model: str) -> str:
    """每个规范化 Base URL 对应不可变实例；并发请求不能互相替换。"""
    normalized = normalize_base_url(base_url, identifier)
    digest = hashlib.sha256(normalized.encode('utf-8')).hexdigest()[:16]
    stem = re.sub(r'[^a-z0-9_]', '_', identifier.lower())[:40] or 'custom'
    target = 'omm_' + stem + '_' + digest
    with _PROVIDER_LOCK:
        existing = ws.catalog.get(target, check_scope=False)
        if existing is not None:
            if str(existing.spec.base_url or '') != normalized:
                raise ValueError('provider hash collision')
            return target
        ws.catalog.register(_custom_provider(identifier, target, normalized, model))
    return target


def _resolve_provider(ws, payload: dict, shared: dict | None = None) -> None:
    """把逻辑 provider/model/baseUrl 解析为请求专属、不可变的 catalog ID。"""
    shared = shared if shared is not None else load_shared_ai_config()
    requested_provider = str(payload.get('provider') or '').strip().lower()
    provider = requested_provider or shared['provider'] or str(ws.catalog.default_id() or 'complete')
    model = str(payload.get('model') or '').strip()
    if not model and (not requested_provider or provider == shared['provider']):
        model = shared['model']

    requested_base = str(payload.get('baseUrl') or payload.get('apiBase') or '').strip()
    if requested_base:
        base_url = requested_base
    elif not requested_provider or provider == shared['provider']:
        base_url = shared['baseUrl']
    else:
        base_url = _DEFAULT_BASE.get(provider, '')

    context = payload.get('context') if isinstance(payload.get('context'), dict) else {}
    context = dict(context)
    if shared['system'] and 'omm_system' not in context:
        context['omm_system'] = shared['system']

    if provider == 'complete':
        resolved = 'complete'
        model = model or 'complete'
        base_url = ''
    elif provider.startswith('omm_') and ws.catalog.get(provider, check_scope=False) is not None:
        resolved = provider
        base_url = str(ws.catalog.get(provider, check_scope=False).spec.base_url or '')
    else:
        base_url = normalize_base_url(base_url or _DEFAULT_BASE.get(provider, ''), provider)
        if not base_url:
            resolved = 'complete'
            model = 'complete'
        else:
            resolved = _register_custom_provider(ws, provider, base_url, model)
            model = model or _DEFAULT_MODEL.get(provider, 'gpt-4o-mini')

    context['omm_base_url'] = base_url
    context.setdefault('omm_logical_provider', provider)
    payload['provider'] = resolved
    if model:
        payload['model'] = model
    payload['context'] = context
