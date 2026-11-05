import { expect, test } from 'bun:test';
import { parseProofMetadata } from './verification.ts';
import { classifyHistoricalProof, type HistoricalProofReader } from './verification.ts';
import { processIdentity } from './process.ts';
import { hostname } from 'node:os';

const metadata = () => ({
  journey: 'Publication journey',
  sourceTasks: ['original-publication'],
  sourceCommit: 'a'.repeat(40),
});

test('proof metadata retains the exact captured identity without sharing mutable source refs', () => {
  const input = metadata();
  const proof = parseProofMetadata(input);
  expect(proof).toEqual(input);
  input.sourceTasks.push('later-source');
  expect(proof.sourceTasks).toEqual(['original-publication']);
});

test('proof metadata rejects priority and execution authorization fields', () => {
  for (const extra of [{ criticalPath: true }, { authorized: true }, { command: ['bun', 'test'] }])
    expect(() => parseProofMetadata({ ...metadata(), ...extra })).toThrow('proof supports only');
});

test('proof metadata requires explicit originals and a captured commit instead of a moving ref', () => {
  for (const input of [
    null,
    [],
    { ...metadata(), journey: '' },
    { ...metadata(), sourceTasks: [] },
    { ...metadata(), sourceTasks: ['original', 'original'] },
    { ...metadata(), sourceTasks: [null] },
    { ...metadata(), sourceCommit: 'dev' },
    { ...metadata(), sourceCommit: 'abc123' },
  ])
    expect(() => parseProofMetadata(input)).toThrow();
});

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { harness, brief } from './test-support.ts';
import { git } from './tasks.ts';
import {
  authorizeProof,
  newProofBinding,
  observeProof,
  originalCommandMatches,
  preflightProof,
  unavailableProofProducer,
  type ProofBinding,
} from './verification.ts';
import { settle } from './settle.ts';
import { makeRecord, readMeasurement } from './records.ts';
import type { Attempt } from './types.ts';

function attempt(taskId: string, n: number, directory: string): Attempt {
  return {
    taskId,
    attempt: n,
    state: 'running',
    profile: { cli: 'codex', model: 'gpt-6.1-sol', effort: 'high', poolClass: 'default' },
    pool: 'fixture',
    tableVersion: 'fixture',
    experiment: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    process: null,
    driver: null,
    logPath: join(directory, `${taskId}-${n}.jsonl`),
    evidencePath: join(directory, 'evidence', taskId),
    auxiliaryProcesses: [],
    session: 'fixture-session',
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
  };
}
function registeredFixture(withoutDependencies = false) {
  const h = harness();
  // Lifecycle-only cases have no dependency manifest, installer or provider to execute.
  if (withoutDependencies) rmSync(join(h.root, 'package.json'));
  // These are the current delivered reader exports and record layout, without launching any native check.
  writeFileSync(
    join(h.root, 'scripts/worker-check.ts'),
    `import {readFileSync} from 'node:fs';
import {join} from 'node:path';
export function readWorkerCheckRecord(id, cwd) { return JSON.parse(readFileSync(join(cwd,'.temp/goal/checks/results',id+'.json'),'utf8')); }
export function readWorkerCheckHistory(id, physical, cwd) { return JSON.parse(readFileSync(join(cwd,'.temp/goal/checks/history',id,physical+'.json'),'utf8')); }
`,
  );
  git(h.root, ['add', 'scripts/worker-check.ts', 'package.json']);
  git(h.root, ['commit', '-m', 'Fixture managed check reader']);
  const commit = git(h.root, ['rev-parse', 'HEAD']);
  git(h.root, ['branch', 'dev', commit]);
  h.store.db.exec('CREATE TABLE manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  const actor = { id: 'fixture', sessionId: 'owner-session' };
  h.store.db
    .query('INSERT INTO manager_sessions VALUES (?,?)')
    .run(actor.id, JSON.stringify({ status: 'running', threadId: actor.sessionId }));
  const sourceBrief = brief();
  sourceBrief.acceptance.command = ['bun', 'test', 'fixture.test.ts'];
  const source = h.store.createTask(
    sourceBrief,
    { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: commit },
    'implementation',
  );
  h.store.updateTask({ taskId: source.id, attempt: 0 }, (task) => {
    task.state = 'integrated';
    task.integratedCommit = commit;
  });
  const proofBrief = {
    ...sourceBrief,
    kind: 'verification' as const,
    paths: [],
    proof: { journey: 'Original journey', sourceTasks: [source.id], sourceCommit: commit },
  };
  const authorization = authorizeProof(h.store, h.root, proofBrief, actor, 'operations', 'dev');
  const proof = h.store.createTask(
    proofBrief,
    { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: commit },
    'implementation',
  );
  h.store.updateTask({ taskId: proof.id, attempt: 0 }, (task) => {
    task.proofAuthorization = authorization;
  });
  const current = h.store.nextAttempt({ taskId: proof.id, attempt: 0 }, (n) =>
    attempt(proof.id, n, h.settings.stateDirectory),
  );
  const binding = newProofBinding(h.store.task(proof.id), current.attempt);
  h.store.reserveProof(binding);
  h.store.bindProof(binding, { status: 'bound', binding });
  return { ...h, source, proof, proofBrief, actor, binding, current };
}
function records(binding: ProofBinding, exitCode = 0) {
  const physicalRunId = '22222222-2222-4222-8222-222222222222';
  const ownership = { taskId: binding.taskId, attempt: binding.attempt };
  const record = {
    custodyVersion: 1,
    id: binding.checkId,
    cwd: binding.cwd,
    argv: binding.argv,
    ownership,
    status: 'finished',
    physicalRunId,
    exitCode,
    log: '.temp/original.log',
  };
  const physical = {
    version: 1,
    id: binding.checkId,
    cwd: binding.cwd,
    argv: binding.argv,
    ownership,
    physicalRunId,
    status: 'finished',
    remoteExpected: false,
    exitCode,
    terminalProof: { local: true, remote: null, resultKnown: true, observedAt: new Date().toISOString() },
  };
  return { record, physical };
}

test('original proof registration retains whole command provenance and rejects shortened or mixed-prefix unions', () => {
  const a = ['env', 'CI=1', 'bun', 'test', 'a.test.ts'];
  const b = ['env', 'CI=1', 'bun', 'test', 'b.test.ts'];
  expect(originalCommandMatches([...a, 'b.test.ts'], [a, b])).toBe(true);
  expect(originalCommandMatches(a, [a, b])).toBe(false);
  expect(originalCommandMatches([...a, 'b.test.ts'], [a, ['bun', 'test', 'b.test.ts']])).toBe(false);
  expect(originalCommandMatches(['bun', 'test'], [a, b])).toBe(false);
});

test('proof authorization rejects missing identity, foreign Goals, unintegrated sources and non-containing commits', () => {
  const h = registeredFixture();
  try {
    expect(() => authorizeProof(h.store, h.root, h.proofBrief, null, 'operations', 'dev')).toThrow('authenticated');
    expect(() =>
      authorizeProof(h.store, h.root, { ...h.proofBrief, goal: 'other' }, h.actor, 'operations', 'dev'),
    ).toThrow('same-Goal');
    h.store.updateTask({ taskId: h.source.id, attempt: 0 }, (task) => {
      task.state = 'ready';
    });
    expect(() => authorizeProof(h.store, h.root, h.proofBrief, h.actor, 'operations', 'dev')).toThrow('integrated');
  } finally {
    h.dispose();
  }
});

test('missing original files are unavailable before execution and production binding stays explicitly unsupported', () => {
  const h = registeredFixture();
  try {
    const next = {
      ...h.proofBrief,
      acceptance: { ...h.proofBrief.acceptance, command: ['bun', 'test', 'missing.test.ts'] },
    };
    expect(preflightProof(h.root, next)).toEqual(['missing.test.ts']);
    expect(preflightProof(h.root, h.proofBrief)).toEqual([]);
    expect(unavailableProofProducer.bind(h.binding).status).toBe('unavailable');
  } finally {
    h.dispose();
  }
});

test('read-only proof succeeds from owned managed terminal UUID evidence without source commit or landing', async () => {
  const h = registeredFixture();
  try {
    const { record, physical } = records(h.binding);
    const directory = join(h.root, '.temp/goal/checks');
    mkdirSync(join(directory, 'results'), { recursive: true });
    mkdirSync(join(directory, 'history', h.binding.checkId), { recursive: true });
    writeFileSync(join(directory, 'results', `${h.binding.checkId}.json`), JSON.stringify(record));
    writeFileSync(
      join(directory, 'history', h.binding.checkId, `${record.physicalRunId}.json`),
      JSON.stringify(physical),
    );
    writeFileSync(
      h.current.logPath,
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: JSON.stringify({
            status: 'success',
            summary: 'original passed',
            blocker: null,
            checks: [],
            approaches: [],
          }),
        },
      }) + '\n',
    );
    const before = git(h.root, ['rev-parse', 'HEAD']);
    await settle(
      h.tasks,
      { attempt: h.current, exited: Promise.resolve({ code: 0, signal: null }) },
      {
        enqueue: () => {
          throw new Error('proof must never land');
        },
      },
    );
    expect(h.store.task(h.proof.id).state).toBe('verified');
    expect(h.store.task(h.source.id).state).toBe('integrated');
    expect(h.store.record(h.current)?.outcome).toBe('verified');
    expect(h.store.record(h.current)?.proof?.record).toEqual(record);
    expect(h.store.proofReservation(h.proof.id, 1)?.status).toBe('released');
    expect(h.tasks.completionScope('fixture')).toEqual([h.source.id]);
    expect(git(h.root, ['rev-parse', 'HEAD'])).toBe(before);
    expect(h.store.task(h.proof.id).mergedCommit).toBeUndefined();
    expect(() =>
      h.store.landing(
        { ...h.current, branch: 'main', worktree: h.root, declaredPaths: [], gate: h.binding.argv },
        () => {
          throw new Error('proof must never enqueue');
        },
      ),
    ).toThrow('cannot enter source landing');
    expect(() => h.store.nextAttempt(h.current, (n) => attempt(h.proof.id, n, h.settings.stateDirectory))).toThrow(
      'cannot retry verified',
    );
    await new WorkerJob(
      h.tasks,
      {
        enqueue: () => {
          throw new Error('proof must never land');
        },
      },
      { deliver: () => {} },
    ).recover(h.proof.id);
    expect(h.store.task(h.proof.id).state).toBe('verified');
  } finally {
    h.dispose();
  }
});

test('managed failures and unknown custody remain non-green and preserve every physical rerun', () => {
  const h = registeredFixture();
  try {
    const { record, physical } = records(h.binding, 1);
    expect(observeProof(h.binding, { record: () => record, history: () => physical }).passed).toBe(false);
    expect(
      observeProof(h.binding, { record: () => ({ ...record, exitCode: 0 }), history: () => undefined }).status,
    ).toBe('unknown');
    const predecessor = '33333333-3333-4333-8333-333333333333';
    const reader = {
      record: () => ({ ...record, exitCode: 0, reruns: 1, waitForPhysicalRunId: predecessor }),
      history: (_id: string, id: string) => ({
        ...physical,
        physicalRunId: id,
        exitCode: id === record.physicalRunId ? 0 : 1,
      }),
    };
    const observation = observeProof(h.binding, reader);
    expect(observation.status).toBe('terminal');
    expect(observation.physical).toHaveLength(2);
    const foreign = { ...record, ownership: { taskId: 'foreign', attempt: 1 } };
    expect(observeProof(h.binding, { ...reader, record: () => foreign }).status).toBe('unknown');
  } finally {
    h.dispose();
  }
});

import { openDb } from './db.ts';
import { WorkerStore } from './store.ts';
import { proofFingerprint, proofSourceUnchanged } from './verification.ts';

test('ordinary SQLite admission caps current runs at three across controllers, preparation, waits and crashes without native binding', () => {
  const h = registeredFixture();
  const db = openDb(join(h.settings.stateDirectory, 'goal.sqlite'));
  try {
    const second = new WorkerStore(db);
    const add = () => {
      const task = h.store.createTask(
        h.proofBrief,
        { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit },
        'implementation',
      );
      h.store.updateTask({ taskId: task.id, attempt: 0 }, (current) => {
        current.proofAuthorization = h.store.task(h.proof.id).proofAuthorization!;
      });
      return { taskId: task.id, attempt: 0 };
    };
    const two = add(),
      three = add(),
      queued = add();
    const make = (ref: typeof two) => (n: number) => ({
      ...attempt(ref.taskId, n, h.settings.stateDirectory),
      state: 'pending' as const,
    });
    const nextTwo = second.nextAttempt(two, make(two), undefined, true);
    const nextThree = h.store.nextAttempt(three, make(three), undefined, true);
    h.store.updateAttempt(nextTwo, (current) => {
      current.state = 'waiting';
      current.checks = [crypto.randomUUID()];
    });
    expect(() => second.nextAttempt(queued, make(queued), undefined, true)).toThrow('three current ordinary checks');
    expect(second.task(queued.taskId).currentAttempt).toBe(0);
    expect(second.proofReservation(nextTwo.taskId, nextTwo.attempt)).toBeUndefined();
    expect(new WorkerStore(db).proofCapacityAvailable('fixture', queued.taskId)).toBe(false);
    // Unknown current optional evidence still counts while its attempt is running/waiting.
    // The initial fixture retains a bound native identity, independent of the ordinary runs.
    expect(h.store.proofReservation(h.proof.id, 1)?.binding).toEqual(h.binding);
    h.store.close(nextTwo, 'stopped');
    expect(second.proofCapacityAvailable('fixture', queued.taskId)).toBe(true);
    const next = second.nextAttempt(queued, make(queued), undefined, true);
    expect(next.attempt).toBe(1);
    expect(second.proofReservation(next.taskId, 1)).toBeUndefined();
    expect(second.attempt(nextThree).state).toBe('pending');
    expect(second.proofCapacityAvailable('fixture', 'another')).toBe(false);
  } finally {
    db.close();
    h.dispose();
  }
});
import { WorkerJob } from './job.ts';
import type { ManagerEvent } from './contracts.ts';

