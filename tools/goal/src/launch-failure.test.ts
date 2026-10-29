import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './merge.ts';
import type { GateOutcome, LandingRequest, ManagerEvent } from './contracts.ts';
import { WorkerJob } from './job.ts';
import { harness, reading } from './test-support.ts';
import { WorkerTasks } from './tasks.ts';

// The CLI fails while loading its configuration: no session starts, nothing is written to stdout, nothing is committed.
const brokenCli = `#!/usr/bin/env bun
console.error('Error loading config.toml: invalid transport in mcp_servers."browser"');
process.exit(1);
`;

test('a launch failure is rerun once without a gate, then goes to the manager', async () => {
  const h = harness(brokenCli),
    inbox: ManagerEvent[] = [],
    landings: LandingRequest[] = [];
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(
      h.tasks,
      { enqueue: (request) => landings.push(request) },
      { deliver: (event) => inbox.push(event) },
    );
    await job.start(task.id);
    await job.drain();
    expect(landings).toEqual([]);
    expect(h.store.task(task.id).currentAttempt).toBe(2);
    for (const attempt of [1, 2]) expect(h.store.attempt({ taskId: task.id, attempt }).failureKind).toBe('tool');
    expect(h.store.record({ taskId: task.id, attempt: 2 })!.escalation).toBe('stalled');
    expect(inbox.map((event) => event.kind)).toEqual(['stalled']);
    expect(inbox[0]!.summary).toContain('invalid transport');
  } finally {
    h.dispose();
  }
});

const committingCli = `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
writeFileSync('result.txt', String(Date.now()));
spawnSync('git', ['add', 'result.txt']); spawnSync('git', ['commit', '-qm', 'result']);
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;

test('the same environment failure twice in a row goes to the manager instead of a third attempt', async () => {
  const h = harness(committingCli),
    inbox: ManagerEvent[] = [];
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver: (event) => inbox.push(event) });
    await job.start(task.id);
    const setup = (attempt: number): GateOutcome => ({
      taskId: task.id,
      attempt,
      passed: false,
      stage: 'setup',
      logPath: 'fixture',
      hostMs: 1,
      changedFiles: ['result.txt'],
      diffLines: 1,
      firstFailure: {
        fingerprint: 'lockfile',
        assertion: 'lockfile had changes',
        excerpt: 'bun install --frozen-lockfile',
      },
    });
    job.onGateOutcome(setup(1));
    await job.drain();
    expect(h.store.task(task.id).currentAttempt).toBe(2);
    expect(inbox).toEqual([]);
    job.onGateOutcome(setup(2));
    await job.drain();
    expect(h.store.task(task.id).currentAttempt).toBe(2);
    expect(h.store.record({ taskId: task.id, attempt: 2 })!.escalation).toBe('stalled');
    expect(inbox.map((event) => event.kind)).toEqual(['stalled']);
  } finally {
    h.dispose();
  }
});

// Cursor refuses an exhausted model before it opens a session, with the reason on stderr only.
const exhaustedCli = `#!/usr/bin/env bun
console.error("ActionRequiredError: You've hit your usage limit Switch to a different model or set a Spend Limit to continue with this model. Your usage limits will reset when your monthly cycle ends on 11/16/2026.");
process.exit(1);
`;

test('a launch refused for an exhausted allowance marks the pool exhausted instead of stalling', async () => {
  const h = harness(exhaustedCli),
    inbox: ManagerEvent[] = [];
  try {
    let reads = 0;
    const tasks = new WorkerTasks(h.settings, h.store, (pool) => reading(pool, ++reads > 1 ? 100 : 0));
    const task = tasks.dispatch(h.briefFile);
    const job = new WorkerJob(tasks, { enqueue() {} }, { deliver: (event) => inbox.push(event) });
    // The harness has one pool, so the rerun that excludes it finds none and rejects.
    await job.start(task.id).catch(() => {});
    await job.drain().catch(() => {});
    expect(h.store.attempt({ taskId: task.id, attempt: 1 }).failureKind).toBe('pool-exhausted');
    const key = h.tasks.settings.pools[0]!.allowanceKey;
    expect(existsSync(join(h.tasks.settings.stateDirectory, 'exhausted', `${key}.json`))).toBe(true);
    expect(inbox.map((event) => event.kind)).not.toContain('stalled');
  } finally {
    h.dispose();
  }
});

// A worker that reports success with part of its work committed and the rest left in the worktree.
const halfCommittingCli = `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
writeFileSync('committed.txt', 'committed');
spawnSync('git', ['add', 'committed.txt']); spawnSync('git', ['commit', '-qm', 'part of the work']);
writeFileSync('left.txt', 'left uncommitted');
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"status":"success","summary":"done"}'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;

