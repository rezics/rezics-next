import { expect, test } from 'bun:test';
import { EEA_COUNTRIES, MARKET_POLICY_VERSION, SignupPolicyProblem } from '../src/market-policy.ts';
import { signupPolicyInput } from '../src/policy-acceptance.ts';
import { POLICY_VERSIONS } from '../src/policy-versions.ts';

const launchCountries = ['US', 'TW', 'SG', 'JP', 'KR', ...EEA_COUNTRIES];
const acceptedPolicies = POLICY_VERSIONS.map(({ policyId, versionDigest }) => ({
  policyId,
  versionDigest,
}));

test('launch registration records current policy receipts without requiring or retaining a birthday', () => {
  for (const country of launchCountries) {
    const admitted = signupPolicyInput({ minimumAgeConfirmed: true, acceptedPolicies }, country);
    expect(admitted).toEqual({
      registrationPolicyVersion: MARKET_POLICY_VERSION,
      signupPolicies: { acceptedPolicies },
    });
    expect(admitted).not.toHaveProperty('birthDate');
  }
});

test('current policy acceptance cannot substitute for the explicit market minimum-age declaration', () => {
  for (const country of launchCountries) {
    for (const minimumAgeConfirmed of [undefined, false, 'true']) {
      expect(() => signupPolicyInput({ minimumAgeConfirmed, acceptedPolicies }, country))
        .toThrow('minimum_age_confirmation_required');
    }
  }
});

test('an age declaration cannot admit missing, partial, duplicate or stale policy receipts in any launch market', () => {
  const invalidReceipts = [
    undefined,
    [],
    [acceptedPolicies[0]],
    [acceptedPolicies[0], acceptedPolicies[0]],
    ...acceptedPolicies.map((_, staleIndex) => acceptedPolicies.map((receipt, index) =>
      index === staleIndex ? { ...receipt, versionDigest: '0'.repeat(64) } : receipt)),
  ];
  for (const country of launchCountries) {
    for (const receipts of invalidReceipts) {
      expect(() => signupPolicyInput({ minimumAgeConfirmed: true, acceptedPolicies: receipts }, country))
        .toThrow(SignupPolicyProblem);
    }
  }
});
