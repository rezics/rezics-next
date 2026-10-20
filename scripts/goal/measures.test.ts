import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Attempt, Ledger, Task } from './goalctl.ts';
import { goalMeasures, measureLines } from './measures.ts';

const nowMs = Date.parse('2026-10-13T12:00:00Z');
function fixture() {
  const root = join(import.meta.dir, '../../.temp/measures-tests');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'case-'));
  const ledger: Ledger = { goals: { api: { manager: 'api', startedAt: '2026-10-12T00:00:00Z' },
    closed: { manager: 'closed', startedAt: '2026-10-12T00:00:00Z', closedAt: '2026-10-12T01:00:00Z' } }, tasks: {} };
  const write = (path: string, value: string) => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), value); };
  const task = (id: string, state: Task['state'] = 'verified') => {
    const t: Task = { id, title: 'Prove a row', effort: 'high', cases: [], paths: [], migrations: [], shared: [], depends: [],
      brief: '', worktree: dir, branch: '', base: '', state, goal: 'api', attempts: [] };
    ledger.tasks[id] = t; return t;
  };
  const attempt = (t: Task, handoff = 'done', options: Partial<Attempt> = {}, usage?: { input_tokens: number; output_tokens: number }) => {
    const n = t.attempts.length + 1;
    const a: Attempt = { n, effort: 'high', engine: 'codex', pid: 0, session: `${t.id}-session`,
      output: `runs/${t.id}/attempt-${n}.json`, lastMessage: `runs/${t.id}/attempt-${n}.last.md`,
      startedAt: `2026-10-13T${String(n).padStart(2, '0')}:00:00Z`, endedAt: `2026-10-13T${String(n).padStart(2, '0')}:30:00Z`, ...options };
    t.attempts.push(a);
    if (a.lastMessage) write(a.lastMessage, `RESULT: ${handoff}\n`);
    write(a.output, JSON.stringify({ type: 'thread.started', thread_id: a.session }) + '\n'
      + (usage ? JSON.stringify({ type: 'turn.completed', usage }) + '\n' : ''));
    return a;
  };
  return { dir, ledger, write, task, attempt,
    report: () => goalMeasures(ledger, { root: dir, nowMs, codexHomes: [join(dir, 'codex')] }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('Goal method measures', () => {
  test('separates first attempts, steps, fixes and retries, by UTC day and run; counts attempts for landed tasks', async () => {
    const f = fixture();
    try {
      const t = f.task('row');
      f.attempt(t, 'partial', { startedAt: '2026-10-12T23:30:00Z' });
      f.attempt(t, 'done');
      f.attempt(t);
      f.attempt(t, 'done', { continuedFor: 'capacity' });
      f.attempt(t, 'done', { continuedFor: 'transport' });
      f.attempt(f.task('other'));
      f.attempt(f.task('open', 'running'));
      f.attempt(f.task('cancelled', 'cancelled'));
      const m = (await f.report()).api!;
      expect(m.attempts.run).toMatchObject({ first: 4, stepResume: 1, fixRound: 1, capacityRetry: 1, transportRetry: 1, handoffRetry: 0 });
      expect(m.firstAttemptShare.run).toEqual({ first: 4, attempts: 5, share: 0.8 });
      expect(m.firstAttemptShare.today).toEqual({ first: 3, attempts: 4, share: 0.75 });
      expect(m.attemptsPerLanded).toEqual({ tasks: { row: 5, other: 1 }, median: 3, largest: { task: 'row', attempts: 5 } });
      expect((await f.report()).closed).toBeUndefined();
    } finally { f.cleanup(); }
  });

  test('the repeats line uses first plus fixes, excludes retries and steps, requires ten attempts below half and tells nobody to stop', async () => {
    const f = fixture();
    try {
      const t = f.task('row');
      for (let n = 0; n < 9; n++) f.attempt(t);
      expect((await f.report()).api!.repeatsDominate).toBe(false);
      f.attempt(t);
      const m = (await f.report()).api!;
      expect(m.repeatsDominate).toBe(true);
      expect(measureLines('api', m).at(-1)).toStartWith('REPEATS api:');
      // Holding first attempts can only lower the share it reads, so the line never asks for that.
      expect(measureLines('api', m).at(-1)).toContain('keep dispatching');
      expect(measureLines('api', m).join('\n')).not.toMatch(/stop/i);
      for (let n = 0; n < 8; n++) f.attempt(f.task(`fresh-${n}`));
      expect((await f.report()).api!.firstAttemptShare.today.share).toBe(0.5);
      expect((await f.report()).api!.repeatsDominate).toBe(false);
    } finally { f.cleanup(); }
  });

  test('resumed Codex output totals are counted once per session, including repeated turn counters', async () => {
    const f = fixture();
    try {
      const t = f.task('row');
      const a = f.attempt(t, 'partial', {}, { input_tokens: 100, output_tokens: 10 });
      f.write(a.output, JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 10 } }) + '\n'
        + JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 140, output_tokens: 14 } }) + '\n{unfinished');
      f.attempt(t, 'done', {}, { input_tokens: 250, output_tokens: 25 });
      f.attempt(t, 'done', { session: 'fresh' }, { input_tokens: 50, output_tokens: 5 });
      expect((await f.report()).api!.tokens).toEqual({ input: 300, output: 30, missingSessions: 0, perProvedRow: 'n/a' });
    } finally { f.cleanup(); }
  });

  test('native session growth excludes prior usage, gaps, repeated counters and future tokens across resumes', async () => {
    const f = fixture();
    try {
      const id = '00000000-0000-0000-0000-000000000001', t = f.task('row');
      f.attempt(t, 'partial', { session: '', lastMessage: undefined }, { input_tokens: 9999, output_tokens: 999 });
      f.write(t.attempts[0]!.output, JSON.stringify({ type: 'thread.started', thread_id: id }) + '\n');
      f.attempt(t, 'done', { session: id }, { input_tokens: 9999, output_tokens: 999 });
      const rows = [['00:59', 100], ['01:10', 150], ['01:20', 150], ['01:45', 170], ['02:10', 250], ['13:00', 500]];
      f.write(`codex/sessions/2026/10/13/rollout-${id}.jsonl`, rows.map(([time, n]) => JSON.stringify({
        timestamp: `2026-10-13T${time}:00Z`, type: 'event_msg', payload: { type: 'token_count',
          info: { total_token_usage: { input_tokens: n, output_tokens: Number(n) / 10 } } } })).join('\n'));
      expect((await f.report()).api!.tokens).toEqual({ input: 130, output: 13, missingSessions: 0, perProvedRow: 'n/a' });
    } finally { f.cleanup(); }
  });

  test('Claude result usage includes cache reads and writes; final handoffs classify steps', async () => {
    const f = fixture();
    try {
      const t = f.task('row');
      const a = f.attempt(t, 'done', { engine: 'claude', lastMessage: undefined });
      f.write(a.output, JSON.stringify({ type: 'result', result: 'RESULT: partial\n', usage: {
        input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 5 } }, null, 2));
      f.attempt(t, 'done', { engine: 'claude' });
      const m = (await f.report()).api!;
      expect(m.tokens.input).toBe(122);
      expect(m.tokens.output).toBe(5);
      expect(m.attempts.run.stepResume).toBe(1);
    } finally { f.cleanup(); }
  });

  test('classes retained landing stops and deduplicates a current ledger refusal against its report', async () => {
    const f = fixture();
    try {
      const t = f.task('row', 'conflict'); f.attempt(t);
      for (const [n, text] of ['Outcome test was edited', 'introduced unit failures; not merging:',
        'blocking review findings:\n outcome test fails on the branch', 'scope changed during review'].entries()) {
        f.write(`runs/row/review-${n}-fixture/stop.txt`, text);
      }
      t.refusal = 'introduced unit failures; not merging:';
      expect((await f.report()).api!.landingsRefused).toEqual({ outcomeTest: 1, gate: 1, failingTestFinding: 1, other: 1 });
      t.refusal = 'introduced type errors; not merging:';
      expect((await f.report()).api!.landingsRefused.gate).toBe(2);
      t.refusal = 'type check inconclusive; not merging:';
      expect((await f.report()).api!.landingsRefused.gate).toBe(2);
    } finally { f.cleanup(); }
  });

  test('a refused step landing is a fix round; missing handoffs make inferred fixes explicit', async () => {
    const f = fixture();
    try {
      const t = f.task('row');
      f.attempt(t, 'partial');
      const at = Date.parse('2026-10-13T01:45:00Z');
      f.write(`runs/row/review-${at}-fixture/stop.txt`, 'Unit gate failed');
      f.attempt(t, 'done', { lastMessage: undefined });
      f.attempt(t);
      const m = (await f.report()).api!;
      expect(m.attempts.run.stepResume).toBe(0);
      expect(m.attempts.run.fixRound).toBe(2);
      expect(m.attempts.inferredFixRounds).toBe(1);
      expect(measureLines('api', m)[0]).toContain('1 fixes inferred from unavailable handoffs');
    } finally { f.cleanup(); }
  });

  test('empty Goals and missing worker evidence remain visibly unavailable; printing and JSON use the same measures', async () => {
    const f = fixture();
    try {
      let m = (await f.report()).api!;
      expect(m.firstAttemptShare.run.share).toBeNull();
      expect(m.attemptsPerLanded.median).toBeNull();
      expect(measureLines('api', m)[0]).toContain('first-attempt n/a');
      f.attempt(f.task('row', 'running'));
      const lines: string[] = [];
      m = (await goalMeasures(f.ledger, { root: f.dir, nowMs, codexHomes: [], print: line => lines.push(line) })).api!;
      expect(m.tokens.missingSessions).toBe(1);
      expect(lines).toEqual(measureLines('api', m));
      expect(lines[0]).toContain('1 sessions unavailable');
      expect(lines[0]).toContain('tokens/proved row n/a');
    } finally { f.cleanup(); }
  });
});

