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

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
function registeredFixture() {
  const h = harness();
  // These are the current delivered reader exports and record layout, without launching any native check.
  writeFileSync(
    join(h.root, 'scripts/worker-check.ts'),
    `import {readFileSync} from 'node:fs';
import {join} from 'node:path';
export function readWorkerCheckRecord(id, cwd) { return JSON.parse(readFileSync(join(cwd,'.temp/goal/checks/results',id+'.json'),'utf8')); }
export function readWorkerCheckHistory(id, physical, cwd) { return JSON.parse(readFileSync(join(cwd,'.temp/goal/checks/history',id,physical+'.json'),'utf8')); }
`,
  );
  git(h.root, ['add', 'scripts/worker-check.ts']);
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

test('one SQLite admission transaction limits each Goal to three owned originals across controllers, waits and crashes', () => {
  const h = registeredFixture();
  const secondDb = openDb(join(h.settings.stateDirectory, 'goal.sqlite'));
  try {
    const second = new WorkerStore(secondDb);
    const add = (goal = h.proofBrief.goal) => {
      const contract = { ...h.proofBrief, goal };
      const task = h.store.createTask(
        contract,
        { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit },
        'implementation',
      );
      h.store.updateTask({ taskId: task.id, attempt: 0 }, (current) => {
        current.proofAuthorization = {
          ...h.store.task(h.proof.id).proofAuthorization!,
          fingerprint: proofFingerprint(contract),
        };
      });
      const current = h.store.nextAttempt({ taskId: task.id, attempt: 0 }, (n) =>
        attempt(task.id, n, h.settings.stateDirectory),
      );
      return { current, binding: newProofBinding(h.store.task(task.id), current.attempt) };
    };
    const two = add(),
      three = add(),
      queued = add(),
      other = add('other-goal');
    expect(second.reserveProof(two.binding)?.status).toBe('reserved');
    h.store.bindProof(two.binding, { status: 'unavailable', cause: 'producer lost after reservation' });
    expect(h.store.reserveProof(three.binding)?.status).toBe('reserved');
    h.store.bindProof(three.binding, { status: 'bound', binding: three.binding });
    h.store.updateAttempt(h.current, (current) => {
      current.state = 'waiting';
      current.checks = [h.binding.checkId];
    });
    h.store.updateAttempt(three.current, (current) => {
      current.state = 'exited';
    });
    expect(second.reserveProof(queued.binding)).toBeNull();
    expect(second.reserveProof(other.binding)?.status).toBe('reserved');
    // A new controller observes durable unknown, waiting and detached ownership instead of freeing it.
    const recovered = new WorkerStore(secondDb);
    expect(recovered.reserveProof(queued.binding)).toBeNull();
    expect(recovered.proofReservation(two.binding.taskId, 1)?.status).toBe('unknown');
    const { record, physical } = records(h.binding);
    const terminal = observeProof(h.binding, { record: () => record, history: () => physical });
    h.store.observeProof(h.binding, terminal);
    expect(recovered.reserveProof(queued.binding)?.status).toBe('reserved');
    // Only explicit, proven never-started producer refusal releases an unstarted reservation.
    h.store.bindProof(queued.binding, {
      status: 'refused',
      provenNeverStarted: true,
      cause: 'runner refused before exec',
    });
    expect(recovered.proofReservation(queued.binding.taskId, 1)?.status).toBe('released');
  } finally {
    secondDb.close();
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
import { createRuntime } from './config.ts';
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
    const identity = ['test/imports/identity-fixture.ts', 'test/imports/identity-driver.ts', 'test/imports/identity-outcomes.test.ts'];
    const growth = ['test/imports/growth-fixture.ts', 'test/imports/growth-driver.ts', 'test/imports/growth-sqlite-capture.ts', 'test/imports/growth-outcomes.test.ts', identity[2]!];
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
      const task = h.store.createTask({ ...brief(), acceptance: { ...brief().acceptance, command } },
        { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: sourceCommit }, 'implementation');
      h.store.updateTask({ taskId: task.id, attempt: 0 }, (current) => {
        current.state = 'integrated';
        current.integratedCommit = sourceCommit;
      });
      return task.id;
    };
    const auth = ['bun', 'run', '--cwd', 'services/auth', 'check'];
    const authTask = original(auth);
    const whole = submittedProof(h, { proof: { ...h.proofBrief.proof, sourceTasks: [authTask], sourceCommit }, acceptance: { ...h.proofBrief.acceptance, command: auth } }).brief;
    expect(authorizeProof(h.store, h.root, whole, h.actor, 'operations', 'dev').originals).toEqual([
      { taskId: authTask, commit: sourceCommit, argv: auth },
    ]);
    expect(() => authorizeProof(h.store, h.root, { ...whole, proof: { ...whole.proof!, sourceTasks: [h.source.id] } }, h.actor, 'operations', 'dev')).toThrow('every whole original');
    expect(() => authorizeProof(h.store, h.root, { ...whole, acceptance: { ...whole.acceptance, command: [...auth, 'test/short.test.ts'] } }, h.actor, 'operations', 'dev')).toThrow('every whole original');
    const kernel = ['bun', 'run', '--cwd', 'services/kernel', 'check'];
    expect(authorizeProof(h.store, h.root, { ...whole, proof: { ...whole.proof!, sourceTasks: [original(kernel)] }, acceptance: { ...whole.acceptance, command: kernel } }, h.actor, 'operations', 'dev').originals[0]?.argv).toEqual(kernel);
    for (const env of [[], ['env', '-u', 'KERNEL_CHECK_REMOTE']]) {
      const a = [...env, ...prefix, ...identity], b = [...env, ...prefix, ...growth];
      const command = [...env, ...prefix, ...new Set([...identity, ...growth])];
      const proof = { ...whole, proof: { ...whole.proof!, sourceTasks: [original(a), original(b)] }, acceptance: { ...whole.acceptance, command } };
      expect(authorizeProof(h.store, h.root, proof, h.actor, 'operations', 'dev').originals.map((entry) => entry.argv)).toEqual([a, b]);
      expect(preflightProof(h.root, proof)).toEqual([]);
      expect(originalCommandMatches([...env, ...prefix, ...command.slice(env.length + prefix.length + 1)], [a, b])).toBe(false);
      expect(originalCommandMatches([...env, ...prefix, ...identity, ...growth], [a, b])).toBe(false);
      expect(originalCommandMatches(command, [a, ['env', 'CI=1', ...prefix, ...growth]])).toBe(false);
      expect(originalCommandMatches(command, [a, [...env, ...prefix, '--timeout', '30000', ...growth]])).toBe(false);
      expect(preflightProof(h.root, { ...proof, acceptance: { ...proof.acceptance, command: [...command, 'test/imports/missing-helper.ts'] } })).toEqual(['test/imports/missing-helper.ts']);
    }
    for (const command of [
      ['bun', 'run', 'check'], ['bun', 'test'], ['bun', 'run', 'gate857', 'fixture.test.ts'],
      ['sh', '-c', 'bun test fixture.test.ts'], ['bun', 'test', '--preload', 'fixture.test.ts'],
      ['bun', 'scripts/worker-check.ts', '--local', '--', 'bun', 'scripts/worker-check.ts', '--', 'bun', 'test', 'fixture.test.ts'],
    ]) {
      const proof = { ...whole, proof: { ...whole.proof!, sourceTasks: [original(command)] }, acceptance: { ...whole.acceptance, command } };
      expect(() => authorizeProof(h.store, h.root, proof, h.actor, 'operations', 'dev')).toThrow('broad root or gate');
    }
    const local = ['bun', 'scripts/worker-check.ts', '--local', '--', 'bun', 'test'];
    const a = [...local, 'fixture.test.ts'], b = [...local, 'other.test.ts'];
    const union = [...a, 'other.test.ts'];
    const wrapped = { ...whole, proof: { ...whole.proof!, sourceTasks: [original(a), original(b)] }, acceptance: { ...whole.acceptance, command: union } };
    expect(authorizeProof(h.store, h.root, wrapped, h.actor, 'operations', 'dev').originals.map((entry) => entry.argv)).toEqual([a, b]);
    expect(originalCommandMatches(['bun', 'test', 'fixture.test.ts', 'other.test.ts'], [a, b])).toBe(false);
    expect(proofExecutionUnavailable(union)).toContain('ONE logical invocation');
  } finally {
    h.dispose();
  }
});

