import { expect, test } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isTransportFailure,
  TRANSPORT_FAILURE_EVENT,
  TRANSPORT_RETRY_BACKOFF_MS,
  TRANSPORT_RETRY_LIMIT,
  transportFailureLine,
  transportRetryBackoffMs,
} from './agents/shared.ts';
import { blockerFingerprint } from './attempt-progress.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { WorkerJob } from './job.ts';
import { defaultPolicy } from './policy.ts';
import { settle } from './settle.ts';
import { harness } from './test-support.ts';
import {
  lastTransportFailure,
  listOpenToolIncidents,
  recordTransportFailure,
  resolveToolIncidentsAfterAttempt,
  transportIncidentResumeAllowed,
} from './tool-incidents.ts';
import type { Attempt } from './types.ts';
import { workerCheckBudgetDirectory } from './worker-check-budget.ts';

const TLS = 'Error: [aborted] Client network socket disconnected before secure TLS connection was established';
const CONNECTION_LOST = 'Connection lost, reconnecting to https://agentn.global.api5.cursor.sh';
const RESUME_STOPPED = 'Agent turn stopped after repeated resume attempts made no progress';
const CONNECTION_FAILED = 'Connection failed repeatedly';
const STREAM = 'stream disconnected before the turn finished';
const WEBSOCKET = 'failed to connect to Responses WebSocket';
const OTHER = "unexpected argument '-C'";

const tlsCli = `#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const directory = join(process.cwd(), '.temp/goal');
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, 'cli-argv.json'), JSON.stringify(process.argv));
if (process.argv.includes('resume')) {
  console.log(JSON.stringify({type:'thread.started',thread_id:'wake-session'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:4,output_tokens:1}}));
} else {
  console.log(JSON.stringify({type:'thread.started',thread_id:'wake-session'}));
  console.error(${JSON.stringify(TLS)});
  process.exit(1);
}
`;

test('transport classification uses stderr, not exit code', () => {
  expect(isTransportFailure(TLS, 0)).toBe(true);
  expect(isTransportFailure(`${CONNECTION_LOST}\nretrying\n${RESUME_STOPPED}`, 0)).toBe(true);
  expect(isTransportFailure(`${CONNECTION_LOST}\n${CONNECTION_FAILED}`, 0)).toBe(true);
  expect(isTransportFailure(STREAM, 0)).toBe(true);
  expect(isTransportFailure(`${WEBSOCKET}\n${WEBSOCKET}`, 1)).toBe(true);
  expect(isTransportFailure(WEBSOCKET, 1)).toBe(false);
  expect(isTransportFailure(`${WEBSOCKET}\n${WEBSOCKET}`, 0)).toBe(false);
  expect(isTransportFailure(CONNECTION_LOST, 1)).toBe(false);
  expect(isTransportFailure(OTHER, 1)).toBe(false);
  expect(transportFailureLine(`${CONNECTION_LOST}\n${RESUME_STOPPED}`)).toBe(RESUME_STOPPED);
  expect(TRANSPORT_RETRY_BACKOFF_MS).toEqual([60_000, 120_000, 240_000]);
  expect(TRANSPORT_RETRY_LIMIT).toBe(6);
  expect([1, 2, 3, 6].map((count) => transportRetryBackoffMs(count))).toEqual([60_000, 120_000, 240_000, 240_000]);
});

function settleHarness(script?: string) {
  const h = script === undefined ? harness() : harness(script);
  const policy = structuredClone(h.settings.policy ?? defaultPolicy);
  policy.containers.commandTimeoutMs = 50;
  h.settings.policy = policy;
  return h;
}

