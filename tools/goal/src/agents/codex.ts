import { unknownReading, tokens, textSignals, parseExitObject } from './shared.ts';
import { existsSync, readFileSync, readdirSync, openSync, closeSync, readSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import defaults from '../../defaults.json';
import type { AgentAdapter, AgentLaunchOptions, SessionUsage, AgentEvent } from '../agents.ts';
import type { Tokens, Pool, PoolReading, Profile } from '../types.ts';

export function parseCodexSessionUsage(
  events: Record<string, any>[],
  start: number,
  end: number,
): { tokens: Tokens; usage: SessionUsage; source: 'codex-session' } | null {
  const ledger = events.filter((event) => event.type === 'token_usage_record');
  if (!ledger.length) return null;
  const totals: Tokens = { input: 0, cached: 0, output: 0 };
  const seen = new Set<string>();
  const usage: SessionUsage = { model: null, effort: null, serviceTier: null, reasoning: 0, compactions: 0 };
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
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
    while (queue.length && result.length < 24) {
      const value = queue.shift()!;
      result.push(value);
      for (const key of keys)
        if (value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])) queue.push(value[key]);
    }
    return result;
  };
  for (const event of events) {
    const at = event.timestamp ? Date.parse(event.timestamp) : start;
    const inside = at >= start && at <= end;
    if (at > end) continue;
    if (!inside) continue;
    const payload = event.payload ?? {};
    if (event.type === 'token_usage_record') {
      const responseId = event.response_id ?? payload.response_id ?? event.responseId;
      if (responseId !== undefined && seen.has(String(responseId))) continue;
      if (responseId !== undefined) seen.add(String(responseId));
      const record = payload.usage ?? event.usage ?? payload;
      totals.input += number(record.input_tokens ?? record.inputTokens);
      totals.cached += number(record.cached_input_tokens ?? record.cachedInputTokens);
      totals.output += number(record.output_tokens ?? record.outputTokens);
      usage.reasoning += number(record.reasoning_output_tokens ?? record.reasoningOutputTokens);
    }
    if (event.type === 'compacted' || payload.type === 'compacted' || event.type === 'session.compacted')
      usage.compactions++;
    const objects = contextObjects(event);
    usage.model = firstString(objects, ['model', 'model_name', 'modelName']) ?? usage.model;
    usage.effort = firstString(objects, ['effort', 'model_reasoning_effort', 'reasoning_effort']) ?? usage.effort;
    usage.serviceTier =
      firstString(objects, ['service_tier', 'serviceTier', 'service_tier_name', 'tier']) ?? usage.serviceTier;
  }
  return { tokens: totals, usage, source: 'codex-session' };
}