test('stopped same-generation and never-started held proof conversion persists authentic registration/start once without fabricated source/token', async () => {
  const h = registeredFixture();
  try {
    const legacy = h.store.createTask({ ...brief(), kind: 'claim' },
      { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit }, 'claim');
    let ref = { taskId: legacy.id, attempt: 0 };
    for (let n = 1; n <= 28; n++) ref = h.store.nextAttempt(ref, (number) => attempt(legacy.id, number, h.settings.stateDirectory));
    h.store.updateAttempt(ref, (current) => {
      current.result = 'Original failed report, not a registered proof';
      current.session = 'retained-original-session';
    });
    h.store.close(ref, 'stopped');
    const raw = h.store.db.query('SELECT body FROM worker_attempts WHERE task_id=? AND attempt=?').get(legacy.id, 28);
    const submitted = submittedProof(h);
    expect(() => h.tasks.queueRetry(legacy.id, { brief: submitted.path, expectedAttempt: 27 }, h.actor)).toThrow('stale');
    expect(h.store.task(legacy.id).brief.kind).toBe('claim');
    expect(h.store.task(legacy.id).proofAuthorization).toBeUndefined();
    h.tasks.queueRetry(legacy.id, { brief: submitted.path, expectedAttempt: 28 }, h.actor);
    const registered = h.store.task(legacy.id);
    expect(registered.currentAttempt).toBe(28);
    expect(registered.brief.kind).toBe('verification');
    expect(registered.proofAuthorization).toMatchObject({ manager: h.actor.id, sessionId: h.actor.sessionId, sourceTree: h.binding.sourceTree });
    expect(registered.proofRun).toBeUndefined();
    expect(h.store.proofReservation(legacy.id, 28)).toBeUndefined();
    expect(h.store.retryIntent(ref)?.status).toBe('pending');
    expect(h.store.db.query('SELECT body FROM worker_attempts WHERE task_id=? AND attempt=?').get(legacy.id, 28)).toEqual(raw);
    expect(h.store.record(ref)?.taskKind).toBe('claim');
    expect(h.store.record(ref)?.proof).toBeUndefined();
    expect(() => h.tasks.queueRetry(legacy.id, { expectedAttempt: 28 }, h.actor)).toThrow('already pending');

    const lane = h.store.createTask(brief(), { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit }, 'implementation');
    const future = { ...h.proofBrief.proof, sourceCommit: 'b'.repeat(40) };
    const held = h.store.createTask({ ...brief(), kind: 'claim', proof: future, after: [lane.id] },
      { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit }, 'claim');
    const before = h.store.task(held.id);
    expect(() => h.tasks.queueProofStart(held.id, { expectedAttempt: 0, brief: submitted.path }, h.actor)).toThrow('removeAfter');
    expect(h.store.task(held.id)).toEqual(before);
    expect(() => h.tasks.queueProofStart(held.id, { expectedAttempt: 0, brief: submitted.path, removeAfter: [lane.id] }, { id: 'foreign', sessionId: 'foreign' })).toThrow('authenticated');
    expect(h.store.task(held.id)).toEqual(before);
    const runtime = createRuntime({ tasks: h.tasks, db: h.store.db });
    const output: string[] = [];
    expect(await runWorkerCommand('retry', [held.id, '--expected-attempt', '0', '--brief', submitted.path, '--remove-after', lane.id], {
      runtime, env: { CODEX_THREAD_ID: h.actor.sessionId }, print: (value) => output.push(value),
    })).toBe(0);
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

test('registered READY0 recovery uses normal first start once across controllers, with no metadata resubmission or duplicate binding', async () => {
  const h = registeredFixture();
  const db = openDb(join(h.settings.stateDirectory, 'goal.sqlite'));
  try {
    const submitted = submittedProof(h);
    const ready = h.store.createTask(submitted.brief,
      { briefPath: submitted.path, worktree: h.root, branch: 'main', base: h.binding.sourceCommit }, 'implementation');
    h.store.updateTask({ taskId: ready.id, attempt: 0 }, (current) => {
      current.proofAuthorization = authorizeProof(h.store, h.root, submitted.brief, h.actor, 'operations', 'dev');
    });
    // Simulate dispatch dying after accepting READY0 but before recording or launching its start.
    expect(h.store.retryIntent({ taskId: ready.id, attempt: 0 })).toBeUndefined();
    let binds = 0, launches = 0;
    const second = new WorkerStore(db);
    const tasks = new WorkerTasks(h.settings, second, (pool) => reading(pool), async (store, task, next) => {
      launches++;
      expect(task.proofRun).toMatchObject({
        status: 'released', binding: { taskId: task.id, attempt: next.attempt },
        observation: { status: 'terminal', passed: true },
      });
      mkdirSync(dirname(next.logPath), { recursive: true });
      writeFileSync(next.logPath, JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ status: 'success', summary: 'Original fixture terminal evidence', blocker: null, checks: [], approaches: [] }) } }) + '\n');
      store.updateTask(next, (current) => { current.state = 'running'; });
      const saved = store.updateAttempt(next, (current) => { current.state = 'running'; current.session = 'proof-session'; });
      return { attempt: saved, exited: Promise.resolve({ code: 0, signal: null }) };
    }, { async bind(binding) {
      binds++;
      const { record, physical } = records(binding);
      const checks = join(h.root, '.temp/goal/checks');
      mkdirSync(join(checks, 'results'), { recursive: true });
      mkdirSync(join(checks, 'history', binding.checkId), { recursive: true });
      writeFileSync(join(checks, 'results', `${binding.checkId}.json`), JSON.stringify(record));
      writeFileSync(join(checks, 'history', binding.checkId, `${record.physicalRunId}.json`), JSON.stringify(physical));
      return { status: 'bound', binding };
    } });
    const job = new WorkerJob(tasks, { enqueue() { throw new Error('proof must never land'); } }, { deliver() {} });
    job.resumePendingRetries();
    job.resumePendingRetries();
    await job.drain();
    expect(binds).toBe(1);
    expect(launches).toBe(1);
    expect(second.task(ready.id).state).toBe('verified');
    expect(second.attempts(ready.id)).toHaveLength(1);
    expect(second.retryIntent({ taskId: ready.id, attempt: 0 })).toMatchObject({ status: 'started', nextAttempt: 1 });
    const retained = second.proofReservation(ready.id, 1)!;
    expect(retained.binding).toMatchObject({ sourceCommit: h.binding.sourceCommit, sourceTree: h.binding.sourceTree, argv: submitted.brief.acceptance.command });
    expect(retained.binding.reservationToken).toMatch(/^[0-9a-f-]{36}$/);
    await job.start(ready.id, { expectedAttempt: 0 });
    job.resumePendingRetries();
    await job.drain();
    expect(binds).toBe(1);
    expect(launches).toBe(1);
  } finally {
    db.close();
    h.dispose();
  }
});

