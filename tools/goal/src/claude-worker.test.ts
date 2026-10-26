import { expect, test } from 'bun:test';
import { launchCommand, workerEnvironment } from './launch.ts';
import { measureLog } from './records.ts';
import { readRouting } from './routing.ts';
import { parseClaudeUsage, readPool, recordClaudeRateLimit } from './usage.ts';
import type { Pool, Profile } from './types.ts';

const pool: Pool = {
  name: 'claude-worker', cli: 'claude', classes: ['claude'], command: '/bin/claude', configDirectory: '/home/fixture/.claude',
  allowanceKey: 'claude', policy: { weight: 1, reservePercent: 15, allowUnknown: false, maxAgeMs: 21600000 },
} as Pool;
const profile: Profile = { cli: 'claude', model: 'claude-sonnet-5-5', effort: 'high', poolClass: 'claude' };

test('a Claude worker runs headless with full access, without the managers hooks or MCP servers', () => {
  const [program, args] = launchCommand({ profile, pool, worktree: '/work', prompt: 'do it', logPath: '/log' });
  expect(program).toBe('/bin/claude');
  expect(args).toEqual(['-p', '--model', 'claude-sonnet-5-5', '--effort', 'high', '--permission-mode', 'bypassPermissions',
    '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--settings', '{"disableAllHooks":true}', '--', 'do it']);
  const env = workerEnvironment(pool, {}, { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: 'manager', PATH: '/bin' });
  expect(env.CLAUDE_CONFIG_DIR).toBe('/home/fixture/.claude');
  expect(env.CLAUDECODE).toBeUndefined();
  expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  const home = require('node:os').homedir();
  expect(workerEnvironment({ ...pool, configDirectory: `${home}/.claude` } as Pool, {}, { CLAUDE_CONFIG_DIR: 'x' }).CLAUDE_CONFIG_DIR).toBeUndefined();
});

const stream = (...events: object[]) => events.map((event) => JSON.stringify(event)).join('\n');

test('a Claude stream yields its session, answer, tokens and tool steps', () => {
  const measured = measureLog(stream(
    { type: 'system', subtype: 'init', session_id: 'claude-session' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'bun test' } }] }, session_id: 'claude-session' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'bun test' } }] }, session_id: 'claude-session' },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: '{"status":"success","summary":"done"}', session_id: 'claude-session',
      usage: { input_tokens: 4, cache_creation_input_tokens: 10, cache_read_input_tokens: 30, output_tokens: 7 } },
  ));
  expect(measured.session).toBe('claude-session');
  expect(measured.result).toBe('{"status":"success","summary":"done"}');
  expect(measured.failureKind).toBeNull();
  expect(measured.tokens).toEqual({ input: 44, cached: 30, output: 7 });
  expect(Object.values(measured.steps).reduce((a, b) => a + b, 0)).toBe(1);
});

test('a refused Claude rate limit or a usage-limit error result is pool exhaustion', () => {
  const rejected = measureLog(stream(
    { type: 'system', subtype: 'init', session_id: 's' },
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } },
    { type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached', session_id: 's' },
  ));
  expect(rejected.failureKind).toBe('pool-exhausted');
  const limited = measureLog(stream({ type: 'result', is_error: true, result: "You've hit your limit · resets 9am", session_id: 's' }));
  expect(limited.failureKind).toBe('pool-exhausted');
  const broken = measureLog(stream({ type: 'result', is_error: true, result: 'error_during_execution', session_id: 's' }));
  expect(broken.failureKind).toBe('tool');
});

test('the OAuth usage body becomes the five-hour and seven-day windows', () => {
  const reading = parseClaudeUsage(JSON.stringify({
    five_hour: { utilization: 8.0, resets_at: '2026-10-26T09:00:00.1+00:00' },
    seven_day: { utilization: 47.0, resets_at: '2026-10-26T15:00:00.1+00:00' },
    seven_day_opus: null,
  }), pool, Date.parse('2026-10-26T05:30:00Z'));
  expect(reading.windows).toEqual([
    { usedPercent: 8, resetsAt: Date.parse('2026-10-26T09:00:00.1+00:00'), minutes: 300 },
    { usedPercent: 47, resetsAt: Date.parse('2026-10-26T15:00:00.1+00:00'), minutes: 10080 },
  ]);
  expect(reading.exhausted).toBe(false);
  expect(reading.observedAt).toBe('2026-10-26T05:30:00.000Z');
  expect(parseClaudeUsage('{}', pool).windows).toEqual([]);
});

test('the routing table accepts a Claude profile', () => {
  const table = readRouting(new URL('../routing.json', import.meta.url).pathname);
  const file = `${process.env.TMPDIR ?? '/tmp'}/routing-claude-${Date.now()}.json`;
  table.classes.implementation.first = profile;
  require('node:fs').writeFileSync(file, JSON.stringify(table));
  expect(readRouting(file).classes.implementation.first).toEqual(profile);
});

test('a finished Claude log refreshes the shared reading, which outlives a refused refresh for twenty minutes', () => {
  const directory = require('node:fs').mkdtempSync(`${require('node:os').tmpdir()}/claude-config-`);
  const local = { ...pool, configDirectory: directory } as Pool;
  const at = Date.parse('2026-10-26T05:47:00Z');
  const log = stream(
    { type: 'system', subtype: 'init', session_id: 's' },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: {
      five_hour: { utilization: 0.1, resetsAt: Date.parse('2026-10-26T09:00:00Z') / 1000 },
      seven_day: { utilization: 0.46, resetsAt: Date.parse('2026-10-26T15:00:00Z') / 1000 },
    } } },
  );
  recordClaudeRateLimit(local, log, at);
  // No credentials in the fixture directory, so every refresh is refused.
  expect(readPool(local, at + 60_000).windows.map((w) => w.usedPercent)).toEqual([10, 46]);
  expect(readPool(local, at + 19 * 60_000).windows.map((w) => w.usedPercent)).toEqual([10, 46]);
  expect(readPool(local, at + 21 * 60_000).windows).toEqual([]);
});

test('a Claude worker woken by its own background command after reporting keeps the report as its final answer', () => {
  const report = '{"status":"success","summary":"done"}';
  const woken = measureLog(stream(
    { type: 'system', subtype: 'init', session_id: 's' },
    { type: 'result', is_error: false, result: report, session_id: 's' },
    { type: 'result', is_error: false, result: 'That notification is the earlier rerun finishing; my report above stands.', session_id: 's' },
  ));
  expect(woken.result).toBe(report);
  expect(woken.failureKind).toBeNull();

  const changed = measureLog(stream(
    { type: 'result', is_error: false, result: report, session_id: 's' },
    { type: 'result', is_error: false, result: 'BLOCKER: the rerun failed after all', session_id: 's' },
  ));
  expect(changed.blocker).toBe('the rerun failed after all');
});
