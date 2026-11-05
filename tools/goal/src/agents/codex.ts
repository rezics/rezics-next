import { unknownReading, textSignals, parseExitObject } from './shared.ts';
import { existsSync, readFileSync, readdirSync, openSync, closeSync, readSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { defaultPolicy } from '../policy.ts';
import type { AgentAdapter } from '../agents.ts';
import type { Pool, PoolReading } from '../types.ts';
import { codexCommand, pinnedCodexProfile } from './codex-command.ts';
import { codexEvent, codexUsageAccumulator, parseCodexAllowance, parseCodexSessionUsage } from './codex-events.ts';

export { parseCodexAllowance, parseCodexSessionUsage };

export const codexAdapter: AgentAdapter = {
  environmentKeys: ['CODEX_HOME', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID'],
  cli: 'codex',
  canResume: true,
  supportsResolver: true,
  streamsLog: true,
  start: codexCommand,
  resume(options) {
    return codexCommand({ ...options, resumeSession: options.session });
  },
  pinProfile: pinnedCodexProfile,
  supportsConsultation(profile) {
    return profile.model.includes('sol') && profile.effort === 'medium';
  },
  signals: textSignals,
  canImport: true,
  announcedReset: true,
  readAllowance: readCodexAllowance,
  readSessionPath: rolloutPathFor,
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
  parseUsage(events, start, end, policy) {
    return parseCodexSessionUsage(events, start, end, policy);
  },
  createUsageAccumulator(start, end, policy) {
    return codexUsageAccumulator(start, end, policy);
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
function tail(file: string, maxBytes: number): string {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size,
      buffer = Buffer.alloc(Math.min(size, maxBytes));
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}
function readCodexAllowance(pool: Pool, now: number, policy = defaultPolicy.provider): PoolReading {
  const sessions = join(pool.configDirectory, 'sessions');
  if (!existsSync(sessions)) return unknownReading(pool, now);
  const files = readdirSync(sessions, { recursive: true })
    .filter((p): p is string => typeof p === 'string' && p.endsWith('.jsonl'))
    .map((p) => join(sessions, p))
    .map((file) => ({ file, modified: statSync(file).mtimeMs }))
    .sort((a, b) => b.modified - a.modified);
  for (const file of files) {
    const reading = parseCodexAllowance(tail(file.file, policy.codexAllowanceTailBytes), pool, now);
    if (reading.windows.length) return reading;
  }
  return unknownReading(pool, now);
}

function rolloutPathFor(configDirectory: string, session: string): string | null {
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
  matches.sort((a, b) => basename(a).localeCompare(basename(b)) || a.localeCompare(b));
  for (const path of matches) {
    try {
      const fd = openSync(path, 'r');
      closeSync(fd);
      return path;
    } catch {
      /* A rollout may disappear during cleanup. */
    }
  }
  return null;
}
