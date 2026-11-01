import { expect, test } from 'bun:test';
import {
  CHECK_HOST_RUNS_ROOT,
  CHECK_HOST_SUPERVISOR_MARKER,
  checkHostScopeUnitName,
  checkHostRunSliceUnitName,
  classifyCheck,
  recognizeCheckHostRun,
  type CheckHostPathEvidence,
  type CheckHostReadEvidence,
  type CheckHostRecognitionReader,
} from './check-placement.ts';
import { dependencyPreparationProgram, runScript } from './remote-check.ts';
import { runOnCheckHost } from './stack-run.ts';

const runId = 'm7v0a9-k1a2b3c4';
const runDirectory = `${CHECK_HOST_RUNS_ROOT}/${runId}`;
const compilerDirectory = `${runDirectory}/services/kernel`;
const supervisorPid = 4321;
const supervisorStart = '912345678';

function processStat(pid: number, group: number, started: string, state = 'S'): string {
  const fields = Array.from({ length: 20 }, () => '0');
  fields[0] = state;
  fields[2] = String(group);
  fields[19] = started;
  return `${pid} (python3) ${fields.join(' ')}`;
}

function producerFixture(host: 'a' | 'b', cwdRealPath = compilerDirectory) {
  const producer = runScript(
    runId,
    runDirectory,
    'services/kernel',
    ['bun', 'scripts/typecheck.ts'],
    host,
    60_000,
    'ordinary',
    180_000,
  );
  const slice = checkHostRunSliceUnitName(runId);
  const scope = checkHostScopeUnitName(runId);
  expect(producer).toContain(`--slice=${slice}`);
  expect(producer).toContain(`--unit=${scope.slice(0, -'.scope'.length)}`);
  expect(producer).toContain(`supervise 180000 ${host} ${runId} ${runDirectory}`);
  expect(producer).not.toContain('prepared input evidence unavailable');
  expect(dependencyPreparationProgram).toContain(
    "durable(root / '.remote-check-supervisor', json.dumps({'pid': os.getpid(), 'started': fields[19], 'group': os.getpgrp()}))",
  );
  expect(dependencyPreparationProgram).toContain("start_new_session=True");

  const paths = new Map<string, CheckHostPathEvidence>([
    [CHECK_HOST_RUNS_ROOT, { status: 'ok', kind: 'directory', realPath: CHECK_HOST_RUNS_ROOT }],
    [runDirectory, { status: 'ok', kind: 'directory', realPath: runDirectory }],
    [compilerDirectory, { status: 'ok', kind: 'directory', realPath: cwdRealPath }],
  ]);
  const reads = new Map<string, CheckHostReadEvidence>([
    [
      '/proc/self/cgroup',
      {
        status: 'ok',
        kind: 'regular',
        text: `0::/system.slice/${slice}/${scope}\n`,
        size: Buffer.byteLength(`0::/system.slice/${slice}/${scope}\n`),
      },
    ],
    [
      `${runDirectory}/${CHECK_HOST_SUPERVISOR_MARKER}`,
      {
        status: 'ok',
        kind: 'regular',
        text: JSON.stringify({ pid: supervisorPid, started: supervisorStart, group: supervisorPid }),
        size: Buffer.byteLength(JSON.stringify({ pid: supervisorPid, started: supervisorStart, group: supervisorPid })),
      },
    ],
    [
      `/proc/${supervisorPid}/stat`,
      {
        status: 'ok',
        kind: 'regular',
        text: processStat(supervisorPid, supervisorPid, supervisorStart),
        size: Buffer.byteLength(processStat(supervisorPid, supervisorPid, supervisorStart)),
      },
    ],
  ]);
  const reader: CheckHostRecognitionReader = {
    inspect: (path) => paths.get(path) ?? { status: 'missing' },
    read: (path, maxBytes) => {
      const evidence = reads.get(path) ?? { status: 'missing' as const };
      return evidence.status === 'ok' && evidence.size > maxBytes ? { status: 'too-large' } : evidence;
    },
  };
  return { producer, reader, paths, reads, scope, slice };
}

test('the generated a/b lifetime and systemd handoff admits an inner compiler in the matching physical scope', () => {
  for (const host of ['a', 'b'] as const) {
    const fixture = producerFixture(host);
    expect(recognizeCheckHostRun(compilerDirectory, fixture.reader)).toEqual({
      outcome: 'admitted',
      runId,
      scope: fixture.scope,
      supervisor: { pid: supervisorPid, started: supervisorStart, group: supervisorPid },
    });
    expect(recognizeCheckHostRun(runDirectory, fixture.reader).outcome).toBe('admitted');
  }
});

test('an admitted a/b run continues the inner compiler in place without nested host discovery', async () => {
  for (const host of ['a', 'b'] as const) {
    const fixture = producerFixture(host);
    let remoteAttempts = 0;
    const result = await runOnCheckHost(
      {
        label: 'kernel typecheck',
        root: runDirectory,
        cwd: compilerDirectory,
        command: ['bun', 'scripts/typecheck.ts'],
      },
      {},
      async () => {
        remoteAttempts += 1;
        return 75;
      },
      (cwd) => recognizeCheckHostRun(cwd, fixture.reader),
    );
    expect(result).toBeNull();
    expect(remoteAttempts).toBe(0);
  }
});

