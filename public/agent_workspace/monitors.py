"""Run monitors: a notification channel, never a token spender of its own.

The assistant proposes conditions as an artifact; the user arms the monitor. A host publishes
lifecycle facts on its event bus, ``Monitors.matches`` filters them in-process, and only a durable
delivery is written. A client decides what to do with a delivery — the server never calls a model.
"""

from __future__ import annotations

from .errors import AIError


class Monitors:
    def __init__(self, store, host):
        self.store = store
        self.host = host
        self._wired = False

    def _wire(self) -> None:
        if self._wired:
            return
        bus = self.host.event_bus()
        if bus is not None:
            bus.subscribe(self.on_event)
        self._wired = True

    def validate(self, conditions: dict) -> dict:
        conditions = dict(conditions or {})
        if not conditions.get('subject') and not conditions.get('run_id'):
            raise AIError('monitor.noSubject', kind='refused', reason='a subject or run_id is required')
        conditions.setdefault('events', ['finished', 'failed'])
        conditions.setdefault('max_triggers', 20)
        try:
            conditions['max_triggers'] = max(1, int(conditions['max_triggers']))
        except (TypeError, ValueError) as exc:
            raise AIError('monitor.badMax', kind='refused') from exc
        return conditions

    def arm(self, account: str, conversation_id: str, conditions: dict) -> dict:
        self._wire()
        return self.store.create_monitor(account, conversation_id, self.validate(conditions))

    def list(self, account: str, status: str = '') -> list[dict]:
        self._wire()
        return self.store.list_monitors(account, status=status or 'active')

    def stop(self, account: str, monitor_id: str) -> bool:
        return self.store.stop_monitor(account, monitor_id)

    @staticmethod
    def matches(conditions: dict, event: str, payload: dict) -> bool:
        events = conditions.get('events') or []
        if events and event not in events:
            return False
        wanted_subject = conditions.get('subject') or conditions.get('run_id')
        if wanted_subject and str(payload.get('subject') or payload.get('run_id') or '') != str(wanted_subject):
            return False
        wanted_statuses = conditions.get('statuses') or []
        if wanted_statuses and str(payload.get('status') or '') not in wanted_statuses:
            return False
        contains = str(conditions.get('console_contains') or '')
        if contains and contains not in str(payload.get('console') or ''):
            return False
        try:
            min_rows = int(conditions.get('min_rows') or 0)
        except (TypeError, ValueError):
            min_rows = 0
        if min_rows and int(payload.get('row_count') or 0) < min_rows:
            return False
        return True

    def on_event(self, event: str, payload: dict) -> None:
        """Called by the event bus. Events carry ids/status/counts — never crawled text."""
        for monitor in self.store.list_monitors(payload.get('account', '')):
            conditions = monitor.get('conditions') or {}
            if not self.matches(conditions, event, payload):
                continue
            delivered = self.store.pending_deliveries(monitor['account'])
            if sum(1 for item in delivered if item['monitor_id'] == monitor['id']) >= int(
                conditions.get('max_triggers', 20)
            ):
                self.store.stop_monitor(monitor['account'], monitor['id'])
                continue
            # Never forward raw content: the client reads details with a read-only tool.
            self.store.add_delivery(
                monitor['account'],
                monitor['id'],
                {
                    'kind': 'monitor',
                    'event': event,
                    'subject': payload.get('subject') or payload.get('run_id') or '',
                    'status': payload.get('status') or '',
                    'counts': {key: value for key, value in payload.items() if isinstance(value, (int, float))},
                    'monitor_id': monitor['id'],
                    'note': conditions.get('note', ''),
                },
            )

    def pending(self, account: str) -> list[dict]:
        return self.store.pending_deliveries(account)

    def ack(self, account: str, delivery_id: str) -> bool:
        return self.store.ack_delivery(account, delivery_id)
