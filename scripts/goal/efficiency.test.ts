import { describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { efficiencyCommand, type EfficiencyRecord } from './efficiency.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'efficiency');
const TEST_ROOT = join(import.meta.dir, '../../.temp/efficiency-tests');

function fixture() {
  mkdirSync(TEST_ROOT, { recursive: true });
  const root = mkdtempSync(join(TEST_ROOT, 'case-'));
  const codex = join(root, '.codex');
  const codex1 = join(root, '.codex-1');
  const files = [
    [join(codex, 'sessions/2026/10/13/session-a.jsonl'), 'session-a.jsonl'],
    [join(codex1, 'sessions/2026/10/13/session-b.jsonl'), 'session-b.jsonl'],
  ] as const;
  for (const [destination, source] of files) {
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(FIXTURES, source), destination);
  }
  return {
    root,
    stateDirectory: join(root, 'state'),
    homes: [codex, codex1],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function run(f: ReturnType<typeof fixture>, args: string[], at = '2026-10-14T00:00:00Z') {
  const output: string[] = [];
  const errors: string[] = [];
  const diagnostics: string[] = [];
  const status = await efficiencyCommand(args, {
    stateDirectory: f.stateDirectory,
    nowMs: Date.parse(at),
    env: { ...process.env, GOAL_CODEX_HOMES: f.homes.join(delimiter) },
    print: line => output.push(line),
    reportError: line => errors.push(line),
    reportDiagnostic: line => diagnostics.push(line),
  });
  return { status, output, errors, diagnostics };
}

function writeSession(home: string, day: string, name: string, started: string, resumed = started): string {
  const file = join(home, 'sessions', day, `${name}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [
    { timestamp: started, payload: { type: 'task_started' } },
    { timestamp: resumed, payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100 } } } },
  ].map(event => JSON.stringify(event)).join('\n'));
  return file;
}

function record(output: string[]): EfficiencyRecord {
  expect(output).toHaveLength(1);
  return JSON.parse(output[0]!) as EfficiencyRecord;
}

describe('Goal efficiency command', () => {
  test.each([
    { since: '2026-10-01T00:00:00Z', until: '2026-10-01T23:59:59Z', days: ['2026/09/30', '2026/10/01', '2026/10/02'] },
    { since: '2026-12-31T23:30:00Z', until: '2027-01-01T00:30:00Z', days: ['2026/12/30', '2026/12/31', '2027/01/01', '2027/01/02'] },
  ])('opens only day directories in the window with a timezone margin: $since', async ({ since, until, days }) => {
    const f = fixture();
    const open = spyOn(fs, 'createReadStream');
    try {
      // Both neighboring local dates can contain starts in the UTC window.
      const expected = days.map((day, index) => writeSession(f.homes[0]!, day, `inside-${index}`, index % 2 ? until : since,
        '2027-02-01T00:00:00Z'));
      writeSession(f.homes[0]!, '2025/12/31', 'old', since);
      writeSession(f.homes[0]!, '2027/02/01', 'resumed-day', since);
      const excluded = writeSession(f.homes[0]!, days[1]!, 'outside-start', '2025-01-01T00:00:00Z', since);
      // Repeated configuration must not read the same log twice.
      f.homes = [f.homes[0]!, f.homes[0]!];
      const result = await run(f, ['--since', since, '--until', until, '--json']);
      expect(result.status).toBe(0);
      expect(record(result.output).sessions.total).toBe(days.length);
      expect(record(result.output).steps).toBe(days.length);
      expect(record(result.output).tokens.input).toBe(days.length * 100);
      expect(open.mock.calls.map(call => call[0]).sort()).toEqual([...expected, excluded].sort());
      expect(result.diagnostics).toEqual([]);
    } finally { open.mockRestore(); f.cleanup(); }
  });

  test('an unbounded start reads earlier logs and reports the count without changing JSON', async () => {
    const f = fixture();
    const open = spyOn(fs, 'createReadStream');
    try {
      const old = writeSession(f.homes[0]!, '2025/12/31', 'old', '2025-12-31T23:00:00Z');
      const nextLocalDay = writeSession(f.homes[0]!, '2026/01/02', 'timezone', '2026-01-01T23:00:00Z');
      writeSession(f.homes[0]!, '2026/01/03', 'later', '2026-01-01T23:00:00Z');
      const result = await run(f, ['--until', '2026-01-01T23:59:59Z', '--json']);
      expect(result.status).toBe(0);
      expect(record(result.output).sessions.total).toBe(2);
      expect(record(result.output).window.since).toBeNull();
      expect(open.mock.calls.map(call => call[0]).sort()).toEqual([old, nextLocalDay].sort());
      expect(result.diagnostics).toEqual(['Opened 2 session logs (no lower time bound).']);
    } finally { open.mockRestore(); f.cleanup(); }
  });

  test('keeps the staged Python measures on the trimmed session fixtures', async () => {
    const f = fixture();
    try {
      const result = await run(f, ['--json']);
      expect(result.status).toBe(0);
      expect(result.errors).toEqual([]);
      const measured = record(result.output);
      expect(measured.sessions).toEqual({ total: 2, workers: 2, landingReviews: 0, other: 0 });
      expect(measured.byRole).toEqual({
        worker: { sessions: 2, inputTokens: 3_481_562, inputShare: 100 },
        landingReviews: { sessions: 0, inputTokens: 0, inputShare: 0 },
        other: { sessions: 0, inputTokens: 0, inputShare: 0 },
      });
      expect(measured.steps).toBe(64);
      expect(measured.tokens).toEqual({ input: 3_481_562, cachedInput: 3_352_320, cachedShare: 96, workerInput: 3_481_562 });
      expect(measured.byTurn).toEqual({ '1-3': 3_481_562, '4-6': 0, '7-12': 0, '13+': 0 });
      expect(measured.byAction).toEqual({
        read: 830_427,
        other: 207_654,
        wait: 1_238_792,
        test: 224_169,
        commit: 212_879,
        think: 219_555,
        edit: 548_086,
      });
      expect(measured.noDecisionShare).toBe(48);
      expect(measured.byEngine).toEqual({ sol: { sessions: 2, turns: 3, steps: 64, inputTokens: 3_481_562 } });
      expect(measured.byAccount).toEqual({
        codex: { sessions: 1, inputTokens: 1_331_035 },
        'codex-1': { sessions: 1, inputTokens: 2_150_527 },
      });
      expect(measured.taskStats).toEqual({ tasks: 2, oneTurnTasks: 1, oneTurnMedianInput: 1_331_035,
        thirteenTurnTasks: 0, thirteenTurnInputShare: 0 });
      expect(measured.longSessions).toEqual({ over150: 0, workers: 2, workerInputShare: 0, after150InputShare: 0 });
      expect(measured.tasks).toEqual([
        { task: 'G-2070', turns: 2, steps: 34, inputTokens: 2_150_527, sessions: 1 },
        { task: 'G-2094', turns: 1, steps: 30, inputTokens: 1_331_035, sessions: 1 },
      ]);

      const text = await run(f, []);
      expect(text.output.join('\n')).toContain('wait 36%');
      expect(text.output.join('\n')).toContain('read 24%');
      expect(text.output.join('\n')).toContain('edit 16%');
      expect(text.output.join('\n')).toContain('test 6%');
      expect(text.output.join('\n')).toContain('1-3 100%');
      expect(text.output.join('\n')).toContain('Input by role: workers 2 sessions, 3,481,562 tokens (100%)');
      expect(text.output.join('\n')).toContain('No-decision steps (wait, test, commit): 48%');
      expect(text.output.length).toBeLessThanOrEqual(60);
    } finally { f.cleanup(); }
  });

  test('--since and --until select by each session first timestamp', async () => {
    const f = fixture();
    try {
      const result = await run(f, ['--since', '2026-10-13T04:45:00Z', '--until', '2026-10-13T04:50:00Z', '--json']);
      const measured = record(result.output);
      expect(measured.sessions.total).toBe(1);
      expect(measured.steps).toBe(30);
      expect(measured.tasks.map(task => task.task)).toEqual(['G-2094']);
      expect(measured.window).toEqual({ since: '2026-10-13T04:45:00.000Z', until: '2026-10-13T04:50:00.000Z' });

      const before = await run(f, ['--since', '2026-10-13T04:30:00Z', '--until', '2026-10-13T04:45:00Z', '--json']);
      const earlier = record(before.output);
      expect(earlier.sessions.total).toBe(1);
      expect(earlier.steps).toBe(34);
      expect(earlier.tasks.map(task => task.task)).toEqual(['G-2070']);
    } finally { f.cleanup(); }
  });

  test('--record sets the next call default window start to that record time', async () => {
    const f = fixture();
    try {
      const first = await run(f, ['--record', '--json'], '2026-10-13T04:45:00Z');
      expect(record(first.output).tasks.map(task => task.task)).toEqual(['G-2070']);
      expect(readFileSync(join(f.stateDirectory, 'efficiency.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);

      const second = await run(f, ['--json'], '2026-10-13T04:50:00Z');
      const measured = record(second.output);
      expect(measured.window.since).toBe('2026-10-13T04:45:00.000Z');
      expect(measured.tasks.map(task => task.task)).toEqual(['G-2094']);
      expect(measured.steps).toBe(30);
      expect(readFileSync(join(f.stateDirectory, 'efficiency.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  test('--last compares one record with no predecessor and two records figure by figure', async () => {
    const f = fixture();
    try {
      await run(f, ['--record', '--json'], '2026-10-13T04:45:00Z');
      const one = await run(f, ['--last']);
      expect(one.output.join('\n')).toContain('Previous: none; last: 2026-10-13T04:45:00.000Z');
      expect(one.output.join('\n')).toContain('Steps: — → 34 (new)');

      await run(f, ['--record', '--json'], '2026-10-13T04:50:00Z');
      const two = await run(f, ['--last']);
      const comparison = two.output.join('\n');
      expect(comparison).toContain('Previous: 2026-10-13T04:45:00.000Z; last: 2026-10-13T04:50:00.000Z');
      expect(comparison).toContain('Steps: 34 → 30 (-4)');
      expect(comparison).toContain('Input tokens: 2,150,527 → 1,331,035 (-819,492)');
      expect(comparison).toContain('Task-turn shares:');
      expect(comparison).toContain('Step-action shares:');
      expect(comparison).toContain('Role worker: sessions 1 → 1 (0)');
      expect(comparison).toContain('No-decision share (wait, test, commit):');
      expect(two.output.length).toBeLessThanOrEqual(60);
    } finally { f.cleanup(); }
  });
});
