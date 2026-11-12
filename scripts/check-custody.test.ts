import { afterEach, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CHECK_CUSTODY_RECORD_MAX_CHARACTERS,
  CHECK_RECORD_CUSTODY_VERSION,
  CHECK_REMOTE_CUSTODY_INITIAL_RECORD_RESERVE_CHARACTERS,
  controllerProofReservationPath,
  custodyJsonCharacters,
  initializeRemoteRunCustody,
  readJsonFile,
  remoteRunCustodyPath,
  validateControllerProofBinding,
  validateControllerProofReservation,
  validControllerProofRegistration,
  writeAtomicJson,
  remoteRunCustodyUpdateLimit,
  type ControllerProofBindingV1,
  type CheckRemoteRunCustody,
  ownershipFromEnvironment,
  processIdentity,
  detachedGroupTerminal,
  type CheckCustodyExpectation,
} from './check-custody.ts';
import {
  cancelWorkerCheck,
  readWorkerCheckCancellation,
  readWorkerCheckCleanupHistory,
  readWorkerCheckCleanupReceipt,
  readWorkerCheckHistory,
  readWorkerCheckRecord,
  startWorkerCheck,
  stopWorkerCheck,
  waitWorkerCheck,
  withOriginalContext,
} from './worker-check.ts';
import { remoteCheckCustodyCallbacks, type RemotePhysicalRunReceipt } from './remote-check.ts';
import { typingInputCommand } from '../tools/goal/src/worker-check-typing-inputs.ts';

const roots: string[] = [];
const inheritedEnvironment = { ...process.env };

function rootFixture(): string {
  const root = mkdtempSync(join(import.meta.dir, '../.temp/check-custody-test-'));
  roots.push(root);
  process.env.REZICS_CHECK_LEDGER_DIR = join(root, 'check-ledger');
  return root;
}

