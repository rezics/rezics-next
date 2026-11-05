import {
  AUTH_MANAGEMENT_CLIENT_ID,
  AUTH_MANAGEMENT_SCOPES,
  isManagementOperation,
  managementOperationProfile,
  type SessionProof,
} from '@rezics/auth-contract';

/** Trusted registration, never a consent/grant or live-session scope union. */
export const authManagementClient = {
  clientId: AUTH_MANAGEMENT_CLIENT_ID,
  firstParty: true,
  scopes: [...new Set(Object.values(AUTH_MANAGEMENT_SCOPES).flat())],
  mode: 'create-or-match' as const,
};

/** Compare only. withFreshHuman and Access retain all native authority checks. */
export function managementCallerMatches(proof: SessionProof, accountId: unknown, operation: unknown): boolean {
  if (!isManagementOperation(operation) || proof.account_id !== accountId) return false;
  const profile = managementOperationProfile(operation.kind);
  return (
    proof.client_id === profile.client_id &&
    proof.scope.length === profile.scope.length &&
    proof.scope.every((scope, index) => scope === profile.scope[index]) &&
    proof.amr.length === 1 &&
    (proof.amr[0] === 'pwd' || proof.amr[0] === 'pop')
  );
}