test('first-start cap waits and old captures keep one durable intent; only authenticated unreserved generation zero can refresh', async () => {
  const h = registeredFixture();
  try {
    for (let n = 0; n < 2; n++) {
      const submitted = submittedProof(h);
      const task = h.store.createTask(submitted.brief, { briefPath: submitted.path, worktree: h.root, branch: 'main', base: h.binding.sourceCommit }, 'implementation');
      h.store.updateTask({ taskId: task.id, attempt: 0 }, (current) => { current.proofAuthorization = authorizeProof(h.store, h.root, submitted.brief, h.actor, 'operations', 'dev'); });
      const ref = h.store.nextAttempt({ taskId: task.id, attempt: 0 }, (number) => attempt(task.id, number, h.settings.stateDirectory));
      const binding = newProofBinding(h.store.task(task.id), ref.attempt);
      h.store.reserveProof(binding);
      h.store.bindProof(binding, { status: 'unknown', cause: 'Actual custody unresolved' });
    }
    const submitted = submittedProof(h);
    const task = h.store.createTask({ ...brief(), kind: 'claim' }, { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit }, 'claim');
    expect(h.tasks.queueProofStart(task.id, { expectedAttempt: 0, brief: submitted.path }, h.actor).status).toBe('waiting');
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
    expect(() => h.tasks.queueProofStart(task.id, { expectedAttempt: 0, brief: fresh.path }, { ...h.actor, sessionId: 'stale-session' })).toThrow('live authenticated');
    h.settings.integration.operationsManager = 'operations';
    const operations = { id: 'operations', sessionId: 'operations-session' };
    h.store.db.query('INSERT INTO manager_sessions VALUES (?,?)').run(operations.id, JSON.stringify({ status: 'running', threadId: operations.sessionId }));
    expect(h.tasks.queueProofStart(task.id, { expectedAttempt: 0, brief: fresh.path }, operations).status).toBe('waiting');
    expect(h.store.task(task.id).brief.proof?.sourceCommit).toBe(sourceCommit);
    expect(h.store.retryIntents().filter((intent) => intent.taskId === task.id)).toHaveLength(1);
    h.store.close(h.current, 'stopped');
    expect(() => h.tasks.queueRetry(h.proof.id, { expectedAttempt: 1, brief: fresh.path }, h.actor)).toThrow('reserved proof source');
    expect(h.store.proofReservation(h.proof.id, 1)?.binding).toEqual(h.binding);
  } finally {
    h.dispose();
  }
});