function restoreEnvironment(): void {
  for (const key of [
    'GOAL_TASK_ID',
    'GOAL_ATTEMPT',
    'GOAL_CHECK_REGISTRY',
    'REZICS_CHECK_MEMORY',
    'REZICS_CHECK_SCOPE',
    'REZICS_CHECK_LEDGER_DIR',
    'REZICS_CHECK_REMOTE_CUSTODY_FILE',
    'REZICS_CHECK_REMOTE_CUSTODY_ID',
    'REZICS_CHECK_PHYSICAL_RUN_ID',
  ]) {
    const value = inheritedEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function configureTask(taskId: string, attempt: number, registry?: string): void {
  process.env.GOAL_TASK_ID = taskId;
  process.env.GOAL_ATTEMPT = String(attempt);
  if (registry === undefined) delete process.env.GOAL_CHECK_REGISTRY;
  else process.env.GOAL_CHECK_REGISTRY = registry;
  process.env.REZICS_CHECK_MEMORY = 'off';
  process.env.REZICS_CHECK_SCOPE = 'off';
  delete process.env.KERNEL_CHECK_REMOTE;
  delete process.env.REZICS_CHECK_MEMORY_LEASE;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

function expectedCustody(id: string, root: string): CheckCustodyExpectation {
  const record = readWorkerCheckRecord(id, root);
  if (!record.ownership || !record.physicalRunId || !record.runnerIdentity || !record.runnerHost) {
    throw new Error('task check did not publish complete physical custody');
  }
  return {
    ownership: record.ownership,
    physicalRunId: record.physicalRunId,
    runnerHost: record.runnerHost,
    runnerIdentity: record.runnerIdentity,
  };
}

function liveCommand(marker: string): string[] {
  return [
    process.execPath,
    '-e',
    `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`,
  ];
}

function markerPid(path: string): number {
  return Number(readFileSync(path, 'utf8'));
}

test('remote custody bounds round-trip generated, escaped and transitioned records', async () => {
  const root = rootFixture(),
    checkId = randomUUID(),
    physicalRunId = randomUUID();
  const ownership = { taskId: randomUUID(), attempt: 4 },
    argv = ['bun', 'run', '--cwd', 'services/kernel', 'typecheck'];
  const remoteArgv = withOriginalContext(
      [
        'env',
        `REZICS_TYPING_INPUTS_PHYSICAL=${physicalRunId}`,
        `REZICS_TYPING_INPUTS_COMMAND=${Buffer.from(JSON.stringify(argv)).toString('base64')}`,
        ...typingInputCommand(argv),
      ],
      {
        GOAL_TASK_ID: ownership.taskId,
        GOAL_ATTEMPT: String(ownership.attempt),
        GOAL_ACCEPTANCE_REQUIRES: 'native,root',
      },
    ),
    binding = { checkId, ownership, argv, remoteArgv };
  expect(remoteArgv.length).toBeLessThan(21);
  expect(Math.max(...remoteArgv.map((argument) => Buffer.byteLength(argument)))).toBeLessThanOrEqual(3000);
  const file = remoteRunCustodyPath(root, physicalRunId);
  initializeRemoteRunCustody(root, physicalRunId, binding);
  expect(readJsonFile<CheckRemoteRunCustody>(file)?.binding?.remoteArgv).toEqual(remoteArgv);
  const initialCustody = readJsonFile<CheckRemoteRunCustody>(file)!;
  const initialCustodyCharacters = custodyJsonCharacters(initialCustody);
  expect(custodyJsonCharacters(initialCustody)).toBeLessThanOrEqual(
    CHECK_CUSTODY_RECORD_MAX_CHARACTERS - CHECK_REMOTE_CUSTODY_INITIAL_RECORD_RESERVE_CHARACTERS,
  );
  expect(remoteRunCustodyUpdateLimit()).toBe(CHECK_CUSTODY_RECORD_MAX_CHARACTERS);
  Object.assign(process.env, {
    REZICS_CHECK_REMOTE_CUSTODY_FILE: file,
    REZICS_CHECK_REMOTE_CUSTODY_ID: checkId,
    REZICS_CHECK_PHYSICAL_RUN_ID: physicalRunId,
  });
  const callbacks = remoteCheckCustodyCallbacks(remoteArgv, [], join(root, 'hosts.json'));
  await callbacks.allocated!({ host: 'check-a', run: 'first-run' });
  await callbacks.notStarted!({ host: 'check-a', run: 'first-run' }, null, 'transport before start');
  await callbacks.allocated!({ host: 'check-b', run: 'second-run' });
  const run = { host: 'check-b', run: 'second-run' },
    native: RemotePhysicalRunReceipt = {
      schema: 1,
      ...run,
      exitCode: 0,
      lifetimeFailure: null,
      resources: {
        schema: 1,
        ...run,
        boot: 'boot-id',
        supervisor: { pid: 7, start: '1', group: 7 },
        cgroup: null,
        cadenceMs: 5000,
        startedMonoMs: 0,
        commandStartedMonoMs: 1,
        terminalMonoMs: 66,
        samples: Array.from({ length: 65 }, (_, index) => ({
          monoMs: index + 1,
          phase: 'command' as const,
          usageUsec: index * 5000,
          memoryPeakBytes: 1024,
          intervalMs: 5000,
          cores: 1,
          unavailable: null,
        })),
        sampledMaxCores: 1,
      },
    };
  await callbacks.completed!(native);
  await callbacks.settled!({
    schema: 1,
    ...run,
    native,
    preparedInputs: null,
    returns: { schema: 1, status: 'empty', entries: [], missing: [], failures: [] },
    cleanup: {
      schema: 1,
      ...run,
      status: 'verified',
      supervisorStopped: true,
      commandGroupTerminal: true,
      containersRemoved: true,
      runDirectoryRemoved: true,
      failures: [],
    },
    transportChildReaped: true,
  });
  const record = readJsonFile<CheckRemoteRunCustody>(file);
  expect([record?.physicalRunId, record?.binding?.checkId, record?.binding?.ownership]).toEqual([
    physicalRunId,
    checkId,
    ownership,
  ]);
  expect(record?.status).toBe('terminal');
  expect(record?.attempts.map(({ host, status }) => [host, status])).toEqual([
    ['check-a', 'not-started'],
    ['check-b', 'terminal'],
  ]);
  expect(record?.attempts[1]).toMatchObject({ id: 'second-run', native, settlement: expect.any(Object) });
  expect(record?.binding).toEqual({ ...binding, hostsFile: join(root, 'hosts.json'), returns: [] });
  expect(custodyJsonCharacters(record)).toBeGreaterThan(
    initialCustodyCharacters + CHECK_REMOTE_CUSTODY_INITIAL_RECORD_RESERVE_CHARACTERS,
  );
  expect(custodyJsonCharacters(record)).toBeLessThanOrEqual(CHECK_CUSTODY_RECORD_MAX_CHARACTERS);

  const max = CHECK_CUSTODY_RECORD_MAX_CHARACTERS;
  const boundary = { payload: 'x'.repeat(max - custodyJsonCharacters({ payload: '' })) };
  const boundaryFile = join(root, 'boundary.json');
  expect(custodyJsonCharacters(boundary)).toBe(max);
  writeAtomicJson(boundaryFile, boundary, true, max);
  expect(readJsonFile(boundaryFile)).toEqual(boundary);
  const unicodeRunId = randomUUID(),
    unicodeArgv = ['bun', '-e', 'console.log("line\nbreak")', '雪🌊', 'quote" and slash\\'];
  initializeRemoteRunCustody(root, unicodeRunId, { checkId, argv, remoteArgv: unicodeArgv });
  expect(readJsonFile<CheckRemoteRunCustody>(remoteRunCustodyPath(root, unicodeRunId))?.binding?.remoteArgv).toEqual(
    unicodeArgv,
  );
  const oversizedRunId = randomUUID();
  expect(() =>
    initializeRemoteRunCustody(root, oversizedRunId, { checkId, argv, remoteArgv: ['bun', 'x'.repeat(64 * 1024)] }),
  ).toThrow('worker-check: invalid remote custody binding');
  expect(existsSync(remoteRunCustodyPath(root, oversizedRunId))).toBe(false);

  const aggregateRunId = randomUUID();
  const aggregateRemoteArgv = ['a'.repeat(27_000), 'b'.repeat(27_000)];
  const aggregateBinding = { checkId, argv, remoteArgv: aggregateRemoteArgv };
  const aggregateRecordLimit = CHECK_CUSTODY_RECORD_MAX_CHARACTERS - CHECK_REMOTE_CUSTODY_INITIAL_RECORD_RESERVE_CHARACTERS;
  expect([...argv, ...aggregateRemoteArgv].every((argument) => Buffer.byteLength(argument) <= 48 * 1024)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify([aggregateBinding.argv, aggregateBinding.remoteArgv]))).toBeLessThanOrEqual(
    56 * 1024,
  );
  expect(
    custodyJsonCharacters({
      version: 1,
      physicalRunId: aggregateRunId,
      binding: aggregateBinding,
      status: 'running',
      attempts: [],
      updatedAt: new Date().toISOString(),
    }),
  ).toBeGreaterThan(aggregateRecordLimit);
  expect(() => initializeRemoteRunCustody(root, aggregateRunId, aggregateBinding)).toThrow(
    `worker-check: serialized custody record exceeds ${aggregateRecordLimit}-character bound`,
  );
  expect(existsSync(remoteRunCustodyPath(root, aggregateRunId))).toBe(false);
});

afterEach(() => {
  restoreEnvironment();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('task-bound durable check custody registers its exact attempt and actual runner identity before command start', async () => {
  const root = rootFixture();
  const registry = join(root, 'registry');
  mkdirSync(registry);
  const taskId = randomUUID();
  const marker = join(root, 'command-started.json');
  configureTask(taskId, 7, registry);
  const source = `const fs=require('node:fs');const path=${JSON.stringify(registry)};const entries=fs.readdirSync(path).filter((name)=>name.endsWith('.json'));if(entries.length!==1)process.exit(91);const registration=JSON.parse(fs.readFileSync(path+'/'+entries[0],'utf8'));fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,registration}));setInterval(()=>{},1000)`;
  const id = startWorkerCheck([process.execPath, '-e', source], root);
  try {
    await waitFor(() => existsSync(marker), 'registered command start');
    const record = readWorkerCheckRecord(id, root);
    const entries = readdirSync(registry).filter((name) => name.endsWith('.json'));
    expect(entries).toEqual([`${id}.${record.physicalRunId}.json`]);
    const registration = JSON.parse(readFileSync(join(registry, entries[0]!), 'utf8'));
    expect(CHECK_RECORD_CUSTODY_VERSION).toBe(1);
    expect(record).toMatchObject({ custodyVersion: 1, ownership: { taskId, attempt: 7 } });
    expect(registration).toMatchObject({
      version: 1,
      checkId: id,
      physicalRunId: record.physicalRunId,
      ownership: { taskId, attempt: 7 },
      runnerHost: record.runnerHost,
      runnerIdentity: record.runnerIdentity,
    });
    expect(JSON.parse(readFileSync(marker, 'utf8')).registration).toEqual(registration);
    expect(record.runnerPid).toBe(record.runnerIdentity?.pid);
    expect(record.runnerHost).toBe(process.env.HOSTNAME ?? record.runnerHost);
    expect(readWorkerCheckHistory(id, record.physicalRunId!, root)?.runnerIdentity).toEqual(record.runnerIdentity);
  } finally {
    const expectation = expectedCustody(id, root);
    await stopWorkerCheck(id, root, expectation);
  }
});

test('exact normal stop reaps only the selected task tree and preserves a shared-checkout peer', async () => {
  const root = rootFixture();
  const registry = join(root, 'registry');
  mkdirSync(registry);
  const firstTask = randomUUID();
  const secondTask = randomUUID();
  const firstMarker = join(root, 'first.pid');
  const secondMarker = join(root, 'second.pid');
  configureTask(firstTask, 1, registry);
  const first = startWorkerCheck(liveCommand(firstMarker), root);
  configureTask(secondTask, 4, registry);
  const second = startWorkerCheck(liveCommand(secondMarker), root);
  try {
    await waitFor(() => existsSync(firstMarker) && existsSync(secondMarker), 'both task commands');
    const firstExpected = expectedCustody(first, root);
    const secondExpected = expectedCustody(second, root);
    expect(firstExpected.ownership).toEqual({ taskId: firstTask, attempt: 1 });
    expect(secondExpected.ownership).toEqual({ taskId: secondTask, attempt: 4 });
    expect(firstExpected.physicalRunId).not.toBe(secondExpected.physicalRunId);
    const receipt = await stopWorkerCheck(first, root, firstExpected);
    expect(receipt).toMatchObject({
      disposition: 'stopped',
      localTerminal: true,
      remoteTerminal: null,
      resultTerminal: true,
    });
    expect(processIdentity(markerPid(firstMarker))).toBeNull();
    expect(processIdentity(markerPid(secondMarker))).not.toBeNull();
    expect(readWorkerCheckRecord(first, root)).toMatchObject({ status: 'finished', exitCode: 143 });
    expect(readWorkerCheckCleanupReceipt(first, firstExpected.physicalRunId, root)).toEqual(receipt);
    expect(readWorkerCheckCleanupHistory(first, firstExpected.physicalRunId, root)).toContainEqual(receipt);
    expect(readWorkerCheckRecord(second, root).status).toBe('running');
  } finally {
    const secondExpected = expectedCustody(second, root);
    await stopWorkerCheck(second, root, secondExpected);
  }
});

test('wrong host, task, attempt, boot, start and group expectations refuse without signaling the owner', async () => {
  const root = rootFixture();
  const registry = join(root, 'registry');
  mkdirSync(registry);
  const taskId = randomUUID();
  const marker = join(root, 'owner.pid');
  configureTask(taskId, 2, registry);
  const id = startWorkerCheck(liveCommand(marker), root);
  try {
    await waitFor(() => existsSync(marker), 'owner process');
    const expected = expectedCustody(id, root);
    const invalid: CheckCustodyExpectation[] = [
      { ...expected, ownership: { taskId: randomUUID(), attempt: expected.ownership.attempt } },
      { ...expected, ownership: { ...expected.ownership, attempt: expected.ownership.attempt + 1 } },
      { ...expected, runnerHost: 'foreign-host.invalid' },
      { ...expected, runnerIdentity: { ...expected.runnerIdentity, boot: randomUUID() } },
      {
        ...expected,
        runnerIdentity: { ...expected.runnerIdentity, start: `${BigInt(expected.runnerIdentity.start) + 1n}` },
      },
      { ...expected, runnerIdentity: { ...expected.runnerIdentity, group: expected.runnerIdentity.group + 1 } },
    ];
    for (const expectation of invalid) {
      const refused = await stopWorkerCheck(id, root, expectation);
      expect(refused.disposition).toBe('refused');
      expect(processIdentity(markerPid(marker))).not.toBeNull();
    }
  } finally {
    await stopWorkerCheck(id, root, expectedCustody(id, root));
  }
});

test('successive task attempts and detached physical reruns keep separate immutable identities', async () => {
  const root = rootFixture();
  const registry = join(root, 'registry');
  mkdirSync(registry);
  const taskId = randomUUID();
  const marker = join(root, 'attempt.pid');
  configureTask(taskId, 1, registry);
  const first = startWorkerCheck(
    [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'first')`],
    root,
  );
  expect(await waitWorkerCheck(first, root, 5_000, { pollMs: 10 })).toBe(0);
  const firstRecord = readWorkerCheckRecord(first, root);
  configureTask(taskId, 2, registry);
  const second = startWorkerCheck(
    [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'second')`],
    root,
  );
  expect(await waitWorkerCheck(second, root, 5_000, { pollMs: 10 })).toBe(0);
  const secondRecord = readWorkerCheckRecord(second, root);
  expect(firstRecord.ownership).toEqual({ taskId, attempt: 1 });
  expect(secondRecord.ownership).toEqual({ taskId, attempt: 2 });
  expect(firstRecord.physicalRunId).not.toBe(secondRecord.physicalRunId);
  expect(readWorkerCheckHistory(first, firstRecord.physicalRunId!, root)?.status).toBe('finished');
  expect(readWorkerCheckHistory(second, secondRecord.physicalRunId!, root)?.status).toBe('finished');
});

test('Root-authorized legacy cancellation persists an idempotent tombstone and leaves the stale result bytes unchanged', async () => {
  const root = rootFixture();
  const id = randomUUID();
  const taskId = randomUUID();
  const resultDirectory = join(root, '.temp/goal/checks/results');
  mkdirSync(resultDirectory, { recursive: true });
  const argv = [
    process.execPath,
    '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'must-not-start'))},'bad')`,
  ];
  const recordPath = join(resultDirectory, `${id}.json`);
  const recordBytes = Buffer.from(
    `${JSON.stringify({ id, cwd: root, argv, status: 'running', log: '.temp/old.log', runnerPid: 2147483646 })}\n`,
  );
  writeFileSync(recordPath, recordBytes);
  const receiptReference = join(root, '..', `root-cancel-${randomUUID()}.json`);
  roots.push(receiptReference);
  const rootReceipt = Buffer.from(JSON.stringify({ records: [{ id, taskId, attempt: 1, argv }] }));
  writeFileSync(receiptReference, rootReceipt);
  const authorization = {
    version: 1 as const,
    issuer: 'rezics-root' as const,
    checkId: id,
    ownership: { taskId, attempt: 1 },
    expectedRecordPath: resolve(recordPath),
    expectedRecordSha256: createHash('sha256').update(recordBytes).digest('hex'),
    expectedArgv: argv,
    receiptReference,
    receiptSha256: createHash('sha256').update(rootReceipt).digest('hex'),
  };
  const refusedAuthorizations = [
    { ...authorization, checkId: randomUUID() },
    { ...authorization, expectedRecordSha256: '0'.repeat(64) },
    { ...authorization, expectedRecordPath: join(root, 'different-result.json') },
    { ...authorization, expectedArgv: [...argv, 'unexpected'] },
    { ...authorization, ownership: { taskId: randomUUID(), attempt: 1 } },
    { ...authorization, ownership: { taskId, attempt: 2 } },
    { ...authorization, receiptReference: recordPath },
    { ...authorization, receiptSha256: '0'.repeat(64) },
  ];
  for (const refusedAuthorization of refusedAuthorizations) {
    expect((await cancelWorkerCheck(refusedAuthorization, root)).disposition).toBe('refused');
    expect(existsSync(join(root, 'must-not-start'))).toBe(false);
    expect(readFileSync(recordPath)).toEqual(recordBytes);
  }
  await expect(
    cancelWorkerCheck({ ...authorization, issuer: 'untrusted' } as unknown as typeof authorization, root),
  ).rejects.toThrow('invalid logical cancellation authorization');
  const cancelled = await cancelWorkerCheck(authorization, root);
  expect(cancelled.disposition).toBe('logically-cancelled-physical-cleanup-unknown');
  expect(readFileSync(recordPath)).toEqual(recordBytes);
  expect(readWorkerCheckCancellation(id, root)).toEqual(cancelled);
  expect(await waitWorkerCheck(id, root, 500, { pollMs: 10 })).toBe(125);
  const repeated = await cancelWorkerCheck(authorization, root);
  expect(repeated).toEqual(cancelled);
  const cli = spawnSync(process.execPath, [resolve(import.meta.dir, 'worker-check.ts'), '--run', id], {
    cwd: root,
    env: { ...process.env, REZICS_CHECK_MEMORY: 'off', REZICS_CHECK_SCOPE: 'off' },
    encoding: 'utf8',
    timeout: 5_000,
  });
  expect(cli.status).toBe(125);
  expect(existsSync(join(root, 'must-not-start'))).toBe(false);
  expect(readFileSync(recordPath)).toEqual(recordBytes);
});

test('missing registry and partial launcher identity fail before a detached command can start', () => {
  const root = rootFixture();
  const marker = join(root, 'must-not-start');
  const taskId = randomUUID();
  configureTask(taskId, 1, join(root, 'missing-registry'));
  expect(() => startWorkerCheck(liveCommand(marker), root)).toThrow('GOAL_CHECK_REGISTRY is unavailable');
  expect(existsSync(marker)).toBe(false);
  configureTask(taskId, 1);
  delete process.env.GOAL_ATTEMPT;
  expect(() => startWorkerCheck(liveCommand(marker), root)).toThrow('GOAL_TASK_ID and GOAL_ATTEMPT');
  expect(() => ownershipFromEnvironment({ GOAL_TASK_ID: taskId })).toThrow('GOAL_TASK_ID and GOAL_ATTEMPT');
  expect(existsSync(marker)).toBe(false);
});

test('verified watchdog rerun keeps old physical custody and stale cleanup cannot stop its replacement', async () => {
  const root = rootFixture();
  const registry = join(root, 'registry');
  mkdirSync(registry);
  const taskId = randomUUID();
  const runs = join(root, 'runs.txt');
  configureTask(taskId, 3, registry);
  const command = [
    process.execPath,
    '-e',
    `const fs=require('node:fs');const path=${JSON.stringify(runs)};const n=fs.existsSync(path)?Number(fs.readFileSync(path,'utf8'))+1:1;fs.writeFileSync(path,String(n));if(n===1)setInterval(()=>{},1000);else process.stdout.write('replacement command finished\\n')`,
  ];
  const id = startWorkerCheck(command, root);
  const original = expectedCustody(id, root);
  try {
    expect(await waitWorkerCheck(id, root, 10_000, { pollMs: 10, stallMs: 200 })).toBe(0);
    const replacement = readWorkerCheckRecord(id, root);
    expect(replacement.physicalRunId).not.toBe(original.physicalRunId);
    expect(replacement.runnerIdentity).not.toEqual(original.runnerIdentity);
    expect(replacement.status).toBe('finished');
    expect(readWorkerCheckHistory(id, original.physicalRunId, root)?.status).toBe('finished');
    const oldCleanup = await stopWorkerCheck(id, root, original);
    expect(oldCleanup.localTerminal).toBe(true);
    expect(oldCleanup.resultTerminal).toBe(true);
    expect(replacement.exitCode).toBe(0);
    expect(readFileSync(runs, 'utf8')).toBe('2');
  } finally {
    const current = readWorkerCheckRecord(id, root);
    if (
      current.status === 'running' &&
      current.ownership &&
      current.physicalRunId &&
      current.runnerIdentity &&
      current.runnerHost
    ) {
      await stopWorkerCheck(id, root, {
        ownership: current.ownership,
        physicalRunId: current.physicalRunId,
        runnerHost: current.runnerHost,
        runnerIdentity: current.runnerIdentity,
      });
    }
  }
});

test('controller proof wire validation is closed, bounded and preserves exact original argument boundaries', () => {
  const root = rootFixture();
  const binding: ControllerProofBindingV1 = {
    version: 1,
    token: randomUUID(),
    checkId: randomUUID(),
    goal: 'performance',
    taskId: randomUUID(),
    attempt: 3,
    sourceCommit: 'a'.repeat(40),
    sourceTree: 'b'.repeat(40),
    cwd: root,
    argv: ['bun', '-e', '', '$literal; `text`', 'two words'],
  };
  const validated = validateControllerProofBinding(binding);
  expect(validated).toEqual(binding);
  expect(validated.argv).not.toBe(binding.argv);
  expect(Object.isFrozen(validated)).toBe(true);
  expect(Object.isFrozen(validated.argv)).toBe(true);
  const invalid: unknown[] = [
    null,
    [],
    { ...binding, extra: true },
    { ...binding, version: 2 },
    { ...binding, token: '../token' },
    { ...binding, checkId: 'prefix' },
    { ...binding, goal: '' },
    { ...binding, goal: 'a'.repeat(129) },
    { ...binding, taskId: 'task' },
    { ...binding, attempt: '3' },
    { ...binding, attempt: 0 },
    { ...binding, attempt: Number.MAX_SAFE_INTEGER + 1 },
    { ...binding, sourceCommit: 'HEAD' },
    { ...binding, sourceCommit: 'a'.repeat(39) },
    { ...binding, sourceTree: 'HEAD^{tree}' },
    { ...binding, sourceTree: 'b'.repeat(64) },
    { ...binding, cwd: '.' },
    { ...binding, cwd: root + '/..' },
    { ...binding, argv: [] },
    { ...binding, argv: [''] },
    { ...binding, argv: ['bun', 7] },
    { ...binding, argv: ['bun', 'x\0y'] },
    { ...binding, argv: ['bun', 'x'.repeat(4097)] },
    { ...binding, argv: new Array(2) },
    { ...binding, argv: Array(1025).fill('x') },
  ];
  for (const candidate of invalid) expect(() => validateControllerProofBinding(candidate)).toThrow();
  const partial: Record<string, unknown> = { ...binding };
  delete partial.sourceTree;
  expect(() => validateControllerProofBinding(partial)).toThrow();
  const reservation = { version: 1, state: 'reserved', binding } as const;
  expect(validateControllerProofReservation(reservation)).toEqual(reservation);
  for (const candidate of [
    { ...reservation, state: 'consumed' },
    { ...reservation, ignored: true },
    { ...reservation, version: '1' },
    { version: 1, binding },
  ])
    expect(() => validateControllerProofReservation(candidate)).toThrow();
  const registry = join(root, 'registry');
  mkdirSync(registry);
  expect(controllerProofReservationPath(registry, binding.token)).toBe(
    join(registry, 'proof-reservations', binding.token + '.json'),
  );
  expect(() => controllerProofReservationPath(registry, '../escape')).toThrow();
  expect(() => controllerProofReservationPath(join(root, 'missing'), binding.token)).toThrow();
});

test('controller proof registration requires actual bound runner and physical custody, beyond a type assertion', () => {
  const root = rootFixture();
  const binding: ControllerProofBindingV1 = {
    version: 1,
    token: randomUUID(),
    checkId: randomUUID(),
    goal: 'performance',
    taskId: randomUUID(),
    attempt: 1,
    sourceCommit: 'a'.repeat(40),
    sourceTree: 'b'.repeat(40),
    cwd: root,
    argv: ['bun', 'test'],
  };
  const registration = {
    version: 1,
    checkId: binding.checkId,
    resultPath: join(root, '.temp/goal/checks/results', binding.checkId + '.json'),
    ownership: { taskId: binding.taskId, attempt: binding.attempt },
    physicalRunId: randomUUID(),
    runnerHost: 'fixture',
    runnerIdentity: processIdentity(),
    registeredAt: new Date().toISOString(),
    controllerProof: binding,
  };
  expect(validControllerProofRegistration(registration, binding)).toBe(false);
  expect(validControllerProofRegistration({ ...registration, controllerProof: undefined }, binding)).toBe(false);
  expect(validControllerProofRegistration({ ...registration, extra: true }, binding)).toBe(false);
});

test('setup cleanup needs a positive owned group observation; absent PID or unreadable identity stays unknown', () => {
  const proc = rootFixture();
  const identity = { pid: 1234, group: 1234, start: '100', boot: randomUUID() };
  expect(detachedGroupTerminal(identity, proc)).toBe(false);
  mkdirSync(join(proc, 'sys/kernel/random'), { recursive: true });
  writeFileSync(join(proc, 'sys/kernel/random/boot_id'), randomUUID());
  expect(detachedGroupTerminal(identity, proc)).toBe(false);
  writeFileSync(join(proc, 'sys/kernel/random/boot_id'), identity.boot);
  mkdirSync(join(proc, '5678'));
  expect(detachedGroupTerminal(identity, proc)).toBe(false);
  const fields = ['S', '1', String(identity.group), ...Array(16).fill('0'), '101'];
  writeFileSync(join(proc, '5678/stat'), `5678 (owned child) ${fields.join(' ')}`);
  expect(detachedGroupTerminal(identity, proc)).toBe(false);
  rmSync(join(proc, '5678'), { recursive: true });
  expect(detachedGroupTerminal(identity, proc)).toBe(true);
  expect(detachedGroupTerminal({ ...identity, group: 9 }, proc)).toBe(false);
  mkdirSync(join(proc, String(identity.pid)));
  fields[2] = '9999';
  writeFileSync(join(proc, String(identity.pid), 'stat'), `${identity.pid} (reused) ${fields.join(' ')}`);
  expect(detachedGroupTerminal(identity, proc)).toBe(false);
});

test('child runtime/gate evidence cannot substitute for controller registration or positive whole-tree custody', async () => {
  const { sameLifecycleGate, validateLifecycleGate } = await import('./check-lifecycle-child.ts');
  const child = processIdentity()!;
  const gate = {
    spec: {
      version: 1 as const,
      checkId: randomUUID(),
      taskId: randomUUID(),
      attempt: 1,
      sourceCommit: 'a'.repeat(40),
      sourceTree: 'b'.repeat(40),
      nonce: 'c'.repeat(64),
      exitCode: 7 as const,
      lifetimeMs: 1_000,
      runtime: { packageManager: 'bun@fixture', version: Bun.version, revision: Bun.revision },
      childSha256: 'd'.repeat(64),
    },
    physicalRunId: randomUUID(),
    host: 'fixture',
    remoteRunId: null,
    child,
  };
  expect(validateLifecycleGate(gate)).toEqual(gate);
  expect(sameLifecycleGate({ ...gate, physicalRunId: randomUUID() }, gate)).toBe(false);
  expect(sameLifecycleGate({ ...gate, spec: { ...gate.spec, attempt: 2 } }, gate)).toBe(false);
  expect(sameLifecycleGate({ ...gate, child: { ...child, boot: randomUUID() } }, gate)).toBe(false);
  expect(
    sameLifecycleGate(
      { ...gate, spec: { ...gate.spec, runtime: { ...gate.spec.runtime, revision: '0'.repeat(40) } } },
      gate,
    ),
  ).toBe(false);
  expect(detachedGroupTerminal(child)).toBe(false);
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'rezics-custody-lifecycle-'));
  try {
    const binding: ControllerProofBindingV1 = {
      version: 1,
      token: randomUUID(),
      goal: 'performance',
      cwd: root,
      checkId: gate.spec.checkId,
      taskId: gate.spec.taskId,
      attempt: 1,
      sourceCommit: gate.spec.sourceCommit,
      sourceTree: gate.spec.sourceTree,
      argv: ['bun', 'test'],
    };
    expect(validControllerProofRegistration(gate, binding)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
