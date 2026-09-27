import { expect, test } from 'bun:test';
import { declaredCases } from '../../../scripts/qa/cases/index.ts';
import { pendingProtectionSubcases } from '../../../scripts/qa/cases/editorial-protection.ts';
import { pendingIdentityCorrectionSubcases } from '../../../scripts/qa/cases/identity-correction.ts';
import { pendingVerificationSubcases } from '../../../scripts/qa/cases/information-verification.ts';

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