test('first-start receiving refuses missing helpers and stale, cancelled, integrated or running-owner conversions before native execution', () => {
  const h = registeredFixture();
  try {
    const submitted = submittedProof(h);
    const make = () => h.store.createTask({ ...brief(), kind: 'claim' }, { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit }, 'claim');
    for (const state of ['cancelled', 'integrated'] as const) {
      const task = make();
      h.store.updateTask({ taskId: task.id, attempt: 0 }, (current) => { current.state = state; });
      expect(() => h.tasks.queueProofStart(task.id, { expectedAttempt: 0, brief: submitted.path }, h.actor)).toThrow('stale');
      expect(h.store.retryIntent({ taskId: task.id, attempt: 0 })).toBeUndefined();
      expect(h.store.task(task.id).brief.kind).toBe('claim');
    }
    const running = make();
    const ref = h.store.nextAttempt({ taskId: running.id, attempt: 0 }, (number) => attempt(running.id, number, h.settings.stateDirectory));
    h.store.updateTask(ref, (current) => { current.state = 'running'; });
    expect(() => h.tasks.queueRetry(running.id, { brief: submitted.path, expectedAttempt: 1 }, h.actor)).toThrow('stale');
    expect(() => h.tasks.queueProofStart(running.id, { expectedAttempt: 0, brief: submitted.path }, h.actor)).toThrow('stale');
    expect(h.store.task(running.id).proofAuthorization).toBeUndefined();
    const command = ['bun', 'run', '--cwd', 'services/kernel', 'check', 'missing-helper.ts', 'fixture.test.ts'];
    h.store.updateTask({ taskId: h.source.id, attempt: 0 }, (current) => { current.brief.acceptance.command = command; });
    const missing = submittedProof(h, { acceptance: { ...h.proofBrief.acceptance, command } });
    const task = make();
    expect(() => h.tasks.queueProofStart(task.id, { expectedAttempt: 0, brief: missing.path }, h.actor)).toThrow(ProofUnavailableError);
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
    h.store.db.query('INSERT INTO manager_sessions VALUES (?,?)').run(operations.id,
      JSON.stringify({ status: 'running', threadId: operations.sessionId }));
    const submitted = submittedProof(h);
    for (const state of ['stopped', 'held'] as const) {
      const task = h.store.createTask({ ...brief(), kind: 'claim', criticalPath: true },
        { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit }, 'critical-path');
      const ref = h.store.nextAttempt({ taskId: task.id, attempt: 0 }, (number) => attempt(task.id, number, h.settings.stateDirectory));
      h.store.close(ref, 'stopped');
      if (state === 'held') h.store.updateHeldRetryTask(ref, (current) => { current.state = 'held'; });
      const raw = h.store.db.query('SELECT body FROM worker_attempts WHERE task_id=? AND attempt=?').get(task.id, 1);
      expect(() => h.tasks.queueRetry(task.id, { expectedAttempt: 1, brief: submitted.path }, null)).toThrow('authenticated');
      h.tasks.queueRetry(task.id, { expectedAttempt: 1, brief: submitted.path }, operations);
      const registered = h.store.task(task.id);
      expect(registered.proofAuthorization).toMatchObject({ manager: operations.id, sessionId: operations.sessionId });
      expect(registered.brief.criticalPath).toBe(false);
      expect(registered.taskClass).toBe('implementation');
      expect(registered.priorityHistory?.at(-1)).toMatchObject({
        value: 'normal', setter: operations.id,
        provenance: { kind: 'manager-session', sessionId: operations.sessionId },
      });
      expect(h.store.record(ref)).toMatchObject({ taskKind: 'claim', criticalPath: true });
      expect(h.store.db.query('SELECT body FROM worker_attempts WHERE task_id=? AND attempt=?').get(task.id, 1)).toEqual(raw);
      expect(h.store.retryIntent(ref)?.status).toBe('pending');
      expect(h.store.proofReservation(task.id, 1)).toBeUndefined();
    }
  } finally {
    h.dispose();
  }
});

