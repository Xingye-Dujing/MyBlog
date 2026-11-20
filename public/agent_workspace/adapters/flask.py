"""An optional Flask binding. Import it only when your host uses Flask.

It does no domain work: it maps JSON bodies onto ``ChatRequest`` and formats canonical events as
SSE. Every route has a direct equivalent on ``AgentWorkspace``, so a host on another framework can
copy this file's bodies into its own router. API keys arrive in the ``X-Provider-Key`` header, never
in a URL (proxy access logs must not record a secret).
"""

from __future__ import annotations

import json

from .. import config
from ..errors import WorkspaceError
from ..types import ChatRequest


def _sse(events):
    for item in events:
        yield f'data: {json.dumps(item, ensure_ascii=False, default=str)}\n\n'


def _json_error(exc: WorkspaceError):
    from flask import jsonify

    return jsonify(exc.to_dict()), 400


def create_blueprint(workspace, *, url_prefix='/api/ai', account_resolver=None):
    """Return a Flask Blueprint wired to ``workspace``."""
    from flask import Blueprint, Response, jsonify, request

    blueprint = Blueprint('agent_workspace', __name__, url_prefix=url_prefix)

    def account() -> str:
        if account_resolver is not None:
            return str(account_resolver() or 'default')
        return str(request.headers.get('X-Account') or request.args.get('account') or 'default')

    def body() -> dict:
        payload = request.get_json(silent=True)
        return payload if isinstance(payload, dict) else {}

    def _int_param(value, default, *, minimum=None, maximum=None):
        """解析不可信的整型查询/请求体参数，返回 ``(值, 错误响应)``。

        ``int('abc')`` 会在路由里抛 ValueError 并变成 HTTP 500；这里统一转成
        400，并按需夹紧到合理区间。
        """
        if value is None or value == '':
            number = default
        else:
            try:
                number = int(value)
            except (TypeError, ValueError, OverflowError):
                return None, (jsonify({'ok': False, 'error': 'invalid integer: %r' % (value,)}), 400)
        if minimum is not None:
            number = max(minimum, number)
        if maximum is not None:
            number = min(maximum, number)
        return number, None

    def api_key() -> str:
        return str(request.headers.get('X-Provider-Key') or body().get('api_key') or '')

    # ── bootstrap / catalog ───────────────────────────────────────────────────

    @blueprint.get('/bootstrap')
    def bootstrap():
        return jsonify(workspace.bootstrap(account(), request.args.get('provider', '')))

    @blueprint.get('/providers')
    def providers():
        return jsonify({'ok': True, 'providers': workspace.providers(account())})

    @blueprint.get('/providers/<provider_id>/models')
    def models(provider_id):
        try:
            return jsonify({'ok': True, 'models': workspace.models(provider_id, api_key(), account())})
        except WorkspaceError as exc:
            return _json_error(exc)

    @blueprint.get('/providers/<provider_id>/balance')
    def balance(provider_id):
        try:
            return jsonify(workspace.balance(provider_id, api_key(), account()))
        except WorkspaceError as exc:
            return _json_error(exc)

    @blueprint.post('/providers/<provider_id>/test')
    def test_provider(provider_id):
        try:
            return jsonify(workspace.test_provider(provider_id, body().get('model', ''), api_key(), account()))
        except WorkspaceError as exc:
            return _json_error(exc)

    # ── conversations / messages ──────────────────────────────────────────────

    @blueprint.get('/conversations')
    def conversations():
        # bool("0") is True, so the common ?archived=0 form must be parsed explicitly.
        archived = str(request.args.get('archived', '')).strip().lower() in ('1', 'true', 'yes', 'on')
        limit, error = _int_param(request.args.get('limit'), 50, minimum=1, maximum=500)
        if error:
            return error
        offset, error = _int_param(request.args.get('offset'), 0, minimum=0)
        if error:
            return error
        return jsonify(
            {
                'ok': True,
                'conversations': workspace.conversations(
                    account(),
                    query=request.args.get('q', ''),
                    archived=archived,
                    limit=limit,
                    offset=offset,
                ),
            }
        )

    @blueprint.post('/conversations')
    def new_conversation():
        row = workspace.store.create_conversation(account(), str(body().get('title') or ''))
        return jsonify({'ok': True, 'conversation': row}), 201

    @blueprint.route('/conversations/<conversation_id>', methods=['GET', 'PATCH', 'DELETE'])
    def conversation(conversation_id):
        if request.method == 'DELETE':
            return jsonify({'ok': workspace.delete_conversation(conversation_id, account())})
        if request.method == 'PATCH':
            return jsonify(
                {
                    'ok': True,
                    'conversation': workspace.patch_conversation(
                        conversation_id,
                        account(),
                        **{key: body()[key] for key in ('title', 'pinned', 'archived') if key in body()},
                    ),
                }
            )
        row = workspace.store.get_conversation(conversation_id, account())
        if not row:
            return jsonify({'ok': False, 'error': 'not found'}), 404
        payload = {'conversation': row, 'messages': workspace.messages(conversation_id)}
        return jsonify({'ok': True, **payload})

    @blueprint.get('/conversations/<conversation_id>/export')
    def export(conversation_id):
        text = workspace.export_conversation(conversation_id, account(), request.args.get('format', 'json'))
        mimetype = 'text/markdown' if request.args.get('format') == 'md' else 'application/json'
        return Response(text, mimetype=mimetype)

    @blueprint.route('/memories', methods=['GET', 'POST'])
    def memories():
        if request.method == 'POST':
            try:
                return jsonify({'ok': True, 'memory': workspace.add_memory(account(), body().get('text', ''))})
            except WorkspaceError as exc:
                return _json_error(exc)
        return jsonify({'ok': True, 'memories': workspace.store.list_memories(account()), 'limit': 200})

    @blueprint.delete('/memories/<memory_id>')
    def delete_memory(memory_id):
        return jsonify({'ok': workspace.delete_memory(account(), memory_id)})

    # ── chat / answer / retry / stop ──────────────────────────────────────────

    @blueprint.post('/chat')
    def chat():
        payload = body()
        max_tokens, error = _int_param(payload.get('max_tokens'), 0, minimum=0)
        if error:
            return error
        timeout, error = _int_param(payload.get('timeout'), 120, minimum=1, maximum=600)
        if error:
            return error
        context = dict(payload.get('context') or {})
        # The composer's extra facts are carried in the context payload, not as server settings.
        for key in ('attachments', 'scope', 'references', 'agent_mode', 'location', 'locale'):
            if key in payload:
                context[key] = payload[key]
        req = ChatRequest(
            text=str(payload.get('text') or ''),
            conversation_id=str(payload.get('conversation_id') or ''),
            account=account(),
            host=request.host_url.rstrip('/'),
            skill=str(payload.get('skill') or ''),
            provider=str(payload.get('provider') or ''),
            model=str(payload.get('model') or ''),
            api_key=api_key(),
            context_payload=context,
            thinking=payload.get('thinking'),
            web_search=payload.get('web_search'),
            safety=str(payload.get('safety') or ''),
            title=bool(payload.get('title', True)),
            max_tokens=max_tokens,
            timeout=timeout,
        )
        try:
            if payload.get('stream') is False:
                events = list(workspace.ask(req))
                return jsonify(
                    {
                        'ok': True,
                        'events': events,
                        'text': ''.join(
                            str(item.get('text') or '') for item in events if item.get('type') == 'text_delta'
                        ),
                    }
                )
            return Response(_sse(workspace.ask(req)), mimetype='text/event-stream')
        except WorkspaceError as exc:
            return _json_error(exc)

    @blueprint.post('/answer')
    def answer():
        payload = body()
        try:
            events = workspace.answer(
                str(payload.get('conversation_id') or ''),
                str(payload.get('call_id') or ''),
                payload.get('answers') or {},
                account=account(),
                custom=str(payload.get('custom') or ''),
            )
            if payload.get('stream') is False:
                return jsonify({'ok': True, 'events': list(events)})
            return Response(_sse(events), mimetype='text/event-stream')
        except WorkspaceError as exc:
            return _json_error(exc)

    @blueprint.post('/retry')
    def retry():
        payload = body()
        try:
            events = workspace.retry(str(payload.get('conversation_id') or ''), account(), api_key())
            if payload.get('stream') is False:
                return jsonify({'ok': True, 'events': list(events)})
            return Response(_sse(events), mimetype='text/event-stream')
        except WorkspaceError as exc:
            return _json_error(exc)

    @blueprint.post('/stop')
    def stop():
        return jsonify({'ok': workspace.stop(str(body().get('conversation_id') or ''))})

    @blueprint.post('/context')
    def context():
        payload = body()
        return jsonify(
            workspace.context_preview(str(payload.get('query') or ''), account(), payload.get('context') or {})
        )

    @blueprint.get('/references')
    def references():
        return jsonify({'ok': True, 'candidates': workspace.reference_candidates(account(), request.args.get('q', ''))})

    @blueprint.get('/usage')
    def usage():
        return jsonify({'ok': True, 'usage': workspace.usage(str(request.args.get('conversation_id') or ''))})

    @blueprint.get('/health')
    def health():
        return jsonify({'ok': True, 'service': 'agent-workspace'})

    # ── artifacts ─────────────────────────────────────────────────────────────

    @blueprint.get('/artifacts')
    def artifacts():
        return jsonify(
            {'ok': True, 'artifacts': workspace.artifacts(account(), request.args.get('conversation_id', ''))}
        )

    @blueprint.post('/artifacts/<artifact_id>/apply')
    def apply_artifact(artifact_id):
        try:
            return jsonify(workspace.apply_artifact(account(), artifact_id))
        except WorkspaceError as exc:
            return _json_error(exc)

    # ── skills / plugins ──────────────────────────────────────────────────────

    @blueprint.route('/skills', methods=['GET', 'POST'])
    def skills():
        if request.method == 'POST':
            try:
                return jsonify({'ok': True, 'skill': workspace.save_skill(account(), body())})
            except WorkspaceError as exc:
                return _json_error(exc)
        return jsonify({'ok': True, 'skills': workspace.skills.list(account())})

    @blueprint.delete('/skills/<skill_id>')
    def delete_skill(skill_id):
        return jsonify({'ok': workspace.delete_skill(account(), skill_id)})

    @blueprint.post('/skills/<skill_id>/fork')
    def fork_skill(skill_id):
        try:
            return jsonify({'ok': True, 'skill': workspace.fork_skill(account(), skill_id)})
        except WorkspaceError as exc:
            return _json_error(exc)

    @blueprint.route('/plugins', methods=['GET', 'POST'])
    def plugins():
        if request.method == 'POST':
            try:
                result = workspace.install_plugin(body(), account(), admin=bool(body().get('admin')))
                return jsonify({'ok': True, **result})
            except WorkspaceError as exc:
                return _json_error(exc)
        return jsonify({'ok': True, 'plugins': workspace.plugins_list()})

    @blueprint.post('/plugins/<plugin_id>/enable')
    def toggle_plugin(plugin_id):
        try:
            result = workspace.toggle_plugin(plugin_id, account(), bool(body().get('enabled')))
            return jsonify({'ok': True, **result})
        except WorkspaceError as exc:
            return _json_error(exc)

    @blueprint.delete('/plugins/<plugin_id>')
    def uninstall_plugin(plugin_id):
        try:
            return jsonify({'ok': workspace.uninstall_plugin(plugin_id, account())})
        except WorkspaceError as exc:
            return _json_error(exc)

    # ── monitors ──────────────────────────────────────────────────────────────

    @blueprint.route('/monitors', methods=['GET', 'POST'])
    def monitors():
        if request.method == 'POST':
            payload = body()
            try:
                return jsonify(
                    {
                        'ok': True,
                        'monitor': workspace.arm_monitor(
                            account(), str(payload.get('conversation_id') or ''), payload.get('conditions') or {}
                        ),
                    }
                )
            except WorkspaceError as exc:
                return _json_error(exc)
        return jsonify({'ok': True, 'monitors': workspace.monitors_list(account())})

    @blueprint.delete('/monitors/<monitor_id>')
    def stop_monitor(monitor_id):
        return jsonify({'ok': workspace.stop_monitor(account(), monitor_id)})

    @blueprint.get('/monitors/events')
    def monitor_events():
        return jsonify({'ok': True, 'events': workspace.monitors.pending(account())})

    @blueprint.post('/monitors/events/<delivery_id>/ack')
    def ack_delivery(delivery_id):
        return jsonify({'ok': workspace.monitors.ack(account(), delivery_id)})

    # ── files ─────────────────────────────────────────────────────────────────

    @blueprint.route('/files', methods=['GET', 'POST'])
    def files():
        if request.method == 'POST':
            payload = body()
            size, error = _int_param(payload.get('size'), 0, minimum=0)
            if error:
                return error
            return jsonify(
                {
                    'ok': True,
                    'file': workspace.add_file(
                        account(),
                        str(payload.get('name') or ''),
                        str(payload.get('path') or ''),
                        size,
                        str(payload.get('conversation_id') or ''),
                    ),
                }
            )
        return jsonify({'ok': True, 'files': workspace.files(account(), request.args.get('conversation_id', ''))})

    @blueprint.delete('/files/<file_id>')
    def delete_file(file_id):
        return jsonify({'ok': workspace.delete_file(account(), file_id)})

    # ── python extension ──────────────────────────────────────────────────────

    @blueprint.get('/python/status')
    def python_status():
        from .. import python_runtime

        return jsonify({'ok': True, 'status': python_runtime.status(workspace.settings)})

    @blueprint.route('/python/scripts', methods=['GET', 'POST'])
    def python_scripts():
        try:
            if request.method == 'POST':
                return jsonify({'ok': True, 'script': workspace.save_script(account(), body())})
            return jsonify({'ok': True, 'scripts': workspace.scripts(account())})
        except WorkspaceError as exc:
            return _json_error(exc)

    @blueprint.get('/python/scripts/<script_id>')
    def python_script(script_id):
        row = workspace.get_script(account(), script_id)
        if not row:
            return jsonify({'ok': False, 'error': 'not found'}), 404
        return jsonify({'ok': True, 'script': row})

    @blueprint.post('/python/scripts/<script_id>/fork')
    def fork_script(script_id):
        try:
            return jsonify({'ok': True, 'script': workspace.fork_script(account(), script_id)})
        except WorkspaceError as exc:
            return _json_error(exc)

    @blueprint.delete('/python/scripts/<script_id>')
    def delete_script(script_id):
        return jsonify({'ok': workspace.delete_script(account(), script_id)})

    @blueprint.post('/python/run')
    def python_run():
        payload = body()
        try:
            result = workspace.tools.execute(
                'python_run',
                payload,
                {
                    'account': account(),
                    'conversation_id': str(payload.get('conversation_id') or ''),
                },
            )
            return jsonify({'ok': True, **result})
        except WorkspaceError as exc:
            return _json_error(exc)

    # ── settings / workspace ──────────────────────────────────────────────────

    @blueprint.route('/settings', methods=['GET', 'POST'])
    def settings():
        if request.method == 'POST':
            try:
                return jsonify(
                    {'ok': True, 'settings': {key: workspace.set_setting(key, value) for key, value in body().items()}}
                )
            except WorkspaceError as exc:
                return _json_error(exc)
        return jsonify({'ok': True, 'settings': workspace.settings.all(), 'schema': config.schema()})

    @blueprint.route('/workspace', methods=['GET', 'POST'])
    def workfolder():
        ws = workspace.workspace(account())
        if request.method == 'POST':
            try:
                return jsonify(ws.set_root(str(body().get('folder') or '')))
            except WorkspaceError as exc:
                return _json_error(exc)
        return jsonify(ws.describe())

    return blueprint