test('a successful attempt lands its whole worktree, committing what the worker left uncommitted', async () => {
  const h = harness(halfCommittingCli),
    landings: LandingRequest[] = [];
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(h.tasks, { enqueue: (request) => landings.push(request) }, { deliver() {} });
    await job.start(task.id);
    await job.drain();
    expect(landings).toHaveLength(1);
    const files = git(task.worktree, 'show', '--name-only', '--format=', 'HEAD');
    expect(files).toContain('left.txt');
    expect(git(task.worktree, 'status', '--porcelain')).toBe('');
  } finally {
    h.dispose();
  }
});

// A worker killed mid-work: it opened a session and edited files, but never gave its final answer.
const killedCli = `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
writeFileSync('half.txt', 'half done');
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'}));
process.kill(process.pid, 'SIGKILL');
`;

test('a worker that ends without a success report is not landed and its half-done worktree is not committed', async () => {
  const h = harness(killedCli),
    landings: LandingRequest[] = [];
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(h.tasks, { enqueue: (request) => landings.push(request) }, { deliver() {} });
    await job.start(task.id);
    await job.drain();
    expect(landings).toEqual([]);
    expect(h.store.attempt({ taskId: task.id, attempt: 1 }).failureKind).toBe('tool');
    expect(h.store.attempt({ taskId: task.id, attempt: 1 }).result).toContain('without a success report');
    expect(git(task.worktree, 'log', '--format=%s', '-1')).not.toContain('left uncommitted');
  } finally {
    h.dispose();
  }
});

// The provider refuses a busy model before a session starts; it says nothing about the task.
const capacityCli = `#!/usr/bin/env bun
console.error('Selected model is at capacity. Please try a different model.');
process.exit(1);
`;

test('a model capacity refusal continues the task after a short pause, however often it repeats', async () => {
  const h = harness(capacityCli),
    inbox: ManagerEvent[] = [];
  try {
    const job = await import('./job.ts');
    const task = h.tasks.dispatch(h.briefFile);
    const worker = new job.WorkerJob(h.tasks, { enqueue() {} }, { deliver: (event) => inbox.push(event) });
    await worker.start(task.id);
    await new Promise((resolve) => setTimeout(resolve, job.CAPACITY_PAUSE_MS * 2 + 3_000));
    expect(h.store.task(task.id).currentAttempt).toBeGreaterThanOrEqual(3);
    expect(h.store.task(task.id).state).not.toBe('stopped');
    expect(inbox.filter((event) => event.kind === 'stalled')).toEqual([]);
    await h.tasks.stop?.(task.id).catch?.(() => {});
  } finally {
    h.dispose();
  }
}, 60_000);

// The CLI hangs before starting a session: it writes nothing and never exits on its own.
const hangingCli = `#!/usr/bin/env bun
await new Promise(resolve => setTimeout(resolve, 600_000));
`;

test('a worker that writes nothing within the start window is stopped and retried, then goes to the manager', async () => {
  const h = harness(hangingCli),
    inbox: ManagerEvent[] = [];
  h.settings.startGraceMs = 1000;
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver: (event) => inbox.push(event) });
    await job.start(task.id);
    await job.drain();
    expect(h.store.task(task.id).currentAttempt).toBe(2);
    for (const attempt of [1, 2]) expect(h.store.attempt({ taskId: task.id, attempt }).failureKind).toBe('tool');
    expect(inbox.map((event) => event.kind)).toEqual(['stalled']);
  } finally {
    h.dispose();
  }
}, 60_000);