test('exact retained local wrapper registration stays pending across host sweeps before any nested check or attempt', async () => {
  const h = registeredFixture();
  try {
    const command = ['bun', 'scripts/worker-check.ts', '--local', '--', 'bun', 'test', 'fixture.test.ts'];
    h.store.updateTask({ taskId: h.source.id, attempt: 0 }, (current) => { current.brief.acceptance.command = command; });
    const submitted = submittedProof(h, { acceptance: { ...h.proofBrief.acceptance, command } });
    const task = h.store.createTask({ ...brief(), kind: 'claim' },
      { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit }, 'claim');
    const reason = proofExecutionUnavailable(command);
    if (!reason) throw new Error('Wrapped command must require its native producer port');
    expect(h.tasks.queueProofStart(task.id, { expectedAttempt: 0, brief: submitted.path }, h.actor)).toEqual({
      taskId: task.id, attempt: 0, status: 'pending', reason,
    });
    const job = new WorkerJob(h.tasks, { enqueue() { throw new Error('proof must never land'); } }, { deliver() {} });
    job.resumePendingRetries();
    await job.drain();
    job.resumePendingRetries();
    await job.drain();
    await expect(job.start(task.id, { expectedAttempt: 0 })).rejects.toThrow('ONE logical invocation');
    expect(h.store.task(task.id).brief.acceptance.command).toEqual(command);
    expect(h.store.task(task.id).proofAuthorization?.originals[0]?.argv).toEqual(command);
    expect(h.store.task(task.id).currentAttempt).toBe(0);
    expect(h.store.attempts(task.id)).toEqual([]);
    expect(h.store.proofReservation(task.id, 1)).toBeUndefined();
    expect(h.store.retryIntents().filter((intent) => intent.taskId === task.id)).toHaveLength(1);
    expect(h.store.retryIntent({ taskId: task.id, attempt: 0 })?.status).toBe('pending');
  } finally {
    h.dispose();
  }
});

