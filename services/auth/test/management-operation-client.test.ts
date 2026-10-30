import { expect, test } from 'bun:test';
import {
  AUTH_PAGE_OPERATION_CLIENT_ID,
  AUTH_PAGE_OPERATION_SCOPES,
  managementOperationProfile,
  type SessionProof,
} from '@rezics/auth-contract';
import { authManagementClient, managementCallerMatches } from '../src/auth-management-client';

test('management registration is separate and its ceiling never becomes a live operation profile', () => {
  expect(authManagementClient).toEqual({
    clientId: 'rezics-auth-account-management',
    firstParty: true,
    scopes: ['account:update', 'organization:membership', 'account:manage'],
    mode: 'create-or-match',
  });
  expect(AUTH_PAGE_OPERATION_CLIENT_ID).toBe('rezics-auth-account-operations');
  expect(AUTH_PAGE_OPERATION_SCOPES).toEqual({ organization: ['organization:create'], delete: ['account:delete'] });
  const operation = { kind: 'rename', accountId: 'managed-subject', handle: 'new-handle', expectedHandle: null };
  const profile = managementOperationProfile('rename');
  const proof: SessionProof = {
    account_id: 'human',
    client_id: profile.client_id,
    scope: profile.scope,
    authn_epoch: 2,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  };
  expect(managementCallerMatches(proof, 'human', operation)).toBe(true);
  expect(managementCallerMatches(proof, 'managed-subject', operation)).toBe(false);
  expect(managementCallerMatches({ ...proof, scope: authManagementClient.scopes }, 'human', operation)).toBe(false);
  expect(managementCallerMatches({ ...proof, client_id: AUTH_PAGE_OPERATION_CLIENT_ID }, 'human', operation)).toBe(
    false,
  );
  expect(managementCallerMatches({ ...proof, amr: ['operator'] }, 'human', operation)).toBe(false);
  expect(managementCallerMatches(proof, 'human', { ...operation, authorization: 'browser-proof' })).toBe(false);
});
