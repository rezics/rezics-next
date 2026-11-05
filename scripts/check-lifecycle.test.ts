import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  LIFECYCLE_CHILD,
  controlLifecycleChild,
  decodeLifecycleSpec,
  encodeLifecycleSpec,
  lifecycleDirectory,
  lifecycleSpecFromArgv,
  observeLifecycleChild,
  readLifecycleChildReceipt,
  sha256,
  validateLifecycleReceipt,
  type LifecycleChildReceipt,
  type LifecycleGate,
  type LifecycleProbeSpec,
} from './check-lifecycle-child.ts';
import {
  lifecycleProbeArgv,
  readLifecycleProbe,
  releaseLifecycleProbe,
  startLifecycleProbe,
  waitLifecycleProbe,
} from './check-lifecycle.ts';
import {
  controllerProofReservationPath,
  detachedGroupTerminal,
  processIdentity,
  sameProcess,
  type ControllerProofBindingV1,
} from './check-custody.ts';
import { ownedLocalCommand } from './remote-check.ts';
import { readWorkerCheckHistory, readWorkerCheckRecord } from './worker-check.ts';
import { hostsLocation } from './stack-run.ts';

const repository = resolve(import.meta.dir, '..');
const pinned = join(repository, 'node_modules/.bin/bun');
const nonce = () => randomBytes(32).toString('hex');

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result.stdout.trim();
}
function sourceFixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rezics-lifecycle-')));
  mkdirSync(join(root, 'scripts'));
  for (const file of ['check-lifecycle-child.ts', 'check-custody.ts'])
    copyFileSync(join(repository, 'scripts', file), join(root, 'scripts', file));
  const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: manifest.packageManager }));
  symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'));
  git(root, 'init', '-q');
  git(root, 'add', 'scripts', 'package.json');
  git(
    root,
    '-c',
    'user.name=Lifecycle fixture',
    '-c',
    'user.email=lifecycle@example.invalid',
    'commit',
    '-qm',
    'Capture bounded child fixture',
  );
  return root;
}
function specFor(root: string, exitCode: 0 | 7 = 0, lifetimeMs = 5_000): LifecycleProbeSpec {
  return decodeLifecycleSpec(
    lifecycleProbeArgv({
      cwd: root,
      checkId: randomUUID(),
      taskId: randomUUID(),
      attempt: 1,
      sourceCommit: git(root, 'rev-parse', 'HEAD'),
      sourceTree: git(root, 'rev-parse', 'HEAD^{tree}'),
      nonce: nonce(),
      exitCode,
      lifetimeMs,
    })[3]!,
  );
}
async function launch(root: string, spec: LifecycleProbeSpec, remoteRunId: string | null = null) {
  const physicalRunId = randomUUID();
  const command = ownedLocalCommand([
    pinned,
    join(root, LIFECYCLE_CHILD),
    '--probe',
    encodeLifecycleSpec(spec),
    '--physical',
    physicalRunId,
  ]);
  const child = Bun.spawn(command, {
    cwd: root,
    env: { ...process.env, ...(remoteRunId ? { REZICS_LIFECYCLE_REMOTE_RUN: remoteRunId } : {}) },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  return { child, physicalRunId, stdout, stderr };
}
async function running(
  root: string,
  run: Awaited<ReturnType<typeof launch>>,
  spec: LifecycleProbeSpec,
  remoteRunId: string | null = null,
): Promise<LifecycleChildReceipt> {
  const deadline = performance.now() + 3_000;
  let reason: unknown;
  while (performance.now() < deadline) {
    try {
      const receipt = await observeLifecycleChild(root, {
        version: 1,
        operation: 'observe',
        spec,
        physicalRunId: run.physicalRunId,
        remoteRunId,
      });
      expect(receipt.state).toBe('running');
      expect(sameProcess(receipt.evidence.gate.child)).toBe(true);
      expect(run.child.exitCode).toBeNull();
      return receipt;
    } catch (error) {
      reason = error;
      await Bun.sleep(10);
    }
  }
  throw new Error(`real child never established running: ${String(reason)}`);
}
async function finish(run: Awaited<ReturnType<typeof launch>>): Promise<void> {
  if (run.child.exitCode === null) run.child.kill('SIGTERM');
  await run.child.exited;
  await Promise.all([run.stdout, run.stderr]);
}

for (const exitCode of [0, 7] as const) {
  test(`real bounded child is held running before authenticated release and exits exactly ${exitCode}`, async () => {
    const root = sourceFixture();
    const spec = specFor(root, exitCode);
    const run = await launch(root, spec);
    try {
      const observed = await running(root, run, spec);
      const { evidence } = observed;
      expect(evidence.runtime.execPath).toBe(realpathSync(pinned));
      expect(evidence.runtime.version).toBe(spec.runtime.version);
      expect(evidence.runtime.revision).toBe(spec.runtime.revision);
      expect(evidence.runtime.executableSha256).toBe(sha256(readFileSync(pinned)));
      expect(evidence.runtime.pinnedExecutableSha256).toBe(evidence.runtime.executableSha256);
      expect(evidence.source).toEqual({
        commit: spec.sourceCommit,
        tree: spec.sourceTree,
        childSha256: spec.childSha256,
      });
      expect(evidence.gate.physicalRunId).toBe(run.physicalRunId);
      expect(evidence.gate.child.start).toMatch(/^\d+$/);
      expect(evidence.gate.child.boot).toBe(processIdentity()!.boot);
      // Neither caller disappearance between calls nor observation releases the gate.
      const second = await observeLifecycleChild(root, {
        version: 1,
        operation: 'observe',
        spec,
        physicalRunId: run.physicalRunId,
        remoteRunId: null,
      });
      expect(second.state).toBe('running');
      expect(run.child.exitCode).toBeNull();
      const release = { version: 1 as const, operation: 'release' as const, gate: evidence.gate };
      expect((await controlLifecycleChild(root, release)).action).toBe('release');
      expect(await run.child.exited).toBe(exitCode);
      const receipt = readLifecycleChildReceipt(root, run.physicalRunId, evidence.gate)!;
      expect(receipt).toMatchObject({ state: 'child-result', exitCode, action: 'release' });
      const terminalBytes = readFileSync(join(root, lifecycleDirectory(run.physicalRunId), 'terminal.json'));
      expect(await controlLifecycleChild(root, release)).toEqual(receipt);
      expect(await controlLifecycleChild(root, release)).toEqual(receipt);
      expect(readFileSync(join(root, lifecycleDirectory(run.physicalRunId), 'terminal.json'))).toEqual(terminalBytes);
      expect(
        (await run.stdout).split('\n').filter((line) => line === 'lifecycle: ' + JSON.stringify(receipt)),
      ).toHaveLength(1);
      await expect(controlLifecycleChild(root, { ...release, operation: 'cancel' })).rejects.toThrow('contradictory');
    } finally {
      await finish(run);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('stale, forged, wrong owner/source/runtime/physical and reused-process gates cannot release a running child', async () => {
  const root = sourceFixture();
  const spec = specFor(root);
  const run = await launch(root, spec);
  try {
    const gate = (await running(root, run, spec)).evidence.gate;
    const forged: LifecycleGate[] = [
      { ...gate, physicalRunId: randomUUID() },
      { ...gate, remoteRunId: 'foreign-run' },
      { ...gate, host: 'foreign-host' },
      { ...gate, child: { ...gate.child, start: String(BigInt(gate.child.start) + 1n) } },
      ...[
        { nonce: nonce() },
        { checkId: randomUUID() },
        { taskId: randomUUID() },
        { attempt: 2 },
        { sourceCommit: '1'.repeat(40) },
        { sourceTree: '2'.repeat(40) },
        { childSha256: '3'.repeat(64) },
        { runtime: { ...spec.runtime, revision: '4'.repeat(40) } },
        { exitCode: 7 as const },
      ].map((change) => ({ ...gate, spec: { ...spec, ...change } })),
    ];
    for (const candidate of forged) {
      await expect(
        controlLifecycleChild(root, { version: 1, operation: 'release', gate: candidate }),
      ).rejects.toThrow();
      expect(run.child.exitCode).toBeNull();
      expect((await controlLifecycleChild(root, { version: 1, operation: 'read', gate })).state).toBe('running');
    }
    expect((await controlLifecycleChild(root, { version: 1, operation: 'release', gate })).action).toBe('release');
    expect(await run.child.exited).toBe(0);
  } finally {
    await finish(run);
    rmSync(root, { recursive: true, force: true });
  }
});

test('remote gate observation and release occur on the actual child host filesystem', async () => {
  const root = sourceFixture();
  const caller = sourceFixture();
  const spec = specFor(root);
  const remote = randomUUID();
  const run = await launch(root, spec, remote);
  try {
    const gate = (await running(root, run, spec, remote)).evidence.gate;
    const request = { version: 1 as const, operation: 'release' as const, gate };
    await expect(controlLifecycleChild(caller, request)).rejects.toThrow('unavailable');
    writeFileSync(join(caller, 'release-child'), 'release');
    expect((await controlLifecycleChild(root, { ...request, operation: 'read' })).state).toBe('running');
    expect(run.child.exitCode).toBeNull();
    await controlLifecycleChild(root, request);
    expect(await run.child.exited).toBe(0);
  } finally {
    await finish(run);
    rmSync(root, { recursive: true, force: true });
    rmSync(caller, { recursive: true, force: true });
  }
});

test('symlink receipts and replaced gate directories are rejected while the original running child stays held', async () => {
  const root = sourceFixture();
  const spec = specFor(root);
  const run = await launch(root, spec);
  try {
    const gate = (await running(root, run, spec)).evidence.gate;
    const dir = join(root, lifecycleDirectory(run.physicalRunId));
    renameSync(join(dir, 'ready.json'), join(dir, 'original.json'));
    symlinkSync(join(dir, 'original.json'), join(dir, 'ready.json'));
    await expect(controlLifecycleChild(root, { version: 1, operation: 'release', gate })).rejects.toThrow();
    rmSync(join(dir, 'ready.json'));
    renameSync(join(dir, 'original.json'), join(dir, 'ready.json'));
    renameSync(dir, dir + '-saved');
    symlinkSync(dir + '-saved', dir);
    await expect(controlLifecycleChild(root, { version: 1, operation: 'release', gate })).rejects.toThrow('unsafe');
    rmSync(dir);
    renameSync(dir + '-saved', dir);
    expect(run.child.exitCode).toBeNull();
    await controlLifecycleChild(root, { version: 1, operation: 'release', gate });
    expect(await run.child.exited).toBe(0);
  } finally {
    await finish(run);
    rmSync(root, { recursive: true, force: true });
  }
});

for (const mismatch of ['runtime', 'source'] as const) {
  test(`actual child refuses a ${mismatch} mismatch as infrastructure before running/application proof`, async () => {
    const root = sourceFixture();
    const base = specFor(root);
    const spec =
      mismatch === 'runtime'
        ? { ...base, runtime: { ...base.runtime, revision: '0'.repeat(40) } }
        : { ...base, sourceCommit: '0'.repeat(40) };
    const run = await launch(root, spec);
    try {
      expect(await run.child.exited).toBe(78);
      const receipt = readLifecycleChildReceipt(root, run.physicalRunId)!;
      expect(receipt).toMatchObject({ state: 'infrastructure-failure', reason: `child ${mismatch} pin mismatch` });
      expect(receipt.exitCode).toBeUndefined();
      expect(existsSync(join(root, lifecycleDirectory(run.physicalRunId), 'ready.json'))).toBe(false);
      expect(await run.stdout).not.toContain('"state":"child-result"');
    } finally {
      await finish(run);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('caller disappearance expires without requested exit, and the same physical incarnation cannot restart', async () => {
  const root = sourceFixture();
  const spec = specFor(root, 7, 1_000);
  const run = await launch(root, spec);
  try {
    const gate = (await running(root, run, spec)).evidence.gate;
    expect(await run.child.exited).toBe(124);
    const receipt = readLifecycleChildReceipt(root, run.physicalRunId)!;
    expect(receipt.state).toBe('infrastructure-failure');
    expect(receipt.exitCode).toBeUndefined();
    const bytes = readFileSync(join(root, lifecycleDirectory(run.physicalRunId), 'terminal.json'));
    await expect(controlLifecycleChild(root, { version: 1, operation: 'release', gate })).rejects.toThrow('expired');
    const replay = Bun.spawn(
      [pinned, join(root, LIFECYCLE_CHILD), '--probe', encodeLifecycleSpec(spec), '--physical', run.physicalRunId],
      { cwd: root, stdout: 'ignore', stderr: 'ignore' },
    );
    expect(await replay.exited).toBe(75);
    expect(readFileSync(join(root, lifecycleDirectory(run.physicalRunId), 'terminal.json'))).toEqual(bytes);
  } finally {
    await finish(run);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a real child crash retains missing result as unknown and cannot be released through a stale running receipt', async () => {
  const root = sourceFixture();
  const spec = specFor(root, 7);
  const run = await launch(root, spec);
  try {
    const gate = (await running(root, run, spec)).evidence.gate;
    process.kill(gate.child.pid, 'SIGKILL');
    expect(await run.child.exited).not.toBe(7);
    expect(readLifecycleChildReceipt(root, run.physicalRunId)!.state).toBe('running');
    await expect(controlLifecycleChild(root, { version: 1, operation: 'release', gate })).rejects.toThrow(
      'gone or replaced',
    );
    expect(existsSync(join(root, lifecycleDirectory(run.physicalRunId), 'terminal.json'))).toBe(false);
  } finally {
    await finish(run);
    rmSync(root, { recursive: true, force: true });
  }
});

test('finite caller cancellation records infrastructure and never claims requested success', async () => {
  const root = sourceFixture();
  const spec = specFor(root);
  const run = await launch(root, spec);
  try {
    const gate = (await running(root, run, spec)).evidence.gate;
    expect((await controlLifecycleChild(root, { version: 1, operation: 'cancel', gate })).action).toBe('cancel');
    expect(await run.child.exited).toBe(125);
    expect(readLifecycleChildReceipt(root, run.physicalRunId)!.state).toBe('infrastructure-failure');
    expect(await run.stdout).not.toContain('"state":"child-result"');
  } finally {
    await finish(run);
    rmSync(root, { recursive: true, force: true });
  }
});

test('wire protocol rejects eval, extra command flags, unlimited lifetime and forged terminal runtime proof', () => {
  const root = sourceFixture();
  try {
    const spec = specFor(root);
    expect(lifecycleSpecFromArgv(['bun', '-e', 'process.exit(0)'])).toBeUndefined();
    expect(
      lifecycleSpecFromArgv(['bun', LIFECYCLE_CHILD, '--probe', encodeLifecycleSpec(spec), '--physical', randomUUID()]),
    ).toBeUndefined();
    expect(() => encodeLifecycleSpec({ ...spec, lifetimeMs: 120_001 })).toThrow();
    expect(() => encodeLifecycleSpec({ ...spec, nonce: 'fake' })).toThrow();
    expect(() => validateLifecycleReceipt({ version: 1, state: 'child-result', exitCode: 0 })).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// This is an ordinary, real producer admission. It requires the configured a/b hosts and is deliberately not skipped
// when host/runtime/custody evidence is missing. Minimal source-completion workers do not execute this acceptance.
for (const exitCode of [0, 7] as const) {
  test(`installed producer admits and holds a genuine remote child, then foreground wait proves exact ${exitCode} and physical terminal custody`, async () => {
    const original = process.cwd();
    const env = { ...process.env };
    const rootParent = realpathSync(mkdtempSync(join(tmpdir(), 'rezics-producer-lifecycle-')));
    const root = join(rootParent, 'source');
    let binding: ControllerProofBindingV1 | undefined;
    let physicalRunId: string | undefined;
    try {
      const hosts = hostsLocation(repository, process.env);
      if (!('file' in hosts))
        throw new Error('real lifecycle acceptance requires configured a/b hosts: ' + hosts.reason);
      const clone = spawnSync('git', ['clone', '--shared', '--quiet', repository, root], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(clone.status, clone.stderr).toBe(0);
      symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'));
      const registry = join(rootParent, 'registry');
      mkdirSync(registry, { mode: 0o700 });
      process.chdir(root);
      process.env.GOAL_TASK_ID = randomUUID();
      process.env.GOAL_ATTEMPT = '1';
      process.env.GOAL_CHECK_REGISTRY = registry;
      process.env.KERNEL_CHECK_REMOTE = resolve(original, hosts.file);
      process.env.REZICS_CHECK_LEDGER_DIR = join(rootParent, 'ledger');
      const spec = specFor(root, exitCode, 120_000);
      binding = {
        version: 1,
        token: randomUUID(),
        checkId: spec.checkId,
        goal: 'performance',
        taskId: spec.taskId,
        attempt: spec.attempt,
        sourceCommit: spec.sourceCommit,
        sourceTree: spec.sourceTree,
        cwd: root,
        argv: ['bun', LIFECYCLE_CHILD, '--probe', encodeLifecycleSpec(spec)],
      };
      process.env.GOAL_TASK_ID = binding.taskId;
      mkdirSync(join(registry, 'proof-reservations'));
      writeFileSync(
        controllerProofReservationPath(registry, binding.token),
        JSON.stringify({ version: 1, state: 'reserved', binding }),
      );
      const started = await startLifecycleProbe({ binding });
      expect(['started', 'replayed']).toContain(started.admission.outcome);
      physicalRunId = readWorkerCheckRecord(binding.checkId, root).physicalRunId!;
      let observed = started.observation;
      const deadline = performance.now() + 180_000;
      while (observed.status !== 'running' && performance.now() < deadline) {
        await Bun.sleep(250);
        observed = await readLifecycleProbe({ binding, physicalRunId });
      }
      expect(observed.status, JSON.stringify(observed)).toBe('running');
      expect(observed.physicalTerminal).toBe(false);
      expect(observed.childExitCode).toBeUndefined();
      const gate = observed.child!.evidence.gate;
      expect(gate.remoteRunId).not.toBeNull();
      expect(observed.child!.evidence.runtime.revision).toBe(spec.runtime.revision);
      expect(observed.child!.evidence.runtime.executableSha256).toBe(
        observed.child!.evidence.runtime.pinnedExecutableSha256,
      );
      expect((await startLifecycleProbe({ binding, observeMs: 0 })).admission.outcome).toBe('replayed');
      expect(readWorkerCheckRecord(binding.checkId, root).physicalRunId).toBe(physicalRunId);
      for (const foreignGate of [
        { ...gate, physicalRunId: randomUUID() },
        { ...gate, remoteRunId: randomUUID() },
        { ...gate, spec: { ...gate.spec, nonce: nonce() } },
        { ...gate, spec: { ...gate.spec, attempt: gate.spec.attempt + 1 } },
        { ...gate, spec: { ...gate.spec, sourceCommit: '0'.repeat(40) } },
        { ...gate, spec: { ...gate.spec, runtime: { ...gate.spec.runtime, revision: '0'.repeat(40) } } },
      ])
        expect((await releaseLifecycleProbe({ binding, gate: foreignGate })).disposition).toBe('unavailable');
      process.env.GOAL_ATTEMPT = '2';
      expect((await releaseLifecycleProbe({ binding, gate })).disposition).toBe('unavailable');
      process.env.GOAL_ATTEMPT = '1';
      expect((await readLifecycleProbe({ binding, physicalRunId })).status).toBe('running');
      expect(readWorkerCheckHistory(binding.checkId, physicalRunId, root)!.terminalProof).toBeUndefined();
      const released = await releaseLifecycleProbe({ binding, gate });
      expect(released.disposition, released.reason).toBe('released');
      expect(released.custody).toBe('unknown');
      const terminal = await waitLifecycleProbe({ binding, physicalRunId, timeoutMs: 60_000 });
      expect(terminal.status, JSON.stringify(terminal)).toBe('terminal');
      expect(terminal.childExitCode).toBe(exitCode);
      expect(terminal.wrapperExitCode).toBe(exitCode);
      expect(terminal.physicalTerminal).toBe(true);
      expect(terminal.physical!.terminalProof).toMatchObject({ local: true, remote: true, resultKnown: true });
      expect(detachedGroupTerminal(terminal.physical!.runnerIdentity)).toBe(true);
      const before = readWorkerCheckHistory(binding.checkId, physicalRunId, root);
      expect((await releaseLifecycleProbe({ binding, gate })).disposition).toBe('released');
      expect((await readLifecycleProbe({ binding, physicalRunId })).child).toEqual(terminal.child);
      expect(readWorkerCheckHistory(binding.checkId, physicalRunId, root)).toEqual(before);
      const cliFile = join(rootParent, 'wait.json');
      writeFileSync(cliFile, JSON.stringify({ binding, physicalRunId, timeoutMs: 0 }));
      const foreground = spawnSync(pinned, [join(repository, 'scripts/check-lifecycle.ts'), 'wait', cliFile], {
        cwd: root,
        env: process.env,
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(foreground.status, foreground.stderr).toBe(exitCode);
      expect(foreground.stdout).toContain(`check: physical ${physicalRunId}`);
      expect(foreground.stdout).toContain(`check: log ${terminal.record!.log}`);
    } finally {
      process.chdir(original);
      for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
      Object.assign(process.env, env);
      // Never remove receipts/source for a run whose whole tree is still unknown. Its finite native deadline owns cleanup.
      let terminal = !binding || !physicalRunId;
      if (binding && physicalRunId) terminal = (await readLifecycleProbe({ binding, physicalRunId })).physicalTerminal;
      if (terminal) rmSync(rootParent, { recursive: true, force: true });
    }
  }, 300_000);
}

test('a crashed observing caller neither releases nor relaunches the bounded child', async () => {
  const root = sourceFixture();
  const spec = specFor(root, 7, 2_000);
  const run = await launch(root, spec);
  let caller: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const observed = await running(root, run, spec);
    const driver = join(root, 'caller.ts');
    writeFileSync(
      driver,
      `import { observeLifecycleChild } from ${JSON.stringify(join(root, LIFECYCLE_CHILD))};
      const r = await observeLifecycleChild(process.cwd(), JSON.parse(process.argv[2]));
      console.log(JSON.stringify(r)); setInterval(()=>{},1000);\n`,
    );
    caller = Bun.spawn(
      [
        pinned,
        driver,
        JSON.stringify({ version: 1, operation: 'observe', spec, physicalRunId: run.physicalRunId, remoteRunId: null }),
      ],
      {
        cwd: root,
        stdout: 'pipe',
        stderr: 'ignore',
        stdin: 'ignore',
      },
    );
    const reader = (caller.stdout as ReadableStream<Uint8Array>).getReader();
    let text = '';
    while (!text.includes('\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('observing caller disappeared before it established running');
      text += Buffer.from(chunk.value).toString();
    }
    expect(JSON.parse(text.trim()).state).toBe('running');
    caller.kill('SIGKILL');
    await caller.exited;
    await reader.cancel();
    expect(sameProcess(observed.evidence.gate.child)).toBe(true);
    expect(
      (await controlLifecycleChild(root, { version: 1, operation: 'read', gate: observed.evidence.gate })).state,
    ).toBe('running');
    expect(await run.child.exited).toBe(124);
    expect(readLifecycleChildReceipt(root, run.physicalRunId)!.exitCode).toBeUndefined();
  } finally {
    if (caller?.exitCode === null) caller.kill('SIGTERM');
    if (caller) await caller.exited;
    await finish(run);
    rmSync(root, { recursive: true, force: true });
  }
});

test('loss of the release acknowledgement preserves immutable receipt recovery for the same real child', async () => {
  const { createConnection } = await import('node:net');
  const root = sourceFixture();
  const spec = specFor(root, 7);
  const run = await launch(root, spec);
  try {
    const observed = await running(root, run, spec);
    const request = { version: 1 as const, operation: 'release' as const, gate: observed.evidence.gate };
    await expect(
      new Promise((_, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port: observed.evidence.port });
        socket.setTimeout(2_000, () => socket.destroy(new Error('transport timed out')));
        socket.on('connect', () => socket.end(JSON.stringify(request) + '\n'));
        socket.on('data', () => {
          socket.destroy();
          reject(new Error('transport lost after release'));
        });
        socket.on('error', reject);
      }),
    ).rejects.toThrow('transport lost');
    expect(await run.child.exited).toBe(7);
    const result = readLifecycleChildReceipt(root, run.physicalRunId)!;
    expect(result.state).toBe('child-result');
    const recovered = await controlLifecycleChild(root, request);
    expect(recovered).toEqual(result);
    expect(
      (await run.stdout).split('\n').filter((line) => line === 'lifecycle: ' + JSON.stringify(result)),
    ).toHaveLength(1);
  } finally {
    await finish(run);
    rmSync(root, { recursive: true, force: true });
  }
});

test('identity-owned supervisor cleanup reaps its real child descendant and preserves unrelated processes', async () => {
  const root = sourceFixture();
  const spec = specFor(root, 7);
  const run = await launch(root, spec);
  const sentinelFile = join(root, 'sentinel.ts');
  writeFileSync(sentinelFile, 'setInterval(()=>{},1000);\n');
  const sentinel = Bun.spawn([pinned, sentinelFile], { cwd: root, stdout: 'ignore', stderr: 'ignore' });
  try {
    const gate = (await running(root, run, spec)).evidence.gate;
    expect(sameProcess(gate.child)).toBe(true);
    run.child.kill('SIGTERM');
    expect(await run.child.exited).not.toBe(7);
    expect(sameProcess(gate.child)).toBe(false);
    expect(detachedGroupTerminal(gate.child)).toBe(true);
    expect(sentinel.exitCode).toBeNull();
    expect(readLifecycleChildReceipt(root, run.physicalRunId)!.exitCode).toBeUndefined();
  } finally {
    sentinel.kill('SIGTERM');
    await sentinel.exited;
    await finish(run);
    rmSync(root, { recursive: true, force: true });
  }
});