test('historical admission distinguishes retained live identities from gone, missing, remote and reused identities without claiming terminal cleanup', () => {
  const check = { taskId: 'original', attempt: 28, checkId: crypto.randomUUID(), cwd: '/retained/original' };
  const identity = processIdentity();
  if (!identity) throw new Error('Current process identity unavailable');
  const registration = {
    version: 1, checkId: check.checkId, physicalRunId: crypto.randomUUID(),
    ownership: { taskId: check.taskId, attempt: check.attempt },
    runnerHost: hostname(), runnerIdentity: identity,
  };
  const reader: HistoricalProofReader = {
    record() { throw new Error('Historical result absent'); },
    history() { return undefined; },
    registrations() { return [registration]; },
    valid(_check, value) { return value === registration; },
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
      ...reader, registrations() { return [runner]; }, valid() { return true; },
    });
    expect(unknown.classification).toBe('historical-unknown');
    expect(unknown.cause).toMatch(/unknown|unresolved/);
    expect(unknown).not.toHaveProperty('passed');
    expect(unknown).not.toHaveProperty('terminalProof');
  }
  const foreign = classifyHistoricalProof(check, { ...reader, valid() { return false; } });
  expect(foreign.classification).toBe('historical-unknown');
  expect(foreign.processes).toEqual([]);
});

