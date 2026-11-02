import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importAttempt, importRunDirectory } from './import-attempt.ts';
import { CLASSIFIER_VERSION } from './records.ts';
import { brief, harness } from './test-support.ts';

const fixture = join(import.meta.dir, 'fixtures/resumed.jsonl');
const profile = { cli: 'codex', model: 'gpt-6-luna', effort: 'max', poolClass: 'codex' } as const;

function options(taskId: string) {
  return {
    taskId,
    startedAt: '2026-10-25T00:01:00Z',
    endedAt: '2026-10-25T00:02:00Z',
    profile,
    pool: 'fixture',
  };
}

function seedTask(h: ReturnType<typeof harness>) {
  return h.store.createTask(
    brief(),
    { briefPath: h.briefFile, worktree: h.root, branch: '', base: '' },
    'implementation',
  );
}

function writeCapture(directory: string, events: string) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'events.jsonl'), events);
  writeFileSync(
    join(directory, 'meta.start.json'),
    JSON.stringify({
      task: 'historical',
      worktree: directory,
      cli: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'high',
      pool: 'historical-pool',
      start: '2026-10-25T00:00:00Z',
      criticalPath: true,
      poolReadingBefore: '0% weekly',
    }),
  );
  writeFileSync(join(directory, 'meta.end.json'), JSON.stringify({ end: '2026-10-25T00:01:00Z', exit: 0 }));
}

test('unreadable captures and injected staging failures preserve original source and previous usable state without a half-import', () => {
  const h = harness();
  try {
    const task = seedTask(h);
    const previous = importAttempt(h.tasks, fixture, options(task.id));
    const usable = {
      task: h.store.task(task.id),
      attempts: h.store.attempts(),
      records: h.store.records(),
      log: readFileSync(h.store.attempt({ taskId: task.id, attempt: 1 }).logPath),
    };
    const source = readFileSync(fixture);
    expect(() =>
      importAttempt(h.tasks, join(h.settings.stateDirectory, 'missing.jsonl'), options(task.id)),
    ).toThrow(/failed to read import capture .*missing\.jsonl/);
    const blocked = join(h.settings.stateDirectory, 'blocked-capture');
    mkdirSync(blocked);
    expect(() => importAttempt(h.tasks, blocked, options(task.id))).toThrow(/failed to read import capture/);
    expect(existsSync(blocked)).toBe(true);
    expect(() =>
      importAttempt(h.tasks, fixture, options(task.id), () => {
        throw new Error('injected staging failure');
      }),
    ).toThrow(/failed to stage import log .*2\.jsonl: injected staging failure/);
    expect(h.store.task(task.id)).toEqual(usable.task);
    expect(h.store.attempts()).toEqual(usable.attempts);
    expect(h.store.records()).toEqual(usable.records);
    expect(h.store.record(previous)).toEqual(previous);
    expect(readFileSync(h.store.attempt({ taskId: task.id, attempt: 1 }).logPath)).toEqual(usable.log);
    expect(readFileSync(fixture)).toEqual(source);
    expect(existsSync(join(h.settings.stateDirectory, 'runs', task.id, '2.jsonl'))).toBe(false);

    const capture = join(h.settings.stateDirectory, 'capture');
    writeCapture(capture, 'turn\n');
    const start = readFileSync(join(capture, 'meta.start.json'));
    const end = readFileSync(join(capture, 'meta.end.json'));
    const events = readFileSync(join(capture, 'events.jsonl'));
    expect(() =>
      importRunDirectory(h.tasks, capture, () => {
        throw new Error('injected staging failure');
      }),
    ).toThrow(/failed to stage import log .*injected staging failure/);
    expect(h.store.tasks()).toEqual([usable.task]);
    expect(readFileSync(join(capture, 'meta.start.json'))).toEqual(start);
    expect(readFileSync(join(capture, 'meta.end.json'))).toEqual(end);
    expect(readFileSync(join(capture, 'events.jsonl'))).toEqual(events);
    const unread = join(h.settings.stateDirectory, 'unread-capture');
    writeCapture(unread, 'turn\n');
    const unreadMeta = readFileSync(join(unread, 'meta.start.json'));
    unlinkSync(join(unread, 'events.jsonl'));
    expect(() => importRunDirectory(h.tasks, unread)).toThrow(/failed to read import capture .*events\.jsonl/);
    expect(h.store.tasks()).toEqual([usable.task]);
    expect(readFileSync(join(unread, 'meta.start.json'))).toEqual(unreadMeta);
  } finally {
    h.dispose();
  }
});

test('successful imports retain matching log, record and terminal metadata', () => {
  const h = harness();
  try {
    const task = seedTask(h);
    const record = importAttempt(h.tasks, fixture, { ...options(task.id), outcome: 'stopped' });
    const attempt = h.store.attempt({ taskId: task.id, attempt: 1 });
    expect(readFileSync(attempt.logPath)).toEqual(readFileSync(fixture));
    expect(h.store.record(attempt)).toEqual(record);
    expect(record).toMatchObject({
      taskId: task.id,
      attempt: 1,
      outcome: 'stopped',
      tokens: { input: 800, cached: 500, output: 80 },
      classifierVersion: CLASSIFIER_VERSION,
    });
    expect(attempt).toMatchObject({
      state: 'exited',
      session: 'fixture-session',
      endedAt: '2026-10-25T00:02:00Z',
      logPath: join(h.settings.stateDirectory, 'runs', task.id, '1.jsonl'),
    });
    expect(h.store.task(task.id).state).toBe('stopped');

    const events = `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } })}\n`;
    const capture = join(h.settings.stateDirectory, 'ok-capture');
    writeCapture(capture, events);
    const imported = importRunDirectory(h.tasks, capture);
    const captured = h.store.attempt({ taskId: imported.taskId, attempt: 1 });
    expect(readFileSync(captured.logPath, 'utf8')).toBe(events);
    expect(readFileSync(join(capture, 'events.jsonl'), 'utf8')).toBe(events);
    expect(h.store.record(captured)).toEqual(imported);
    expect(imported).toMatchObject({
      outcome: 'stopped',
      tableVersion: 'pre-control-plane',
      tokens: { input: 100, cached: 80, output: 10 },
      criticalPath: true,
    });
    expect(captured).toMatchObject({
      state: 'exited',
      exitCode: 0,
      endedAt: '2026-10-25T00:01:00Z',
    });
    expect(h.store.task(imported.taskId).state).toBe('stopped');
  } finally {
    h.dispose();
  }
});