const silentAfterCommitCli = `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const commit = () => spawnSync('git', ['add', 'result.txt']) && spawnSync('git', ['commit', '-qm', 'worker progress']);
if (process.env.GOAL_ATTEMPT === '1') {
  writeFileSync('result.txt', 'committed by the first attempt');
  commit();
  console.log(JSON.stringify({type:'thread.started',thread_id:'silent-worker'}));
  await new Promise(resolve => setTimeout(resolve, 600_000));
} else {
  if (readFileSync('result.txt', 'utf8') !== 'committed by the first attempt') process.exit(12);
  writeFileSync('result.txt', 'continued by the replacement attempt');
  commit();
  console.log(JSON.stringify({type:'thread.started',thread_id:'replacement-worker'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
}
`;

test('a running worker whose log is silent is stopped and retried from its commits', async () => {
  const h = harness(silentAfterCommitCli),
    landings: LandingRequest[] = [];
  h.settings.silenceMs = 1000;
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(h.tasks, { enqueue: (request) => landings.push(request) }, { deliver() {} });
    await job.start(task.id);
    await job.drain();
    const first = h.store.attempt({ taskId: task.id, attempt: 1 });
    expect(first.failureKind).toBe('tool');
    expect(first.result).toBe('stalled: no output for 1 minute');
    expect(h.store.task(task.id).currentAttempt).toBe(2);
    expect(git(task.worktree, 'rev-list', '--count', `${task.base}..HEAD`)).toBe('2');
    expect(landings).toHaveLength(1);
  } finally {
    h.dispose();
  }
}, 15_000);

