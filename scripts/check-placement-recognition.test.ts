import { expect, test } from 'bun:test';
import {
  CHECK_HOST_RUNS_ROOT,
  CHECK_HOST_SUPERVISOR_MARKER,
  CHECK_HOST_SUPERVISOR_MARKER_SCHEMA,
  checkHostScopeUnitName,
  checkHostRunSliceUnitName,
  classifyCheck,
  isCheckHostRunCandidate,
  recognizeCheckHostRun,
  type CheckHostPathEvidence,
  type CheckHostReadEvidence,
  type CheckHostRecognitionReader,
} from './check-placement.ts';
import { dependencyPreparationProgram, runScript, sourceInputVerificationProgram } from './remote-check.ts';
import { runOnCheckHost } from './stack-run.ts';

const runId = 'm7v0a9-k1a2b3c4';
const runDirectory = `${CHECK_HOST_RUNS_ROOT}/${runId}`;
const compilerDirectory = `${runDirectory}/services/kernel`;
const supervisorPid = 4321;
const supervisorStart = '912345678';
const fixtureUid = 1000;

function processStat(pid: number, group: number, started: string, state = 'S'): string {
  const fields = Array.from({ length: 20 }, () => '0');
  fields[0] = state;
  fields[2] = String(group);
  fields[19] = started;
  return `${pid} (python3) ${fields.join(' ')}`;
}

function markerRecord(host: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const values: Record<string, unknown> = {
    schema: CHECK_HOST_SUPERVISOR_MARKER_SCHEMA.version,
    host,
    run: runId,
    pid: supervisorPid,
    started: supervisorStart,
    group: supervisorPid,
    uid: fixtureUid,
  };
  return {
    ...Object.fromEntries(CHECK_HOST_SUPERVISOR_MARKER_SCHEMA.fields.map((field) => [field, values[field]] as const)),
    ...overrides,
  };
}

function producerFixture(host: 'a' | 'b' | 'c', cwdRealPath = compilerDirectory) {
  const producer = runScript(
    runId,
    runDirectory,
    'services/kernel',
    ['bun', 'scripts/typecheck.ts'],
    host,
    { version: '1.2.3', revision: 'a'.repeat(40) },
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
  expect(producer).toContain(Buffer.from(dependencyPreparationProgram).toString('base64'));
  expect(dependencyPreparationProgram).toContain(
    `SUPERVISOR_SCHEMA = ${JSON.stringify(CHECK_HOST_SUPERVISOR_MARKER_SCHEMA)}`,
  );
  expect(dependencyPreparationProgram).toContain(
    "supervisor = dict(zip(SUPERVISOR_SCHEMA['fields'], supervisor_values))",
  );
  expect(sourceInputVerificationProgram).toContain(
    `SUPERVISOR_SCHEMA=${JSON.stringify(CHECK_HOST_SUPERVISOR_MARKER_SCHEMA)}`,
  );
  expect(sourceInputVerificationProgram).toContain("set(marker)!=set(SUPERVISOR_SCHEMA['fields'])");
  expect(sourceInputVerificationProgram).toContain(
    "read_control_json(root,'.remote-check-supervisor',maximum=SUPERVISOR_SCHEMA['maxBytes'])",
  );
  expect(dependencyPreparationProgram).toContain('start_new_session=True');

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
        text: JSON.stringify(markerRecord(host)),
        size: Buffer.byteLength(JSON.stringify(markerRecord(host))),
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
    uid: () => fixtureUid,
    read: (path, maxBytes) => {
      const evidence = reads.get(path) ?? { status: 'missing' as const };
      return evidence.status === 'ok' && evidence.size > maxBytes ? { status: 'too-large' } : evidence;
    },
  };
  return {
    producer,
    reader,
    paths,
    reads,
    markerPath: `${runDirectory}/${CHECK_HOST_SUPERVISOR_MARKER}`,
    scope,
    slice,
  };
}

function setMarker(fixture: ReturnType<typeof producerFixture>, record: unknown): void {
  const serialized = typeof record === 'string' ? record : JSON.stringify(record);
  if (serialized === undefined) throw new Error('marker fixture must serialize to text');
  const text = serialized;
  fixture.reads.set(fixture.markerPath, {
    status: 'ok',
    kind: 'regular',
    text,
    size: Buffer.byteLength(text),
  });
}

function setReadText(fixture: ReturnType<typeof producerFixture>, path: string, text: string): void {
  fixture.reads.set(path, { status: 'ok', kind: 'regular', text, size: Buffer.byteLength(text) });
}

