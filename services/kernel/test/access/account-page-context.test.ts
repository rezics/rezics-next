import { expect, test } from 'bun:test';
import { accountProfileAuthorityAnchor } from '../../src/access/account-viewer-actions.ts';

const accountId = '0192f3a0-6c1e-7b2a-8000-000000000021';
const operatorId = '0192f3a0-6c1e-7b2a-8000-000000000022';

test('current managed actor advice follows the live operator anchor and closes for other identities or states', () => {
  expect(
    accountProfileAuthorityAnchor({ kind: 'actor', state: 'active', operatorAccountId: operatorId }, accountId),
  ).toEqual({ operatorId, id: operatorId, action: 'account:manage' });
  expect(
    accountProfileAuthorityAnchor({ kind: 'actor', state: 'suspended', operatorAccountId: operatorId }, accountId),
  ).toEqual({ operatorId: null, id: accountId, action: 'account:update' });
  expect(
    accountProfileAuthorityAnchor({ kind: 'organization', state: 'active', operatorAccountId: operatorId }, accountId),
  ).toEqual({ operatorId: null, id: accountId, action: 'account:update' });
});
