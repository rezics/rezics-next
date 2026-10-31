import { expect, test } from 'bun:test';
import { parseProofMetadata } from './verification.ts';

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