test('proof failures stay non-green and route exact native evidence to the original owner without a model fix', async () => {
  const h = registeredFixture();
  try {
    const { record, physical } = records(h.binding, 1);
    const directory = join(h.root, '.temp/goal/checks');
    mkdirSync(join(directory, 'results'), { recursive: true });
    mkdirSync(join(directory, 'history', h.binding.checkId), { recursive: true });
    writeFileSync(
      join(directory, 'results', `${h.binding.checkId}.json`),
      JSON.stringify({ ...record, failureSummary: 'expected navigation assertion' }),
    );
    writeFileSync(
      join(directory, 'history', h.binding.checkId, `${record.physicalRunId}.json`),
      JSON.stringify(physical),
    );
    writeFileSync(
      h.current.logPath,
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: JSON.stringify({
            status: 'success',
            summary: 'provider exit is not native proof',
            blocker: null,
            checks: [],
            approaches: [],
          }),
        },
      }) + '\n',
    );
    const events: ManagerEvent[] = [];
    const landing = {
      enqueue: () => {
        throw new Error('failed proof cannot land');
      },
    };
    await settle(h.tasks, { attempt: h.current, exited: Promise.resolve({ code: 0, signal: null }) }, landing);
    new WorkerJob(h.tasks, landing, { deliver: (event) => events.push(event) }).onAttemptExit(h.current);
    expect(h.store.task(h.proof.id).state).toBe('stopped');
    expect(h.store.record(h.current)?.outcome).toBe('stopped');
    expect(h.store.task(h.source.id).state).toBe('integrated');
    expect(events[0]?.managerId).toBe('fixture');
    expect(events[0]?.summary).toContain('exit 1');
    expect(events[0]?.summary).toContain('.temp/original.log');
    expect(h.store.retryIntent(h.current)).toBeUndefined();
    expect(h.store.record(h.current)?.proof?.record).toHaveProperty('failureSummary', 'expected navigation assertion');
  } finally {
    h.dispose();
  }
});

test('source advancement invalidates passing evidence and unregistered product jobs cannot obtain a proof permit', () => {
  const h = registeredFixture();
  try {
    const product = h.store.createTask(
      brief(),
      { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit },
      'implementation',
    );
    const current = h.store.nextAttempt({ taskId: product.id, attempt: 0 }, (n) =>
      attempt(product.id, n, h.settings.stateDirectory),
    );
    expect(() => h.store.reserveProof({ ...h.binding, taskId: product.id, attempt: current.attempt })).toThrow(
      'registered exact source',
    );
    expect(proofSourceUnchanged(h.store.task(h.proof.id), 'dev')).toBe(true);
    writeFileSync(join(h.root, 'later-source'), 'later source');
    git(h.root, ['add', 'later-source']);
    git(h.root, ['commit', '-m', 'Advance fixture source']);
    git(h.root, ['update-ref', 'refs/heads/dev', git(h.root, ['rev-parse', 'HEAD'])]);
    expect(proofSourceUnchanged(h.store.task(h.proof.id), 'dev')).toBe(false);
  } finally {
    h.dispose();
  }
});

test('authoritative custody after model cancellation releases its owned permit without reviving the task', () => {
  const h = registeredFixture();
  try {
    h.store.updateAttempt(h.current, (current) => {
      current.state = 'cancelled';
    });
    const { record, physical } = records(h.binding);
    h.store.observeProof(h.binding, observeProof(h.binding, { record: () => record, history: () => physical }));
    expect(h.store.proofReservation(h.proof.id, 1)?.status).toBe('released');
    expect(h.store.attempt(h.current).state).toBe('cancelled');
    expect(h.store.task(h.proof.id).integratedCommit).toBeUndefined();
  } finally {
    h.dispose();
  }
});

import { nativeProofBinding, receiveProofStart, PROOF_PRODUCER_COMMIT } from './verification.ts';
import { checkScriptFixture, temporaryDirectory } from './test-support.ts';
import { pathToFileURL } from 'node:url';

const wireBinding = (): ProofBinding => ({
  version: 1,
  reservationToken: '11111111-1111-4111-8111-111111111111',
  checkId: '22222222-2222-4222-8222-222222222222',
  taskId: '33333333-3333-4333-8333-333333333333',
  goal: 'fixture',
  attempt: 1,
  sourceCommit: 'a'.repeat(40),
  sourceTree: 'b'.repeat(40),
  cwd: '/work/proof',
  argv: ['env', '-u', 'KERNEL_CHECK_REMOTE', 'bun', 'run', '--cwd', 'services/kernel', 'check', 'a.test.ts'],
});

test('delivered proof ABI retains canonical binding, started/replayed identity and authoritative refusal distinctions', async () => {
  const binding = wireBinding(),
    wire = nativeProofBinding(binding),
    registry = '/work/registry';
  const directory = temporaryDirectory();
  try {
    const path = join(directory.path, 'check-custody.ts');
    writeFileSync(path, checkScriptFixture(PROOF_PRODUCER_COMMIT).read('scripts/check-custody.ts'));
    const custody = await import(pathToFileURL(path).href);
    expect(custody.validateControllerProofBinding(wire)).toEqual(wire);
    expect(() =>
      custody.validateControllerProofBinding({ ...wire, reservationToken: binding.reservationToken }),
    ).toThrow();
    const resultPath = join(binding.cwd, '.temp/goal/checks/results', `${binding.checkId}.json`);
    for (const outcome of ['started', 'replayed'] as const) {
      const result = receiveProofStart(binding, registry, { version: 1, outcome, binding: wire, resultPath });
      expect(result).toEqual({ status: 'bound', binding, native: { outcome, resultPath, registry } });
    }
    expect(
      receiveProofStart(binding, registry, {
        version: 1,
        outcome: 'refused-never-started',
        binding: wire,
        reason: 'source changed before intent',
      }),
    ).toEqual({ status: 'refused', provenNeverStarted: true, cause: 'source changed before intent' });
    expect(
      receiveProofStart(binding, registry, {
        version: 1,
        outcome: 'unavailable',
        binding: wire,
        custody: 'unknown',
        reason: 'intent exists, runner missing',
      }),
    ).toEqual({ status: 'unknown', cause: 'intent exists, runner missing' });
    for (const changed of [
      { token: crypto.randomUUID() },
      { checkId: crypto.randomUUID() },
      { taskId: crypto.randomUUID() },
      { goal: 'other' },
      { attempt: 2 },
      { sourceCommit: 'c'.repeat(40) },
      { sourceTree: 'c'.repeat(40) },
      { argv: binding.argv.slice(0, -1) },
      { cwd: '/other/source' },
    ])
      expect(
        receiveProofStart(binding, registry, {
          version: 1,
          outcome: 'refused-never-started',
          binding: { ...wire, ...changed },
          reason: 'refused',
        }).status,
      ).toBe('unknown');
    for (const response of [
      { version: 1, outcome: 'started', binding: wire, resultPath: '/other/result' },
      { version: 1, outcome: 'unavailable', binding: wire, reason: 'missing custody' },
      { version: 1, outcome: 'refused-never-started', binding: wire, reason: '' },
      { version: 1, outcome: 'refused-never-started', binding: wire, reason: 'refused', extra: true },
      { version: 2, outcome: 'refused-never-started', binding: wire, reason: 'refused' },
    ])
      expect(receiveProofStart(binding, registry, response).status).toBe('unknown');
  } finally {
    directory.close();
  }
});

test('delivered proof command provenance retains Kernel env prefixes and whole Auth originals', () => {
  for (const env of [[], ['env', '-u', 'KERNEL_CHECK_REMOTE'], ['env', 'CI=1']]) {
    const prefix = [...env, 'bun', 'run', '--cwd', 'services/kernel', 'check'];
    const a = [...prefix, 'a.test.ts', 'shared.test.ts'];
    const b = [...prefix, 'shared.test.ts', 'b.test.ts'];
    expect(originalCommandMatches([...a, 'b.test.ts'], [a, b])).toBe(true);
    expect(originalCommandMatches(a, [a, b])).toBe(false);
    expect(
      originalCommandMatches(
        [...a, 'b.test.ts'],
        [a, ['bun', 'run', '--cwd', 'services/kernel', 'check', 'b.test.ts']],
      ),
    ).toBe(env.length === 0);
  }
  const auth = [
    'sh',
    '-c',
    'env -u KERNEL_CHECK_REMOTE bun run --cwd services/auth typecheck && bun test services/auth/tests/a.test.ts',
  ];
  expect(originalCommandMatches(auth, [auth])).toBe(true);
  expect(originalCommandMatches(['bun', 'test', 'services/auth/tests/a.test.ts'], [auth])).toBe(false);
  expect(
    originalCommandMatches(
      ['bun', 'test', 'a.test.ts', 'b.test.ts'],
      [
        ['bun', 'test', 'a.test.ts'],
        ['env', '-u', 'KERNEL_CHECK_REMOTE', 'bun', 'test', 'b.test.ts'],
      ],
    ),
  ).toBe(false);
  expect(
    originalCommandMatches(
      ['bun', 'run', 'gate857', 'a.test.ts', 'b.test.ts'],
      [
        ['bun', 'run', 'gate857', 'a.test.ts'],
        ['bun', 'run', 'gate857', 'b.test.ts'],
      ],
    ),
  ).toBe(false);
});

test('proof file unions keep explicit service files in source order under an identical raw env prefix', () => {
  const prefix = ['env', '-u', 'KERNEL_CHECK_REMOTE', 'bun', 'run', '--cwd', 'services/kernel', 'check'];
  const first = [...prefix, 'test/imports/identity-fixture.ts', 'test/imports/identity-outcomes.test.ts'];
  const second = [...prefix, 'test/imports/growth-fixture.ts', 'test/imports/growth-outcomes.test.ts'];
  const union = [...prefix, ...new Set([...first.slice(prefix.length), ...second.slice(prefix.length)])];
  expect(originalCommandMatches(union, [first, second])).toBe(true);
  expect(
    originalCommandMatches(
      [...prefix, ...second.slice(prefix.length), ...first.slice(prefix.length)],
      [first, second],
    ),
  ).toBe(false);
  const differentPrefix = ['env', 'CI=1', ...prefix.slice(3), ...second.slice(prefix.length)];
  expect(originalCommandMatches(union, [first, differentPrefix])).toBe(false);
});

test('historical detached UUIDs consume proof capacity without acquiring source or token provenance', () => {
  const h = registeredFixture();
  try {
    const old = h.store.createTask(
      brief(),
      { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit },
      'implementation',
    );
    const oldAttempt = h.store.nextAttempt({ taskId: old.id, attempt: 0 }, (n) =>
      attempt(old.id, n, h.settings.stateDirectory),
    );
    const checks = [crypto.randomUUID(), crypto.randomUUID()];
    h.store.updateAttempt(oldAttempt, (current) => {
      current.state = 'waiting';
      current.checks = checks;
    });
    expect(h.store.historicalProofChecks('fixture').map((check) => check.checkId)).toEqual(checks);
    expect(h.store.proofCapacityAvailable('fixture', 'new-proof')).toBe(false);
    const check = h.store.historicalProofChecks()[0]!;
    expect(() =>
      h.store.observeHistoricalProof(check, {
        status: 'unknown',
        passed: false,
        cause: 'missing',
        record: null,
        physical: [],
      }),
    ).toThrow();
    h.store.observeHistoricalProof(check, {
      status: 'terminal',
      passed: false,
      cause: 'owned terminal custody',
      record: {},
      physical: [],
    });
    expect(h.store.proofCapacityAvailable('fixture', 'new-proof')).toBe(true);
    expect(h.store.task(old.id).proofRun).toBeUndefined();
    expect(h.store.attempt(oldAttempt).checks).toEqual(checks);
    expect(h.store.attempt(oldAttempt).state).toBe('waiting');
  } finally {
    h.dispose();
  }
});

import { workerCheckProtocol, workerPrompt, launchCommand } from './launch.ts';
import { fixturePool } from './test-support.ts';
import { requireOriginalProofProfile } from './agents.ts';
import { readRouting, routeTask } from './routing.ts';

