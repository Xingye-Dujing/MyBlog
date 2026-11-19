"""Token facts and provider-priced estimates — money is never synthesised."""

from __future__ import annotations

from .util import local_day_start_utc


class Costs:
    def __init__(self, store, settings, catalog):
        self.store = store
        self.settings = settings
        self.catalog = catalog

    def conversation_cost(self, conversation_id: str) -> dict:
        rows = self.store.conversation_usage(conversation_id)
        lines = []
        prompt = completion = cached = reasoning = calls = 0
        amount = 0.0
        currency = ''
        priced = True
        for row in rows:
            model = str(row.get('model') or '')
            provider_id = str(row.get('provider') or '')
            row_prompt = int(row.get('prompt_tokens') or 0)
            row_completion = int(row.get('completion_tokens') or 0)
            row_cached = int(row.get('cached_tokens') or 0)
            prompt += row_prompt
            completion += row_completion
            cached += row_cached
            reasoning += int(row.get('reasoning_tokens') or 0)
            calls += int(row.get('calls') or 0)
            price = None
            provider = self.catalog.get(provider_id)
            if provider is not None:
                price = provider.cost(model, row_prompt, row_completion, row_cached)
            if price and price.get('amount') is not None:
                amount += float(price['amount'])
                currency = currency or str(price.get('currency') or '')
            else:
                priced = False
            lines.append(
                {
                    'provider': provider_id,
                    'model': model,
                    'prompt_tokens': row_prompt,
                    'completion_tokens': row_completion,
                    'cached_tokens': row_cached,
                    'calls': int(row.get('calls') or 0),
                    'cost': price.get('amount') if price else None,
                    'currency': str((price or {}).get('currency') or ''),
                }
            )
        return {
            'prompt_tokens': prompt,
            'completion_tokens': completion,
            'cached_tokens': cached,
            'reasoning_tokens': reasoning,
            'total_tokens': prompt + completion,
            'cache_hit_rate': round(cached / prompt, 4) if prompt else 0.0,
            'calls': calls,
            'cost': round(amount, 6) if (lines and priced) else None,
            'currency': currency,
            'cost_complete': bool(lines) and priced,
            'models': lines,
        }

    def spend_state(self, conversation_id: str, account: str) -> dict:
        """The caps and what is already spent — checked BEFORE another provider round."""
        conv_cap = max(0, int(self.settings.get('budget.conversation_tokens', 0)))
        day_cap = max(0, int(self.settings.get('budget.daily_tokens', 0)))
        conv_tokens = int(
            (self.store.token_usage(account=account, conversation_id=conversation_id) or {}).get('tokens') or 0
        )
        day_tokens = int(
            (self.store.token_usage(account=account, since=local_day_start_utc()) or {}).get('tokens') or 0
        )
        scope = ''
        limit = 0
        spent = 0
        if conv_cap and conv_tokens >= conv_cap:
            scope, limit, spent = 'conversation', conv_cap, conv_tokens
        elif day_cap and day_tokens >= day_cap:
            scope, limit, spent = 'day', day_cap, day_tokens
        return {
            'conversation_tokens': conv_tokens,
            'conversation_limit': conv_cap,
            'daily_tokens': day_tokens,
            'daily_limit': day_cap,
            'exceeded': bool(scope),
            'scope': scope,
            'limit': limit,
            'spent': spent,
        }
