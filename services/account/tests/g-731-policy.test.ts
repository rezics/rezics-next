import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  admitRegistration,
  EEA_COUNTRIES,
  MARKET_POLICY,
  marketRule,
  SignupPolicyProblem,
} from '../src/market-policy.ts';
import { POLICY_VERSIONS } from '../src/policy-versions.ts';
import { validatePolicyAcceptance } from '../src/policy-acceptance.ts';

test('G-731 market class guard: every EEA country, minimum and supported adult markets', () => {
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
    expect(rule.adultAvailable).toBe(!['KR', 'GB', 'CN'].includes(country));
  }
  for (const country of [null, undefined, '', 'XX', 'T1'])
    expect(marketRule(country).minimumAge).toBe(16);
  expect(marketRule('CN').registration).toBe(false);
});

test('G-731 registration requires a minimum-age declaration without collecting a birthday', () => {
  for (const country of ['US', 'KR', 'DE', undefined]) {
    expect(() => admitRegistration(true, country)).not.toThrow();
    for (const value of [undefined, null, false, 'true', '1990-01'])
      expect(() => admitRegistration(value, country)).toThrow('minimum_age_confirmation_required');
  }
  expect(() => admitRegistration(true, 'CN')).toThrow('market_unavailable');
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