test('proof routing keeps provider eligibility at the agent boundary without entering product experiments', () => {
  const table = readRouting(join(import.meta.dir, '../routing.json'));
  const contract = {
    ...brief(),
    kind: 'verification' as const,
    paths: [],
    proof: { journey: 'Original journey', sourceTasks: ['original'], sourceCommit: 'a'.repeat(40) },
  };
  const ordinary = table.classes.implementation.first;
  expect(() => requireOriginalProofProfile(ordinary)).not.toThrow();
  for (const sequence of [1, 2, 3]) {
    expect(routeTask(contract, sequence, table)).toEqual({
      taskClass: 'implementation',
      profile: ordinary,
      tableVersion: table.version,
      experiment: null,
    });
  }
  for (const cli of ['claude', 'grok', 'cursor'] as const) {
    const unsupported = { ...ordinary, cli };
    expect(() => requireOriginalProofProfile(unsupported)).toThrow('ordinary Codex worker route');
    const changed = structuredClone(table);
    changed.classes.implementation.first = unsupported;
    expect(() => routeTask(contract, 1, changed)).toThrow('ordinary Codex worker route');
    // Verification's provider restriction does not change the ordinary product experiment.
    expect(routeTask(brief(), 1, changed).experiment).toBe('implementation-model');
  }
});

test('delivered proof provider boundaries consume the bound invocation and never mint an unbound UUID', () => {
  const directory = temporaryDirectory();
  try {
    const binding = wireBinding();
    binding.cwd = directory.path;
    const contract = {
      ...brief(),
      kind: 'verification' as const,
      paths: [],
      markdown: 'Observe the captured original.',
      acceptance: { ...brief().acceptance, command: binding.argv },
      proof: { journey: 'Original journey', sourceTasks: ['original'], sourceCommit: binding.sourceCommit },
    };
    const observation = {
      status: 'running' as const,
      passed: false,
      cause: 'physical terminal custody unresolved',
      record: { id: binding.checkId },
      physical: [],
    };
    const run = {
      binding,
      status: 'bound' as const,
      native: {
        outcome: 'replayed' as const,
        registry: join(directory.path, 'registry'),
        resultPath: join(directory.path, '.temp/goal/checks/results', `${binding.checkId}.json`),
      },
      observation,
    };
    const task = {
      id: binding.taskId,
      sequence: 1,
      brief: contract,
      briefPath: '',
      state: 'running' as const,
      worktree: directory.path,
      branch: 'worker/proof',
      base: binding.sourceCommit,
      taskClass: 'implementation' as const,
      currentAttempt: 1,
      createdAt: new Date().toISOString(),
      proofRun: run,
    };
    for (const resumeSession of [undefined, 'actual-same-session']) {
      const prompt = workerPrompt(task, undefined, undefined, [], directory.path);
      const [, argv] = launchCommand({
        profile: { cli: 'codex', model: 'gpt-6.1-sol', effort: 'high', poolClass: 'default' },
        pool: fixturePool(directory.path),
        worktree: directory.path,
        prompt,
        ...(resumeSession ? { resumeSession } : {}),
      });
      expect(argv.join(' ')).toContain('already started or replayed');
      expect(argv.join(' ')).toContain(binding.checkId);
      expect(argv.join(' ')).not.toContain('bun scripts/worker-check.ts --');
      expect(argv.join(' ')).not.toContain('Run exactly one ordinary worker-check invocation');
    }
    for (const boundary of [
      run,
      { ...run, status: 'released' as const, observation: { ...observation, status: 'terminal' as const } },
    ]) {
      const prompt = workerCheckProtocol(directory.path, contract, undefined, boundary);
      expect(prompt).toContain('Current owned check evidence');
      expect(prompt).toContain('same session');
      expect(prompt).not.toContain('before you start a check');
    }
    const prefix = ['env', '-u', 'KERNEL_CHECK_REMOTE', 'bun', 'test', '--timeout', '30000'];
    expect(
      originalCommandMatches(
        [...prefix, 'a.test.ts', 'b.test.ts'],
        [
          [...prefix, 'a.test.ts'],
          [...prefix, 'b.test.ts'],
        ],
      ),
    ).toBe(true);
    expect(
      originalCommandMatches(
        [...prefix, 'a.test.ts', 'b.test.ts'],
        [
          [...prefix, 'a.test.ts'],
          ['bun', 'test', 'b.test.ts'],
        ],
      ),
    ).toBe(false);
  } finally {
    directory.close();
  }
});

import { dirname } from 'node:path';
import { WorkerTasks } from './tasks.ts';
import { parseBrief, readRiskOwnership } from './briefs.ts';
import { reading } from './test-support.ts';
import { proofExecutionUnavailable, ProofUnavailableError } from './verification.ts';
import { checkSettings, createRuntime, loadSettings } from './config.ts';
import { runWorkerCommand } from './worker-commands.ts';
import type { Brief } from './types.ts';

/** Submit through the real local brief parser, rather than assigning a proof permit to a task. */
function submittedProof(h: ReturnType<typeof registeredFixture>, changes: Partial<Brief> = {}) {
  const value = {
    goal: h.proofBrief.goal,
    manager: h.proofBrief.manager,
    kind: 'verification',
    proof: h.proofBrief.proof,
    riskAreas: [],
    acceptance: h.proofBrief.acceptance,
    criticalPath: false,
    waiting: [],
    after: [],
    ...changes,
  };
  const markdown = `---\n${JSON.stringify(value, null, 2)}\n---\nObserve the exact original; source and tests are read-only.\n`;
  const path = join(h.settings.stateDirectory, `proof-${crypto.randomUUID()}.md`);
  writeFileSync(path, markdown);
  return { path, brief: parseBrief(markdown, readRiskOwnership(h.settings.riskAreasFile)) };
}

test('Exact whole original Auth workspace check and complete homogeneous helper-plus-test file union authorize without relaxing root/gate prohibition', () => {
  const h = registeredFixture();
  try {
    const prefix = ['bun', 'run', '--cwd', 'services/kernel', 'check'];
    const identity = [
      'test/imports/identity-fixture.ts',
      'test/imports/identity-driver.ts',
      'test/imports/identity-outcomes.test.ts',
    ];
    const growth = [
      'test/imports/growth-fixture.ts',
      'test/imports/growth-driver.ts',
      'test/imports/growth-sqlite-capture.ts',
      'test/imports/growth-outcomes.test.ts',
      identity[2]!,
    ];
    for (const file of [...identity, ...growth]) {
      const path = join(h.root, 'services/kernel', file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'export {};\n');
    }
    git(h.root, ['add', 'services/kernel']);
    git(h.root, ['commit', '-m', 'Fixture original helper and test inputs']);
    const sourceCommit = git(h.root, ['rev-parse', 'HEAD']);
    git(h.root, ['update-ref', 'refs/heads/dev', sourceCommit]);
    const original = (command: string[]) => {
      const task = h.store.createTask(
        { ...brief(), acceptance: { ...brief().acceptance, command } },
        { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: sourceCommit },
        'implementation',
      );
      h.store.updateTask({ taskId: task.id, attempt: 0 }, (current) => {
        current.state = 'integrated';
        current.integratedCommit = sourceCommit;
      });
      return task.id;
    };
    const auth = ['bun', 'run', '--cwd', 'services/auth', 'check'];
    const authTask = original(auth);
    const whole = submittedProof(h, {
      proof: { ...h.proofBrief.proof, sourceTasks: [authTask], sourceCommit },
      acceptance: { ...h.proofBrief.acceptance, command: auth },
    }).brief;
    expect(authorizeProof(h.store, h.root, whole, h.actor, 'operations', 'dev').originals).toEqual([
      { taskId: authTask, commit: sourceCommit, argv: auth },
    ]);
    expect(() =>
      authorizeProof(
        h.store,
        h.root,
        { ...whole, proof: { ...whole.proof!, sourceTasks: [h.source.id] } },
        h.actor,
        'operations',
        'dev',
      ),
    ).toThrow('every whole original');
    expect(() =>
      authorizeProof(
        h.store,
        h.root,
        { ...whole, acceptance: { ...whole.acceptance, command: [...auth, 'test/short.test.ts'] } },
        h.actor,
        'operations',
        'dev',
      ),
    ).toThrow('every whole original');
    const kernel = ['bun', 'run', '--cwd', 'services/kernel', 'check'];
    expect(
      authorizeProof(
        h.store,
        h.root,
        {
          ...whole,
          proof: { ...whole.proof!, sourceTasks: [original(kernel)] },
          acceptance: { ...whole.acceptance, command: kernel },
        },
        h.actor,
        'operations',
        'dev',
      ).originals[0]?.argv,
    ).toEqual(kernel);
    for (const env of [[], ['env', '-u', 'KERNEL_CHECK_REMOTE']]) {
      const a = [...env, ...prefix, ...identity],
        b = [...env, ...prefix, ...growth];
      const command = [...env, ...prefix, ...new Set([...identity, ...growth])];
      const proof = {
        ...whole,
        proof: { ...whole.proof!, sourceTasks: [original(a), original(b)] },
        acceptance: { ...whole.acceptance, command },
      };
      expect(
        authorizeProof(h.store, h.root, proof, h.actor, 'operations', 'dev').originals.map((entry) => entry.argv),
      ).toEqual([a, b]);
      expect(preflightProof(h.root, proof)).toEqual([]);
      expect(
        originalCommandMatches([...env, ...prefix, ...command.slice(env.length + prefix.length + 1)], [a, b]),
      ).toBe(false);
      expect(originalCommandMatches([...env, ...prefix, ...identity, ...growth], [a, b])).toBe(false);
      expect(originalCommandMatches(command, [a, ['env', 'CI=1', ...prefix, ...growth]])).toBe(false);
      expect(originalCommandMatches(command, [a, [...env, ...prefix, '--timeout', '30000', ...growth]])).toBe(false);
      expect(
        preflightProof(h.root, {
          ...proof,
          acceptance: { ...proof.acceptance, command: [...command, 'test/imports/missing-helper.ts'] },
        }),
      ).toEqual(['test/imports/missing-helper.ts']);
    }
    for (const command of [
      ['bun', 'run', 'check'],
      ['bun', 'test'],
      ['bun', 'run', 'gate857', 'fixture.test.ts'],
      ['sh', '-c', 'bun test fixture.test.ts'],
      ['bun', 'test', '--preload', 'fixture.test.ts'],
      [
        'bun',
        'scripts/worker-check.ts',
        '--local',
        '--',
        'bun',
        'scripts/worker-check.ts',
        '--',
        'bun',
        'test',
        'fixture.test.ts',
      ],
    ]) {
      const proof = {
        ...whole,
        proof: { ...whole.proof!, sourceTasks: [original(command)] },
        acceptance: { ...whole.acceptance, command },
      };
      expect(() => authorizeProof(h.store, h.root, proof, h.actor, 'operations', 'dev')).toThrow('broad root or gate');
    }
    const local = ['bun', 'scripts/worker-check.ts', '--local', '--', 'bun', 'test'];
    const a = [...local, 'fixture.test.ts'],
      b = [...local, 'other.test.ts'];
    const union = [...a, 'other.test.ts'];
    const wrapped = {
      ...whole,
      proof: { ...whole.proof!, sourceTasks: [original(a), original(b)] },
      acceptance: { ...whole.acceptance, command: union },
    };
    expect(
      authorizeProof(h.store, h.root, wrapped, h.actor, 'operations', 'dev').originals.map((entry) => entry.argv),
    ).toEqual([a, b]);
    expect(originalCommandMatches(['bun', 'test', 'fixture.test.ts', 'other.test.ts'], [a, b])).toBe(false);
    expect(proofExecutionUnavailable(union)).toContain('ONE logical invocation');
  } finally {
    h.dispose();
  }
});

