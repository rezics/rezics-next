import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attemptSession,
  CLASSIFIER_VERSION,
  classifyStep,
  measureLog,
  measureSessionFile,
  readMeasurement,
} from './records.ts';
import {
  scanSessionJsonl,
  SESSION_JSONL_MAX_RECORD_BYTES,
  SESSION_JSONL_READ_BUFFER_BYTES,
} from './session-accounting.ts';
import type { Attempt } from './types.ts';
import { harness } from './test-support.ts';
import { importAttempt } from './import-attempt.ts';

const fixture = join(import.meta.dir, 'fixtures/resumed.jsonl');
test('resumed rollout records increments within the attempt window, ignoring repeated cumulative snapshots', () => {
  const measured = measureLog(readFileSync(fixture, 'utf8'), {
    startedAt: '2026-10-25T00:01:00Z',
    endedAt: '2026-10-25T00:02:00Z',
  });
  expect(measured.tokens).toEqual({ input: 800, cached: 500, output: 80 });
  expect(measured.steps).toEqual({ decision: 0, read: 1, edit: 1, wait: 0, check: 1, commit: 1 });
  expect(measured.session).toBe('fixture-session');
  const exec = [1000, 1300, 1300]
    .map((input_tokens) => JSON.stringify({ type: 'turn.completed', usage: { input_tokens } }))
    .join('\n');
  expect(measureLog(exec, { baseline: { input: 1000, cached: 0, output: 0 } }).tokens.input).toBe(300);
  expect(classifyStep('wait', '')).toBe('wait');
  expect(classifyStep('reasoning', '')).toBe('decision');
});
test('reasoning items are not steps', () => {
  const lines = [
    { type: 'thread.started', thread_id: 'session' },
    ...[1, 2, 3].map((n) => ({ type: 'item.completed', item: { id: `r${n}`, type: 'reasoning', text: 'thinking' } })),
    { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls' } },
    { type: 'item.completed', item: { id: 'c2', type: 'command_execution', command: 'bun test' } },
    { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
  ];
  const measured = measureLog(lines.map((line) => JSON.stringify(line)).join('\n'));
  expect(Object.values(measured.steps).reduce((a, b) => a + b, 0)).toBe(2);
});

test('import creates a complete measurement record without launching a worker', async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const record = importAttempt(h.tasks, fixture, {
      taskId: task.id,
      startedAt: '2026-10-25T00:01:00Z',
      endedAt: '2026-10-25T00:02:00Z',
      profile: { cli: 'codex', model: 'gpt-6-luna', effort: 'max', poolClass: 'codex' },
      pool: 'fixture',
    });
    expect(record.tokens.input).toBe(800);
    expect(record.classifierVersion).toBe(CLASSIFIER_VERSION);
    expect(record.steps).toBe(4);
    expect(record.tableVersion).toBe(
      `imported-before-${(await Bun.file(join(import.meta.dir, '../routing.json')).json()).version}`,
    );
    expect(h.store.records()).toEqual([record]);
  } finally {
    h.dispose();
  }
});

test('import refuses to replace a waiting attempt', async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const worker = await h.tasks.retry(task.id);
    h.store.updateAttempt(worker.attempt, (attempt) => {
      attempt.state = 'waiting';
      attempt.checks = ['check-id'];
    });
    expect(() =>
      importAttempt(h.tasks, fixture, {
        taskId: task.id,
        startedAt: '2026-10-25T00:01:00Z',
        endedAt: '2026-10-25T00:02:00Z',
        profile: { cli: 'codex', model: 'gpt-6-luna', effort: 'max', poolClass: 'codex' },
        pool: 'fixture',
      }),
    ).toThrow('cannot import over a running or waiting attempt');
  } finally {
    h.dispose();
  }
});

test('out-of-order cumulative observations cannot make resumed token totals grow twice', () => {
  const log = [1000, 1300, 1000, 1300, 1500]
    .map((input_tokens) => JSON.stringify({ type: 'turn.completed', usage: { input_tokens } }))
    .join('\n');
  expect(measureLog(log, { baseline: { input: 1000, cached: 0, output: 0 } }).tokens.input).toBe(500);
});