test('one hundred historical unknowns archive durably and allow exactly three new checks while current unknown reservations retain capacity', () => {
  const h = registeredFixture();
  let restarted: ReturnType<typeof openDb> | undefined;
  try {
    const old = h.store.createTask(brief(),
      { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit }, 'implementation');
    const ref = h.store.nextAttempt({ taskId: old.id, attempt: 0 }, (n) => attempt(old.id, n, h.settings.stateDirectory));
    const checks = Array.from({ length: 100 }, () => crypto.randomUUID());
    h.store.updateAttempt(ref, (current) => {
      current.checks = [...checks, 'bun test labelled-not-a-native-uuid'];
      current.result = 'Retained historical unknown report';
    });
    h.store.close(ref, 'stopped');
    const raw = h.store.db.query('SELECT body FROM worker_attempts WHERE task_id=? AND attempt=?').get(old.id, 1);
    const reservations = h.store.activeProofReservations();
    const leasePath = join(h.settings.stateDirectory, 'retained-physical-lease.json');
    writeFileSync(leasePath, '{"physical":"unresolved"}');
    expect(h.store.historicalProofChecks()).toHaveLength(100);
    const reader: HistoricalProofReader = {
      record() { throw new Error('Retained historical result absent'); }, history() { return undefined; },
      registrations() { return []; }, valid() { return false; },
    };
    for (const check of h.store.historicalProofChecks())
      h.store.classifyHistoricalProof(check, classifyHistoricalProof(check, reader));
    expect(h.store.historicalProofChecks()).toHaveLength(100);
    expect(h.store.historicalProofSlots()).toEqual([]);
    expect(h.store.activeProofReservations()).toEqual(reservations);
    expect(h.store.events(old.id).filter((event) => event.kind === 'historical-proof-classified')).toHaveLength(100);
    expect(h.store.events(old.id).some((event) => event.kind === 'historical-proof-terminal')).toBe(false);
    expect(h.store.db.query('SELECT body FROM worker_attempts WHERE task_id=? AND attempt=?').get(old.id, 1)).toEqual(raw);
    expect(h.store.task(old.id).proofAuthorization).toBeUndefined();
    expect(h.store.task(old.id).proofRun).toBeUndefined();
    expect(readFileSync(leasePath, 'utf8')).toBe('{"physical":"unresolved"}');
    restarted = openDb(join(h.settings.stateDirectory, 'goal.sqlite'));
    const store = new WorkerStore(restarted);
    expect(store.historicalProofSlots()).toEqual([]);
    expect(store.historicalProofChecks()).toHaveLength(100);
    // The fixture already has the first new bound proof. Two further reservations fill cap3, including unknown custody.
    for (let index = 0; index < 3; index++) {
      const task = store.createTask(h.proofBrief,
        { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit }, 'implementation');
      store.updateTask({ taskId: task.id, attempt: 0 }, (current) => {
        current.proofAuthorization = h.store.task(h.proof.id).proofAuthorization;
      });
      const next = store.nextAttempt({ taskId: task.id, attempt: 0 }, (n) => attempt(task.id, n, h.settings.stateDirectory));
      const binding = newProofBinding(store.task(task.id), next.attempt);
      const reservation = store.reserveProof(binding);
      if (index < 2) {
        expect(reservation?.status).toBe('reserved');
        store.bindProof(binding, { status: 'unknown', cause: 'Current native custody unknown' });
      } else expect(reservation).toBeNull();
    }
    expect(store.activeProofReservations()).toHaveLength(3);
    expect(store.proofCapacityAvailable('fixture', 'next-proof')).toBe(false);
    expect(store.proofCapacityReason('fixture', 'next-proof')).toContain('3 current reservations');
    expect(store.events(old.id).some((event) => event.kind === 'historical-proof-terminal')).toBe(false);
    expect(readFileSync(leasePath, 'utf8')).toBe('{"physical":"unresolved"}');
  } finally {
    restarted?.close();
    h.dispose();
  }
});