test('stopped same-generation and never-started held proof conversion persists authentic registration/start once without fabricated source/token', async () => {
  const h = registeredFixture();
  try {
    const legacy = h.store.createTask(
      { ...brief(), kind: 'claim' },
      { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit },
      'claim',
    );
    let ref = { taskId: legacy.id, attempt: 0 };
    for (let n = 1; n <= 28; n++)
      ref = h.store.nextAttempt(ref, (number) => attempt(legacy.id, number, h.settings.stateDirectory));
    h.store.updateAttempt(ref, (current) => {
      current.result = 'Original failed report, not a registered proof';
      current.session = 'retained-original-session';
    });
    h.store.close(ref, 'stopped');
    const raw = h.store.db.query('SELECT body FROM worker_attempts WHERE task_id=? AND attempt=?').get(legacy.id, 28);
    const submitted = submittedProof(h);
    expect(() => h.tasks.queueRetry(legacy.id, { brief: submitted.path, expectedAttempt: 27 }, h.actor)).toThrow(
      'stale',
    );
    expect(h.store.task(legacy.id).brief.kind).toBe('claim');
    expect(h.store.task(legacy.id).proofAuthorization).toBeUndefined();
    h.tasks.queueRetry(legacy.id, { brief: submitted.path, expectedAttempt: 28 }, h.actor);
    const registered = h.store.task(legacy.id);
    expect(registered.currentAttempt).toBe(28);
    expect(registered.brief.kind).toBe('verification');
    expect(registered.proofAuthorization).toMatchObject({
      manager: h.actor.id,
      sessionId: h.actor.sessionId,
      sourceTree: h.binding.sourceTree,
    });
    expect(registered.proofRun).toBeUndefined();
    expect(h.store.proofReservation(legacy.id, 28)).toBeUndefined();
    expect(h.store.retryIntent(ref)?.status).toBe('pending');
    expect(
      h.store.db.query('SELECT body FROM worker_attempts WHERE task_id=? AND attempt=?').get(legacy.id, 28),
    ).toEqual(raw);
    expect(h.store.record(ref)?.taskKind).toBe('claim');
    expect(h.store.record(ref)?.proof).toBeUndefined();
    expect(() => h.tasks.queueRetry(legacy.id, { expectedAttempt: 28 }, h.actor)).toThrow('already pending');

    const lane = h.store.createTask(
      brief(),
      { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit },
      'implementation',
    );
    const future = { ...h.proofBrief.proof, sourceCommit: 'b'.repeat(40) };
    const held = h.store.createTask(
      { ...brief(), kind: 'claim', proof: future, after: [lane.id] },
      { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit },
      'claim',
    );
    const before = h.store.task(held.id);
    expect(() => h.tasks.queueProofStart(held.id, { expectedAttempt: 0, brief: submitted.path }, h.actor)).toThrow(
      'removeAfter',
    );
    expect(h.store.task(held.id)).toEqual(before);
    expect(() =>
      h.tasks.queueProofStart(
        held.id,
        { expectedAttempt: 0, brief: submitted.path, removeAfter: [lane.id] },
        { id: 'foreign', sessionId: 'foreign' },
      ),
    ).toThrow('authenticated');
    expect(h.store.task(held.id)).toEqual(before);
    const runtime = createRuntime({ tasks: h.tasks, db: h.store.db });
    const output: string[] = [];
    expect(
      await runWorkerCommand(
        'retry',
        [held.id, '--expected-attempt', '0', '--brief', submitted.path, '--remove-after', lane.id],
        {
          runtime,
          env: { CODEX_THREAD_ID: h.actor.sessionId },
          print: (value) => output.push(value),
        },
      ),
    ).toBe(0);
    expect(JSON.parse(output[0]!)).toEqual({ taskId: held.id, attempt: 0, status: 'created' });
    const converted = h.store.task(held.id);
    expect(converted.state).toBe('ready');
    expect(converted.currentAttempt).toBe(0);
    expect(converted.brief.proof).toEqual(submitted.brief.proof);
    expect(converted.brief.after).toEqual([]);
    expect(converted.proofAuthorization?.sessionId).toBe(h.actor.sessionId);
    expect(converted.proofRun).toBeUndefined();
    expect(h.store.attempts(held.id)).toEqual([]);
    h.tasks.queueProofStart(held.id, { expectedAttempt: 0 }, h.actor);
    expect(h.store.retryIntents().filter((intent) => intent.taskId === held.id)).toHaveLength(1);
    expect(h.store.retryIntent({ taskId: held.id, attempt: 0 })?.status).toBe('pending');
  } finally {
    h.dispose();
  }
});

test('registered READY0 recovery uses ordinary start/wait/wake/result once without metadata resubmission, producer binding or a second UUID', async () => {
  const h = registeredFixture(true);
  const db = openDb(join(h.settings.stateDirectory, 'goal.sqlite'));
  try {
    const submitted = submittedProof(h);
    const ready = h.store.createTask(
      submitted.brief,
      { briefPath: submitted.path, worktree: h.root, branch: 'main', base: h.binding.sourceCommit },
      'implementation',
    );
    h.store.updateTask({ taskId: ready.id, attempt: 0 }, (current) => {
      current.proofAuthorization = authorizeProof(h.store, h.root, submitted.brief, h.actor, 'operations', 'dev');
    });
    const id = crypto.randomUUID();
    const directory = join(h.root, '.temp/goal/checks/results');
    mkdirSync(directory, { recursive: true });
    let launches = 0,
      binds = 0;
    const second = new WorkerStore(db);
    const tasks = new WorkerTasks(
      h.settings,
      second,
      (pool) => reading(pool),
      async (store, task, next, _pool, prompt) => {
        launches++;
        expect(prompt).toContain('Run exactly one ordinary worker-check invocation');
        expect(task.proofRun).toBeUndefined();
        const record = {
          id,
          cwd: task.worktree,
          argv: task.brief.acceptance.command,
          ownership: { taskId: task.id, attempt: next.attempt },
          status: 'running',
          log: '.temp/original.log',
        };
        writeFileSync(join(directory, `${id}.json`), JSON.stringify(record));
        mkdirSync(dirname(next.logPath), { recursive: true });
        writeFileSync(
          next.logPath,
          JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'agent_message',
              text: JSON.stringify({
                status: 'waiting',
                summary: 'Original active',
                blocker: null,
                checks: [id],
                approaches: [],
              }),
            },
          }) + '\n',
        );
        store.updateTask(next, (current) => {
          current.state = 'running';
        });
        const saved = store.updateAttempt(next, (current) => {
          current.state = 'running';
          current.session = 'proof-session';
        });
        return { attempt: saved, exited: Promise.resolve({ code: 0, signal: null }) };
      },
      {
        async bind() {
          binds++;
          throw new Error('Ordinary proof must not call a producer');
        },
      },
    );
    const job = new WorkerJob(
      tasks,
      {
        enqueue() {
          throw new Error('proof must never land');
        },
      },
      { deliver() {} },
    );
    job.resumePendingRetries();
    job.resumePendingRetries();
    await job.drain();
    expect(launches).toBe(1);
    expect(binds).toBe(0);
    expect(second.attempt({ taskId: ready.id, attempt: 1 })).toMatchObject({ state: 'waiting', checks: [id] });
    expect(second.retryIntent({ taskId: ready.id, attempt: 0 })).toMatchObject({ status: 'started', nextAttempt: 1 });
    expect(second.proofReservation(ready.id, 1)).toBeUndefined();
    const current = second.attempt({ taskId: ready.id, attempt: 1 });
    expect(await job['checkWakeMessage'](current, second.task(ready.id))).toBeNull();
    const record = JSON.parse(readFileSync(join(directory, `${id}.json`), 'utf8'));
    writeFileSync(join(directory, `${id}.json`), JSON.stringify({ ...record, status: 'finished', exitCode: 0 }));
    expect(await job['checkWakeMessage'](current, second.task(ready.id))).toContain('exit 0');
    // Exercise settlement of the same resumed generation without invoking a real provider in this receiving test.
    writeFileSync(
      current.logPath,
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: JSON.stringify({
            status: 'success',
            summary: 'Actual original terminal zero',
            blocker: null,
            checks: [],
            approaches: [],
          }),
        },
      }) + '\n',
    );
    await settle(
      tasks,
      { attempt: current, exited: Promise.resolve({ code: 0, signal: null }), resuming: true },
      {
        enqueue() {
          throw new Error('proof must never land');
        },
      },
    );
    expect(second.task(ready.id).state).toBe('verified');
    expect(second.record(current)?.proof).toMatchObject({
      status: 'terminal',
      passed: true,
      record: { id, exitCode: 0 },
    });
    await job.start(ready.id, { expectedAttempt: 0 });
    job.resumePendingRetries();
    await job.drain();
    expect(second.attempts(ready.id)).toHaveLength(1);
    expect(launches).toBe(1);
    expect(binds).toBe(0);
  } finally {
    db.close();
    h.dispose();
  }
});
test('first-start cap waits and old captures keep one durable intent; authenticated stopped generations can register a future capture', async () => {
  const h = registeredFixture();
  try {
    for (let n = 0; n < 2; n++) {
      const submitted = submittedProof(h);
      const task = h.store.createTask(
        submitted.brief,
        { briefPath: submitted.path, worktree: h.root, branch: 'main', base: h.binding.sourceCommit },
        'implementation',
      );
      h.store.updateTask({ taskId: task.id, attempt: 0 }, (current) => {
        current.proofAuthorization = authorizeProof(h.store, h.root, submitted.brief, h.actor, 'operations', 'dev');
      });
      const ref = h.store.nextAttempt({ taskId: task.id, attempt: 0 }, (number) =>
        attempt(task.id, number, h.settings.stateDirectory),
      );
      const binding = newProofBinding(h.store.task(task.id), ref.attempt);
      h.store.reserveProof(binding);
      h.store.bindProof(binding, { status: 'unknown', cause: 'Actual custody unresolved' });
    }
    const submitted = submittedProof(h);
    const task = h.store.createTask(
      { ...brief(), kind: 'claim' },
      { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit },
      'claim',
    );
    expect(h.tasks.queueProofStart(task.id, { expectedAttempt: 0, brief: submitted.path }, h.actor).status).toBe(
      'waiting',
    );
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    job.resumePendingRetries();
    await job.drain();
    expect(h.store.attempts(task.id)).toEqual([]);
    expect(h.store.proofReservation(task.id, 0)).toBeUndefined();
    writeFileSync(join(h.root, 'later-source'), 'fresh capture');
    git(h.root, ['add', 'later-source']);
    git(h.root, ['commit', '-m', 'Advance integration fixture']);
    const sourceCommit = git(h.root, ['rev-parse', 'HEAD']);
    git(h.root, ['update-ref', 'refs/heads/dev', sourceCommit]);
    await expect(job.start(task.id, { expectedAttempt: 0 })).rejects.toThrow('integration source advanced');
    job.resumePendingRetries();
    await job.drain();
    expect(h.store.task(task.id).brief.proof?.sourceCommit).toBe(h.binding.sourceCommit);
    expect(h.store.attempts(task.id)).toEqual([]);
    const fresh = submittedProof(h, { proof: { ...h.proofBrief.proof, sourceCommit } });
    expect(() =>
      h.tasks.queueProofStart(
        task.id,
        { expectedAttempt: 0, brief: fresh.path },
        { ...h.actor, sessionId: 'stale-session' },
      ),
    ).toThrow('live authenticated');
    h.settings.integration.operationsManager = 'operations';
    const operations = { id: 'operations', sessionId: 'operations-session' };
    h.store.db
      .query('INSERT INTO manager_sessions VALUES (?,?)')
      .run(operations.id, JSON.stringify({ status: 'running', threadId: operations.sessionId }));
    expect(h.tasks.queueProofStart(task.id, { expectedAttempt: 0, brief: fresh.path }, operations).status).toBe(
      'waiting',
    );
    expect(h.store.task(task.id).brief.proof?.sourceCommit).toBe(sourceCommit);
    expect(h.store.retryIntents().filter((intent) => intent.taskId === task.id)).toHaveLength(1);
    expect(() => h.tasks.queueRetry(h.proof.id, { expectedAttempt: 1, brief: fresh.path }, h.actor)).toThrow('stale');
    h.store.close(h.current, 'stopped');
    h.tasks.queueRetry(h.proof.id, { expectedAttempt: 1, brief: fresh.path }, h.actor);
    expect(h.store.retryIntent(h.current)?.status).toBe('pending');
    expect(h.store.task(h.proof.id).brief.proof?.sourceCommit).toBe(sourceCommit);
    expect(h.store.proofReservation(h.proof.id, 1)?.binding).toEqual(h.binding);
  } finally {
    h.dispose();
  }
});

test('first-start receiving refuses missing helpers and stale, cancelled, integrated or running-owner conversions before native execution', () => {
  const h = registeredFixture();
  try {
    const submitted = submittedProof(h);
    const make = () =>
      h.store.createTask(
        { ...brief(), kind: 'claim' },
        { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit },
        'claim',
      );
    for (const state of ['cancelled', 'integrated'] as const) {
      const task = make();
      h.store.updateTask({ taskId: task.id, attempt: 0 }, (current) => {
        current.state = state;
      });
      expect(() => h.tasks.queueProofStart(task.id, { expectedAttempt: 0, brief: submitted.path }, h.actor)).toThrow(
        'stale',
      );
      expect(h.store.retryIntent({ taskId: task.id, attempt: 0 })).toBeUndefined();
      expect(h.store.task(task.id).brief.kind).toBe('claim');
    }
    const running = make();
    const ref = h.store.nextAttempt({ taskId: running.id, attempt: 0 }, (number) =>
      attempt(running.id, number, h.settings.stateDirectory),
    );
    h.store.updateTask(ref, (current) => {
      current.state = 'running';
    });
    expect(() => h.tasks.queueRetry(running.id, { brief: submitted.path, expectedAttempt: 1 }, h.actor)).toThrow(
      'stale',
    );
    expect(() => h.tasks.queueProofStart(running.id, { expectedAttempt: 0, brief: submitted.path }, h.actor)).toThrow(
      'stale',
    );
    expect(h.store.task(running.id).proofAuthorization).toBeUndefined();
    const command = ['bun', 'run', '--cwd', 'services/kernel', 'check', 'missing-helper.ts', 'fixture.test.ts'];
    h.store.updateTask({ taskId: h.source.id, attempt: 0 }, (current) => {
      current.brief.acceptance.command = command;
    });
    const missing = submittedProof(h, { acceptance: { ...h.proofBrief.acceptance, command } });
    const task = make();
    expect(() => h.tasks.queueProofStart(task.id, { expectedAttempt: 0, brief: missing.path }, h.actor)).toThrow(
      ProofUnavailableError,
    );
    expect(h.store.task(task.id).brief.kind).toBe('claim');
    expect(h.store.attempts(task.id)).toEqual([]);
    expect(h.store.retryIntent({ taskId: task.id, attempt: 0 })).toBeUndefined();
  } finally {
    h.dispose();
  }
});

