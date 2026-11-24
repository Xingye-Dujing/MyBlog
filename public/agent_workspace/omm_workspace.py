# -*- coding: utf-8 -*-
"""OMM-ZEN 的 AgentWorkspace 适配：配置注入、暂停恢复与产物幂等。"""
from __future__ import annotations

import json

from .agent import Agent
from .errors import AIError
from .omm_config import _resolve_provider, load_shared_ai_config
from .service import AgentWorkspace
from .types import ChatRequest

_PROVIDER_PREF = 'omm.ai.provider.'


class OMMAgent(Agent):
    def _system(self, request, skill, provider, account) -> str:
        base = super()._system(request, skill, provider, account)
        extra = str((request.context_payload or {}).get('omm_system') or '').strip()
        if not extra:
            return base
        return base + '\n\nUser-configured system instructions:\n' + extra


class OMMWorkspace(AgentWorkspace):
    """只扩展 OMM 适配层，不修改 vendored agent/service/store。"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.agent = OMMAgent(self)
        self._artifact_plans = {}

    def _save_provider_config(self, conversation_id: str, request: ChatRequest, model: str = '') -> None:
        if not conversation_id:
            return
        context = request.context_payload or {}
        value = {
            'provider': request.provider,
            'logical_provider': str(context.get('omm_logical_provider') or request.provider),
            'model': model or request.model,
            'base_url': str(context.get('omm_base_url') or ''),
            'system': str(context.get('omm_system') or ''),
        }
        self.store.set_pref(request.account or 'default', _PROVIDER_PREF + conversation_id,
                            json.dumps(value, ensure_ascii=False, sort_keys=True))

    def _load_provider_config(self, account: str, conversation_id: str) -> dict:
        raw = self.store.get_pref(account or 'default', _PROVIDER_PREF + conversation_id, '')
        try:
            value = json.loads(raw)
        except (TypeError, ValueError):
            return {}
        return value if isinstance(value, dict) else {}

    def ask(self, request: ChatRequest):
        shared = load_shared_ai_config()
        context = dict(request.context_payload or {})
        payload = {
            'provider': request.provider,
            'model': request.model,
            'baseUrl': context.get('omm_base_url') or '',
            'context': context,
        }
        _resolve_provider(self, payload, shared)
        request.provider = str(payload.get('provider') or '')
        request.model = str(payload.get('model') or '')
        request.api_key = str(request.api_key or shared['apiKey'] or '')
        request.context_payload = dict(payload.get('context') or {})
        for event in super().ask(request):
            if event.get('type') in ('conversation', 'meta'):
                self._save_provider_config(
                    str(event.get('conversation_id') or request.conversation_id or ''),
                    request,
                    str(event.get('model') or ''),
                )
            yield event

    def answer(self, conversation_id: str, call_id: str, answers, *, account: str = 'default',
               custom: str = '', provider: str = '', model: str = '', base_url: str = '',
               api_key: str = ''):
        if not api_key:
            try:
                from flask import has_request_context, request
                if has_request_context():
                    api_key = str(request.headers.get('X-Provider-Key') or '')
            except (ImportError, RuntimeError):
                pass
        saved = self._load_provider_config(account, conversation_id)
        logical_provider = str(saved.get('logical_provider') or saved.get('provider') or provider or '')
        context = {
            'omm_base_url': str(saved.get('base_url') or base_url or ''),
            'omm_logical_provider': logical_provider,
            'omm_system': str(saved.get('system') or ''),
        }
        request = ChatRequest(
            text='',
            conversation_id=conversation_id,
            account=account,
            provider=logical_provider,
            model=str(saved.get('model') or model or ''),
            api_key=api_key,
            context_payload=context,
            answers={'call_id': call_id, **(answers if isinstance(answers, dict) else {}), 'custom': custom},
            resume_call_id=call_id,
        )
        return self.ask(request)

    def apply_artifact(self, account: str, artifact_id: str) -> dict:
        with self._lock:
            artifact = self.store.get_artifact(artifact_id)
            if not artifact or artifact.get('account') != account:
                raise AIError('artifact.unknown', kind='not_found', key='artifact.unknown', reason=artifact_id)
            if artifact.get('status') == 'applied':
                return {
                    'ok': True,
                    'artifact_id': artifact_id,
                    'already_applied': True,
                    'result': {'ok': True, 'kind': artifact['kind'], 'action': 'already_applied'},
                }
            if artifact.get('status') == 'prepared' and artifact_id in self._artifact_plans:
                return {
                    'ok': True,
                    'artifact_id': artifact_id,
                    'already_prepared': True,
                    'result': self._artifact_plans[artifact_id],
                }
            result = self._artifact_plans.get(artifact_id)
            if result is None:
                result = self.host.apply_artifact(artifact['kind'], artifact['payload'])
                self._artifact_plans[artifact_id] = result
            self.store._run(
                "UPDATE artifacts SET status='prepared' WHERE id=? AND status!='applied'",
                (artifact_id,),
            )
            return {'ok': True, 'artifact_id': artifact_id, 'result': result}

    def commit_artifact(self, account: str, artifact_id: str) -> dict:
        """确认客户端已真实保存/发送/打开产物，避免假应用。"""
        with self._lock:
            artifact = self.store.get_artifact(artifact_id)
            if not artifact or artifact.get('account') != account:
                raise AIError('artifact.unknown', kind='not_found', key='artifact.unknown', reason=artifact_id)
            self.store._run(
                "UPDATE artifacts SET status='applied' WHERE id=? AND status!='applied'",
                (artifact_id,),
            )
            self._artifact_plans.pop(artifact_id, None)
            return {'ok': True, 'artifact_id': artifact_id, 'status': 'applied'}
