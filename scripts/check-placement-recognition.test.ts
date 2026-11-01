import { expect, test } from 'bun:test';
import {
  CHECK_HOST_RUNS_ROOT,
  CHECK_HOST_SUPERVISOR_MARKER,
  checkHostScopeUnitName,
  checkHostSliceUnitName,
  recognizeCheckHostRun,
  type CheckHostPathEvidence,
  type CheckHostReadEvidence,
  type CheckHostRecognitionReader,
} from './check-placement.ts';
import { dependencyPreparationProgram, runScript } from './remote-check.ts';

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
  const producer = runScript(runId, runDirectory, 'services/kernel', ['bun', 'scripts/typecheck.ts'], host);
  const slice = checkHostSliceUnitName(runId);
  const scope = checkHostScopeUnitName(runId);
  expect(producer).toContain(`--slice=${slice}`);
  expect(producer).toContain(`--unit=${scope.slice(0, -'.scope'.length)}`);
  expect(producer).toContain(`supervise 180000 ${host} ${runId} ${runDirectory}`);
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
  }
});

test('a lexical run path whose physical compiler cwd escapes its run is refused', () => {
  const fixture = producerFixture('a', '/tmp/escaped/services/kernel');
  expect(recognizeCheckHostRun(compilerDirectory, fixture.reader)).toEqual({
    outcome: 'refused',
    reason: 'cwd-not-confined',
  });
});