test('configured operations receives stopped and held conversions with authentic ordinary priority and unchanged old attempts', () => {
  const h = registeredFixture();
  try {
    h.settings.integration.operationsManager = 'operations';
    const operations = { id: 'operations', sessionId: 'operations-session' };
    h.store.db
      .query('INSERT INTO manager_sessions VALUES (?,?)')
      .run(operations.id, JSON.stringify({ status: 'running', threadId: operations.sessionId }));
    const submitted = submittedProof(h);
    for (const state of ['stopped', 'held'] as const) {
      const task = h.store.createTask(
        { ...brief(), kind: 'claim', criticalPath: true },
        { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit },
        'critical-path',
      );
      const ref = h.store.nextAttempt({ taskId: task.id, attempt: 0 }, (number) =>
        attempt(task.id, number, h.settings.stateDirectory),
      );
      h.store.close(ref, 'stopped');
      if (state === 'held')
        h.store.updateHeldRetryTask(ref, (current) => {
          current.state = 'held';
        });
      const raw = h.store.db.query('SELECT body FROM worker_attempts WHERE task_id=? AND attempt=?').get(task.id, 1);
      expect(() => h.tasks.queueRetry(task.id, { expectedAttempt: 1, brief: submitted.path }, null)).toThrow(
        'authenticated',
      );
      h.tasks.queueRetry(task.id, { expectedAttempt: 1, brief: submitted.path }, operations);
      const registered = h.store.task(task.id);
      expect(registered.proofAuthorization).toMatchObject({ manager: operations.id, sessionId: operations.sessionId });
      expect(registered.brief.criticalPath).toBe(false);
      expect(registered.taskClass).toBe('implementation');
      expect(registered.priorityHistory?.at(-1)).toMatchObject({
        value: 'normal',
        setter: operations.id,
        provenance: { kind: 'manager-session', sessionId: operations.sessionId },
      });
      expect(h.store.record(ref)).toMatchObject({ taskKind: 'claim', criticalPath: true });
      expect(
        h.store.db.query('SELECT body FROM worker_attempts WHERE task_id=? AND attempt=?').get(task.id, 1),
      ).toEqual(raw);
      expect(h.store.retryIntent(ref)?.status).toBe('pending');
      expect(h.store.proofReservation(task.id, 1)).toBeUndefined();
    }
  } finally {
    h.dispose();
  }
});

test('exact retained local wrapper registers for ordinary execution without stripping provenance, native port or nested invocation', async () => {
  const h = registeredFixture();
  try {
    const command = ['bun', 'scripts/worker-check.ts', '--local', '--', 'bun', 'test', 'fixture.test.ts'];
    h.store.updateTask({ taskId: h.source.id, attempt: 0 }, (current) => {
      current.brief.acceptance.command = command;
    });
    const submitted = submittedProof(h, { acceptance: { ...h.proofBrief.acceptance, command } });
    const task = h.store.createTask(
      { ...brief(), kind: 'claim' },
      { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit },
      'claim',
    );
    expect(h.tasks.queueProofStart(task.id, { expectedAttempt: 0, brief: submitted.path }, h.actor)).toEqual({
      taskId: task.id,
      attempt: 0,
      status: 'created',
    });
    const saved = h.store.task(task.id);
    expect(saved.brief.acceptance.command).toEqual(command);
    expect(saved.proofAuthorization?.originals[0]?.argv).toEqual(command);
    expect(ordinaryProofCommand(command)).toEqual({
      invocation: command,
      recordedArgv: ['bun', 'test', 'fixture.test.ts'],
    });
    expect(workerPrompt(saved, undefined, undefined, [], h.root)).toContain(
      "'bun' 'scripts/worker-check.ts' '--local' '--' 'bun' 'test' 'fixture.test.ts'",
    );
    expect(h.store.task(task.id).currentAttempt).toBe(0);
    expect(h.store.attempts(task.id)).toEqual([]);
    expect(h.store.proofReservation(task.id, 1)).toBeUndefined();
    expect(h.store.retryIntents().filter((intent) => intent.taskId === task.id)).toHaveLength(1);
  } finally {
    h.dispose();
  }
});
test('historical admission distinguishes retained live identities from gone, missing, remote and reused identities without claiming terminal cleanup', () => {
  const check = { taskId: 'original', attempt: 28, checkId: crypto.randomUUID(), cwd: '/retained/original' };
  const identity = processIdentity();
  if (!identity) throw new Error('Current process identity unavailable');
  const registration = {
    version: 1,
    checkId: check.checkId,
    physicalRunId: crypto.randomUUID(),
    ownership: { taskId: check.taskId, attempt: check.attempt },
    runnerHost: hostname(),
    runnerIdentity: identity,
  };
  const reader: HistoricalProofReader = {
    record() {
      throw new Error('Historical result absent');
    },
    history() {
      return undefined;
    },
    registrations() {
      return [registration];
    },
    valid(_check, value) {
      return value === registration;
    },
  };
  const live = classifyHistoricalProof(check, reader);
  expect(live.classification).toBe('live');
  expect(live.processes).toEqual([{ identity, host: hostname(), live: true }]);
  expect(live.cause).toContain(check.checkId);
  expect(live.record).toBeNull();
  expect(live.physical).toEqual([null]);
  for (const runner of [
    { ...registration, runnerIdentity: { ...identity, start: String(BigInt(identity.start) + 1n) } },
    { ...registration, runnerHost: 'unobserved-remote-host' },
    { ...registration, runnerIdentity: { pid: identity.pid } },
  ]) {
    const unknown = classifyHistoricalProof(check, {
      ...reader,
      registrations() {
        return [runner];
      },
      valid() {
        return true;
      },
    });
    expect(unknown.classification).toBe('historical-unknown');
    expect(unknown.cause).toMatch(/unknown|unresolved/);
    expect(unknown).not.toHaveProperty('passed');
    expect(unknown).not.toHaveProperty('terminalProof');
  }
  const foreign = classifyHistoricalProof(check, {
    ...reader,
    valid() {
      return false;
    },
  });
  expect(foreign.classification).toBe('historical-unknown');
  expect(foreign.processes).toEqual([]);
});

test('one hundred older active-looking and current stopped rows preserve archives and raw leases without regrowing logical cap after restart', () => {
  const h = registeredFixture();
  const db = openDb(join(h.settings.stateDirectory, 'goal.sqlite'));
  try {
    const old = h.store.createTask(
      brief(),
      { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit },
      'implementation',
    );
    const first = h.store.nextAttempt({ taskId: old.id, attempt: 0 }, (n) =>
      attempt(old.id, n, h.settings.stateDirectory),
    );
    const checks = Array.from({ length: 100 }, () => crypto.randomUUID());
    h.store.updateAttempt(first, (current) => {
      current.state = 'waiting';
      current.checks = checks;
      current.result = 'Raw unknown report';
    });
    const next = h.store.nextAttempt(first, (n) => attempt(old.id, n, h.settings.stateDirectory));
    // Retained older rows may look active; only the exact current generation is eligible for cap inspection.
    const rawOld = JSON.parse(
      (
        h.store.db.query('SELECT body FROM worker_attempts WHERE task_id=? AND attempt=1').get(old.id) as {
          body: string;
        }
      ).body,
    );
    h.store.db
      .query('UPDATE worker_attempts SET body=? WHERE task_id=? AND attempt=1')
      .run(JSON.stringify({ ...rawOld, state: 'waiting' }), old.id);
    h.store.updateAttempt(next, (current) => {
      current.checks = [...checks, 'bun test labelled-not-a-UUID'];
    });
    h.store.close(next, 'stopped');
    for (const checkId of checks)
      h.store.db
        .query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)')
        .run(
          old.id,
          1,
          'historical-proof-terminal',
          new Date().toISOString(),
          JSON.stringify({ checkId, status: 'historical-unknown', passed: false, archivedBy: 'supermanager' }),
        );
    const raw = h.store.db.query('SELECT body FROM worker_attempts WHERE task_id=? ORDER BY attempt').all(old.id);
    const events = h.store.events(old.id);
    const leasePath = join(h.settings.stateDirectory, 'retained-physical-lease.json');
    writeFileSync(leasePath, '{"physical":"unresolved"}');
    const store = new WorkerStore(db);
    expect(store.historicalProofChecks()).toEqual([]);
    expect(store.historicalProofSlots()).toEqual([]);
    expect(store.proofCapacityAvailable('fixture', 'new-proof')).toBe(true);
    for (let i = 0; i < 2; i++) {
      const task = store.createTask(
        h.proofBrief,
        { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit },
        'implementation',
      );
      store.updateTask({ taskId: task.id, attempt: 0 }, (current) => {
        current.proofAuthorization = h.store.task(h.proof.id).proofAuthorization!;
      });
      store.nextAttempt(
        { taskId: task.id, attempt: 0 },
        (n) => attempt(task.id, n, h.settings.stateDirectory),
        undefined,
        true,
      );
    }
    expect(store.proofCapacityAvailable('fixture', 'fourth-proof')).toBe(false);
    expect(store.db.query('SELECT body FROM worker_attempts WHERE task_id=? ORDER BY attempt').all(old.id)).toEqual(
      raw,
    );
    expect(store.events(old.id)).toEqual(events);
    expect(store.task(old.id).proofRun).toBeUndefined();
    expect(readFileSync(leasePath, 'utf8')).toBe('{"physical":"unresolved"}');
  } finally {
    db.close();
    h.dispose();
  }
});
test('current waiting historical runner occupies cap3 regardless of optional classification until its logical attempt stops', () => {
  const h = registeredFixture();
  try {
    const old = h.store.createTask(
      brief(),
      { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit },
      'implementation',
    );
    const ref = h.store.nextAttempt({ taskId: old.id, attempt: 0 }, (n) =>
      attempt(old.id, n, h.settings.stateDirectory),
    );
    h.store.updateAttempt(ref, (current) => {
      current.checks = [crypto.randomUUID()];
    });
    const check = h.store.historicalProofChecks()[0]!;
    const identity = processIdentity();
    if (!identity) throw new Error('Current process identity unavailable');
    const record = {
      custodyVersion: 1,
      id: check.checkId,
      cwd: check.cwd,
      status: 'finished',
      ownership: { taskId: old.id, attempt: 1 },
      runnerHost: hostname(),
      runnerIdentity: identity,
    };
    const reader: HistoricalProofReader = {
      record() {
        return record;
      },
      history() {
        return undefined;
      },
      registrations() {
        return [];
      },
      valid() {
        return false;
      },
    };
    h.store.classifyHistoricalProof(check, classifyHistoricalProof(check, reader));
    expect(h.store.historicalProofSlots()).toEqual([check]);
    const task = h.store.createTask(
      h.proofBrief,
      { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit },
      'implementation',
    );
    h.store.updateTask({ taskId: task.id, attempt: 0 }, (current) => {
      current.proofAuthorization = h.store.task(h.proof.id).proofAuthorization!;
    });
    const next = h.store.nextAttempt({ taskId: task.id, attempt: 0 }, (n) =>
      attempt(task.id, n, h.settings.stateDirectory),
    );
    expect(h.store.reserveProof(newProofBinding(h.store.task(task.id), next.attempt))?.status).toBe('reserved');
    expect(h.store.proofCapacityAvailable('fixture', 'another-proof')).toBe(false);
    expect(h.store.proofCapacityReason('fixture', 'another-proof')).toContain(check.checkId);
    expect(h.store.proofCapacityAvailable('fixture', old.id)).toBe(false);
    // A mismatched start time denotes a gone/reused identity; no process is signalled or stopped by this case.
    const gone = { ...record, runnerIdentity: { ...identity, start: String(BigInt(identity.start) + 1n) } };
    h.store.classifyHistoricalProof(
      check,
      classifyHistoricalProof(check, {
        ...reader,
        record() {
          return gone;
        },
      }),
    );
    expect(h.store.historicalProofSlots()).toEqual([check]);
    expect(h.store.proofCapacityAvailable('fixture', 'another-proof')).toBe(false);
    h.store.close(ref, 'stopped');
    expect(h.store.historicalProofSlots()).toEqual([]);
    expect(h.store.proofCapacityAvailable('fixture', 'another-proof')).toBe(true);
    expect(h.store.attempt(ref).checks).toEqual([check.checkId]);
    expect(h.store.events(old.id).some((event) => event.kind === 'historical-proof-terminal')).toBe(false);
  } finally {
    h.dispose();
  }
});

