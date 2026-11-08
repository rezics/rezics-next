import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { checkHostPressureProgram } from './check-host-pressure.ts';
import { parseRemotePhysicalRunReceipt, parseRunLifetimeFailure, RUN_PRESSURE_FAILURE_MARKER } from './remote-check.ts';
import { remoteLifetimeInfrastructureCause } from './worker-check.ts';

test('shared pressure state applies recovery hysteresis and permits one ordinary self-shed per cooldown', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      checkHostPressureProgram +
        `
state, shed = pressure_transition({}, 5, 0, 0, 'boot')
assert state['paused'] and not shed
state, shed = pressure_transition(state, 5, 0, 15, 'boot', False)
assert not shed  # Protected priority cannot spend the ordinary shedding opportunity.
state, shed = pressure_transition(state, 5, 0, 15, 'boot', True)
assert shed
state, shed = pressure_transition(state, 5, 0, 44, 'boot', True)
assert not shed
state, shed = pressure_transition(state, 5, 0, 45, 'boot', True)
assert shed
state, _ = pressure_transition(state, 0, 0, 46, 'boot')
state, _ = pressure_transition(state, 0, 2, 75, 'boot')
assert state['paused'] and 'healthySince' not in state
state, _ = pressure_transition(state, 0, 0, 76, 'boot')
state, _ = pressure_transition(state, 0, 0, 106, 'boot')
assert not state['paused']
state, shed = pressure_transition(state, 5, 0, 1, 'new-boot', True)
assert not shed and state['severeSince'] == 1
`,
    ],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
});

test('pressure interruption requires the same physical receipt and never claims compiler failure or a timeout', () => {
  const receipt = {
    schema: 1 as const,
    status: 'infrastructure-failure' as const,
    phase: 'host-pressure' as const,
    host: 'check-a',
    run: 'owned-run',
    limitMs: 15000,
    elapsedMs: 20,
    pressure: { memoryFull: 5, ioFull: 0, sustainedMs: 15000 },
    command: 'bun typecheck',
  };
  const output = RUN_PRESSURE_FAILURE_MARKER + JSON.stringify(receipt);
  const physical = {
    schema: 1 as const,
    host: 'check-a',
    run: 'owned-run',
    exitCode: 124,
    lifetimeFailure: receipt,
    resources: null,
  };
  expect(parseRunLifetimeFailure(output)).toEqual(receipt);
  expect(parseRemotePhysicalRunReceipt(physical)).toEqual(physical);
  expect(remoteLifetimeInfrastructureCause(output, physical)).toBe(output);
  expect(remoteLifetimeInfrastructureCause(output)).toBeUndefined();
  expect(remoteLifetimeInfrastructureCause(output, { ...physical, run: 'foreign-run' })).toBeUndefined();
  expect(
    parseRunLifetimeFailure(
      RUN_PRESSURE_FAILURE_MARKER +
        JSON.stringify({ ...receipt, pressure: { ...receipt.pressure, sustainedMs: 14000 } }),
    ),
  ).toBeNull();
});
