from __future__ import annotations

import pytest

from agent_workspace import AIError
from agent_workspace.host import HostEnvironment


def manifest(identifier='pack.one', kind='skill-pack', **extra):
    data = {
        'id': identifier,
        'name': 'Pack',
        'version': 1,
        'api': 1,
        'kind': kind,
        'permissions': [],
        'contributions': {
            'skills': [{'id': 'pack.skill', 'prompt': 'from pack', 'name': 'Pack skill'}],
        },
    }
    data.update(extra)
    return data


def test_plugin_validation(offline):
    with pytest.raises(AIError):
        offline.plugins.validate(manifest(identifier='Bad ID'))
    with pytest.raises(AIError) as exc:
        offline.plugins.validate(manifest(api=2))
    assert exc.value.kind == 'refused'
    with pytest.raises(AIError):
        offline.plugins.validate(manifest(kind='unknown'))
    with pytest.raises(AIError):
        offline.plugins.validate(manifest(permissions=['root.access']))


def test_code_plugin_cloud_refused(offline):
    offline.host._environment = HostEnvironment(kind='cloud')
    with pytest.raises(AIError) as exc:
        offline.plugins.validate(manifest(identifier='pack.code', kind='code'))
    assert exc.value.kind == 'capability'


def test_install_enable_disable_roundtrip(offline):
    result = offline.install_plugin(manifest(), 'alice')
    assert result['enabled'] is True
    assert offline.skills.get('pack.skill', 'alice') is not None
    assert offline.plugins_list()[0]['id'] == 'pack.one'
    offline.toggle_plugin('pack.one', 'alice', enabled=False)
    assert offline.skills.get('pack.skill', 'alice') is None
    offline.toggle_plugin('pack.one', 'alice', enabled=True)
    assert offline.skills.get('pack.skill', 'alice') is not None
    assert offline.uninstall_plugin('pack.one') is True
    assert offline.plugins_list() == []
    with pytest.raises(AIError):
        offline.install_plugin(manifest(), 'alice')
        offline.install_plugin(manifest(), 'alice')  # a duplicate, machine-level id, is refused


def test_installed_contribution_is_account_scoped(offline):
    offline.install_plugin(manifest(), 'alice')
    assert offline.skills.get('pack.skill', 'alice') is not None
    assert offline.scopes.visible('pack.skill', 'alice') is True
    assert offline.scopes.visible('pack.skill', 'bob') is False
    rows = [row['id'] for row in offline.skills.list('bob')]
    assert 'pack.skill' not in rows


def test_tool_pack_registers_and_removes_tool(offline):
    data = manifest(identifier='pack.tool', kind='tool-pack')
    data['contributions'] = {
        'tools': [
            {
                'name': 'pack.echo',
                'description': 'echo',
                'parameters': {'type': 'object', 'properties': {}},
            }
        ]
    }
    offline.install_plugin(data, 'alice')
    assert offline.tools.get('pack.echo') is not None
    offline.uninstall_plugin('pack.tool')
    assert offline.tools.get('pack.echo') is None


def test_monitor_matching_and_delivery(offline):
    monitor = offline.arm_monitor(
        'alice',
        'c1',
        {
            'subject': 'run_1',
            'events': ['failed'],
            'statuses': ['failed'],
            'note': 'analyse failures',
        },
    )
    offline.publish_event(
        'failed',
        {'account': 'alice', 'subject': 'run_1', 'status': 'failed', 'row_count': 0, 'console': 'secret crawled text'},
    )
    pending = offline.monitors.pending('alice')
    assert len(pending) == 1
    payload = pending[0]['payload']
    assert payload['kind'] == 'monitor'
    assert 'secret crawled text' not in str(payload)  # events carry ids/status/counts only
    assert offline.monitors.ack('alice', pending[0]['id']) is True
    assert offline.monitors.pending('alice') == []
    assert offline.stop_monitor('alice', monitor['id']) is True


def test_monitor_max_triggers_stops(offline):
    offline.arm_monitor(
        'alice',
        'c1',
        {
            'subject': 'r',
            'events': ['failed'],
            'max_triggers': 1,
        },
    )
    for _ in range(3):
        offline.publish_event('failed', {'account': 'alice', 'subject': 'r', 'status': 'failed'})
    assert len(offline.monitors.pending('alice')) == 1
    assert [row['id'] for row in offline.monitors.list('alice', status='active')] == []


def test_monitor_conditions_validate(offline):
    with pytest.raises(AIError):
        offline.arm_monitor('alice', 'c1', {})
    assert offline.monitors.validate({'run_id': 'r'})['max_triggers'] == 20