test('unreserved retained product generations refresh through authenticated public first-start once without changing historical attempts or pending intent', async () => {
  const h = registeredFixture();
  try {
    const task = h.store.createTask(
      { ...brief(), kind: 'claim' },
      { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit },
      'claim',
    );
    let ref = { taskId: task.id, attempt: 0 };
    for (let n = 0; n < 2; n++)
      ref = h.store.nextAttempt(ref, (number) => attempt(task.id, number, h.settings.stateDirectory));
    h.store.updateAttempt(ref, (current) => {
      current.result = 'Historical product report';
      current.session = 'original-session';
    });
    h.store.close(ref, 'stopped');
    const raw = h.store.db.query('SELECT body FROM worker_attempts WHERE task_id=? ORDER BY attempt').all(task.id);
    const submitted = submittedProof(h);
    h.tasks.queueRetry(task.id, { expectedAttempt: 2, brief: submitted.path }, h.actor);
    const originalIntent = h.store.retryIntent(ref);
    const originalRecord = h.store.record(ref);
    writeFileSync(join(h.root, 'fresh-source'), 'fresh source');
    git(h.root, ['add', 'fresh-source']);
    git(h.root, ['commit', '-m', 'Advance integration for unreserved retained product proof']);
    const sourceCommit = git(h.root, ['rev-parse', 'HEAD']);
    git(h.root, ['update-ref', 'refs/heads/dev', sourceCommit]);
    const fresh = submittedProof(h, { proof: { ...h.proofBrief.proof, sourceCommit } });
    expect(() => h.tasks.queueProofStart(task.id, { expectedAttempt: 1, brief: fresh.path }, h.actor)).toThrow('stale');
    expect(() => h.tasks.queueProofStart(task.id, { expectedAttempt: 2, brief: fresh.path }, null)).toThrow(
      'authenticated',
    );
    const runtime = createRuntime({ tasks: h.tasks, db: h.store.db });
    const output: string[] = [];
    expect(
      await runWorkerCommand('retry', [task.id, '--proof-start', '--expected-attempt', '2', '--brief', fresh.path], {
        runtime,
        env: { CODEX_THREAD_ID: h.actor.sessionId },
        print: (value) => output.push(value),
      }),
    ).toBe(0);
    expect(JSON.parse(output[0]!)).toEqual({ taskId: task.id, attempt: 2, status: 'created' });
    expect(h.store.task(task.id).brief.proof?.sourceCommit).toBe(sourceCommit);
    expect(h.store.task(task.id).brief.acceptance.command).toEqual(submitted.brief.acceptance.command);
    expect(h.store.task(task.id).currentAttempt).toBe(2);
    expect(h.store.retryIntent(ref)).toEqual(originalIntent);
    expect(h.store.retryIntents().filter((intent) => intent.taskId === task.id)).toHaveLength(1);
    expect(h.store.record(ref)).toEqual(originalRecord);
    expect(h.store.db.query('SELECT body FROM worker_attempts WHERE task_id=? ORDER BY attempt').all(task.id)).toEqual(
      raw,
    );
    expect(h.store.proofReservation(task.id, 2)).toBeUndefined();
    h.tasks.queueProofStart(task.id, { expectedAttempt: 2 }, h.actor);
    expect(h.store.retryIntent(ref)).toEqual(originalIntent);
    const registeredRef = { taskId: task.id, attempt: h.store.task(task.id).currentAttempt };
    const next =
      h.store.attempt(registeredRef).state === 'stopped'
        ? h.store.retryStopped(task.id, (number) => attempt(task.id, number, h.settings.stateDirectory))
        : h.store.nextAttempt(registeredRef, (number) => attempt(task.id, number, h.settings.stateDirectory));
    const binding = newProofBinding(h.store.task(task.id), next.attempt);
    h.store.reserveProof(binding);
    h.store.bindProof(binding, { status: 'unknown', cause: 'Bound current proof is uncertain' });
    expect(() => h.tasks.queueProofStart(task.id, { expectedAttempt: 3, brief: fresh.path }, h.actor)).toThrow('stale');
    h.store.close(next, 'stopped');
    expect(h.tasks.queueProofStart(task.id, { expectedAttempt: 3, brief: fresh.path }, h.actor).status).toBe('created');
    expect(h.store.proofReservation(task.id, 3)?.binding).toEqual(binding);
  } finally {
    h.dispose();
  }
});

import {
  loadHistoricalProofReader,
  refreshHistoricalProofAdmission,
  validateHistoricalProofReaderSource,
} from './verification.ts';
import { SqliteLandingQueue } from './land.ts';

test('historical reader settings resolve only the explicit local source and reject empty values', () => {
  const h = harness();
  try {
    expect(h.settings.integration.checkScriptReaderRoot).toBeUndefined();
    const local = JSON.parse(readFileSync(h.settings.localFile, 'utf8'));
    local.integration = { checkScriptReaderRoot: '.temp/captured-native-source' };
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    expect(loadSettings({ cwd: h.root, env: {} }).integration.checkScriptReaderRoot).toBe(
      join(h.root, '.temp/captured-native-source'),
    );
    local.integration.checkScriptReaderRoot = '';
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    expect(() => checkSettings({ cwd: h.root, env: {} })).toThrow('nonempty');
  } finally {
    h.dispose();
  }
});

test('historical reader validates the complete captured closure before importing and reads deleted historical modules as data only', async () => {
  const directory = temporaryDirectory();
  try {
    // Only structural read APIs are installed. No native product/remote module or execution capability is imported.
    git(directory.path, ['clone', '--shared', '--no-checkout', resolve(import.meta.dir, '../../..'), '.']);
    git(directory.path, ['config', 'user.name', 'Fixture']);
    git(directory.path, ['config', 'user.email', 'fixture@example.invalid']);
    mkdirSync(join(directory.path, 'scripts'));
    writeFileSync(join(directory.path, '.gitignore'), '.temp/\n');
    const helper = `import {readFileSync} from 'node:fs';
import {join} from 'node:path';
export function read(cwd, path) { return JSON.parse(readFileSync(join(cwd,'.temp/goal/checks',path),'utf8')); }
`;
    writeFileSync(join(directory.path, 'scripts/reader-data.ts'), helper);
    const marker = join(directory.path, '.temp/imported');
    mkdirSync(join(directory.path, '.temp'));
    writeFileSync(
      join(directory.path, 'scripts/worker-check.ts'),
      `import {writeFileSync} from 'node:fs';
import {read} from './reader-data.ts';
writeFileSync(${JSON.stringify(marker)}, 'readonly reader imported');
export function readWorkerCheckRecord(id, cwd) { return read(cwd, 'results/'+id+'.json'); }
export function readWorkerCheckHistory(id, physical, cwd) { return read(cwd, 'history/'+id+'/'+physical+'.json'); }
`,
    );
    writeFileSync(
      join(directory.path, 'scripts/check-custody.ts'),
      `export function validRegistration() { throw new Error('No registrations in readonly fixture'); }\n`,
    );
    git(directory.path, ['add', '.']);
    const tree = git(directory.path, ['write-tree']);
    const commit = git(directory.path, [
      'commit-tree',
      tree,
      '-p',
      PROOF_PRODUCER_COMMIT,
      '-m',
      'Readonly reader fixture',
    ]);
    git(directory.path, ['update-ref', 'refs/heads/reader-fixture', commit]);
    git(directory.path, ['symbolic-ref', 'HEAD', 'refs/heads/reader-fixture']);
    git(directory.path, ['reset', '--hard', commit]);
    git(directory.path, ['branch', 'fixture-integration', commit]);
    const source = { root: directory.path, integrationRoot: directory.path, integrationBranch: 'fixture-integration' };
    expect(validateHistoricalProofReaderSource(source)).toBe(commit);
    expect(() => validateHistoricalProofReaderSource({ ...source, root: `${directory.path}/.` })).toThrow(
      'canonical Git',
    );
    git(directory.path, ['update-ref', 'refs/heads/fixture-integration', PROOF_PRODUCER_COMMIT]);
    await expect(loadHistoricalProofReader(join(directory.path, '.temp/registry'), source)).rejects.toThrow(
      'integration ancestor',
    );
    git(directory.path, ['update-ref', 'refs/heads/fixture-integration', commit]);
    writeFileSync(
      join(directory.path, 'scripts/reader-data.ts'),
      helper + '\nthrow new Error("Changed dependency");\n',
    );
    git(directory.path, ['update-index', '--assume-unchanged', 'scripts/reader-data.ts']);
    expect(git(directory.path, ['status', '--porcelain', '--untracked-files=no'])).toBe('');
    await expect(loadHistoricalProofReader(join(directory.path, '.temp/registry'), source)).rejects.toThrow(
      'differs from captured',
    );
    expect(existsSync(marker)).toBe(false);
    git(directory.path, ['update-index', '--no-assume-unchanged', 'scripts/reader-data.ts']);
    writeFileSync(join(directory.path, 'scripts/reader-data.ts'), helper);

    const oldCwd = join(directory.path, '.temp/deleted-producer');
    const check = { taskId: 'historical-task', attempt: 28, checkId: crypto.randomUUID(), cwd: oldCwd };
    const physicalRunId = crypto.randomUUID();
    mkdirSync(join(oldCwd, '.temp/goal/checks/results'), { recursive: true });
    mkdirSync(join(oldCwd, '.temp/goal/checks/history', check.checkId), { recursive: true });
    // There is deliberately no scripts directory in the historical cwd.
    const record = {
      custodyVersion: 1,
      id: check.checkId,
      cwd: oldCwd,
      physicalRunId,
      ownership: { taskId: check.taskId, attempt: check.attempt },
      status: 'unknown',
    };
    const physical = {
      version: 1,
      id: check.checkId,
      cwd: oldCwd,
      physicalRunId,
      ownership: record.ownership,
      status: 'unknown',
    };
    writeFileSync(join(oldCwd, '.temp/goal/checks/results', `${check.checkId}.json`), JSON.stringify(record));
    writeFileSync(
      join(oldCwd, '.temp/goal/checks/history', check.checkId, `${physicalRunId}.json`),
      JSON.stringify(physical),
    );
    const reader = await loadHistoricalProofReader(join(directory.path, '.temp/registry'), source);
    expect(readFileSync(marker, 'utf8')).toBe('readonly reader imported');
    expect(reader.record(check.checkId, oldCwd)).toEqual(record);
    expect(reader.history(check.checkId, physicalRunId, oldCwd)).toEqual(physical);
    expect(classifyHistoricalProof(check, reader)).toMatchObject({
      classification: 'historical-unknown',
      record,
      physical: [physical],
      registrations: [],
      processes: [],
    });
    writeFileSync(join(directory.path, 'scripts/reader-data.ts'), helper + '\n// Next captured revision\n');
    git(directory.path, ['add', 'scripts/reader-data.ts']);
    git(directory.path, ['commit', '-m', 'Move previously imported reader root']);
    git(directory.path, ['update-ref', 'refs/heads/fixture-integration', git(directory.path, ['rev-parse', 'HEAD'])]);
    await expect(loadHistoricalProofReader(join(directory.path, '.temp/registry'), source)).rejects.toThrow(
      'source changed',
    );
  } finally {
    directory.close();
  }
});

test('unavailable optional historical reader records one diagnostic while ordinary admission and orphan/retry recovery continue', async () => {
  const h = registeredFixture();
  try {
    h.settings.integration.checkScriptReaderRoot = join(h.root, '.temp/missing-reader');
    const old = h.store.createTask(
      brief(),
      { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit },
      'implementation',
    );
    const oldRef = h.store.nextAttempt({ taskId: old.id, attempt: 0 }, (n) =>
      attempt(old.id, n, h.settings.stateDirectory),
    );
    h.store.updateAttempt(oldRef, (current) => {
      current.checks = [crypto.randomUUID()];
      current.result = 'Raw historical report';
    });
    const raw = h.store.db.query('SELECT body FROM worker_attempts WHERE task_id=?').all(old.id);
    const checks = h.store.historicalProofChecks();
    const reservations = h.store.activeProofReservations();
    const source = {
      root: h.settings.integration.checkScriptReaderRoot,
      integrationRoot: h.root,
      integrationBranch: 'dev',
    };
    await expect(
      refreshHistoricalProofAdmission(h.store, join(h.settings.stateDirectory, 'check-registry'), source),
    ).rejects.toBeInstanceOf(ProofUnavailableError);
    await h.tasks.refreshProofAdmission(h.store.task(h.proof.id));
    expect(h.store.proofCapacityAvailable('fixture', 'another')).toBe(true);

    const ordinary = h.store.createTask(
      brief(),
      { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit },
      'implementation',
    );
    const ref = h.store.nextAttempt({ taskId: ordinary.id, attempt: 0 }, (n) =>
      attempt(ordinary.id, n, h.settings.stateDirectory),
    );
    h.store.updateAttempt(ref, (current) => {
      current.state = 'exited';
      current.endedAt = new Date().toISOString();
      current.exitCode = 0;
      current.result = 'RESULT: success';
    });
    h.store.updateTask(ref, (current) => {
      current.state = 'landing';
    });
    h.store.landing(
      {
        ...ref,
        branch: ordinary.branch,
        worktree: ordinary.worktree,
        declaredPaths: ordinary.brief.paths,
        gate: ordinary.brief.acceptance.command,
      },
      () => {},
    );
    const inbox: ManagerEvent[] = [];
    const job = new WorkerJob(h.tasks, new SqliteLandingQueue(h.store.db, h.store), {
      deliver: (event) => inbox.push(event),
    });
    let retrySweeps = 0;
    // Observe durable recovery without launching a worker or native check in this receiving test.
    job.resumePendingRetries = () => {
      retrySweeps++;
    };
    await job.recoverOrphans();
    await job.drain();
    await job.recoverOrphans();
    await job.drain();
    expect(retrySweeps).toBe(2);
    expect(h.store.task(ordinary.id).state).toBe('ready');
    expect(h.store.retryIntent(ref)?.status).toBe('pending');
    expect(h.store.events(ordinary.id).filter((event) => event.kind === 'orphaned-landing-recovered')).toHaveLength(1);
    expect(inbox.filter((event) => event.taskId === ordinary.id)).toHaveLength(1);
    expect(h.store.events().filter((event) => event.kind === 'historical-proof-reader-unavailable')).toHaveLength(1);
    expect(
      h.store
        .events(old.id)
        .some((event) => ['historical-proof-classified', 'historical-proof-terminal'].includes(event.kind)),
    ).toBe(false);
    expect(h.store.historicalProofSlots()).toEqual(checks);
    expect(h.store.activeProofReservations()).toEqual(reservations);
    expect(h.store.db.query('SELECT body FROM worker_attempts WHERE task_id=?').all(old.id)).toEqual(raw);
  } finally {
    h.dispose();
  }
});

