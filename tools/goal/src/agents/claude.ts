import type { AgentAdapter, AgentLaunchOptions, AgentEvent } from '../agents.ts';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { unknownReading, tokens, textSignals, parseExitObject } from './shared.ts';
import type { Pool, PoolReading } from '../types.ts';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

export const claudeAdapter: AgentAdapter = {
  supportsConsultation() {
    return false;
  },
  environmentKeys: ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'],
  cli: 'claude',
  canResume: true,
  streamsLog: true,
  start(options) {
    return command(options);
  },
  resume(options) {
    return command({ ...options, resumeSession: options.session });
  },
  signals: textSignals,
  canImport: false,
  readAllowance: readClaudeUsage,
  parseEvent: claudeEvent,
  parseExit: parseExitObject,
  sessionId(event) {
    return (event.type === 'system' && event.subtype === 'init') || event.type === 'result'
      ? (event.session_id ?? event.sessionId ?? null)
      : null;
  },
  isRateLimit(event) {
    return event.type === 'rate_limit_event' && event.rate_limit_info?.status === 'rejected';
  },
  matchesEvent(event) {
    return (
      event.type === 'system' ||
      event.type === 'assistant' ||
      event.type === 'result' ||
      event.type === 'rate_limit_event'
    );
  },
  environment(pool, env) {
    return resolve(pool.configDirectory) === join(homedir(), '.claude')
      ? env
      : { ...env, CLAUDE_CONFIG_DIR: pool.configDirectory };
  },
  afterExit(pool, log) {
    recordClaudeRateLimit(pool, log);
  },
  parseUsage() {
    return null;
  },
  failure(event) {
    return event.type === 'result' && event.is_error === true ? String(event.result ?? 'Claude turn failed') : null;
  },
  completed() {
    return false;
  },
};
function command(options: AgentLaunchOptions): [string, string[]] {
  const { profile, pool, prompt } = options;
  return [
    pool.command,
    [
      '-p',
      '--model',
      profile.model,
      '--effort',
      profile.effort,
      '--permission-mode',
      'bypassPermissions',
      '--output-format',
      'stream-json',
      '--verbose',
      ...(options.resumeSession ? ['--resume', options.resumeSession] : []),
      '--strict-mcp-config',
      '--settings',
      JSON.stringify({ disableAllHooks: true }),
      '--',
      prompt,
    ],
  ];
}

/** Parse the plan windows of Claude's OAuth usage endpoint, the one Claude Code's /usage reads. */
export function parseClaudeUsage(body: string, pool: Pool, now = Date.now()): PoolReading {
  const value = JSON.parse(body) as Record<string, { utilization?: unknown; resets_at?: unknown } | null>;
  const windows = (
    [
      ['five_hour', 300],
      ['seven_day', 10080],
    ] as const
  ).flatMap(([key, minutes]) => {
    const window = value[key];
    if (typeof window?.utilization !== 'number' || !Number.isFinite(window.utilization)) return [];
    const resetsAt = typeof window.resets_at === 'string' ? Date.parse(window.resets_at) : NaN;
    return [
      {
        usedPercent: Math.min(100, Math.max(0, window.utilization)),
        resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
        minutes,
      },
    ];
  });
  if (!windows.length) return unknownReading(pool, now);
  return {
    pool: pool.name,
    allowanceKey: pool.allowanceKey,
    at: new Date(now).toISOString(),
    observedAt: new Date(now).toISOString(),
    windows,
    exhausted: windows.some((w) => w.usedPercent >= 100),
    error: null,
  };
}
// The endpoint rate-limits its callers, so all control-plane processes share one cached reading: it is refreshed at
// most every two minutes, and a refused refresh keeps the last good reading for up to twenty minutes. The token goes
// to curl on stdin, never in its arguments.
const CLAUDE_REFRESH_MS = 120_000,
  CLAUDE_STALE_MS = 1_200_000;
