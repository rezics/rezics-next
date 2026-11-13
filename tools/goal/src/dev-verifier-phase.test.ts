import { expect, test } from 'bun:test';
import {
  consumeVerifierPhaseReceipt,
  DEV_VERIFIER_PHASES,
  verifierCommandSha256,
  type DevVerifierPhaseBinding,
  type DevVerifierPhaseReceipt,
} from './dev-verifier-phase.ts';

function measuredPhases() {
  return Object.fromEntries(
    DEV_VERIFIER_PHASES.map((phase, index) => [
      phase,
      { status: 'measured', clockId: 'check-host:boot-1', startedMs: index * 10, completedMs: index * 10 + 7 },
    ]),
  );
}

function receipt(binding: DevVerifierPhaseBinding): DevVerifierPhaseReceipt {
  return {
    schema: 1,
    executionId: binding.executionId,
    commandSha256: verifierCommandSha256(binding.command, binding.cwd),
    runner: { kind: 'check-host', id: 'physical-run-7', host: 'kernel-check-a' },
    phases: measuredPhases(),
  };
}

function remotePhysicalReceipt(commandStartedMonoMs: number | null) {
  const resources = {
    schema: 1 as const,
    host: 'kernel-check-a',
    run: 'physical-run-7',
    boot: 'boot-1',
    supervisor: { pid: 7, start: '1234', group: 7 },
    cgroup: null,
    cadenceMs: 5000 as const,
    startedMonoMs: 10,
    commandStartedMonoMs,
    terminalMonoMs: 50,
    samples: [],
    sampledMaxCores: null,
  };
  return {
    schema: 1 as const,
    host: 'kernel-check-a',
    run: 'physical-run-7',
    exitCode: 0,
    lifetimeFailure: null,
    resources,
  };
}

test('phase evidence is accepted only for the exact command execution and named runner', () => {
  const binding = { executionId: 'execution-7', command: ['bun', 'test', 'boot.test.ts'], cwd: 'services/kernel' };
  const accepted = consumeVerifierPhaseReceipt(receipt(binding), binding);
  expect(accepted).toMatchObject({
    schema: 1,
    executionId: 'execution-7',
    runner: { kind: 'check-host', id: 'physical-run-7', host: 'kernel-check-a' },
    phases: { execution: { status: 'measured', durationMs: 7 } },
  });

  const wrongRun = consumeVerifierPhaseReceipt(receipt(binding), { ...binding, executionId: 'execution-8' });
  const wrongCommand = consumeVerifierPhaseReceipt(receipt(binding), {
    ...binding,
    command: ['bun', 'test', 'other.test.ts'],
  });
  const prose = consumeVerifierPhaseReceipt('remote-check: command phase execution 7.000 s', binding);
  for (const rejected of [wrongRun, wrongCommand, prose]) {
    expect(rejected.runner).toEqual({ kind: 'unknown', id: null });
    expect(DEV_VERIFIER_PHASES.map((phase) => rejected.phases[phase].status)).toEqual([
      'unknown',
      'unknown',
      'unknown',
      'unknown',
    ]);
  }
});

test('absent and invalid boundaries stay unknown while explicit unreached phases stay visible', () => {
  const binding = { executionId: 'execution-9', command: ['bun', 'test', 'boot.test.ts'] };
  const producerReceipt = receipt(binding);
  const partial = consumeVerifierPhaseReceipt(
    {
      ...producerReceipt,
      phases: {
        queue: { status: 'measured', clockId: 'client-clock', startedMs: 5, completedMs: 9 },
        preparation: { status: 'unreached', reason: 'No check host admitted the run.' },
        execution: { status: 'unreached', reason: 'The command was never launched.' },
        settlement: { status: 'measured', clockId: 'client-clock', startedMs: 12, completedMs: 13 },
      },
    },
    binding,
  );
  expect(partial.phases).toMatchObject({
    queue: { status: 'measured', durationMs: 4 },
    preparation: { status: 'unreached' },
    execution: { status: 'unreached' },
    settlement: { status: 'measured', durationMs: 1 },
  });

  const omitted = consumeVerifierPhaseReceipt(
    { ...producerReceipt, phases: { execution: { status: 'measured', clockId: '', startedMs: 0, completedMs: 1 } } },
    binding,
  );
  expect(omitted.phases.queue.status).toBe('unknown');
  expect(omitted.phases.preparation.status).toBe('unknown');
  expect(omitted.phases.execution.status).toBe('unknown');
  expect(omitted.phases.settlement.status).toBe('unknown');

  const contradictory = consumeVerifierPhaseReceipt(
    {
      ...producerReceipt,
      phases: {
        queue: { status: 'measured', clockId: 'client-clock', startedMs: 1, completedMs: 2 },
        preparation: { status: 'unreached', reason: 'Preparation failed.' },
        execution: { status: 'measured', clockId: 'host-clock', startedMs: 3, completedMs: 4 },
      },
    },
    binding,
  );
  expect(DEV_VERIFIER_PHASES.every((phase) => contradictory.phases[phase].status === 'unknown')).toBe(true);

  const overlapping = consumeVerifierPhaseReceipt(
    {
      ...producerReceipt,
      phases: {
        queue: { status: 'measured', clockId: 'same-clock', startedMs: 1, completedMs: 5 },
        preparation: { status: 'measured', clockId: 'same-clock', startedMs: 4, completedMs: 6 },
        execution: { status: 'measured', clockId: 'same-clock', startedMs: 6, completedMs: 7 },
      },
    },
    binding,
  );
  expect(DEV_VERIFIER_PHASES.every((phase) => overlapping.phases[phase].status === 'unknown')).toBe(true);
});

test('remote-check physical receipts provide only their authoritative preparation and execution boundaries', () => {
  const binding = { executionId: 'execution-10', command: ['bun', 'run', '--cwd', 'services/kernel', 'check'] };
  const source = remotePhysicalReceipt(30);
  const remote = consumeVerifierPhaseReceipt(
    {
      schema: 1,
      executionId: binding.executionId,
      commandSha256: verifierCommandSha256(binding.command),
      runner: { kind: 'check-host', id: source.run, host: source.host },
      remoteReceipt: source,
    },
    binding,
  );
  expect(remote.phases).toMatchObject({
    queue: { status: 'unknown' },
    preparation: { status: 'measured', clockId: 'check-host:kernel-check-a:boot-1', durationMs: 20 },
    execution: { status: 'measured', durationMs: 20 },
    settlement: { status: 'unknown' },
  });

  const unreachedSource = remotePhysicalReceipt(null);
  const unreached = consumeVerifierPhaseReceipt(
    {
      schema: 1,
      executionId: binding.executionId,
      commandSha256: verifierCommandSha256(binding.command),
      runner: { kind: 'check-host', id: unreachedSource.run, host: unreachedSource.host },
      remoteReceipt: unreachedSource,
    },
    binding,
  );
  expect(unreached.phases.execution).toMatchObject({ status: 'unreached' });
});
