"""The turn loop: one provider call, many tool calls, one durable transcript.

A turn is several assistant rows, not one. Each tool use is followed immediately by its result,
all grouped by ``turn_id``. A question pauses the turn; its answer arrives in a later request as a
tool result, not as a new user message. Writes are artifacts the user applies — never a side effect
of the model deciding so.

The assistant row is created BEFORE the provider call as ``streaming`` and settled after it. A kill
or disconnect therefore leaves a row the next boot can settle as ``interrupted``, instead of an
answer that vanished. Each provider round gets its own assistant row so tool results stay adjacent
to the calls they answer.
"""

from __future__ import annotations

import json
import time

from . import approval_preview
from .errors import AIError, WorkspaceError
from .providers.base import replay_context
from .types import (
    ChatRequest,
    block_text,
    message_text,
    new_id,
    text_block,
    thinking_block,
    tool_result_block,
    tool_use_block,
)
from .util import estimate_tokens, event

PERSIST_EVERY_SECONDS = 1.0


class Agent:
    def __init__(self, services):
        self.services = services

    # ── transcript → provider messages ─────────────────────────────────────────

    @staticmethod
    def provider_messages(rows: list[dict]) -> list[dict]:
        out = []
        for row in rows:
            role = row.get('role')
            meta = row.get('meta') or {}
            if role == 'user':
                out.append(
                    {
                        'role': 'user',
                        'content': message_text(row),
                        'meta': {'context_text': meta.get('context_text', '')},
                    }
                )
            elif role == 'assistant':
                tool_calls = []
                for block in row.get('blocks') or []:
                    if block.get('type') == 'tool_use':
                        tool_calls.append(
                            {
                                'id': block.get('id'),
                                'type': 'function',
                                'function': {
                                    'name': block.get('name'),
                                    'arguments': json.dumps(block.get('input') or {}, ensure_ascii=False),
                                },
                            }
                        )
                out.append(
                    {
                        'role': 'assistant',
                        'content': block_text(row.get('blocks')),
                        'tool_calls': tool_calls,
                        'meta': {'reasoning_content': meta.get('reasoning_content', '')},
                    }
                )
            elif role == 'tool':
                block = next((item for item in row.get('blocks') or [] if item.get('type') == 'tool_result'), {})
                out.append(
                    {
                        'role': 'tool',
                        'tool_call_id': block.get('tool_use_id', ''),
                        'content': json.dumps(block.get('content'), ensure_ascii=False, default=str),
                    }
                )
        return out

    def repair_tool_pairs(self, rows: list[dict], turn_id: str) -> list[dict]:
        """Heal an orphan ``tool_use`` left by a crash between the call and its result.

        Providers reject a tool_call without its result, so one interrupted turn must not poison
        every later turn. A synthetic result records the fact; it is never presented as an answer.
        """
        answered = set()
        for row in rows:
            for block in row.get('blocks') or []:
                if block.get('type') == 'tool_result':
                    answered.add(str(block.get('tool_use_id') or ''))
        repaired = []
        for row in rows:
            repaired.append(row)
            if row.get('role') != 'assistant':
                continue
            for block in row.get('blocks') or []:
                if block.get('type') != 'tool_use':
                    continue
                call_id = str(block.get('id') or '')
                if call_id and call_id not in answered:
                    answered.add(call_id)
                    self.services.store.append_message(
                        row['conversation_id'],
                        turn_id,
                        'tool',
                        [tool_result_block(call_id, {'interrupted': True}, True)],
                        {'tool': block.get('name', ''), 'call_id': call_id, 'repair': True},
                    )
                    repaired.append(
                        {
                            'role': 'tool',
                            'conversation_id': row['conversation_id'],
                            'blocks': [tool_result_block(call_id, {'interrupted': True}, True)],
                            'meta': {},
                        }
                    )
        return repaired

    def fit_history(self, messages: list[dict], window: int, reserved: int = 0) -> tuple[list[dict], dict]:
        """Drop oldest whole turns at a user boundary; never cut a system prompt mid-string.

        ``reserved`` is the system prompt plus tool schemas plus the output budget: counting only
        message characters lets a local model's prompt overflow the window it actually reports.
        """
        meta = {'window': window, 'budget': 0, 'dropped': 0, 'kept': len(messages)}
        if not window:
            return messages, meta
        budget = max(200, int(window * 0.8) - int(reserved))
        meta['budget'] = budget
        total = sum(estimate_tokens(str(item.get('content') or '')) for item in messages)
        if total <= budget:
            return messages, meta
        kept = list(messages)
        while kept and total > budget:
            index = next((i for i, item in enumerate(kept) if item.get('role') == 'user'), None)
            if index is None:
                break
            end = next((i for i in range(index + 1, len(kept)) if kept[i].get('role') == 'user'), len(kept))
            removed = kept[index:end]
            total -= sum(estimate_tokens(str(item.get('content') or '')) for item in removed)
            del kept[index:end]
            meta['dropped'] += 1
        meta['kept'] = len(kept)
        return kept, meta

    # ── one turn ───────────────────────────────────────────────────────────────

    def run(self, request: ChatRequest):
        services = self.services
        store = services.store
        account = request.account or 'default'
        conversation_id = request.conversation_id
        conversation = store.get_conversation(conversation_id, account)
        if not conversation:
            conversation = store.create_conversation(account, title='', conversation_id=conversation_id)
            conversation_id = conversation['id']
            yield event('conversation', conversation_id=conversation_id)
        request.conversation_id = conversation_id
        resuming = bool(request.context_payload.get('resume_mode'))
        retrying = bool(request.context_payload.get('retry'))

        turn_id = new_id('turn')
        cancel = request.cancel_event
        provider_id = request.provider or services.catalog.default_id()
        provider = services.catalog.get(provider_id, account)
        if provider is None:
            raise AIError('provider.unknown', kind='refused', key='provider.unknown', reason=provider_id)
        configured_model = str(services.settings.get('chat.default_model', '') or '')
        model = (
            request.model
            or configured_model
            or (provider.spec.models[0].id if provider.spec.models else '')
            or services.catalog.default_model(provider_id, request.api_key, request.host)
        )

        if request.thinking and not provider.supports('thinking', model):
            raise AIError(
                'capability.refused',
                kind='capability',
                key='capability.refused',
                reason=services.t('workspace.refusal.capability', capability='thinking'),
            )
        if request.answers is not None:
            yield from self._resume(request, conversation_id, account, turn_id, provider, model)
            return

        # A paused question the user never answered leaves an assistant tool_use in the transcript.
        # Providers (Ollama included) reject a tool_call without its tool_result, so a NEW user turn
        # must first settle any pending call with an explicit "skipped" result.
        for call_id, info in list(services.pending.items()):
            if info.get('conversation_id') == conversation_id:
                services.pending.pop(call_id, None)
                self._persist_tool_result(
                    conversation_id, turn_id, call_id, info.get('tool', 'question'), {'skipped': True}, False
                )

        if retrying:
            previous = store.last_message(conversation_id, 'user')
            text = message_text(previous) if previous else ''
            if not text:
                raise AIError('retry.noUserTurn', kind='not_found', key='retry.noUserTurn', reason=conversation_id)
            context_text, context_meta = services.context.build(text, account, request.context_payload)
            replay_text, replay_meta = services.context.for_replay(context_text)
            context_meta.update(replay_meta)
            context_meta['retried'] = True
        elif resuming:
            previous = store.last_message(conversation_id, 'user')
            text = message_text(previous) if previous else ''
            replay_text = str((previous.get('meta') or {}).get('context_text') or '')
            context_meta = {'resumed': True}
        else:
            text = request.text
            context_text, context_meta = services.context.build(text, account, request.context_payload)
            replay_text, replay_meta = services.context.for_replay(context_text)
            context_meta.update(replay_meta)

        skill = services.skills.get(request.skill or 'general', account)
        if skill is None:
            raise AIError('skill.unknown', kind='refused', key='skill.unknown', reason=request.skill)
        available, reason = services.skills.availability(skill, provider_id, model)
        if not available:
            raise AIError('skill.unavailable', kind='capability', key='skill.unavailable', reason=reason)
        if request.web_search is None:
            request.web_search = bool(services.settings.get('chat.web_search_default', True))
        if request.web_search and provider.supports('web_search', model):
            context_meta['web_search'] = True

        yield event(
            'meta',
            conversation_id=conversation_id,
            turn_id=turn_id,
            skill=skill.id,
            provider=provider_id,
            model=model,
            context=context_meta,
        )
        if not (resuming or retrying):
            yield from self._user_row(conversation_id, turn_id, text, replay_text, account)

        allowed = set(skill.tools)
        tool_schemas = services.tools.schemas(allowed)
        if request.context_payload.get('chat_only'):
            tool_schemas = []
            allowed = set()
        elif request.context_payload.get('disable_questions'):
            tool_schemas = [
                schema for schema in tool_schemas if schema['name'] not in ('ask_user_question', 'request_approval')
            ]
            allowed -= {'ask_user_question', 'request_approval'}

        rounds = 0
        max_rounds = int(services.settings.get('tools.max_rounds', 30))
        while True:
            if cancel is not None and getattr(cancel, 'is_set', lambda: False)():
                yield event('done', stop_reason='cancelled')
                return
            spend = services.costs.spend_state(conversation_id, account)
            if spend['exceeded']:
                yield event(
                    'error',
                    kind='budget',
                    message=services.t('workspace.budget.exceeded', scope=spend['scope'], limit=spend['limit']),
                )
                yield event('paused', reason='budget', conversation_id=conversation_id)
                return

            rows = self.repair_tool_pairs(store.list_messages(conversation_id), turn_id)
            history = self.provider_messages(rows)
            window = provider.context_window(model)
            reserved = (
                estimate_tokens(self._system(request, skill, provider, account))
                + estimate_tokens(json.dumps(tool_schemas, ensure_ascii=False))
                + int(request.max_tokens or 2048)
            )
            history, history_meta = self.fit_history(history, window, reserved)
            context_meta['history'] = history_meta
            provider_messages = list(history)
            if not resuming or retrying:
                provider_messages.append({'role': 'user', 'content': text, 'meta': {'context_text': replay_text}})
            payload = {
                'system': self._system(request, skill, provider, account),
                'messages': replay_context(provider_messages),
                'tools': tool_schemas,
                'thinking': request.thinking,
                'web_search': request.web_search,
                'safety': request.safety,
                'title': request.title,
                'max_tokens': request.max_tokens,
                'timeout': request.timeout,
                'cancel_event': cancel,
                'api_key': request.api_key,
                'host': request.host,
                'model': model,
                'user_id': account,
                'reasoning_effort': services.settings.get('chat.reasoning_effort', 'high'),
                'temperature': float(services.settings.get('chat.temperature', 0.3) or 0.3),
                'tool_mode': request.context_payload.get('tool_mode', ''),
            }
            # The row exists before the first byte is read, so a crash leaves a visible answer.
            assistant_row = store.append_message(
                conversation_id,
                turn_id,
                'assistant',
                [],
                {'context_text': replay_text},
                status='streaming',
            )
            assistant_blocks: list[dict] = []
            assistant_meta: dict = {}
            tool_calls: list[dict] = []
            usage: dict = {}
            stop_reason = 'end_turn'
            title = ''
            last_flush = time.monotonic()
            try:
                for item in provider.stream(payload):
                    kind = item.get('type')
                    if kind not in ('meta', 'usage', 'done', 'title'):
                        yield item
                    if kind == 'thinking_delta':
                        assistant_blocks.append(thinking_block(item.get('text', '')))
                    elif kind == 'text_delta':
                        assistant_blocks.append(text_block(item.get('text', '')))
                    elif kind == 'tool_call':
                        call = {
                            'id': item.get('id') or new_id('call'),
                            'name': item.get('name') or '',
                            'arguments': item.get('arguments') or {},
                        }
                        tool_calls.append(call)
                        assistant_blocks.append(tool_use_block(call['id'], call['name'], call['arguments']))
                        if item.get('parse_error'):
                            assistant_meta['parse_error'] = item['parse_error']
                    elif kind == 'usage':
                        usage = item.get('usage') or {}
                    elif kind == 'title':
                        title = item.get('text', '')
                    elif kind == 'citation':
                        assistant_meta.setdefault('citations', []).append(item.get('payload') or {})
                    elif kind == 'server_tool':
                        assistant_meta.setdefault('server_tools', []).append(
                            item.get('payload') or item.get('block') or {}
                        )
                    elif kind == 'refusal':
                        assistant_meta['refusal'] = item.get('text', '')
                    elif kind == 'done':
                        stop_reason = item.get('stop_reason') or 'end_turn'
                        assistant_meta.update(
                            {key: value for key, value in item.items() if key in ('stop_reason', 'reasoning_content')}
                        )
                    if time.monotonic() - last_flush >= PERSIST_EVERY_SECONDS:
                        self._flush(assistant_row['id'], assistant_blocks, assistant_meta, 'streaming')
                        last_flush = time.monotonic()
            except WorkspaceError as exc:
                status = 'interrupted' if exc.kind in ('cancelled', 'error') else 'error'
                self._flush(assistant_row['id'], assistant_blocks, assistant_meta, status)
                if exc.kind == 'cancelled':
                    yield event('done', stop_reason='cancelled')
                else:
                    yield event('error', kind=exc.kind, message=exc.message)
                    yield event('done', stop_reason='error')
                return

            merged = self._merge_blocks(assistant_blocks)
            if not merged and not tool_calls:
                store.delete_message(assistant_row['id'])
            else:
                assistant_meta['context_text'] = replay_text
                if tool_calls:
                    assistant_meta['tool_calls'] = tool_calls
                self._flush(assistant_row['id'], merged, assistant_meta, 'done')
            if title and not conversation.get('title'):
                store.patch_conversation(conversation_id, account, title=title[:80])
                yield event('title', text=title[:80])
            if usage:
                yield event('usage', usage=usage)
                store.record_usage(
                    account,
                    conversation_id,
                    provider_id,
                    model,
                    int(usage.get('prompt_tokens') or 0),
                    int(usage.get('completion_tokens') or 0),
                    int(usage.get('cached_tokens') or 0),
                    int(usage.get('reasoning_tokens') or 0),
                )
            if stop_reason == 'max_tokens':
                yield event('notice', text='response.truncated', key='response.truncated')
            if not tool_calls:
                yield event('done', stop_reason=stop_reason)
                return
            for call in tool_calls:
                result = yield from self._dispatch(call, request, conversation_id, account, turn_id, allowed, cancel)
                if result == 'pause':
                    yield event('paused', reason='question', conversation_id=conversation_id)
                    return
            rounds += 1
            if max_rounds and rounds >= max_rounds:
                yield event(
                    'question',
                    call_id=new_id('call_round'),
                    question='Continue or stop?',
                    options=['Continue', 'Stop'],
                    detail={'rounds': rounds},
                    kind='rounds',
                )
                yield event('paused', reason='rounds', conversation_id=conversation_id)
                return

    def _flush(self, message_id: str, blocks: list[dict], meta: dict, status: str) -> None:
        self.services.store.update_message(message_id, blocks=blocks, meta=meta, status=status)

    def _system(self, request: ChatRequest, skill, provider, account) -> str:
        services = self.services
        lines = [
            f'You are operating in a {services.host.environment().kind} host.',
            services.host.environment().prompt_line(),
            skill.prompt,
            'Read the smallest evidence first. A missing id or column is refused by name.',
            'Writes are proposals: use present_artifact and let the user apply them.',
            f'Provider: {provider.spec.id}. '
            f'Model: {request.model or (provider.spec.models[0].id if provider.spec.models else "")}.',
        ]
        return '\n\n'.join(line for line in lines if line)

    def _merge_blocks(self, blocks: list[dict]) -> list[dict]:
        """Merge adjacent same-type deltas so one paragraph is one block, not 200 tiny ones."""
        merged: list[dict] = []
        for block in blocks:
            if merged and merged[-1].get('type') == block.get('type'):
                kind = block.get('type')
                if kind == 'text':
                    merged[-1]['text'] += block.get('text', '')
                elif kind == 'thinking':
                    merged[-1]['thinking'] += block.get('thinking', '')
                continue
            merged.append(dict(block))
        return merged

    def _user_row(self, conversation_id, turn_id, text, replay_text, account):
        blocks = [text_block(text)]
        references, unresolved = self.services.references.resolve(text, account)
        if references:
            blocks.append(text_block(f'\n[Resolved references]\n{references}'))
        row_meta = {'context_text': replay_text, 'unresolved_references': unresolved}
        self.services.store.append_message(conversation_id, turn_id, 'user', blocks, row_meta)
        yield event('user', text=text, references=bool(references), unresolved=unresolved)

    # ── tool dispatch ──────────────────────────────────────────────────────────

    def _dispatch(self, call, request, conversation_id, account, turn_id, allowed, cancel):
        services = self.services
        name = call['name']
        args = call['arguments']
        call_id = call['id']
        tools = services.tools
        yield event('tool_start', call_id=call_id, tool=name, arguments=args)

        if name == 'ask_user_question':
            question = str(args.get('question') or '')
            options = args.get('options') or []
            if isinstance(options, str):
                try:
                    options = json.loads(options)
                except ValueError:
                    options = [part.strip() for part in options.split(',') if part.strip()]
            if not isinstance(options, (list, tuple)):
                options = [options]
            options = [str(option) for option in options[:12]]
            if not question or not options:
                yield event('tool_result', call_id=call_id, tool=name, content={'error': 'badArgs'}, is_error=True)
                return 'continue'
            services.pending[call_id] = {'kind': 'question', 'conversation_id': conversation_id}
            yield event(
                'question',
                call_id=call_id,
                question=question,
                options=options,
                allow_custom=bool(args.get('allow_custom')),
                detail=args.get('detail') or {},
                tool=name,
            )
            return 'pause'

        if name == 'update_plan':
            steps = [str(step) for step in args.get('steps') or []]
            yield event('plan', steps=steps, call_id=call_id)
            content = {'ok': True, 'steps': steps}
        elif name == 'present_artifact':
            kind = str(args.get('kind') or '')
            if not kind:
                yield event('tool_result', call_id=call_id, tool=name, content={'error': 'missing kind'}, is_error=True)
                return 'continue'
            artifact = services.store.save_artifact(account, conversation_id, kind, dict(args.get('payload') or {}))
            yield event(
                'artifact',
                call_id=call_id,
                kind=kind,
                title=str(args.get('title') or ''),
                artifact_id=artifact['id'],
                payload=artifact['payload'],
                summary=str(args.get('summary') or ''),
            )
            content = {'ok': True, 'artifact_id': artifact['id'], 'kind': kind}
        elif name == 'request_approval':
            tool = str(args.get('tool') or '')
            exact = args.get('args') or {}
            spec = tools.get(tool, account)
            if tool not in allowed:
                # The offer list is the contract here too: approval may not be
                # used to promote a tool the turn never advertised.
                content = {'error': 'tool.notOffered', 'tool': tool}
            elif spec is None:
                content = {'error': 'unknown tool', 'tool': tool}
            else:
                yield from self._ask_approval(call_id, conversation_id, tool, exact, args, request, allowed)
                return 'pause'
        else:
            # The offer list is the contract: a tool the turn did not advertise is refused here, at
            # execution, not merely hidden from the schema list. Replayed history cannot smuggle one.
            if name not in allowed:
                content = {'error': 'tool.notOffered', 'tool': name}
                yield event('tool_result', call_id=call_id, tool=name, content=content, is_error=True)
                self._persist_tool_result(conversation_id, turn_id, call_id, name, content, True)
                return 'continue'
            spec = tools.check(name, {'account': account})
            auto = bool(services.settings.get('approval.auto', True))
            if spec.mutating and not auto and not services.approvals.consume(conversation_id, name, args):
                yield from self._ask_approval(
                    call_id, conversation_id, name, args, {'question': f'Allow {name}?', 'detail': args}, request,
                    allowed,
                )
                return 'pause'
            ctx = {
                'account': account,
                'conversation_id': conversation_id,
                'provider_id': request.provider,
                'cancel_event': cancel,
            }
            try:
                content = tools.execute(name, args, ctx, allowed=allowed)
            except AIError as exc:
                content = {'error': exc.message, 'kind': exc.kind, 'key': exc.key}
                yield event('tool_result', call_id=call_id, tool=name, content=content, is_error=True)
                self._persist_tool_result(conversation_id, turn_id, call_id, name, content, True)
                return 'continue'

        yield event('tool_result', call_id=call_id, tool=name, content=content)
        self._persist_tool_result(conversation_id, turn_id, call_id, name, content, False)
        return 'continue'

    def _ask_approval(self, call_id, conversation_id, tool, exact, args, request, allowed=None):
        services = self.services
        labels = {'once': 'Allow once', 'session': 'Allow for this session'}
        preview = approval_preview.preview(tool, exact, services.workspace(request.account))
        services.approvals.request(conversation_id, tool, exact, call_id, labels)
        services.pending[call_id] = {
            'kind': 'approval',
            'conversation_id': conversation_id,
            'tool': tool,
            'args': exact,
            'allowed': tuple(allowed or ()),
        }
        yield event(
            'question',
            call_id=call_id,
            question=str(args.get('question') or f'Allow {tool}?'),
            options=[labels['once'], labels['session'], 'Deny'],
            allow_custom=False,
            detail={'tool': tool, 'arguments': exact, 'preview': preview},
            kind='approval',
        )

    def _persist_tool_result(self, conversation_id, turn_id, call_id, name, content, is_error):
        self.services.store.append_message(
            conversation_id,
            turn_id,
            'tool',
            [tool_result_block(call_id, content, is_error)],
            {'tool': name, 'call_id': call_id},
        )

    # ── resume a paused turn ───────────────────────────────────────────────────

    def _resume(self, request, conversation_id, account, turn_id, provider, model):
        services = self.services
        call_id = request.resume_call_id
        pending = services.pending.pop(call_id, {})
        answers = request.answers or {}
        selected = answers.get(call_id, answers) if isinstance(answers, dict) else answers
        content = {'answers': selected}
        if pending.get('kind') == 'approval':
            tool_name = pending.get('tool', '')
            selection = selected.get('selected') if isinstance(selected, dict) else selected
            if isinstance(selection, str):
                selection = [selection]
            answers_list = [
                {
                    'selected': list(selection or []),
                    'custom': str(selected.get('custom', '') if isinstance(selected, dict) else ''),
                }
            ]
            scope = services.approvals.settle(conversation_id, call_id, answers_list)
            if not scope:
                content = {'error': 'approval.denied'}
            else:
                tool_args = pending.get('args') or {}
                if not services.approvals.consume(conversation_id, tool_name, tool_args):
                    content = {'error': 'approval.notGranted'}
                else:
                    ctx = {
                        'account': account,
                        'conversation_id': conversation_id,
                        'provider_id': request.provider,
                        'cancel_event': request.cancel_event,
                    }
                    try:
                        executed = services.tools.execute(
                            tool_name, tool_args, ctx, allowed=pending.get('allowed') or None
                        )
                        content = {'approved': scope, 'tool': tool_name, 'result': executed}
                    except AIError as exc:
                        content = {'approved': scope, 'tool': tool_name, 'error': exc.message}
        self._persist_tool_result(
            conversation_id, turn_id, call_id, pending.get('tool', 'question'), content, bool(content.get('error'))
        )
        yield event('tool_result', call_id=call_id, tool=pending.get('tool', 'question'), content=content)
        request.answers = None
        request.resume_call_id = ''
        request.context_payload['resume_mode'] = True
        try:
            yield from self.run(request)
        finally:
            request.context_payload.pop('resume_mode', None)
