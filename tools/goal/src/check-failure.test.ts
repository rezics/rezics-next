import { expect, test } from 'bun:test';
import { classifyRun } from './dev-verifier.ts';
import { isPromotionInfrastructureText, isTransportTimeout } from './check-failure.ts';

const transportTimeouts = [
  'ETIMEDOUT',
  'spawnSync docker run ETIMEDOUT',
  'timeout while starting docker',
  'ssh: connect failed; exit 255',
  'rsync error: unexplained error (code 255)',
];
const bunTestTimeout = '(fail) fixture waits [5001.00ms]\n  ^ this test timed out after 5000ms.';
const assertion = 'AssertionError: expected fixture result';

test('verifier and promotion share transport and timeout recognition', () => {
  for (const output of transportTimeouts) {
    expect(isTransportTimeout(output)).toBe(true);
    expect(isPromotionInfrastructureText(output)).toBe(true);
    expect(classifyRun({ passed: false, timedOut: false, output })).toBe('infrastructure');
  }
  expect(isTransportTimeout(assertion)).toBe(false);
  expect(isPromotionInfrastructureText(assertion)).toBe(false);
  expect(classifyRun({ passed: false, timedOut: false, output: assertion })).toBe('fail');
});

test('promotion excludes Bun test timeouts and treats Docker run failures as infrastructure', () => {
  expect(isTransportTimeout(bunTestTimeout)).toBe(true);
  expect(isPromotionInfrastructureText(bunTestTimeout)).toBe(false);
  expect(classifyRun({ passed: false, timedOut: false, output: bunTestTimeout })).toBe('infrastructure');
  expect(isPromotionInfrastructureText('docker run failed with exit code 1')).toBe(true);
  expect(isTransportTimeout('docker run failed with exit code 1')).toBe(false);
  expect(classifyRun({ passed: false, timedOut: false, output: 'docker run failed with exit code 1' })).toBe('fail');
});
