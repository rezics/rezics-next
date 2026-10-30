import { managementOperationProfile, type AccountOperation, type SessionProof } from '@rezics/auth-contract';

/** Local typed alias until the shared management discriminator admits automated.
 * Transfer already installs exactly account:manage on this separate client. */
export const automatedManagementProfile = () => managementOperationProfile('transfer');
export type AutomatedDescriptor = Omit<Extract<AccountOperation, { kind: 'automated' }>, 'authorization'>;

export function automatedDescriptorMatches(value: Record<string, unknown>, key: string): boolean {
  return (
    Object.keys(value).sort().join(',') === 'handle,kind,operationKey,operatorAccountId,registrationId' &&
    value.kind === 'automated' &&
    value.registrationId === '' &&
    value.operationKey === key &&
    key.length > 0 &&
    key.length <= 128 &&
    typeof value.operatorAccountId === 'string' &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.exec(value.operatorAccountId)?.[0] === value.operatorAccountId &&
    typeof value.handle === 'string' &&
    /^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/.exec(value.handle)?.[0] === value.handle
  );
}

/** Compare only. Native fresh proof, consent and Access decide current authority. */
export function automatedCallerMatches(proof: SessionProof, accountId: unknown): boolean {
  const profile = automatedManagementProfile();
  return (
    proof.account_id === accountId &&
    proof.client_id === profile.client_id &&
    proof.scope.length === 1 &&
    proof.scope[0] === profile.scope[0] &&
    proof.amr.length === 1 &&
    (proof.amr[0] === 'pwd' || proof.amr[0] === 'pop')
  );
}

/** Never turn a pending stage, callback or unexpected native answer into success. */
export function automatedNativeResult(result: unknown): { accountId: string } | null {
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    Object.keys(result).join(',') !== 'accountId' ||
    !('accountId' in result) ||
    typeof result.accountId !== 'string' ||
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.exec(result.accountId)?.[0] !== result.accountId
  )
    return null;
  return { accountId: result.accountId };
}
