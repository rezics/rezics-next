import { expect, test } from 'bun:test';
import { declaredCases } from '../../../scripts/qa/cases/index.ts';
import { pendingProtectionSubcases } from '../../../scripts/qa/cases/editorial-protection.ts';
import { pendingIdentityCorrectionSubcases } from '../../../scripts/qa/cases/identity-correction.ts';
import { pendingVerificationSubcases } from '../../../scripts/qa/cases/information-verification.ts';
import { pendingPresentationSubcases } from '../../../scripts/qa/cases/presentation-and-addressing.ts';

test('prospective protection, verification and identity obligations retain existing case IDs without a pass claim', () => {
  const ids = new Set(declaredCases.map(({ id }) => id));
  expect([pendingProtectionSubcases.length, pendingVerificationSubcases.length,
    pendingIdentityCorrectionSubcases.length]).toEqual([21, 13, 5]);
  const scenarios = new Set<string>();
  for (const subcase of [
    ...pendingProtectionSubcases, ...pendingVerificationSubcases, ...pendingIdentityCorrectionSubcases,
  ]) {
    expect(subcase.status).toBe('pending');
    expect(subcase.caseIds.length).toBeGreaterThan(0);
    for (const id of subcase.caseIds) expect(ids.has(id)).toBe(true);
    expect(subcase.requiredResult.length).toBeGreaterThan(0);
    expect(scenarios.has(subcase.scenario)).toBe(false);
    scenarios.add(subcase.scenario);
  }
});

test('prospective addressing, summary and visual-selection obligations stay pending under existing VIEW IDs', () => {
  const ids = new Set(declaredCases.map(({ id }) => id));
  expect(pendingPresentationSubcases).toHaveLength(21);
  const scenarios = new Set(pendingPresentationSubcases.map(({ scenario }) => scenario));
  expect(scenarios.size).toBe(pendingPresentationSubcases.length);
  for (const subcase of pendingPresentationSubcases) {
    expect(subcase.status).toBe('pending');
    for (const id of subcase.caseIds) expect(id.startsWith('VIEW') && ids.has(id)).toBe(true);
    expect(subcase.requiredResult.length).toBeGreaterThan(0);
  }
});
