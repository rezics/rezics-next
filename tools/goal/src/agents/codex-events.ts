import { unknownReading, tokens } from './shared.ts';
import { defaultPolicy } from '../policy.ts';
import type { AgentEvent, AgentUsage, AgentUsageAccumulator, SessionUsage } from '../agents.ts';
import type { Pool, PoolReading, Tokens } from '../types.ts';

export function parseCodexSessionUsage(
  events: Iterable<Record<string, any>>,
  start: number,
  end: number,
  policy = defaultPolicy.provider,
): { tokens: Tokens; usage: SessionUsage; source: 'codex-session' } | null {
  const accumulator = codexUsageAccumulator(start, end, policy);
  for (const event of events) accumulator.add(event);
  return accumulator.finish() as { tokens: Tokens; usage: SessionUsage; source: 'codex-session' } | null;
}

export function codexUsageAccumulator(
  start: number,
  end: number,
  policy = defaultPolicy.provider,
): AgentUsageAccumulator {
  const totals: Tokens = { input: 0, cached: 0, output: 0 };
  const seen = new Set<string>();
  const usage: SessionUsage = { model: null, effort: null, serviceTier: null, reasoning: 0, compactions: 0 };
  let foundLedger = false;
  let valid = true;
  const firstString = (objects: Record<string, any>[], names: string[]): string | null => {
    for (const object of objects)
      for (const name of names) {
        const value = object[name];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
    return null;
  };
  const contextObjects = (event: Record<string, any>): Record<string, any>[] => {
    const result: Record<string, any>[] = [];
    const queue: Record<string, any>[] = [event];
    const keys = ['payload', 'info', 'settings', 'thread_settings', 'turn_context', 'context', 'config', 'model_info'];
    while (queue.length && result.length < policy.usageContextObjects) {
      const value = queue.shift()!;
      result.push(value);
      for (const key of keys)
        if (value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])) queue.push(value[key]);
    }
    return result;
  };
  return {
    add(event) {
      if (event.type === 'token_usage_record') foundLedger = true;
      const at = event.timestamp ? Date.parse(event.timestamp) : start;
      if (at < start || at > end) return;
      const payload = event.payload ?? {};
      if (event.type === 'token_usage_record') {
        const responseId = event.response_id ?? payload.response_id ?? event.responseId;
        if (responseId !== undefined && seen.has(String(responseId))) return;
        if (responseId !== undefined) seen.add(String(responseId));
        const record = payload.usage ?? event.usage ?? payload;
        if (!record || typeof record !== 'object' || Array.isArray(record)) valid = false;
        else {
          const value = (names: string[]): number => {
            for (const name of names) {
              if (!Object.hasOwn(record, name)) continue;
              const current = record[name];
              if (typeof current === 'number' && Number.isFinite(current) && current >= 0) return current;
              valid = false;
              return 0;
            }
            return 0;
          };
          if (
            ![
              'input_tokens',
              'inputTokens',
              'cached_input_tokens',
              'cachedInputTokens',
              'output_tokens',
              'outputTokens',
            ].some((key) => Object.hasOwn(record, key))
          )
            valid = false;
          totals.input += value(['input_tokens', 'inputTokens']);
          totals.cached += value(['cached_input_tokens', 'cachedInputTokens']);
          totals.output += value(['output_tokens', 'outputTokens']);
          usage.reasoning += value(['reasoning_output_tokens', 'reasoningOutputTokens']);
        }
      }
      if (event.type === 'compacted' || payload.type === 'compacted' || event.type === 'session.compacted')
        usage.compactions++;
      const objects = contextObjects(event);
      usage.model = firstString(objects, ['model', 'model_name', 'modelName']) ?? usage.model;
      usage.effort = firstString(objects, ['effort', 'model_reasoning_effort', 'reasoning_effort']) ?? usage.effort;
      usage.serviceTier =
        firstString(objects, ['service_tier', 'serviceTier', 'service_tier_name', 'tier']) ?? usage.serviceTier;
    },
    finish(): AgentUsage {
      return foundLedger && valid ? { tokens: totals, usage, source: 'codex-session' } : null;
    },
  };
}

