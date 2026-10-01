import { POLICY_VERSIONS } from '../../services/account/src/policy-versions.ts';

/** Synthetic adult declaration for local demo/test accounts, never real people.
 * Callers submit this through Account's sign-up API so fixtures exercise the
 * same admission and acceptance path as public enrollment. */
export const signupPolicyFixture = {
  minimumAgeConfirmed: true,
  acceptedPolicies: POLICY_VERSIONS.map(({ policyId, versionDigest }) => ({
    policyId,
    versionDigest,
  })),
};
