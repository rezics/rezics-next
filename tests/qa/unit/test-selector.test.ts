import { expect, test } from 'bun:test';
import { selectTestCommand } from '../../../scripts/qa/test.ts';
import { testArgs } from '../../../scripts/qa/acceptance.ts';
import { parseArgs } from '../../../scripts/qa/core.ts';

test('QA09: explicit unit paths still run without a service stack', () => {
  expect(selectTestCommand(['model/compiler/generate.test.ts', '-t', 'profile'])).toEqual([
    'bun', ['test', 'model/compiler/generate.test.ts', '-t', 'profile'],
  ]);
});

test('QA10/MODEL17: native model matrix selects the isolated strict model tier', () => {
  expect(selectTestCommand(['model/tests/native-equivalence.test.ts', '-t', 'MODEL17']))
    .toEqual(['corepack', ['yarn', 'qa', '--tier', 'model', '--file',
      'model/tests/native-equivalence.test.ts', '--id', 'MODEL17']]);
  expect(testArgs('model')).toEqual(['infra/jena/tests/command.integration.test.ts',
    'model/compiler/generate.test.ts',
    'model/tests/native-equivalence.test.ts', 'packages/model/tests/generated.test.ts']);
  expect(selectTestCommand(['infra/jena/tests/command.integration.test.ts', '-t', 'MODEL17']))
    .toEqual(['corepack', ['yarn', 'qa', '--tier', 'model', '--file',
      'infra/jena/tests/command.integration.test.ts', '--id', 'MODEL17']]);
});

test('QA10: registered integration paths and acceptance IDs select shared QA setup', () => {
  expect(selectTestCommand(['services/main/tests/acting-context.integration.test.ts', '-t', 'IAM03']))
    .toEqual(['corepack', ['yarn', 'qa', '--tier', 'integration', '--file',
      'services/main/tests/acting-context.integration.test.ts', '--id', 'IAM03']]);
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
  expect(() => testArgs('integration', undefined, { files: ['services/main/tests/unregistered.integration.test.ts'] }))
    .toThrow('not registered');
});

test('QA10/SYS02: registered fault file routes to its isolated tier', () => {
  expect(selectTestCommand(['tests/qa/fault-recovery/lost-response.test.ts', '-t', 'SYS02']))
    .toEqual(['corepack', ['yarn', 'qa', '--tier', 'fault/recovery', '--file',
      'tests/qa/fault-recovery/lost-response.test.ts', '--id', 'SYS02']]);
  expect(testArgs('fault/recovery', undefined, { files: ['tests/qa/fault-recovery/lost-response.test.ts'],
    id: 'SYS02' })).toEqual(['tests/qa/fault-recovery/lost-response.test.ts', '-t',
      '^(?:[A-Z][A-Z0-9]*\\d{2,}/)*SYS02(?:/|:)']);
  expect(selectTestCommand(['services/main/tests/recovery.integration.test.ts', '-t', 'OPS03']))
    .toEqual(['corepack', ['yarn', 'qa', '--tier', 'fault/recovery', '--file',
      'services/main/tests/recovery.integration.test.ts', '--id', 'OPS03']]);
});

test('QA10/OPS05: registered load file routes to the isolated k6 tier', () => {
  expect(selectTestCommand(['tests/qa/load/public-query.test.ts', '-t', 'OPS05']))
    .toEqual(['corepack', ['yarn', 'qa', '--tier', 'load', '--file',
      'tests/qa/load/public-query.test.ts', '--id', 'OPS05']]);
  expect(testArgs('load', undefined, { files: ['tests/qa/load/public-query.test.ts'],
    id: 'OPS05' })).toEqual(['tests/qa/load/public-query.test.ts', '-t',
      '^(?:[A-Z][A-Z0-9]*\\d{2,}/)*OPS05(?:/|:)']);
});

test('QA10: web browser file routes through the isolated e2e tier', () => {
  expect(selectTestCommand(['apps/web/tests/public-search.e2e.ts']))
    .toEqual(['corepack', ['yarn', 'qa', '--tier', 'e2e', '--file',
      'apps/web/tests/public-search.e2e.ts']]);
});