export function parseCodexAllowance(text: string, pool: Pool, now = Date.now()): PoolReading {
  for (const line of text.split('\n').reverse()) {
    if (!line.includes('rate_limits')) continue;
    try {
      const event = JSON.parse(line);
      const limits = event.payload?.rate_limits ?? event.rate_limits;
      if (!limits) continue;
      const windows: PoolReading['windows'] = (
        [
          ['primary', limits.primary],
          ['secondary', limits.secondary],
        ] as const
      ).flatMap(([window, value]) => {
        if (typeof value?.used_percent !== 'number' || !Number.isFinite(value.used_percent)) return [];
        return [
          {
            window,
            usedPercent: value.resets_at != null && Number(value.resets_at) * 1000 <= now ? 0 : value.used_percent,
            resetsAt: value.resets_at == null ? null : Number(value.resets_at) * 1000,
            minutes: value.window_minutes ?? null,
          },
        ];
      });
      if (!windows.length) continue;
      const observedAt =
        typeof event.timestamp === 'string' && Number.isFinite(Date.parse(event.timestamp)) ? event.timestamp : null;
      return {
        pool: pool.name,
        allowanceKey: pool.allowanceKey,
        at: new Date(now).toISOString(),
        observedAt,
        windows,
        exhausted:
          windows.some((w) => w.usedPercent >= 100) ||
          (!!limits.rate_limit_reached_type && windows.some((w) => w.usedPercent > 0)),
        error: null,
      };
    } catch {
      /* An incomplete final JSONL line is not an observation. */
    }
  }
  return unknownReading(pool, now);
}

export function codexEvent(event: Record<string, any>, hasRollout: boolean): AgentEvent | null {
  const payload = event.payload ?? event;
  const item = event.item ?? payload;
  const result: AgentEvent = {};
  if (item.type === 'command_execution' && typeof item.command === 'string')
    result.commands = [{ ...(item.id ? { id: item.id } : {}), text: item.command }];
  if (payload.type === 'function_call') {
    try {
      const input = payload.arguments ?? payload.input;
      const args = typeof input === 'string' ? JSON.parse(input) : input;
      const command = args?.cmd ?? args?.command;
      if (typeof command === 'string')
        result.commands = [
          { ...((payload.call_id ?? payload.id) ? { id: payload.call_id ?? payload.id } : {}), text: command },
        ];
    } catch {
      /* An incomplete call has no command yet. */
    }
  }

  const usage = hasRollout
    ? payload.type === 'token_count'
      ? payload.info?.total_token_usage
      : null
    : event.type === 'turn.completed'
      ? event.usage
      : null;
  if (usage) result.usage = { tokens: tokens(usage), delta: event.usage_mode === 'delta' };
  if (
    ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'function_call', 'custom_tool_call'].includes(
      item.type,
    ) &&
    event.type !== 'item.started'
  ) {
    const input = item.command ?? item.input ?? item.arguments ?? '';
    const id = item.call_id ?? item.id;
    result.steps = [
      {
        ...(id ? { id } : {}),
        name: item.name ?? item.type,
        input: typeof input === 'string' ? input : JSON.stringify(input),
      },
    ];
  }
  // Only a completed message is an answer: a started or streamed item, or a rollout event_msg echo, carries partial or
  // no text, and replacing the answer with it lost a worker's final report.
  if (item.type === 'agent_message' && event.type === 'item.completed')
    result.answer = typeof item.text === 'string' ? item.text : '';
  if (
    payload.type === 'message' &&
    payload.role === 'assistant' &&
    (event.type === 'response_item' || event === payload)
  )
    result.answer = (payload.content ?? []).map((part: { text?: string }) => part.text ?? '').join('\n');
  return Object.keys(result).length ? result : null;
}
