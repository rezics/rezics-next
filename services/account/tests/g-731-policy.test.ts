import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  admitBirthMonth,
  EEA_COUNTRIES,
  MARKET_POLICY,
  marketRule,
  SignupPolicyProblem,
} from '../src/market-policy.ts';
import { POLICY_VERSIONS } from '../src/policy-versions.ts';
import { validatePolicyAcceptance } from '../src/policy-acceptance.ts';

test('G-731 market class guard: every EEA country, minimum and closed adult market', () => {
  const expected =
    'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO'.split(
      ' ',
    );
  expect([...EEA_COUNTRIES].sort() as string[]).toEqual(expected.sort());
  for (const country of expected)
    expect(MARKET_POLICY[country]?.minimumAge).toBeGreaterThanOrEqual(16);
  for (const [country, rule] of Object.entries(MARKET_POLICY)) {
    expect(rule.minimumAge).toBeGreaterThanOrEqual(
      country === 'KR' ? 14 : expected.includes(country) ? 16 : 13,
    );
    expect(rule.adultAvailable).toBe(false);
  }
  for (const country of [null, undefined, '', 'XX', 'T1'])
    expect(marketRule(country).minimumAge).toBe(16);
  expect(marketRule('CN').registration).toBe(false);
});

test('G-731 month-only boundary never admits before the last possible birthday, including UTC year rollover', () => {
  for (const [country, age] of [
    ['US', 13],
    ['KR', 14],
    ['DE', 16],
  ] as const) {
    for (const month of [1, 2, 6, 12]) {
      const birth = `${2026 - age}-${String(month).padStart(2, '0')}`;
      const during = new Date(Date.UTC(2026, month - 1, 28, 23, 59, 59));
      expect(() => admitBirthMonth(birth, country, during)).toThrow('market_minimum_age');
      expect(admitBirthMonth(birth, country, new Date(Date.UTC(2026, month, 1)))).toBe(birth);
    }
  }
  for (const birth of ['2027-01', '2000-00', '2000-13', '2000-1', '1899-12', 2000]) {
    expect(() => admitBirthMonth(birth, 'US', new Date('2026-01-01'))).toThrow(
      'invalid_birth_month',
    );
  }
  expect(() => admitBirthMonth(undefined)).toThrow('birth_month_required');
  expect(() => admitBirthMonth('1990-01', 'CN')).toThrow('market_unavailable');
});

test('G-731 policy source digests and exact complete acknowledgement', () => {
  for (const policy of POLICY_VERSIONS) {
    expect(
      createHash('sha256')
        .update(readFileSync(new URL(`../../../${policy.source}`, import.meta.url)))
        .digest('hex'),
    ).toBe(policy.versionDigest);
  }
  const accepted = POLICY_VERSIONS.map(({ policyId, versionDigest }) => ({
    policyId,
    versionDigest,
  }));
  expect(validatePolicyAcceptance(accepted)).toEqual(accepted);
  for (const value of [
    undefined,
    [],
    [accepted[0], accepted[0]],
    [accepted[0]],
    [{ ...accepted[0], versionDigest: 'a'.repeat(64) }, accepted[1]],
  ]) {
    expect(() => validatePolicyAcceptance(value)).toThrow(SignupPolicyProblem);
  }
});
