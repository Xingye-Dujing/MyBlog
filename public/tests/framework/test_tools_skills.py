from __future__ import annotations

import pytest

from agent_workspace.errors import AIError
from agent_workspace.host import HostEnvironment
from agent_workspace.tools import CONTROL_TOOLS, ToolSpec


def test_control_tools_always_present(offline):
    names = [schema['name'] for schema in offline.tools.schemas()]
    for name in CONTROL_TOOLS:
        assert name in names
    assert 'project_facts' in names


def test_skill_allowlist_filters_tools(offline):
    names = [schema['name'] for schema in offline.tools.schemas({'project_facts'})]
    assert 'project_facts' in names
    assert 'docs_search' not in names
    assert 'ask_user_question' in names


def test_execute_generic_tool(offline):
    result = offline.tools.execute('project_facts', {}, {'account': 'default'})
    assert 'A test product' in result['text']
    result = offline.tools.execute('docs_search', {'query': '评论采集'}, {'account': 'default'})
    assert result['results']


def test_unknown_tool_is_refused_by_name(offline):
    with pytest.raises(AIError) as exc:
        offline.tools.execute('does_not_exist', {}, {'account': 'default'})
    assert exc.value.kind == 'refused'
    assert 'does_not_exist' in exc.value.message


def test_tool_result_is_bounded(offline):
    offline.settings.set('tools.max_result_chars', 1000)
    result = offline.tools.execute('project_facts', {}, {'account': 'default'})
    assert len(str(result)) <= 1100


def test_host_tool_registration(offline):
    def handler(args, ctx):
        return {'echo': args.get('value')}

    offline.tools.register(
        ToolSpec(
            'echo',
            'Echo a value',
            {
                'type': 'object',
                'properties': {'value': {'type': 'string'}},
            },
            handler=handler,
        )
    )
    assert offline.tools.execute('echo', {'value': 'hi'}, {'account': 'default'})['echo'] == 'hi'
    with pytest.raises(AIError):
        offline.tools.register(ToolSpec('ask_user_question', 'reserved', {}, handler=handler))


def test_local_only_skills_refused_in_cloud(offline):
    offline.host._environment = HostEnvironment(kind='cloud')
    developer = offline.skills.get('developer', 'default')
    available, reason = offline.skills.availability(developer, 'deepseek')
    assert available is False
    assert reason == 'workspace.skill.cloudRefused'
    rows = {row['id']: row for row in offline.skills.list('default')}
    assert rows['developer']['available'] is False


def test_user_skill_fork_and_delete(offline):
    forked = offline.skills.fork('default', 'project')
    assert forked['id'].startswith('project_copy')
    assert offline.skills.get(forked['id'], 'default') is not None
    assert offline.skills.delete_user('default', forked['id']) is True
    with pytest.raises(AIError):
        offline.skills.save_user('default', {'id': 'general', 'prompt': 'override'})


def test_host_skills_are_listed(offline):
    from agent_workspace.types import SkillSpec

    offline.host.skills = lambda: [
        SkillSpec('domain.skill', 'n', 'd', 'prompt', tools=('project_facts',), group='domain')
    ]
    rows = {row['id']: row for row in offline.skills.list('default')}
    assert 'domain.skill' in rows
    assert rows['domain.skill']['group'] == 'domain'
