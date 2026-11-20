"""Declarative plugin packs: portable data, validated before install, reversible on disable.

The four kinds are skill-pack, provider-pack, tool-pack and code. The first three are plain data;
a code plugin is local/admin only and a cloud host refuses it by name. A plugin may not override a
built-in contribution id, two installed packs may not mint the same id, and enabling a pack keeps
the ownership recorded at install time — the caller cannot reassign it to another account.
"""

from __future__ import annotations

import json

from .errors import AIError
from .skills import BUILTIN_SKILLS
from .tools import CONTROL_TOOLS, GENERIC_NAMES
from .types import PLUGIN_ID_RE, ToolSpec, skill_from_manifest

API_VERSION = 1
KINDS = ('skill-pack', 'provider-pack', 'tool-pack', 'code')
PERMISSIONS = ('skills.contribute', 'tools.contribute', 'providers.contribute', 'code.execute')


class PluginHost:
    def __init__(self, store, host, settings, scopes, skills, tools, catalog, provider_factories):
        self.store = store
        self.host = host
        self.settings = settings
        self.scopes = scopes
        self.skills = skills
        self.tools = tools
        self.catalog = catalog
        self.provider_factories = provider_factories
        self._code_registry: dict[str, object] = {}

    def _installed(self) -> dict:
        raw = self.store.get_pref('__machine__', 'plugins.installed', '{}')
        try:
            value = json.loads(raw)
            return value if isinstance(value, dict) else {}
        except ValueError:
            return {}

    def _save(self, installed: dict) -> None:
        self.store.set_pref('__machine__', 'plugins.installed', json.dumps(installed, ensure_ascii=False))

    # ── validation ────────────────────────────────────────────────────────────

    def validate(self, manifest: dict) -> dict:
        if not isinstance(manifest, dict):
            raise AIError('plugin.invalid', kind='refused', key='plugin.invalid', reason='manifest must be an object')
        identifier = str(manifest.get('id') or '')
        if not PLUGIN_ID_RE.match(identifier):
            raise AIError('plugin.invalid', kind='refused', key='plugin.invalid', reason='bad id')
        try:
            api_version = int(manifest.get('api') or 0)
        except (TypeError, ValueError, OverflowError):
            api_version = -1
        if api_version != API_VERSION:
            raise AIError(
                'plugin.apiMismatch', kind='refused', key='plugin.apiMismatch', reason=str(manifest.get('api'))
            )
        kind = str(manifest.get('kind') or '')
        if kind not in KINDS:
            raise AIError('plugin.unknownKind', kind='refused', key='plugin.unknownKind', reason=kind)
        for permission in manifest.get('permissions') or ():
            if permission not in PERMISSIONS:
                raise AIError(
                    'plugin.unknownPermission', kind='refused', key='plugin.unknownPermission', reason=str(permission)
                )
        if kind == 'code' and self.host.environment().cloud:
            raise AIError('plugin.codeCloudRefused', kind='capability', key='plugin.codeCloudRefused')
        if kind == 'code' and not self.host.environment().local:
            raise AIError('plugin.codeRefused', kind='refused', key='plugin.codeRefused')
        if identifier in self._installed():
            raise AIError('plugin.duplicate', kind='refused', key='plugin.duplicate', reason=identifier)
        # A contribution id may not collide with a built-in, whatever the plugin's kind.
        contributions = manifest.get('contributions') or {}
        for payload in contributions.get('skills') or ():
            if str(payload.get('id') or '') in BUILTIN_SKILLS:
                raise AIError(
                    'plugin.builtinConflict',
                    kind='refused',
                    key='plugin.builtinConflict',
                    reason=str(payload.get('id')),
                )
        for payload in contributions.get('tools') or ():
            if str(payload.get('name') or '') in set(CONTROL_TOOLS) | GENERIC_NAMES:
                raise AIError(
                    'plugin.builtinConflict',
                    kind='refused',
                    key='plugin.builtinConflict',
                    reason=str(payload.get('name')),
                )
        for payload in contributions.get('providers') or ():
            from .providers.registry import BUILTIN_IDS

            if str(payload.get('id') or '') in BUILTIN_IDS:
                raise AIError(
                    'plugin.builtinConflict',
                    kind='refused',
                    key='plugin.builtinConflict',
                    reason=str(payload.get('id')),
                )
        return manifest

    def list(self) -> list[dict]:
        rows = []
        for identifier, row in self._installed().items():
            payload = json.loads(row['manifest'])
            rows.append(
                {
                    'id': identifier,
                    'manifest': payload,
                    'enabled': bool(row.get('enabled')),
                    'account': row.get('account', ''),
                }
            )
        return rows

    def install(self, manifest: dict, account: str, *, admin: bool = False) -> dict:
        """A machine-level install; a code plugin additionally requires admin."""
        manifest = self.validate(manifest)
        if manifest['kind'] == 'code' and not admin:
            raise AIError('plugin.adminRequired', kind='refused', key='plugin.adminRequired')
        installed = self._installed()
        self._check_id_collisions(manifest, installed, account)
        installed[manifest['id']] = {
            'manifest': json.dumps(manifest, ensure_ascii=False),
            'enabled': False,
            'account': account,
        }
        self._save(installed)
        self.enable(manifest['id'], account, enabled=True)
        return {'id': manifest['id'], 'installed': True, 'enabled': True}

    def _check_id_collisions(self, manifest: dict, installed: dict, account: str) -> None:
        """Refuse an id another installed pack or another account already owns."""
        contributions = manifest.get('contributions') or {}
        for section, field in (('skills', 'id'), ('tools', 'name'), ('providers', 'id')):
            for payload in contributions.get(section) or ():
                identifier = str(payload.get(field) or '')
                if not identifier:
                    continue
                if self.scopes.owner(identifier) and self.scopes.owner(identifier) != account:
                    raise AIError('plugin.idCollision', kind='refused', key='plugin.idCollision', reason=identifier)
                for other_id, row in installed.items():
                    if other_id == manifest.get('id'):
                        continue
                    other = json.loads(row['manifest']).get('contributions') or {}
                    for other_payload in other.get(section) or ():
                        if str(other_payload.get(field) or '') == identifier:
                            raise AIError(
                                'plugin.idCollision', kind='refused', key='plugin.idCollision', reason=identifier
                            )

    def enable(self, plugin_id: str, account: str, *, enabled: bool) -> dict:
        installed = self._installed()
        row = installed.get(plugin_id)
        if row is None:
            raise AIError('plugin.unknown', kind='not_found', key='plugin.unknown', reason=plugin_id)
        owner = str(row.get('account') or account)
        if owner != account:
            raise AIError('plugin.foreign', kind='refused', key='plugin.foreign', reason=plugin_id)
        row['enabled'] = bool(enabled)
        self._save(installed)
        manifest = json.loads(row['manifest'])
        contributions = manifest.get('contributions') or {}
        if enabled:
            for payload in contributions.get('skills') or ():
                skill = skill_from_manifest(payload, account=owner)
                self.skills.register(skill)
                self.scopes.remember(skill.id, owner)
            for payload in contributions.get('tools') or ():
                spec = ToolSpec(
                    str(payload.get('name') or ''),
                    str(payload.get('description') or ''),
                    dict(payload.get('parameters') or {'type': 'object', 'properties': {}}),
                    permission=str(payload.get('permission') or 'read:project'),
                    handler=self._code_handler(plugin_id, str(payload.get('name') or '')),
                    local_only=str(payload.get('kind') or '') == 'code',
                )
                self.tools.register(spec, owner=owner)
                self.scopes.remember(spec.name, owner)
            for payload in contributions.get('providers') or ():
                factory = self.provider_factories.get(str(payload.get('transport') or ''))
                if factory is None:
                    continue
                provider = factory(payload)
                self.catalog.register(provider, owner=owner)
            if manifest.get('kind') == 'code':
                self._code_registry[plugin_id] = manifest
        else:
            for payload in contributions.get('skills') or ():
                self.skills.unregister(str(payload.get('id') or ''))
                self.scopes.forget(str(payload.get('id') or ''))
            for payload in contributions.get('tools') or ():
                self.tools.unregister(str(payload.get('name') or ''))
            for payload in contributions.get('providers') or ():
                self.catalog.unregister(str(payload.get('id') or ''))
            self._code_registry.pop(plugin_id, None)
        return {'id': plugin_id, 'enabled': bool(enabled)}

    def uninstall(self, plugin_id: str, account: str = '') -> bool:
        row = self._installed().get(plugin_id)
        if row is None:
            return False
        if account and str(row.get('account') or '') != account:
            raise AIError('plugin.foreign', kind='refused', key='plugin.foreign', reason=plugin_id)
        if row.get('enabled'):
            self.enable(plugin_id, str(row.get('account') or ''), enabled=False)
        installed = self._installed()
        installed.pop(plugin_id, None)
        self._save(installed)
        return True

    def _code_handler(self, plugin_id: str, name: str):
        # A code pack supplies only a declarative handler here; a host with a real sandbox may
        # replace this. There is deliberately no arbitrary import/exec path in the framework.
        def handler(args, ctx):
            raise AIError(
                'plugin.codeNoRunner', kind='refused', key='plugin.codeNoRunner', reason=f'{plugin_id}:{name}'
            )

        return handler

    def visible_tools(self, account: str) -> list[str]:
        return self.scopes.filter([spec.name for spec in self.tools._extra.values()], account)