test('long retained sessions keep bounded read buffers and isolate the current attempt window', () => {
  const temp = join(import.meta.dir, '../../../.temp');
  mkdirSync(temp, { recursive: true });
  const root = mkdtempSync(join(temp, 'session-accounting-'));
  const session = 'streamed-session';
  const start = '2026-10-25T00:01:00.000Z';
  const currentStart = '2026-10-25T00:01:05.000Z';
  const end = '2026-10-25T00:02:00.000Z';
  const configDirectory = join(root, 'codex-home');
  const sessions = join(configDirectory, 'sessions', '2026', '10', '25');
  mkdirSync(sessions, { recursive: true });
  const rollout = join(sessions, `rollout-2026-10-25T00-00-00-${session}.jsonl`);
  const lines = (events: object[]) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';
  const usage = (input_tokens: number, cached_input_tokens: number, output_tokens: number) => ({
    input_tokens,
    cached_input_tokens,
    output_tokens,
  });

  try {
    const history = Array.from({ length: 30_000 }, (_, index) =>
      JSON.stringify({
        timestamp: '2026-10-25T00:00:00.000Z',
        type: 'turn_context',
        payload: { ordinal: index, note: 'unrelated retained history' },
      }),
    ).join('\n');
    writeFileSync(
      rollout,
      `${history}\n${lines([
        {
          timestamp: '2026-10-25T00:00:59.000Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: usage(1000, 700, 200) } },
        },
        {
          timestamp: '2026-10-25T00:01:01.000Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: usage(1300, 900, 250) } },
        },
        {
          timestamp: '2026-10-25T00:01:02.000Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: usage(1300, 900, 250) } },
        },
        {
          timestamp: '2026-10-25T00:01:03.000Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: usage(1250, 875, 240) } },
        },
        {
          timestamp: '2026-10-25T00:01:04.000Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: usage(1500, 1000, 300) } },
        },
        {
          timestamp: '2026-10-25T00:03:00.000Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: usage(9000, 8000, 1000) } },
        },
      ])}`,
    );
    const scan = scanSessionJsonl(rollout, () => {});
    expect(scan.complete).toBe(true);
    expect(scan.bytesRead).toBeGreaterThan(SESSION_JSONL_READ_BUFFER_BYTES * 10);
    expect(scan.maxBufferedBytes).toBeLessThanOrEqual(SESSION_JSONL_READ_BUFFER_BYTES + SESSION_JSONL_MAX_RECORD_BYTES);
    expect(scan.maxBufferedBytes).toBeLessThan(scan.bytesRead / 2);

    const previous = lines([
      { type: 'thread.started', thread_id: session },
      {
        timestamp: '2026-10-25T00:01:00.500Z',
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify({ status: 'waiting', checks: ['old-check'] }) },
      },
    ]);
    const current = lines([
      { timestamp: currentStart, type: 'turn.started' },
      {
        timestamp: '2026-10-25T00:01:05.000Z',
        type: 'item.completed',
        item: { id: 'current-command', type: 'command_execution', command: 'bun test' },
      },
    ]);
    const logPath = join(root, 'attempt.jsonl');
    writeFileSync(logPath, previous + current);
    const attempt = {
      session,
      logPath,
      startedAt: start,
      endedAt: end,
      profile: { cli: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    } as unknown as Attempt;
    const measured = readMeasurement(attempt, {
      configDirectory,
      logStartOffset: Buffer.byteLength(previous),
    });

    expect(measured.tokens).toEqual({ input: 500, cached: 300, output: 100 });
    expect(measured.total).toEqual({ input: 1500, cached: 1000, output: 300 });
    expect(measured.steps.check).toBe(1);
    expect(measured.result).toBe('');
    expect(measured.waitingChecks).toBeNull();

    const partial = join(root, 'partial-session.jsonl');
    writeFileSync(partial, '{"type":"token_usage_record",');
    expect(measureSessionFile(partial, { startedAt: start, endedAt: end })).toBeNull();
    const unsupported = join(root, 'unsupported-session.jsonl');
    writeFileSync(unsupported, JSON.stringify({ type: 'token_usage_record', payload: { usage: 'future-format' } }));
    expect(measureSessionFile(unsupported, { startedAt: start, endedAt: end })?.hasUsage).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI imports a preexisting log from a brief without starting a model or landing it', async () => {
  const { runWorkerCommand } = await import('./worker-commands.ts');
  const h = harness(),
    output: string[] = [];
  try {
    await runWorkerCommand(
      'import-attempt',
      [
        fixture,
        '--brief',
        h.briefFile,
        '--start',
        '2026-10-25T00:01:00Z',
        '--end',
        '2026-10-25T00:02:00Z',
        '--pool',
        'fixture',
        '--model',
        'gpt-6-luna',
        '--effort',
        'max',
      ],
      { tasks: h.tasks, print: (s) => output.push(s), env: {} },
    );
    const record = JSON.parse(output[0]!);
    expect(record.tokens.input).toBe(800);
    expect(record.diffLines).toBeNull();
    expect(record.hostMs).toBeNull();
    expect(h.store.attempts()[0]!.process).toBeNull();
    expect(h.store.tasks()[0]!.state).toBe('stopped');
    expect(h.store.events().filter((e) => e.kind === 'landing-requested')).toEqual([]);
  } finally {
    h.dispose();
  }
});

test('capture-directory import uses historical metadata without launching a CLI or changing its source checkout', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { runWorkerCommand } = await import('./worker-commands.ts');
  const h = harness(),
    output: string[] = [];
  try {
    const capture = join(h.settings.stateDirectory, 'capture');
    mkdirSync(capture);
    writeFileSync(
      join(capture, 'events.jsonl'),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 },
      }),
    );
    writeFileSync(
      join(capture, 'meta.start.json'),
      JSON.stringify({
        task: 'historical',
        worktree: h.root,
        cli: 'codex',
        model: 'gpt-6.1-sol',
        effort: 'high',
        pool: 'historical-pool',
        start: '2026-10-25T00:00:00Z',
        criticalPath: true,
        poolReadingBefore: '0% weekly',
      }),
    );
    writeFileSync(join(capture, 'meta.end.json'), JSON.stringify({ end: '2026-10-25T00:01:00Z', exit: 0 }));
    await runWorkerCommand('import-attempt', [capture], {
      tasks: h.tasks,
      env: {},
      print: (value) => output.push(value),
    });
    const record = JSON.parse(output[0]!);
    expect(record.tokens).toEqual({ input: 100, cached: 80, output: 10 });
    expect(record.criticalPath).toBe(true);
    expect(record.before.windows[0].usedPercent).toBe(0);
    expect(record.tableVersion).toBe('pre-control-plane');
    expect(h.store.tasks()[0]!.branch).toBe('');
    expect(h.store.attempts()[0]!.exitCode).toBe(0);
  } finally {
    h.dispose();
  }
});

test('a recovered CLI transport error is not an attempt failure after a completed turn', () => {
  const log = [
    { type: 'error', message: 'Reconnecting' },
    { type: 'turn.completed', usage: { input_tokens: 10 } },
  ]
    .map((value) => JSON.stringify(value))
    .join('\n');
  expect(measureLog(log).failureKind).toBeNull();
});

test('a superseded attempt whose session is not yet recorded names it from the head of its run log', () => {
  const directory = mkdtempSync(join(tmpdir(), 'attempt-session-'));
  try {
    const logPath = join(directory, '2.jsonl');
    writeFileSync(logPath, '{"type":"thread.started","thread_id":"thread-from-log"}\n{"type":"turn.started"}\n');
    const attempt = {
      session: null,
      logPath,
      profile: { cli: 'codex', model: 'gpt-6-luna', effort: 'max' },
    } as unknown as Attempt;
    expect(attemptSession(attempt)).toBe('thread-from-log');
    expect(attemptSession({ ...attempt, session: 'recorded' })).toBe('recorded');
    expect(attemptSession({ ...attempt, logPath: join(directory, 'missing.jsonl') })).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