test('the generated a/b/c lifetime and systemd handoff admits an inner compiler in the matching physical scope', () => {
  for (const host of ['a', 'b', 'c'] as const) {
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

test('an admitted a/b/c run continues the inner compiler in place without nested host discovery', async () => {
  for (const host of ['a', 'b', 'c'] as const) {
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
  expect(diagnostics).toEqual(['stack-run: kernel typecheck physical run recognition refused (cwd-not-confined)']);
});

test('malformed run paths remain candidates and cannot enter nested placement', () => {
  const malformed = `${CHECK_HOST_RUNS_ROOT}/UpperCase/services/kernel`;
  expect(isCheckHostRunCandidate(malformed)).toBe(true);
  expect(recognizeCheckHostRun(malformed, producerFixture('a').reader)).toEqual({
    outcome: 'refused',
    reason: 'run-id-invalid',
  });
});

test('only exact producer markers and live process evidence are admitted', () => {
  const cases: {
    name: string;
    alter: (fixture: ReturnType<typeof producerFixture>) => void;
    reason: string;
  }[] = [
    {
      name: 'the obsolete three-field marker',
      alter: (fixture) => setMarker(fixture, { pid: supervisorPid, started: supervisorStart, group: supervisorPid }),
      reason: 'supervisor-marker-invalid',
    },
    {
      name: 'a missing field',
      alter: (fixture) => {
        const marker = markerRecord('a');
        delete marker.uid;
        setMarker(fixture, marker);
      },
      reason: 'supervisor-marker-invalid',
    },
    {
      name: 'an extra field',
      alter: (fixture) => setMarker(fixture, markerRecord('a', { extra: true })),
      reason: 'supervisor-marker-invalid',
    },
    {
      name: 'an unsupported schema version',
      alter: (fixture) => setMarker(fixture, markerRecord('a', { schema: 2 })),
      reason: 'supervisor-marker-invalid',
    },
    {
      name: 'malformed marker JSON',
      alter: (fixture) => setMarker(fixture, '{broken'),
      reason: 'supervisor-marker-invalid',
    },
    {
      name: 'an invalid host label',
      alter: (fixture) => setMarker(fixture, markerRecord('../foreign')),
      reason: 'supervisor-host-invalid',
    },
    {
      name: 'a marker for another run',
      alter: (fixture) => setMarker(fixture, markerRecord('a', { run: 'another-run' })),
      reason: 'supervisor-run-mismatch',
    },
    {
      name: 'a marker owned by another uid',
      alter: (fixture) => setMarker(fixture, markerRecord('a', { uid: fixtureUid + 1 })),
      reason: 'supervisor-uid-mismatch',
    },
    {
      name: 'an unsafe pid',
      alter: (fixture) => setMarker(fixture, markerRecord('a', { pid: Number.MAX_SAFE_INTEGER + 1 })),
      reason: 'supervisor-marker-invalid',
    },
    {
      name: 'a nonleader process group',
      alter: (fixture) => setMarker(fixture, markerRecord('a', { group: supervisorPid + 1 })),
      reason: 'supervisor-group-mismatch',
    },
    {
      name: 'a stat record naming another pid',
      alter: (fixture) =>
        setReadText(
          fixture,
          `/proc/${supervisorPid}/stat`,
          processStat(supervisorPid + 1, supervisorPid, supervisorStart),
        ),
      reason: 'supervisor-stat-invalid',
    },
    {
      name: 'a mismatched process start time',
      alter: (fixture) =>
        setReadText(fixture, `/proc/${supervisorPid}/stat`, processStat(supervisorPid, supervisorPid, '812345678')),
      reason: 'supervisor-start-mismatch',
    },
    {
      name: 'a mismatched process group',
      alter: (fixture) =>
        setReadText(
          fixture,
          `/proc/${supervisorPid}/stat`,
          processStat(supervisorPid, supervisorPid + 1, supervisorStart),
        ),
      reason: 'supervisor-group-mismatch',
    },
    {
      name: 'an unknown process state',
      alter: (fixture) =>
        setReadText(
          fixture,
          `/proc/${supervisorPid}/stat`,
          processStat(supervisorPid, supervisorPid, supervisorStart, '?'),
        ),
      reason: 'supervisor-state-unknown',
    },
    {
      name: 'a dead process',
      alter: (fixture) =>
        setReadText(
          fixture,
          `/proc/${supervisorPid}/stat`,
          processStat(supervisorPid, supervisorPid, supervisorStart, 'Z'),
        ),
      reason: 'supervisor-not-live',
    },
    {
      name: 'a foreign cgroup scope',
      alter: (fixture) =>
        setReadText(fixture, '/proc/self/cgroup', `0::/system.slice/${fixture.slice}/rezics-check-another-run.scope\n`),
      reason: 'scope-mismatch',
    },
    {
      name: 'a foreign run slice with the expected scope',
      alter: (fixture) =>
        setReadText(fixture, '/proc/self/cgroup', `0::/system.slice/rezics-check-another-run.slice/${fixture.scope}\n`),
      reason: 'scope-mismatch',
    },
    {
      name: 'a cgroup path with an escaped component',
      alter: (fixture) =>
        setReadText(fixture, '/proc/self/cgroup', `0::/system.slice/../${fixture.slice}/${fixture.scope}\n`),
      reason: 'cgroup-invalid',
    },
    {
      name: 'a run directory that resolves outside the runs root',
      alter: (fixture) =>
        fixture.paths.set(runDirectory, { status: 'ok', kind: 'symlink', realPath: '/tmp/foreign-run' }),
      reason: 'run-directory-not-physical',
    },
    {
      name: 'a symlinked marker',
      alter: (fixture) => fixture.reads.set(fixture.markerPath, { status: 'symlink' }),
      reason: 'supervisor-marker-not-regular',
    },
    {
      name: 'an oversized marker',
      alter: (fixture) => fixture.reads.set(fixture.markerPath, { status: 'too-large' }),
      reason: 'supervisor-marker-oversized',
    },
  ];

  for (const scenario of cases) {
    const fixture = producerFixture('a');
    scenario.alter(fixture);
    expect(recognizeCheckHostRun(compilerDirectory, fixture.reader), scenario.name).toEqual({
      outcome: 'refused',
      reason: scenario.reason,
    });
  }
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
    { version: '1.2.3', revision: 'a'.repeat(40) },
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

test('a workstation worker outside a physical run is refused even with a valid c supervisor', () => {
  const fixture = producerFixture('c');
  expect(recognizeCheckHostRun('/home/worker/checkout', fixture.reader)).toEqual({
    outcome: 'refused',
    reason: 'cwd-outside-runs',
  });
});