import { ordinaryProofCommand, observeOrdinaryProof, readProofObservation, registeredProof } from './verification.ts';

function ordinaryTask(root: string): import('./types.ts').Task {
  const contract = {
    ...brief(),
    kind: 'verification' as const,
    paths: [],
    acceptance: { ...brief().acceptance, command: ['bun', 'test', 'fixture.test.ts'] },
    proof: { journey: 'Original', sourceTasks: ['original'], sourceCommit: 'a'.repeat(40) },
  };
  return {
    id: 'ordinary-proof',
    sequence: 1,
    brief: contract,
    briefPath: '',
    state: 'running',
    worktree: root,
    branch: 'worker/ordinary-proof',
    base: contract.proof.sourceCommit,
    taskClass: 'implementation',
    currentAttempt: 1,
    createdAt: new Date().toISOString(),
    proofAuthorization: {
      fingerprint: proofFingerprint(contract),
      manager: contract.manager,
      sessionId: 'authenticated-owner',
      integrationBranch: 'dev',
      sourceTree: 'b'.repeat(40),
      originals: [{ taskId: 'original', commit: contract.proof.sourceCommit, argv: contract.acceptance.command }],
    },
  };
}

test('ordinary original invocation preserves whole Auth, helper union and exact env/local wrapper argv without a native port or double wrapping', () => {
  const auth = ['bun', 'run', '--cwd', 'services/auth', 'check'];
  expect(ordinaryProofCommand(auth)).toEqual({
    invocation: ['bun', 'scripts/worker-check.ts', '--', ...auth],
    recordedArgv: auth,
  });
  const helpers = [
    'env',
    '-u',
    'KERNEL_CHECK_REMOTE',
    'bun',
    'run',
    '--cwd',
    'services/kernel',
    'check',
    'identity-fixture.ts',
    'identity-driver.ts',
    'identity-outcomes.test.ts',
  ];
  expect(ordinaryProofCommand(helpers).recordedArgv).toEqual(helpers);
  const wrapped = [
    'env',
    '-u',
    'KERNEL_CHECK_REMOTE',
    'bun',
    'scripts/worker-check.ts',
    '--local',
    '--',
    'bun',
    'test',
    'fixture.ts',
    'driver.ts',
    'outcomes.test.ts',
  ];
  expect(ordinaryProofCommand(wrapped)).toEqual({ invocation: wrapped, recordedArgv: wrapped.slice(7) });
  expect(wrapped.filter((word) => word === 'scripts/worker-check.ts')).toHaveLength(1);
  for (const invalid of [
    ['bun', 'run', 'check'],
    ['bun', 'scripts/gate857.ts'],
    ['sh', '-c', auth.join(' ')],
    ['bun', 'scripts/worker-check.ts', '--local', '--', ...wrapped],
    ['bun', 'run', '--cwd', 'services/kernel', 'check', '--changed', 'outcomes.test.ts'],
  ])
    expect(() => ordinaryProofCommand(invalid)).toThrow();
});

test('ordinary original result uses actual wrapper exit without optional custody and rejects wrong owner, attempt, argv or unknown terminal status', () => {
  const task = ordinaryTask('/work/proof');
  const id = '11111111-1111-4111-8111-111111111111';
  const record = {
    id,
    cwd: task.worktree,
    ownership: { taskId: task.id, attempt: 1 },
    argv: task.brief.acceptance.command,
    status: 'finished',
    exitCode: 0,
    log: '.temp/original.log',
  };
  expect(registeredProof(task.brief, task.proofAuthorization)).toBe(true);
  expect(observeOrdinaryProof(task, id, record)).toMatchObject({ status: 'terminal', passed: true, physical: [] });
  expect(observeOrdinaryProof(task, id, { ...record, status: 'running', exitCode: undefined }).status).toBe('running');
  expect(
    observeOrdinaryProof(task, id, { ...record, exitCode: 1, failureSummary: 'actual failed assertion' }),
  ).toMatchObject({ status: 'terminal', passed: false, cause: expect.stringContaining('actual failed assertion') });
  for (const wrong of [
    { ...record, ownership: undefined },
    { ...record, ownership: { taskId: 'foreign', attempt: 1 } },
    { ...record, ownership: { taskId: task.id, attempt: 2 } },
    { ...record, cwd: '/other' },
    { ...record, argv: ['bun', 'test', 'narrowed.test.ts'] },
    { ...record, exitCode: undefined },
    { ...record, exitCode: '0' },
  ])
    expect(observeOrdinaryProof(task, id, wrong)).toMatchObject({ status: 'unknown', passed: false });
  const unregistered = { ...task };
  delete unregistered.proofAuthorization;
  expect(observeOrdinaryProof(unregistered, id, record).passed).toBe(false);
});

test('ordinary original records wait then terminate without token/physical receipts and detect duplicate current invocation while ignoring older evidence', async () => {
  const directory = temporaryDirectory();
  try {
    const task = ordinaryTask(directory.path);
    const results = join(directory.path, '.temp/goal/checks/results');
    mkdirSync(results, { recursive: true });
    const id = crypto.randomUUID(),
      old = crypto.randomUUID(),
      duplicate = crypto.randomUUID();
    const record = {
      id,
      cwd: task.worktree,
      ownership: { taskId: task.id, attempt: 1 },
      argv: task.brief.acceptance.command,
      status: 'running',
      log: '.temp/original.log',
    };
    writeFileSync(join(results, `${id}.json`), JSON.stringify(record));
    writeFileSync(
      join(results, `${old}.json`),
      JSON.stringify({ ...record, id: old, ownership: { taskId: task.id, attempt: 0 } }),
    );
    expect((await readProofObservation(task, [id])).status).toBe('running');
    expect((await readProofObservation(task, [`bun check ${id}`])).passed).toBe(false);
    writeFileSync(join(results, `${id}.json`), JSON.stringify({ ...record, status: 'finished', exitCode: 0 }));
    expect(await readProofObservation(task)).toMatchObject({ status: 'terminal', passed: true, record: { id } });
    writeFileSync(join(results, `${duplicate}.json`), JSON.stringify({ ...record, id: duplicate }));
    expect(await readProofObservation(task, [id])).toMatchObject({
      status: 'unknown',
      passed: false,
      cause: expect.stringContaining('exactly one'),
    });
  } finally {
    directory.close();
  }
});

test('public logical release authenticates exact generation, retains unknown binding and physical facts, and refuses a live ordinary run', async () => {
  const h = registeredFixture();
  try {
    const unknown = {
      status: 'unknown' as const,
      passed: false,
      cause: 'Optional native custody unavailable',
      record: null,
      physical: [{ retained: 'unknown' }],
    };
    h.store.observeProof(h.binding, unknown);
    expect(() => h.tasks.releaseProof(h.proof.id, 1, h.actor)).toThrow('stopped or exited');
    h.store.close(h.current, 'stopped');
    const raw = h.store.db.query('SELECT body FROM worker_attempts WHERE task_id=?').all(h.proof.id);
    const path = join(h.settings.stateDirectory, 'physical-lease');
    writeFileSync(path, 'unknown physical owner retained');
    expect(() => h.tasks.releaseProof(h.proof.id, 0, h.actor)).toThrow('stale');
    expect(() => h.tasks.releaseProof(h.proof.id, 1, null)).toThrow('authenticated');
    const output: string[] = [];
    const runtime = createRuntime({ tasks: h.tasks, db: h.store.db });
    expect(
      await runWorkerCommand('retry', [h.proof.id, '--release-proof', '--expected-attempt', '1'], {
        runtime,
        env: { CODEX_THREAD_ID: h.actor.sessionId },
        print: (value) => output.push(value),
      }),
    ).toBe(0);
    expect(JSON.parse(output[0]!)).toEqual({
      taskId: h.proof.id,
      attempt: 1,
      status: 'released',
      checks: [h.binding.checkId],
    });
    expect(h.store.proofReservation(h.proof.id, 1)).toMatchObject({
      status: 'released',
      binding: h.binding,
      observation: unknown,
      logicalRelease: { reason: expect.stringContaining('native custody remains independent') },
    });
    expect(h.store.db.query('SELECT body FROM worker_attempts WHERE task_id=?').all(h.proof.id)).toEqual(raw);
    expect(readFileSync(path, 'utf8')).toBe('unknown physical owner retained');
    expect(h.tasks.releaseProof(h.proof.id, 1, h.actor).checks).toEqual([]);
    expect(h.store.events(h.proof.id).filter((event) => event.kind === 'proof-logical-released')).toHaveLength(1);
    expect(h.store.events(h.proof.id).some((event) => event.kind === 'historical-proof-terminal')).toBe(false);
  } finally {
    h.dispose();
  }
});

test('ordinary proof preparation preserves clean retained empty-report commits and launches only the fresh authorized capture', async () => {
  const h = registeredFixture(true);
  try {
    const retained = join(h.root, '.temp/retained-product');
    git(h.root, ['worktree', 'add', '-b', 'retained-product', retained, h.binding.sourceCommit]);
    git(retained, ['commit', '--allow-empty', '-m', 'Retained empty product report']);
    const retainedHead = git(retained, ['rev-parse', 'HEAD']);
    const task = h.store.createTask(
      { ...brief(), kind: 'claim' },
      { briefPath: h.briefFile, worktree: retained, branch: 'retained-product', base: h.binding.sourceCommit },
      'claim',
    );
    const old = h.store.nextAttempt({ taskId: task.id, attempt: 0 }, (n) =>
      attempt(task.id, n, h.settings.stateDirectory),
    );
    h.store.updateAttempt(old, (value) => {
      value.result = 'Retained paid report';
      value.session = 'retained-session';
    });
    h.store.close(old, 'stopped');
    writeFileSync(join(h.root, 'fresh-capture'), 'Current integrated source');
    git(h.root, ['add', 'fresh-capture']);
    git(h.root, ['commit', '-m', 'Fresh proof capture']);
    const sourceCommit = git(h.root, ['rev-parse', 'HEAD']);
    git(h.root, ['update-ref', 'refs/heads/dev', sourceCommit]);
    const submitted = submittedProof(h, { proof: { ...h.proofBrief.proof, sourceCommit } });
    h.tasks.queueProofStart(task.id, { expectedAttempt: 1, brief: submitted.path }, h.actor);
    let launches = 0;
    const tasks = new WorkerTasks(
      h.settings,
      h.store,
      (pool) => reading(pool),
      async (store, current, next) => {
        launches++;
        expect(current.worktree).not.toBe(retained);
        expect(git(current.worktree, ['rev-parse', 'HEAD'])).toBe(sourceCommit);
        expect(git(current.worktree, ['branch', '--show-current'])).toBe('');
        expect(current.brief.acceptance.command).toEqual(submitted.brief.acceptance.command);
        expect(current.proofRun).toBeUndefined();
        const saved = store.updateAttempt(next, (value) => {
          value.state = 'running';
        });
        store.updateTask(next, (value) => {
          value.state = 'running';
        });
        return { attempt: saved, exited: Promise.resolve({ code: 0, signal: null }) };
      },
    );
    await tasks.retry(task.id, { expectedAttempt: 1 });
    expect(launches).toBe(1);
    expect(h.store.task(task.id).currentAttempt).toBe(2);
    expect(git(retained, ['rev-parse', 'HEAD'])).toBe(retainedHead);
    expect(git(retained, ['status', '--porcelain'])).toBe('');
    expect(h.store.attempt(old)).toMatchObject({ result: 'Retained paid report', session: 'retained-session' });
    expect(h.store.record(old)?.taskKind).toBe('claim');
    expect(h.store.events(task.id).filter((event) => event.kind === 'proof-source-prepared')).toHaveLength(1);
    expect(h.store.events(task.id).filter((event) => event.kind === 'proof-command-ready')).toHaveLength(1);
    expect(h.store.retryIntents().filter((intent) => intent.taskId === task.id)).toHaveLength(1);
  } finally {
    h.dispose();
  }
});

test('interrupted ordinary proof launch never replays a prepared command or permits same-source argv replacement', async () => {
  const h = registeredFixture(true);
  try {
    const submitted = submittedProof(h);
    const task = h.store.createTask(
      submitted.brief,
      { briefPath: submitted.path, worktree: h.root, branch: 'main', base: h.binding.sourceCommit },
      'implementation',
    );
    h.tasks.queueProofStart(task.id, { expectedAttempt: 0 }, h.actor);
    const current = h.store.nextAttempt(
      { taskId: task.id, attempt: 0 },
      (n) => ({
        ...attempt(task.id, n, h.settings.stateDirectory),
        state: 'pending',
        startedAt: new Date(0).toISOString(),
      }),
      undefined,
      true,
    );
    h.store.event(current, 'proof-command-ready', { argv: task.brief.acceptance.command, cwd: task.worktree });
    let launches = 0;
    const tasks = new WorkerTasks(
      h.settings,
      h.store,
      (pool) => reading(pool),
      async () => {
        launches++;
        throw new Error('Unknown original invocation must not replay');
      },
    );
    const job = new WorkerJob(tasks, { enqueue() {} }, { deliver() {} });
    await job.recoverOrphans();
    await job.drain();
    expect(launches).toBe(0);
    expect(h.store.task(task.id)).toMatchObject({ currentAttempt: 1, state: 'stopped' });
    expect(h.store.attempt(current)).toMatchObject({
      state: 'exited',
      failureKind: 'tool',
      blocker: expect.stringContaining('no automatic replay'),
    });
    expect(h.store.attempts(task.id)).toHaveLength(1);
    expect(h.store.proofReservation(task.id, 1)).toBeUndefined();
    expect(h.store.proofCapacityAvailable('fixture', 'another')).toBe(true);
    expect(() =>
      h.store.assertProofRegistration(current, {
        ...task.brief,
        acceptance: { ...task.brief.acceptance, command: ['bun', 'test', 'different.test.ts'] },
      }),
    ).toThrow('may never be replaced');
    expect(h.store.events(task.id).some((event) => event.kind === 'proof-verified')).toBe(false);
  } finally {
    h.dispose();
  }
});

