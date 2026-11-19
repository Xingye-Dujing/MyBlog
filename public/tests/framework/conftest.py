from __future__ import annotations

import pytest

from agent_workspace import AgentWorkspace, DefaultHostAdapter, EventBus


class TestHost(DefaultHostAdapter):
    """A small domain host used across the suite: facts, docs, a resolver and an event bus."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._bus = EventBus()
        self.applied: list = []
        self.imports: list = []

    def facts(self) -> dict:
        return {
            'summary': 'A test product with a canvas and two datasets.',
            'rules': 'unknown ids are refused by name',
            '节点': 'source, clean, chart',
            '分析算子': 'count, mean',
        }

    def capabilities(self) -> dict:
        return {'catbus': True, 'canvas': True, 'cloud': False}

    def resolve_dataset(self, dataset_id: str):
        if dataset_id == 'ds_1':
            return {'id': dataset_id, 'rows': 3, 'columns': ['text', 'score']}
        return None

    def resolve_run(self, run_id: str):
        if run_id == 'run_1':
            return {'id': run_id, 'status': 'failed', 'node_errors': {'n3': 'timeout'}}
        return None

    def import_table(self, path: str) -> dict:
        self.imports.append(path)
        return {'dataset_id': 'ds_imported', 'path': path}

    def apply_artifact(self, kind: str, payload: dict) -> dict:
        self.applied.append((kind, payload))
        return {'kind': kind, 'applied': True}

    def event_bus(self) -> EventBus:
        return self._bus


@pytest.fixture
def host(tmp_path):

    docs = tmp_path / 'docs'
    docs.mkdir()
    (docs / 'guide.md').write_text(
        '# 采集指南\n\n评论采集需要登录。\n\n# 图表\n\n图表需要 x 和 y 列。', encoding='utf-8'
    )
    return TestHost(data_dir=tmp_path / 'data', lang='zh', doc_roots=[str(docs) + '/'])


@pytest.fixture
def workspace(host):
    ws = AgentWorkspace(host)
    yield ws
    ws.close()


@pytest.fixture
def offline(workspace):
    """A workspace whose default provider is the deterministic offline transport."""
    workspace.settings.set('chat.default_provider', 'complete')
    return workspace


@pytest.fixture
def scripted(offline):
    from scripted_provider import ScriptedProvider

    from agent_workspace.types import SkillSpec, ToolSpec

    offline.catalog.register(ScriptedProvider())
    offline.settings.set('chat.default_provider', 'scripted')
    offline.tools.register(
        ToolSpec('ping', 'Ping', {'type': 'object', 'properties': {}}, handler=lambda args, ctx: {'pong': True})
    )
    offline.skills.register(SkillSpec('tester', 'n', 'd', 'test prompt', tools=('ping',)))
    return offline