test('environment markers and caller run IDs cannot replace a refused physical predicate', async () => {
  const fixture = producerFixture('a', '/tmp/escaped/services/kernel');
  const diagnostics: string[] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => diagnostics.push(values.join(' '));
  let remoteAttempts = 0;
  try {
    const result = await runOnCheckHost(
      {
        label: 'kernel typecheck',
        root: runDirectory,
        cwd: compilerDirectory,
        command: ['bun', 'scripts/typecheck.ts'],
      },
      {
        KERNEL_CHECK_ON_REMOTE: '1',
        REZICS_CHECK_RUN: runId,
        KERNEL_CHECK_REMOTE: '/inert/unreadable-hosts.json',
      },
      async () => {
        remoteAttempts += 1;
        return 0;
      },
      (cwd) => recognizeCheckHostRun(cwd, fixture.reader),
    );
    expect(result).toBe(75);
  } finally {
    console.error = original;
  }
  expect(remoteAttempts).toBe(0);
  expect(diagnostics).toContain(
    'stack-run: kernel typecheck physical run recognition refused (cwd-not-confined)',
  );
});

test('stale, forged and unknown supervisor identities fail closed with bounded reasons', () => {
  const stale = producerFixture('a');
  stale.reads.set(`/proc/${supervisorPid}/stat`, {
    status: 'ok',
    kind: 'regular',
    text: processStat(supervisorPid, supervisorPid, '812345678'),
    size: Buffer.byteLength(processStat(supervisorPid, supervisorPid, '812345678')),
  });
  expect(recognizeCheckHostRun(compilerDirectory, stale.reader)).toEqual({
    outcome: 'refused',
    reason: 'supervisor-start-mismatch',
  });

  const forged = producerFixture('a');
  const markerPath = `${runDirectory}/${CHECK_HOST_SUPERVISOR_MARKER}`;
  const marker = JSON.stringify({ pid: supervisorPid, started: supervisorStart, group: supervisorPid + 1 });
  forged.reads.set(markerPath, { status: 'ok', kind: 'regular', text: marker, size: Buffer.byteLength(marker) });
  expect(recognizeCheckHostRun(compilerDirectory, forged.reader)).toEqual({
    outcome: 'refused',
    reason: 'supervisor-group-mismatch',
  });

  const unknown = producerFixture('b');
  const stat = processStat(supervisorPid, supervisorPid, supervisorStart, '?');
  unknown.reads.set(`/proc/${supervisorPid}/stat`, {
    status: 'ok',
    kind: 'regular',
    text: stat,
    size: Buffer.byteLength(stat),
  });
  expect(recognizeCheckHostRun(compilerDirectory, unknown.reader)).toEqual({
    outcome: 'refused',
    reason: 'supervisor-state-unknown',
  });

  const dead = producerFixture('b');
  const deadStat = processStat(supervisorPid, supervisorPid, supervisorStart, 'Z');
  dead.reads.set(`/proc/${supervisorPid}/stat`, {
    status: 'ok',
    kind: 'regular',
    text: deadStat,
    size: Buffer.byteLength(deadStat),
  });
  expect(recognizeCheckHostRun(compilerDirectory, dead.reader)).toEqual({
    outcome: 'refused',
    reason: 'supervisor-not-live',
  });

  const wrongScope = producerFixture('a');
  const cgroupPath = '/proc/self/cgroup';
  const wrongCgroup = `0::/system.slice/${wrongScope.slice}/rezics-check-another-run.scope\n`;
  wrongScope.reads.set(cgroupPath, {
    status: 'ok',
    kind: 'regular',
    text: wrongCgroup,
    size: Buffer.byteLength(wrongCgroup),
  });
  expect(recognizeCheckHostRun(compilerDirectory, wrongScope.reader)).toEqual({
    outcome: 'refused',
    reason: 'scope-mismatch',
  });

  const oversized = producerFixture('b');
  oversized.reads.set(`${runDirectory}/${CHECK_HOST_SUPERVISOR_MARKER}`, { status: 'too-large' });
  expect(recognizeCheckHostRun(compilerDirectory, oversized.reader)).toEqual({
    outcome: 'refused',
    reason: 'supervisor-marker-oversized',
  });
});

test('a lexical run path whose physical compiler cwd escapes its run is refused', () => {
  const fixture = producerFixture('a', '/tmp/escaped/services/kernel');
  expect(recognizeCheckHostRun(compilerDirectory, fixture.reader)).toEqual({
    outcome: 'refused',
    reason: 'cwd-not-confined',
  });
});

test('the generated generic evidence check exists only when a source fingerprint is requested', () => {
  const generic = runScript(
    runId,
    runDirectory,
    'services/kernel',
    ['bun', 'scripts/typecheck.ts'],
    'a',
    60_000,
    'ordinary',
    180_000,
    undefined,
    undefined,
    undefined,
    undefined,
    [],
    'a'.repeat(64),
  );
  expect(generic).toContain('prepared input evidence unavailable');
  expect(generic).toContain('frozen source upload verification failed');
});

test('pure TypeScript stays local while the database-backed kernel compiler stays remote', () => {
  const repository = import.meta.dir.replace(/\/scripts$/, '');
  expect(classifyCheck(['tsc', '--noEmit', '-p', 'packages/client/tsconfig.json'], repository).placement).toBe('local');
  expect(classifyCheck(['bun', 'run', '--cwd', 'services/kernel', 'typecheck'], repository).placement).toBe('remote');
});