for (const result of ['passed', 'assertion', 'timeout', 'environment', 'harness'] as const) {
  test('a recorded ' + result + ' job wake is counted on its UTC day', async () => {
    const f = fixture();
    try {
      const t = f.task('job');
      f.attempt(t, 'parked', { startedAt: '2026-10-12T23:00:00Z' });
      f.attempt(t, 'done', { continuedFor: 'job', jobResult: result });
      const m = (await f.report()).api!;
      expect(m.attempts.run.jobWake[result]).toBe(1);
      expect(m.attempts.today.jobWake[result]).toBe(1);
      expect(m.attempts.run.fixRound).toBe(0);
      expect(m.firstAttemptShare.run.share).toBe(1);
      expect(m.firstAttemptShare.today.share).toBeNull();
      expect(measureLines('api', m)[0]).toContain('1 ' + result);
    } finally { f.cleanup(); }
  });
}

test('legacy job records retain passed results; unknown wakes and fixes remain visible', async () => {
  const f = fixture();
  try {
    const t = f.task('legacy');
    f.attempt(t, 'parked');
    f.attempt(t, 'parked', { continuedFor: 'job' });
    f.attempt(t, 'done', { continuedFor: 'job' });
    f.attempt(t);
    mkdirSync(join(f.dir, '.temp/goal/jobs'), { recursive: true });
    const db = new Database(join(f.dir, '.temp/goal/jobs/jobs.sqlite'));
    db.exec('CREATE TABLE jobs(id TEXT PRIMARY KEY, record TEXT NOT NULL)');
    db.query('INSERT INTO jobs VALUES(?, ?)').run('old', JSON.stringify({ task: t.id, attempt: 1, resumedAttempt: 2, phase: 'woken', code: 0 }));
    db.close();
    const m = (await f.report()).api!;
    expect(m.attempts.run.jobWake).toMatchObject({ passed: 1, unclassified: 1 });
    expect(m.attempts.run.fixRound).toBe(1);
    expect(m.attempts.run.unclassified).toBe(2);
    expect(m.firstAttemptShare.run.share).toBe(0.5);
    expect(measureLines('api', m)[0]).toContain('today:');
    expect(measureLines('api', m)[0]).toContain('2 unclassified');
  } finally { f.cleanup(); }
});

test('explicit baseline-red and environment resumes exclude only those causes', async () => {
  const f = fixture();
  try {
    const t = f.task('resume');
    f.attempt(t);
    f.attempt(t, 'done', { resumeClass: 'baselineRed' });
    f.attempt(t, 'done', { resumeClass: 'environment' });
    f.attempt(t, 'done', { resumeClass: 'fixRound' });
    f.attempt(t, 'done', { resumeClass: 'sameScope' });
    const m = (await f.report()).api!;
    expect(m.attempts.run).toMatchObject({ baselineRed: 1, environment: 1, fixRound: 2, unclassified: 0 });
    expect(m.firstAttemptShare.run.share).toBe(1 / 3);
    expect(measureLines('api', m)[0]).toContain('1 baseline-red, 1 environment');
  } finally { f.cleanup(); }
});
