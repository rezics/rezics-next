import { expect, test } from 'bun:test';
import { selectTestCommand } from '../../../scripts/qa/test.ts';
import { testArgs } from '../../../scripts/qa/acceptance.ts';
import { parseArgs } from '../../../scripts/qa/core.ts';

test('QA09: explicit unit paths still run without a service stack', () => {
  expect(selectTestCommand(['model/compiler/generate.test.ts', '-t', 'profile'])).toEqual([
    'bun', ['test', 'model/compiler/generate.test.ts', '-t', 'profile'],
  ]);
});

test('QA10: registered integration paths and acceptance IDs select shared QA setup', () => {
  expect(selectTestCommand(['tests/qa/integration/shared-stack.test.ts', '-t', 'IAM01']))
    .toEqual(['corepack', ['yarn', 'qa', '--tier', 'integration', '--file',
      'tests/qa/integration/shared-stack.test.ts', '--id', 'IAM01']]);
  expect(parseArgs(['--tier', 'integration', '--file',
    'tests/qa/integration/shared-stack.test.ts', '--id', 'IAM01']))
    .toEqual({ tier: 'integration', onlyFailed: undefined, keep: false, record: false,
      files: ['tests/qa/integration/shared-stack.test.ts'], id: 'IAM01' });
  expect(testArgs('integration', undefined, { files: ['tests/qa/integration/shared-stack.test.ts'],
    id: 'IAM01' })).toEqual(['tests/qa/integration/shared-stack.test.ts', '-t',
      '^(?:[A-Z][A-Z0-9]*\\d{2,}/)*IAM01(?:/|:)']);
});

test('QA11: selected runs reject unsafe paths and full-record combinations', () => {
  expect(() => selectTestCommand(['tests/qa/integration/shared-stack.test.ts',
    'model/compiler/generate.test.ts'])).toThrow('separate commands');
  expect(() => selectTestCommand(['../outside.test.ts'])).toThrow('outside this checkout or missing');
  expect(() => parseArgs(['--record', '--tier', 'integration', '--id', 'OPS01']))
    .toThrow('--record requires a full run');
  expect(() => testArgs('integration', undefined, { files: ['services/main/tests/full-work.integration.test.ts'] }))
    .toThrow('not registered');
});