test('authenticated stopped UNKNOWN proof retry captures fresh SAME-ID source without reconciliation and retains old binding and report', async () => {
  const h = registeredFixture(true);
  try {
    const oldBrief = structuredClone(h.store.task(h.proof.id).brief);
    const oldAuthorization = h.store.task(h.proof.id).proofAuthorization;
    const unknown = {
      status: 'unknown' as const,
      passed: false,
      cause: 'Retained native result unavailable',
      record: null,
      physical: [{ physicalRunId: 'retained-unknown', cleanup: null }],
    };
    h.store.observeProof(h.binding, unknown);
    h.store.updateAttempt(h.current, (value) => {
      value.result = 'Paid original report';
      value.session = 'paid-session';
      value.checks = [h.binding.checkId];
    });
    h.store.putRecord({
      ...makeRecord(
        h.store.task(h.proof.id),
        h.store.attempt(h.current),
        readMeasurement(h.store.attempt(h.current)),
        'stopped',
      ),
      proof: unknown,
    });
    const rawRecord = h.store.db.query('SELECT body FROM worker_records WHERE task_id=? AND attempt=1').get(h.proof.id);
    const originalEvents = h.store.events(h.proof.id);
    h.store.close(h.current, 'stopped');
    const rawAttempt = h.store.db
      .query('SELECT body FROM worker_attempts WHERE task_id=? AND attempt=1')
      .get(h.proof.id);
    const originalHead = git(h.root, ['rev-parse', 'HEAD']);
    // Advance integration independently; retain the original proof cwd/branch and empty report history.
    const integrated = join(h.root, '.temp/new-integration');
    git(h.root, ['worktree', 'add', '-b', 'new-integration', integrated, originalHead]);
    writeFileSync(join(integrated, 'new-source'), 'Fresh integrated capture');
    git(integrated, ['add', 'new-source']);
    git(integrated, ['commit', '-m', 'Capture future proof source']);
    const sourceCommit = git(integrated, ['rev-parse', 'HEAD']);
    git(h.root, ['update-ref', 'refs/heads/dev', sourceCommit]);
    const fresh = submittedProof(h, { proof: { ...h.proofBrief.proof, sourceCommit } });
    expect(() => h.tasks.queueProofStart(h.proof.id, { expectedAttempt: 1, brief: fresh.path }, null)).toThrow(
      'authenticated',
    );
    expect(() => h.tasks.queueProofStart(h.proof.id, { expectedAttempt: 2, brief: fresh.path }, h.actor)).toThrow(
      'stale',
    );
    const runtime = createRuntime({ tasks: h.tasks, db: h.store.db });
    const output: string[] = [];
    const retainedRow = h.store.db
      .query('SELECT body FROM worker_proof_reservations WHERE task_id=? AND attempt=1')
      .get(h.proof.id);
    const retainedRun = h.store.proofReservation(h.proof.id, 1)!;
    expect(retainedRun).toMatchObject({ binding: h.binding, status: 'bound', observation: unknown });
    const changedArgv = submittedProof(h, {
      proof: fresh.brief.proof!,
      acceptance: { ...fresh.brief.acceptance, command: [...fresh.brief.acceptance.command, '--changed'] },
    });
    expect(() => h.tasks.queueProofStart(h.proof.id, { expectedAttempt: 1, brief: changedArgv.path }, h.actor)).toThrow(
      'proof cannot register a broad root or gate campaign',
    );
    expect(() => h.store.assertProofRegistration(h.current, changedArgv.brief)).toThrow('exact original acceptance');
    const changedOriginal = submittedProof(h, { proof: { ...fresh.brief.proof!, journey: 'Different journey' } });
    expect(() =>
      h.tasks.queueProofStart(h.proof.id, { expectedAttempt: 1, brief: changedOriginal.path }, h.actor),
    ).toThrow('exact original metadata');
    expect(h.store.retryIntent(h.current)).toBeUndefined();
    expect(h.store.task(h.proof.id).brief).toEqual(oldBrief);
    expect(
      h.store.db.query('SELECT body FROM worker_proof_reservations WHERE task_id=? AND attempt=1').get(h.proof.id),
    ).toEqual(retainedRow);
    expect(
      await runWorkerCommand('retry', [h.proof.id, '--proof-start', '--expected-attempt', '1', '--brief', fresh.path], {
        runtime,
        env: { CODEX_THREAD_ID: h.actor.sessionId },
        print: (value) => output.push(value),
      }),
    ).toBe(0);
    expect(JSON.parse(output.pop()!)).toEqual({ taskId: h.proof.id, attempt: 1, status: 'created' });
    const registered = h.store.task(h.proof.id);
    expect(registered).toMatchObject({ currentAttempt: 1, brief: { proof: fresh.brief.proof }, proofRun: retainedRun });
    expect(registered.brief.acceptance).toEqual(oldBrief.acceptance);
    expect(h.store.db.query('SELECT body FROM worker_attempts WHERE task_id=? AND attempt=1').get(h.proof.id)).toEqual(
      rawAttempt,
    );
    expect(h.store.proofReservation(h.proof.id, 2)).toBeUndefined();
    expect(
      h.store.db.query('SELECT body FROM worker_proof_reservations WHERE task_id=? AND attempt=1').get(h.proof.id),
    ).toEqual(retainedRow);
    expect(
      h.store
        .events(h.proof.id)
        .some((event) => ['proof-logical-reconciled', 'proof-logical-released'].includes(event.kind)),
    ).toBe(false);
    const archived = h.store.events(h.proof.id).filter((event) => event.kind === 'proof-registration-replaced');
    expect(archived).toHaveLength(1);
    expect(JSON.parse(archived[0]!.body)).toMatchObject({
      brief: oldBrief,
      authorization: oldAuthorization,
      previousFingerprint: proofFingerprint(oldBrief),
      newFingerprint: proofFingerprint(fresh.brief),
      proofRun: retainedRun,
    });
    const oldRecord = h.store.record(h.current);
    h.tasks.queueProofStart(h.proof.id, { expectedAttempt: 1 }, h.actor);
    expect(h.store.retryIntents().filter((intent) => intent.taskId === h.proof.id)).toEqual([
      { taskId: h.proof.id, attempt: 1, options: {}, status: 'pending' },
    ]);
    expect(h.store.record(h.current)).toEqual(oldRecord);
    expect(h.store.events(h.proof.id).filter((event) => event.kind === 'proof-registration-replaced')).toHaveLength(1);
    let launches = 0;
    const futureCheck = crypto.randomUUID();
    const tasks = new WorkerTasks(
      h.settings,
      h.store,
      (pool) => reading(pool),
      async (store, task, next) => {
        launches++;
        expect(task.id).toBe(h.proof.id);
        expect(next.attempt).toBe(2);
        expect(git(task.worktree, ['rev-parse', 'HEAD'])).toBe(sourceCommit);
        expect(task.worktree).not.toBe(h.binding.cwd);
        expect(task.brief.acceptance.command).toEqual(h.binding.argv);
        expect(task.proofRun).toMatchObject({ binding: h.binding, observation: unknown, status: 'released' });
        // Host policy disposition is optional evidence, never this invocation's identity.
        const saved = store.updateAttempt(next, (value) => {
          value.state = 'waiting';
          value.checks = [futureCheck];
        });
        store.updateTask(next, (value) => {
          value.state = 'running';
        });
        return { attempt: saved, exited: Promise.resolve({ code: 0, signal: null }) };
      },
    );
    await tasks.retry(h.proof.id, { expectedAttempt: 1 });
    expect(launches).toBe(1);
    expect(futureCheck).not.toBe(h.binding.checkId);
    expect(h.store.task(h.proof.id).currentAttempt).toBe(2);
    expect(h.store.events(h.proof.id, 2).filter((event) => event.kind === 'proof-command-ready')).toHaveLength(1);
    expect(h.store.proofReservation(h.proof.id, 2)).toBeUndefined();
    const disposed = h.store.proofReservation(h.proof.id, 1)!;
    expect(disposed.logicalRelease?.reason).toContain('native custody remains independent');
    const { logicalRelease, ...oldEvidence } = disposed;
    expect(oldEvidence).toEqual({ ...retainedRun, status: 'released' });
    expect(h.store.events(h.proof.id).slice(0, originalEvents.length)).toEqual(originalEvents);
    expect(h.store.attempt(h.current)).toMatchObject({
      result: 'Paid original report',
      session: 'paid-session',
      checks: [h.binding.checkId],
    });
    expect(h.store.db.query('SELECT body FROM worker_records WHERE task_id=? AND attempt=1').get(h.proof.id)).toEqual(
      rawRecord,
    );
    expect(git(h.root, ['rev-parse', 'HEAD'])).toBe(originalHead);
    expect(
      h.store.events(h.proof.id).some((event) => ['proof-verified', 'historical-proof-terminal'].includes(event.kind)),
    ).toBe(false);
    // The new current wait consumes one logical slot; released UNKNOWN history consumes none.
    for (let index = 0; index < 2; index++) {
      const task = h.store.createTask(
        fresh.brief,
        { briefPath: fresh.path, worktree: integrated, branch: 'new-integration', base: sourceCommit },
        'implementation',
      );
      h.tasks.queueProofStart(task.id, { expectedAttempt: 0 }, h.actor);
      h.store.nextAttempt(
        { taskId: task.id, attempt: 0 },
        (n) => attempt(task.id, n, h.settings.stateDirectory),
        undefined,
        true,
      );
    }
    expect(h.store.proofCapacityAvailable('fixture', 'fourth')).toBe(false);
    expect(() => h.tasks.queueProofStart(h.proof.id, { expectedAttempt: 1, brief: fresh.path }, h.actor)).toThrow(
      'stale',
    );
    expect(() => h.tasks.queueProofStart(h.proof.id, { expectedAttempt: 2, brief: fresh.path }, h.actor)).toThrow(
      'stale',
    );
    expect(() => h.tasks.releaseProof(h.proof.id, 2, h.actor)).toThrow('stopped or exited');
  } finally {
    h.dispose();
  }
});

test('ordinary exited command-ready proof retries without reconciliation and refuses a still-live terminal driver', () => {
  const h = registeredFixture(true);
  try {
    const submitted = submittedProof(h);
    const task = h.store.createTask(
      submitted.brief,
      { briefPath: submitted.path, worktree: h.root, branch: 'main', base: h.binding.sourceCommit },
      'implementation',
    );
    h.tasks.queueProofStart(task.id, { expectedAttempt: 0 }, h.actor);
    const ref = h.store.nextAttempt({ taskId: task.id, attempt: 0 }, (n) =>
      attempt(task.id, n, h.settings.stateDirectory),
    );
    h.store.updateRetryIntent({ taskId: task.id, attempt: 0 }, (value) => {
      value.status = 'started';
      value.nextAttempt = ref.attempt;
    });
    h.store.event(ref, 'proof-command-ready', {
      sourceCommit: h.binding.sourceCommit,
      argv: submitted.brief.acceptance.command,
    });
    // A retained exited worker may still have the task's running state until host settlement.
    h.store.updateAttempt(ref, (value) => {
      value.state = 'exited';
      value.endedAt = new Date().toISOString();
    });
    h.store.updateTask(ref, (value) => {
      value.state = 'running';
    });
    expect(h.tasks.queueProofStart(task.id, { expectedAttempt: 1 }, h.actor).status).toBe('created');
    expect(h.store.proofReservation(task.id, 1)).toBeUndefined();
    expect(h.store.events(task.id, 1).filter((event) => event.kind === 'proof-logical-reconciled')).toHaveLength(0);
    expect(
      h.store.retryIntents().filter((intent) => intent.taskId === task.id && intent.status === 'pending'),
    ).toHaveLength(1);
    const live = h.store.createTask(
      submitted.brief,
      { briefPath: submitted.path, worktree: h.root, branch: 'main', base: h.binding.sourceCommit },
      'implementation',
    );
    const liveRef = h.store.nextAttempt({ taskId: live.id, attempt: 0 }, (n) => ({
      ...attempt(live.id, n, h.settings.stateDirectory),
      driver: processIdentity(),
    }));
    h.store.event(liveRef, 'proof-command-ready', { argv: submitted.brief.acceptance.command });
    h.store.close(liveRef, 'stopped');
    expect(() => h.tasks.releaseProof(live.id, 1, h.actor)).toThrow('live or uncertain');
    expect(h.store.releaseExitedProofReservations(liveRef)).toEqual([]);
    expect(h.store.events(live.id, 1).some((event) => event.kind === 'proof-logical-reconciled')).toBe(false);
    expect(() => h.tasks.queueProofStart(live.id, { expectedAttempt: 1 }, h.actor)).toThrow('stale');
  } finally {
    h.dispose();
  }
});