export const codexAdapter: AgentAdapter = {
  environmentKeys: ['CODEX_HOME', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID'],
  cli: 'codex',
  canResume: true,
  streamsLog: true,
  start(options) {
    return command(options);
  },
  resume(options) {
    return command({ ...options, resumeSession: options.session });
  },
  pinProfile: pinnedCodexProfile,
  supportsConsultation(profile) {
    return profile.model.includes('sol') && profile.effort === 'medium';
  },
  signals: textSignals,
  canImport: true,
  announcedReset: true,
  readAllowance: readCodexAllowance,
  readSession: rolloutFor,
  hasRollout(events) {
    return events.some((event) => event.payload?.type === 'token_count' && event.payload.info?.total_token_usage);
  },
  parseEvent: codexEvent,
  isUsageLimit(event) {
    return (event.error?.code ?? event.code) === 'usage_limit_exceeded';
  },
  parseExit: parseExitObject,
  sessionId(event) {
    return event.type === 'thread.started'
      ? (event.thread_id ?? null)
      : event.type === 'session_meta'
        ? (event.payload?.id ?? event.payload?.session_id ?? null)
        : null;
  },
  isRateLimit(event) {
    return ['usage_limit_exceeded', 'rate_limit_exceeded', 'insufficient_quota'].includes(
      event.error?.code ?? event.code,
    );
  },
  matchesEvent(event) {
    return [
      'thread.started',
      'turn.failed',
      'token_usage_record',
      'turn.completed',
      'error',
      'session_meta',
      'event_msg',
      'response_item',
      'item.completed',
      'item.started',
    ].includes(event.type);
  },
  environment(pool, env) {
    return { ...env, CODEX_HOME: pool.configDirectory };
  },
  afterExit() {},
  parseUsage(events, start, end) {
    return parseCodexSessionUsage(events, start, end);
  },
  failure(event) {
    return event.type === 'turn.failed' || event.type === 'error'
      ? String(event.error?.message ?? event.message ?? 'Codex turn failed')
      : null;
  },
  completed(event) {
    return event.type === 'turn.completed';
  },
};
function command(options: AgentLaunchOptions): [string, string[]] {
  const { profile, pool, worktree, prompt } = options;
  const codex = options.codex ?? defaults.codex;
  const mcp: string[] = [];
  const config = join(pool.configDirectory, 'config.toml');
  if (existsSync(config)) {
    const servers = (Bun.TOML.parse(readFileSync(config, 'utf8')) as { mcp_servers?: Record<string, unknown> })
      .mcp_servers;
    // An inline table merges the server settings; dotted quoted paths create a server without a transport.
    const disabled = Object.keys(servers ?? {}).map((name) => `${JSON.stringify(name)}={enabled=false}`);
    if (disabled.length) mcp.push('-c', `mcp_servers={${disabled.join(',')}}`);
  }
  return [
    pool.command,
    [
      'exec',
      ...(options.consultation
        ? [
            '--skip-git-repo-check',
            '--ignore-user-config',
            '-c',
            'project_doc_max_bytes=0',
            '-c',
            'web_search="disabled"',
          ]
        : []),
      ...(options.resumeSession ? ['resume', options.resumeSession] : []),
      '--json',
      '-m',
      profile.model,
      '-c',
      `model_reasoning_effort=${profile.effort}`,
      '-c',
      `model_auto_compact_token_limit=${profile.model.includes('luna') ? codex.compactTokens.luna : codex.compactTokens.sol}`,
      '-c',
      `tool_output_token_limit=${codex.toolOutputTokens}`,
      '-c',
      'features.unified_exec=true',
      '-c',
      `background_terminal_max_timeout=${codex.backgroundTerminalMaxTimeoutMs}`,
      '-c',
      // Only local settings choose the tier, including when an attempt keeps an older routing profile.
      `service_tier=${JSON.stringify(codex.serviceTier)}`,
      ...(profile.model.includes('sol') ? ['-c', `model_context_window=${codex.solContextWindow}`] : []),
      '-c',
      'features.multi_agent=false',
      '-c',
      'features.multi_agent_v2=false',
      ...mcp,
      ...(options.readOnly
        ? ['-s', 'read-only', '-c', 'approval_policy="never"']
        : ['--dangerously-bypass-approvals-and-sandbox']),
      ...(options.research ? ['-c', 'web_search="live"'] : []),
      ...(!options.readOnly ? ['--output-schema', join(import.meta.dir, '../../worker-result.schema.json')] : []),
      '-C',
      worktree,
      '--',
      prompt,
    ],
  ];
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
function tail(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size,
      buffer = Buffer.alloc(Math.min(size, 1024 * 1024));
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}
function readCodexAllowance(pool: Pool, now: number): PoolReading {
  const sessions = join(pool.configDirectory, 'sessions');
  if (!existsSync(sessions)) return unknownReading(pool, now);
  const files = readdirSync(sessions, { recursive: true })
    .filter((p): p is string => typeof p === 'string' && p.endsWith('.jsonl'))
    .map((p) => join(sessions, p))
    .map((file) => ({ file, modified: statSync(file).mtimeMs }))
    .sort((a, b) => b.modified - a.modified);
  for (const file of files) {
    const reading = parseCodexAllowance(tail(file.file), pool, now);
    if (reading.windows.length) return reading;
  }
  return unknownReading(pool, now);
}

function rolloutFor(configDirectory: string, session: string): string | null {
  const root = join(configDirectory, 'sessions');
  const suffix = `-${session}.jsonl`;
  const pending = [root];
  const matches: string[] = [];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)) matches.push(path);
    }
  }
  matches.sort((a, b) => basename(a).localeCompare(basename(a)) || a.localeCompare(b));
  for (const path of matches) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      /* A rollout may disappear during cleanup. */
    }
  }
  return null;
}

function codexEvent(event: Record<string, any>, hasRollout: boolean): AgentEvent | null {
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
  if (item.type === 'agent_message') result.answer = item.text ?? '';
  if (payload.type === 'message' && payload.role === 'assistant')
    result.answer = (payload.content ?? []).map((part: { text?: string }) => part.text ?? '').join('\n');
  return Object.keys(result).length ? result : null;
}

/** Preserve the legacy brief's explicit model pin independently of the selected route. */
function pinnedCodexProfile(model: string, requestedEffort: string | undefined, route: Profile): Profile {
  if (!/^gpt-[a-z0-9.-]+$/.test(model)) throw new Error(`brief model must be a Codex model: ${model}`);
  const effort = (requestedEffort ?? 'high') as Profile['effort'];
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error(`invalid brief effort: ${effort}`);
  return {
    cli: 'codex',
    model,
    effort,
    poolClass: route.cli === 'codex' ? route.poolClass : 'codex',
    ...(route.serviceTier ? { serviceTier: route.serviceTier } : {}),
  };
}
