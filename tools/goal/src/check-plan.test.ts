import { expect, test } from 'bun:test';
import { selectAffectedChecks } from './check-plan.ts';
import { integrationChecksForFiles, landingAffectedChecks } from './merge-train.ts';

const checks = [
  { paths: ['apps/web/**'], command: ['web-check'] },
  { paths: ['services/kernel/**'], command: ['kernel-check'] },
  { paths: ['packages/ui/**'], command: ['ordinary-check'] },
  { paths: ['packages/search/**'], command: ['unmatched-check'] },
];
const changed = ['services/kernel/src/core.ts', 'apps/web/src/page.ts', 'packages/ui/src/button.ts'];

test('shared selection preserves configured checks and order for Web, Kernel, and ordinary paths', () => {
  const selected = selectAffectedChecks(changed, checks);
  expect(selected).toEqual(checks.slice(0, 3));
  expect(selected[0]).toBe(checks[0]);
  expect(integrationChecksForFiles(changed, checks)).toEqual(selected);
  expect(landingAffectedChecks(changed, false, checks)).toEqual(selected);
  expect(selectAffectedChecks([], checks)).toEqual([]);
});