function claudeCache(pool: Pool): string {
  return join(
    tmpdir(),
    `goal-claude-usage-${createHash('sha256').update(pool.configDirectory).digest('hex').slice(0, 16)}.json`,
  );
}
/** Claude Code streams the plan's windows in its rate_limit_event; a finished worker's log refreshes the shared reading. */
export function recordClaudeRateLimit(pool: Pool, log: string, now = Date.now()): void {
  let info: { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }> } | undefined;
  for (const line of log.split('\n')) {
    if (!line.includes('"rate_limit_event"')) continue;
    try {
      info = JSON.parse(line).rate_limit_info ?? info;
    } catch {
      /* Not an event line. */
    }
  }
  const windows = info?.unifiedWindows;
  if (!windows) return;
  const body = Object.fromEntries(
    Object.entries(windows).map(([key, window]) => [
      key,
      {
        utilization: typeof window.utilization === 'number' ? window.utilization * 100 : undefined,
        resets_at: typeof window.resetsAt === 'number' ? new Date(window.resetsAt * 1000).toISOString() : undefined,
      },
    ]),
  );
  const reading = parseClaudeUsage(JSON.stringify(body), pool, now);
  if (!reading.observedAt) return;
  const cache = claudeCache(pool);
  writeFileSync(`${cache}.${process.pid}`, JSON.stringify(reading), { mode: 0o600 });
  renameSync(`${cache}.${process.pid}`, cache);
}
export function readClaudeUsage(pool: Pool, now: number): PoolReading {
  const cache = claudeCache(pool);
  let cached: PoolReading | undefined;
  try {
    cached = JSON.parse(readFileSync(cache, 'utf8')) as PoolReading;
  } catch {
    /* No reading yet. */
  }
  const age = cached?.observedAt ? now - Date.parse(cached.observedAt) : Infinity;
  const reuse = (reading: PoolReading) => ({
    ...reading,
    pool: pool.name,
    allowanceKey: pool.allowanceKey,
    at: new Date(now).toISOString(),
  });
  if (cached && age < CLAUDE_REFRESH_MS) return reuse(cached);
  const token = (() => {
    try {
      return (
        JSON.parse(readFileSync(join(pool.configDirectory, '.credentials.json'), 'utf8')) as {
          claudeAiOauth?: { accessToken?: unknown };
        }
      ).claudeAiOauth?.accessToken;
    } catch {
      return undefined;
    }
  })();
  const response =
    typeof token === 'string' && token
      ? spawnSync(
          'curl',
          [
            '-sf',
            '-m',
            '10',
            '-H',
            '@-',
            '-H',
            'anthropic-beta: oauth-2025-04-20',
            'https://api.anthropic.com/api/oauth/usage',
          ],
          { input: `Authorization: Bearer ${token}\n`, encoding: 'utf8' },
        )
      : undefined;
  const reading = response?.status === 0 ? parseClaudeUsage(response.stdout, pool, now) : undefined;
  if (reading?.observedAt) {
    writeFileSync(`${cache}.${process.pid}`, JSON.stringify(reading), { mode: 0o600 });
    renameSync(`${cache}.${process.pid}`, cache);
    return reading;
  }
  if (cached && age < CLAUDE_STALE_MS) return reuse(cached);
  return unknownReading(pool, now, 'quota observation unavailable');
}

function claudeEvent(event: Record<string, any>, hasRollout: boolean): AgentEvent | null {
  const result: AgentEvent = {};
  if (event.type === 'assistant')
    result.commands = (event.message?.content ?? [])
      .filter((call: Record<string, any>) => call?.type === 'tool_use' && typeof call.input?.command === 'string')
      .map((call: Record<string, any>) => ({ ...(call.id ? { id: call.id } : {}), text: call.input.command }));
  if (event.type === 'assistant')
    result.steps = (event.message?.content ?? [])
      .filter((call: Record<string, any>) => call?.type === 'tool_use')
      .map((call: Record<string, any>) => {
        const input = call.input?.command ?? call.input ?? '';
        return {
          ...(call.id ? { id: call.id } : {}),
          name: call.name ?? 'tool_use',
          input: typeof input === 'string' ? input : JSON.stringify(input),
        };
      });
  if (event.type === 'result') {
    if (!hasRollout && event.usage) result.usage = { tokens: tokens(event.usage), delta: event.usage_mode === 'delta' };
    if (event.result !== undefined)
      result.answer = typeof event.result === 'string' ? event.result : JSON.stringify(event.result);
    result.final = true;
  }
  return Object.keys(result).length ? result : null;
}
