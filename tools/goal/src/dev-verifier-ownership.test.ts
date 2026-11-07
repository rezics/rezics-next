import { expect, test } from 'bun:test';
import { testFailureRepairBrief, type TestFailureRepair } from './dev-verifier.ts';
import type { Task } from './types.ts';

test('a batched repair brief names each failing test file and assertion under its owning Goal', () => {
  const owner = {
    id: 'kernel-owner',
    brief: {
      goal: 'kernel',
      manager: 'kernel-manager',
      paths: ['services/kernel/**'],
      riskAreas: [],
    },
  } as unknown as Task;
  const repair: TestFailureRepair = {
    goal: 'kernel',
    manager: 'kernel-manager',
    commit: 'current-head',
    owner,
    paths: ['services/kernel/**'],
    failures: [
      {
        test: 'services/kernel/test/session.test.ts',
        assertions: ['AssertionError: expected active session'],
        error: 'AssertionError: expected active session',
        owner,
      },
      {
        test: 'services/kernel/test/lease.test.ts',
        assertions: ['AssertionError: lease remained held'],
        error: 'AssertionError: lease remained held',
        owner,
      },
    ],
  };
  const brief = testFailureRepairBrief(repair);
  expect(brief).toContain('"urgent": true');
  expect(brief).toContain('Test failure repair batch for goal `kernel`');
  expect(brief).toContain('services/kernel/test/session.test.ts');
  expect(brief).toContain('AssertionError: expected active session');
  expect(brief).toContain('services/kernel/test/lease.test.ts');
  expect(brief).toContain('AssertionError: lease remained held');
});