const activeWriterCli = `#!/usr/bin/env bun
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
console.log(JSON.stringify({type:'thread.started',thread_id:'active-writer'}));
for (let i = 0; i < 10; i++) {
  console.log(JSON.stringify({type:'item.completed',item:{id:'heartbeat-' + i,type:'reasoning',text:'working'}}));
  await delay(100);
}
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;

test('a worker that keeps writing is never stopped by the silence window', async () => {
  const h = harness(activeWriterCli),
    landings: LandingRequest[] = [],
    inbox: ManagerEvent[] = [];
  h.settings.silenceMs = 300;
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(
      h.tasks,
      { enqueue: (request) => landings.push(request) },
      { deliver: (event) => inbox.push(event) },
    );
    await job.start(task.id);
    await job.drain();
    expect(h.store.task(task.id).currentAttempt).toBe(1);
    expect(h.store.attempt({ taskId: task.id, attempt: 1 }).failureKind).toBeNull();
    expect(landings).toHaveLength(1);
    expect(inbox.filter((event) => event.kind === 'stalled')).toEqual([]);
  } finally {
    h.dispose();
  }
}, 15_000);

const checkWaitCli = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
console.log(JSON.stringify({type:'thread.started',thread_id:'check-wait-worker'}));
for (let i = 0; i < 9; i++) {
  appendFileSync(process.env.GOAL_CHECK_WAIT_FILE, '100\\n');
  await delay(100);
}
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;

test('time recorded waiting for a check slot counts as run activity', async () => {
  const h = harness(checkWaitCli),
    landings: LandingRequest[] = [],
    inbox: ManagerEvent[] = [];
  h.settings.silenceMs = 300;
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(
      h.tasks,
      { enqueue: (request) => landings.push(request) },
      { deliver: (event) => inbox.push(event) },
    );
    await job.start(task.id);
    await job.drain();
    expect(h.store.task(task.id).currentAttempt).toBe(1);
    expect(h.store.attempt({ taskId: task.id, attempt: 1 }).failureKind).toBeNull();
    expect(landings).toHaveLength(1);
    expect(inbox.filter((event) => event.kind === 'stalled')).toEqual([]);
  } finally {
    h.dispose();
  }
}, 15_000);

const repeatedlySilentCli = `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if (process.env.GOAL_ATTEMPT === '1') {
  writeFileSync('result.txt', 'committed before the stall');
  spawnSync('git', ['add', 'result.txt']);
  spawnSync('git', ['commit', '-qm', 'worker progress']);
}
console.log(JSON.stringify({type:'thread.started',thread_id:'silent-worker'}));
await new Promise(resolve => setTimeout(resolve, 600_000));
`;

test('a repeated silence failure reports the stalled output window to the manager', async () => {
  const h = harness(repeatedlySilentCli),
    inbox: ManagerEvent[] = [];
  h.settings.silenceMs = 800;
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver: (event) => inbox.push(event) });
    await job.start(task.id);
    await job.drain();
    expect(h.store.task(task.id).currentAttempt).toBe(2);
    expect(h.store.task(task.id).state).toBe('stopped');
    expect(inbox.filter((event) => event.kind === 'stalled').map((event) => event.summary)).toEqual([
      'stalled: no output for 1 minute',
    ]);
  } finally {
    h.dispose();
  }
}, 15_000);

test('the host starts a ready task whose dispatching process is gone, once', async () => {
  const h = harness(),
    inbox: ManagerEvent[] = [];
  // A start window long enough for the fixture worker to write, even on a loaded host.
  h.settings.startGraceMs = 5_000;
  try {
    // Dispatched, but the command that would start it ended before it could: created well before the window.
    const task = h.tasks.dispatch(h.briefFile);
    h.store.updateTask({ taskId: task.id, attempt: 0 }, (current) => {
      current.createdAt = new Date(Date.now() - 60_000).toISOString();
    });
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver: (event) => inbox.push(event) });
    await job.recoverOrphans({ adoptRunning: true });
    await job.drain();
    expect(h.store.task(task.id).currentAttempt).toBe(1);
    // A late start from the original dispatch is a no-op, not a second attempt.
    await job.start(task.id, { expectedAttempt: 0 });
    await job.drain();
    expect(h.store.task(task.id).currentAttempt).toBe(1);
  } finally {
    h.dispose();
  }
}, 60_000);

test('check host transport failures are recognized as capacity, ordinary tool failures are not', async () => {
  const { CHECK_HOST_TRANSPORT } = await import('./records.ts');
  for (const detail of [
    'Connection closed by 159.195.212.125 port 22',
    'RemoteTransportError: host a',
    'kex_exchange_identification: read: Connection reset by peer',
    'acceptance exited 255 after SSH to check host a timed out',
    'rsync error: unexplained error (code 255)',
  ])
    expect(CHECK_HOST_TRANSPORT.test(detail)).toBe(true);
  for (const detail of ['Error loading config.toml: invalid transport', 'test failed: expected 3 received 2'])
    expect(CHECK_HOST_TRANSPORT.test(detail)).toBe(false);
});

test('failed check-host Bun downloads are transport failures without hiding task failures', async () => {
  const { CHECK_HOST_TRANSPORT } = await import('./records.ts');
  for (const detail of [
    'curl: (56) OpenSSL SSL_read: unexpected eof while reading',
    'curl: (35) TLS connect error',
    'curl: (6) Could not resolve host',
    'curl: (7) Failed to connect',
    'curl: (18) transfer closed with outstanding read data',
    'curl: (28) Operation timed out',
    'curl: (52) Empty reply from server',
    'gzip: stdin: unexpected end of file',
    'tar: Unexpected EOF in archive',
    'remote-check: downloaded Bun does not match packageManager 1.4.4-canary.20261027.1',
  ])
    expect(CHECK_HOST_TRANSPORT.test(detail)).toBe(true);

  expect(
    CHECK_HOST_TRANSPORT.test('mux_client_request_session: session request failed: Session open refused by peer'),
  ).toBe(false);
  expect(CHECK_HOST_TRANSPORT.test('test failed: expected curl to return a URL')).toBe(false);
  expect(CHECK_HOST_TRANSPORT.test('Build output contains curl: (56) but the test assertion failed')).toBe(false);
});
