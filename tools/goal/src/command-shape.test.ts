import { expect, test } from 'bun:test';
import { parseBunTestCommand, parseEnvironmentPrefix } from './command-shape.ts';

test('environment prefixes retain ordered raw unsets and assignments', () => {
  const argv = ['env', '-u', 'KERNEL_CHECK_REMOTE', 'CI=1', 'bun', 'test', 'outcomes.test.ts'];
  const parsed = parseEnvironmentPrefix(argv);
  expect(parsed.raw).toEqual(argv.slice(0, 4));
  expect(parsed.command).toEqual(argv.slice(4));
  expect(parsed.operations.map(({ raw }) => raw)).toEqual([['-u', 'KERNEL_CHECK_REMOTE'], ['CI=1']]);
});

test('Bun test syntax preserves focused wrappers, selectors, cwd, timeout and explicit file order', () => {
  const focused = [
    'bun',
    'apps/web/scripts/focused.ts',
    '--private-network',
    '--',
    'bun',
    'test',
    'tests/account.test.ts',
    '-t',
    'signed-out action',
  ];
  const focusedTest = parseBunTestCommand(focused, 4)!;
  expect(focusedTest.prefix).toEqual(focused.slice(0, 6));
  expect(focusedTest.arguments.map(({ raw }) => raw)).toEqual([['tests/account.test.ts'], ['-t', 'signed-out action']]);

  const proof = [
    'env',
    '-u',
    'KERNEL_CHECK_REMOTE',
    'bun',
    '--cwd',
    'services/kernel',
    'test',
    '--timeout',
    '30000',
    'test/imports/helper.ts',
    'test/imports/result.test.ts',
  ];
  const environment = parseEnvironmentPrefix(proof);
  const proofTest = parseBunTestCommand(proof, environment.offset)!;
  expect(proofTest.prefix).toEqual(proof.slice(0, 7));
  expect(proofTest.arguments.map(({ raw }) => raw)).toEqual([
    ['--timeout', '30000'],
    ['test/imports/helper.ts'],
    ['test/imports/result.test.ts'],
  ]);
  expect(
    parseBunTestCommand(['bun', 'test', 'first.test.ts', 'second.test.ts'])?.arguments.map(({ value }) => value),
  ).toEqual(['first.test.ts', 'second.test.ts']);
});