test('live historical runner occupies cap3 until its actual identity is gone and archival never releases a physical lease', () => {
  const h = registeredFixture();
  try {
    const old = h.store.createTask(brief(),
      { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit }, 'implementation');
    const ref = h.store.nextAttempt({ taskId: old.id, attempt: 0 }, (n) => attempt(old.id, n, h.settings.stateDirectory));
    h.store.updateAttempt(ref, (current) => { current.checks = [crypto.randomUUID()]; });
    const check = h.store.historicalProofChecks()[0]!;
    const identity = processIdentity();
    if (!identity) throw new Error('Current process identity unavailable');
    const record = {
      custodyVersion: 1, id: check.checkId, cwd: check.cwd, status: 'finished',
      ownership: { taskId: old.id, attempt: 1 }, runnerHost: hostname(), runnerIdentity: identity,
    };
    const reader: HistoricalProofReader = {
      record() { return record; }, history() { return undefined; }, registrations() { return []; }, valid() { return false; },
    };
    h.store.classifyHistoricalProof(check, classifyHistoricalProof(check, reader));
    expect(h.store.historicalProofSlots()).toEqual([check]);
    const task = h.store.createTask(h.proofBrief,
      { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit }, 'implementation');
    h.store.updateTask({ taskId: task.id, attempt: 0 }, (current) => { current.proofAuthorization = h.store.task(h.proof.id).proofAuthorization; });
    const next = h.store.nextAttempt({ taskId: task.id, attempt: 0 }, (n) => attempt(task.id, n, h.settings.stateDirectory));
    expect(h.store.reserveProof(newProofBinding(h.store.task(task.id), next.attempt))?.status).toBe('reserved');
    expect(h.store.proofCapacityAvailable('fixture', 'another-proof')).toBe(false);
    expect(h.store.proofCapacityReason('fixture', 'another-proof')).toContain(check.checkId);
    expect(h.store.proofCapacityAvailable('fixture', old.id)).toBe(false);
    // A mismatched start time denotes a gone/reused identity; no process is signalled or stopped by this case.
    const gone = { ...record, runnerIdentity: { ...identity, start: String(BigInt(identity.start) + 1n) } };
    h.store.classifyHistoricalProof(check, classifyHistoricalProof(check, { ...reader, record() { return gone; } }));
    expect(h.store.historicalProofSlots()).toEqual([]);
    expect(h.store.proofCapacityAvailable('fixture', 'another-proof')).toBe(true);
    expect(h.store.attempt(ref).checks).toEqual([check.checkId]);
    expect(h.store.events(old.id).some((event) => event.kind === 'historical-proof-terminal')).toBe(false);
  } finally { h.dispose(); }
});

test('unreserved retained product generations refresh through authenticated public first-start once without changing historical attempts or pending intent', async () => {
  const h = registeredFixture();
  try {
    const task = h.store.createTask({ ...brief(), kind: 'claim' },
      { briefPath: h.briefFile, worktree: h.root, branch: 'main', base: h.binding.sourceCommit }, 'claim');
    let ref = { taskId: task.id, attempt: 0 };
    for (let n = 0; n < 2; n++) ref = h.store.nextAttempt(ref, (number) => attempt(task.id, number, h.settings.stateDirectory));
    h.store.updateAttempt(ref, (current) => { current.result = 'Historical product report'; current.session = 'original-session'; });
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
    expect(() => h.tasks.queueProofStart(task.id, { expectedAttempt: 2, brief: fresh.path }, null)).toThrow('authenticated');
    const runtime = createRuntime({ tasks: h.tasks, db: h.store.db });
    const output: string[] = [];
    expect(await runWorkerCommand('retry', [task.id, '--proof-start', '--expected-attempt', '2', '--brief', fresh.path], {
      runtime, env: { CODEX_THREAD_ID: h.actor.sessionId }, print: (value) => output.push(value),
    })).toBe(0);
    expect(JSON.parse(output[0]!)).toEqual({ taskId: task.id, attempt: 2, status: 'created' });
    expect(h.store.task(task.id).brief.proof?.sourceCommit).toBe(sourceCommit);
    expect(h.store.task(task.id).brief.acceptance.command).toEqual(submitted.brief.acceptance.command);
    expect(h.store.task(task.id).currentAttempt).toBe(2);
    expect(h.store.retryIntent(ref)).toEqual(originalIntent);
    expect(h.store.retryIntents().filter((intent) => intent.taskId === task.id)).toHaveLength(1);
    expect(h.store.record(ref)).toEqual(originalRecord);
    expect(h.store.db.query('SELECT body FROM worker_attempts WHERE task_id=? ORDER BY attempt').all(task.id)).toEqual(raw);
    expect(h.store.proofReservation(task.id, 2)).toBeUndefined();
    h.tasks.queueProofStart(task.id, { expectedAttempt: 2 }, h.actor);
    expect(h.store.retryIntent(ref)).toEqual(originalIntent);
    const next = h.store.nextAttempt(ref, (number) => attempt(task.id, number, h.settings.stateDirectory));
    const binding = newProofBinding(h.store.task(task.id), next.attempt);
    h.store.reserveProof(binding);
    h.store.bindProof(binding, { status: 'unknown', cause: 'Bound current proof is uncertain' });
    h.store.close(next, 'stopped');
    expect(() => h.tasks.queueProofStart(task.id, { expectedAttempt: 3, brief: fresh.path }, h.actor)).toThrow('reserved proof source');
    expect(h.store.proofReservation(task.id, 3)?.binding).toEqual(binding);
  } finally { h.dispose(); }
});
