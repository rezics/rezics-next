import { expect, test } from 'bun:test';
import { parseReplayArgs } from '../../../scripts/qa/replay.ts';

test('P0.4: QA replay keeps the exact signed seed and one registered test selection', () => {
  expect(parseReplayArgs(['--seed', '-2147483648', 'packages/model/tests/generated.test.ts',
    '-t', 'MODEL15'])).toEqual({ seed: -2147483648,
    file: 'packages/model/tests/generated.test.ts', id: 'MODEL15' });
  expect(parseReplayArgs(['--seed', '2147483647', 'tests/qa/fault-recovery/lost-response.test.ts',
    '-t', 'SYS02']).seed).toBe(2147483647);
  expect(() => parseReplayArgs(['--seed', '2147483648', 'packages/model/tests/generated.test.ts',
    '-t', 'MODEL15'])).toThrow('signed 32-bit');
  expect(() => parseReplayArgs(['--seed', '5', '../outside.test.ts', '-t', 'MODEL15']))
    .toThrow('outside this checkout or missing');
  expect(() => parseReplayArgs(['--seed', '5', 'packages/model/tests/generated.test.ts',
    '-t', 'MODEL15', '--extra'])).toThrow('Usage');
});