function runningAttempt(h: ReturnType<typeof harness>, stderr: string, logEvents: unknown[] = []): Attempt {
  const task = h.tasks.dispatch(h.briefFile);
  const startedAt = new Date().toISOString();
  const attempt = h.store.nextAttempt({ taskId: task.id, attempt: 0 }, (number): Attempt => ({
    taskId: task.id,
    attempt: number,
    state: 'pending',
    profile: { cli: 'codex', model: 'gpt-6-luna', effort: 'high', poolClass: 'codex' },
    pool: 'fixture',
    tableVersion: 'fixture',
    experiment: null,
    startedAt,
    endedAt: null,
    process: null,
    driver: null,
    logPath: join(h.settings.stateDirectory, 'runs', task.id, `${number}.jsonl`),
    evidencePath: join(h.settings.stateDirectory, 'evidence', task.id, String(number)),
    auxiliaryProcesses: [],
    session: null,
    fixRound: 0,
    consulted: false,
    previousFailure: null,
    failure: null,
    escalation: null,
    before: null,
    after: null,
    exitCode: null,
    result: '',
    blocker: null,
    approaches: [],
  }));
  mkdirSync(join(attempt.logPath, '..'), { recursive: true });
  const events = logEvents.length ? logEvents : [{ type: 'thread.started', thread_id: 'wake-session' }];
  writeFileSync(attempt.logPath, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  if (stderr) writeFileSync(`${attempt.logPath}.err`, `${stderr}\n`);
  h.store.updateAttempt(attempt, (current) => {
    current.state = 'running';
    current.session = 'wake-session';
  });
  h.store.updateTask(attempt, (current) => {
    current.state = 'running';
  });
  return h.store.attempt(attempt);
}

test('an empty or unparsed result records the last stderr line after the worker-ended prefix', async () => {
  const h = settleHarness();
  try {
    const first = runningAttempt(h, `noise\n${OTHER}`);
    await settle(h.tasks, { attempt: first, exited: Promise.resolve({ code: 1, signal: null }) }, { enqueue() {} });
    expect(h.store.attempt(first).result).toBe(`Worker ended without a success report (exit 1): ${OTHER}`);
    expect(h.store.attempt(first).failureKind).toBe('tool');
    expect(h.store.attempt(first).state).toBe('exited');
    expect(h.store.task(first.taskId).currentAttempt).toBe(1);

    const empty = runningAttempt(h, '');
    await settle(h.tasks, { attempt: empty, exited: Promise.resolve({ code: 1, signal: null }) }, { enqueue() {} });
    expect(h.store.attempt(empty).result).toBe('Worker ended without a success report (exit 1): ');
    expect(blockerFingerprint(h.store.attempt(empty))).toBe('');
  } finally {
    h.dispose();
  }
}, 15_000);

test('a transport drop stays on the same attempt and does not spend the check budget', async () => {
  const h = settleHarness();
  try {
    const attempt = runningAttempt(h, TLS);
    const budget = workerCheckBudgetDirectory(h.settings.stateDirectory, attempt.taskId, attempt.attempt);
    mkdirSync(budget, { recursive: true });
    writeFileSync(join(budget, '1'), '');
    writeFileSync(join(budget, '2'), '');
    await settle(h.tasks, { attempt, exited: Promise.resolve({ code: 1, signal: null }) }, { enqueue() {} });
    const settled = h.store.attempt(attempt);
    const failure = lastTransportFailure(h.store, attempt)!;
    expect(settled.state).toBe('waiting');
    expect(settled.failureKind).toBeNull();
    expect(settled.session).toBe('wake-session');
    expect(settled.result).toBe(TLS);
    expect(h.store.task(attempt.taskId).currentAttempt).toBe(1);
    expect(failure).toMatchObject({ count: 1, line: TLS, delayMs: 60_000 });
    expect(
      h.store.events(attempt.taskId, attempt.attempt).filter((event) => event.kind === TRANSPORT_FAILURE_EVENT),
    ).toHaveLength(1);
    expect(readdirSync(budget).sort()).toEqual(['1', '2']);
  } finally {
    h.dispose();
  }
}, 15_000);

test('Cursor reconnect-stop and Codex stream or repeated WebSocket drops resume the same way', async () => {
  const h = settleHarness();
  try {
    for (const [stderr, code] of [
      [`${CONNECTION_LOST}\n${RESUME_STOPPED}`, 1],
      [STREAM, 1],
      [`${WEBSOCKET}\nretry\n${WEBSOCKET}`, 2],
    ] as const) {
      const attempt = runningAttempt(h, stderr);
      await settle(h.tasks, { attempt, exited: Promise.resolve({ code, signal: null }) }, { enqueue() {} });
      expect(h.store.attempt(attempt)).toMatchObject({
        state: 'waiting',
        failureKind: null,
        result: transportFailureLine(stderr),
      });
      expect(h.store.task(attempt.taskId).currentAttempt).toBe(1);
    }
  } finally {
    h.dispose();
  }
}, 20_000);

test('a seventh consecutive transport drop on the attempt becomes a tool failure with the transport line', async () => {
  const h = settleHarness();
  try {
    const attempt = runningAttempt(h, TLS);
    await settle(h.tasks, { attempt, exited: Promise.resolve({ code: 1, signal: null }) }, { enqueue() {} });
    for (let count = 2; count <= TRANSPORT_RETRY_LIMIT; count++)
      h.store.event(attempt, TRANSPORT_FAILURE_EVENT, {
        count,
        line: TLS,
        delayMs: 240_000,
        nextResumeAt: new Date().toISOString(),
      });
    expect(h.store.attempt(attempt).state).toBe('waiting');
    expect(lastTransportFailure(h.store, attempt)?.count).toBe(6);
    await settle(h.tasks, { attempt, exited: Promise.resolve({ code: 1, signal: null }) }, { enqueue() {} });
    const settled = h.store.attempt(attempt);
    expect(settled.state).toBe('exited');
    expect(settled.failureKind).toBe('tool');
    expect(settled.result).toContain(TLS);
    expect(settled.blocker).toBe(TLS);
    expect(h.store.task(attempt.taskId).currentAttempt).toBe(1);
  } finally {
    h.dispose();
  }
}, 15_000);

test('transport failures open one environment incident on the transport line and release every held task at once', async () => {
  const h = settleHarness();
  const now = Date.now();
  try {
    const inbox = new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory);
    const attempts = [TLS, TLS, TLS].map((line) => runningAttempt(h, line));
    const refs = [];
    for (const attempt of attempts) {
      await settle(h.tasks, { attempt, exited: Promise.resolve({ code: 1, signal: null }) }, { enqueue() {} });
      const settled = h.store.attempt(attempt);
      const recorded = recordTransportFailure(
        h.store,
        h.store.task(attempt.taskId),
        settled,
        h.settings,
        inbox,
        TLS,
        now,
      );
      refs.push({ taskId: attempt.taskId, attempt: attempt.attempt, opened: recorded.opened });
    }
    expect(refs.map((ref) => ref.opened)).toEqual([false, false, true]);
    const incident = listOpenToolIncidents(h.store)[0]!;
    expect(incident.fingerprint).toBe(blockerFingerprint({ blocker: TLS, result: '' }));
    expect(incident.errorLine).toBe(TLS);
    expect(incident.line).not.toContain('worker ended without a success report');
    const probe = refs.find((ref) => ref.opened)!;
    const held = refs.filter((ref) => ref.taskId !== probe.taskId);
    expect(transportIncidentResumeAllowed(h.store, probe, now)).toBe(true);
    expect(held.map((ref) => transportIncidentResumeAllowed(h.store, ref, now))).toEqual([false, false]);
    const later = h.store.updateAttempt(probe, (current) => {
      current.state = 'exited';
      current.failureKind = null;
      current.result = 'RESULT: success';
      current.blocker = null;
    });
    expect(resolveToolIncidentsAfterAttempt(h.store, probe, h.store.task(probe.taskId), later)).toEqual([incident]);
    expect(listOpenToolIncidents(h.store)).toEqual([]);
    expect(held.map((ref) => transportIncidentResumeAllowed(h.store, ref, now))).toEqual([true, true]);
  } finally {
    h.dispose();
  }
}, 20_000);

test('a transport drop resumes the existing session after backoff', async () => {
  const h = settleHarness(tlsCli);
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.start(task.id);
    await job.drain();
    const ref = { taskId: task.id, attempt: 1 };
    expect(h.store.attempt(ref)).toMatchObject({
      state: 'waiting',
      session: 'wake-session',
      result: TLS,
      failureKind: null,
    });
    expect(h.store.task(task.id).currentAttempt).toBe(1);
    await job.recoverOrphans();
    await job.drain();
    expect(h.store.attempt(ref).state).toBe('exited');
    expect(h.store.attempt(ref).result).toContain('RESULT: success');
    expect(h.store.attempt(ref).failureKind).toBeNull();
    expect(h.store.task(task.id).currentAttempt).toBe(1);
    const argv = JSON.parse(
      readFileSync(join(h.store.task(task.id).worktree, '.temp/goal/cli-argv.json'), 'utf8'),
    ) as string[];
    expect(argv).toContain('resume');
    expect(argv).toContain('wake-session');
  } finally {
    await h.disposeAsync();
  }
}, 30_000);
