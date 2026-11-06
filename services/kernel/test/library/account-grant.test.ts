import { expect, test } from 'bun:test';
import { grantCapable, type GrantedAccount } from '../../src/library/account-grant.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { routeOf } from '../../src/route/route.ts';

/** Version 7 identifier: the route is derived from its node bytes. */
const accountId = '018f0c3e-5a7b-7c1d-9e2f-3a4b5c6d7e8f';
const route = routeOf(accountId)!;

function account(overrides: Partial<GrantedAccount> = {}): GrantedAccount {
  return { route, accountId, kind: 'actor', state: 'active', fenced: false, minimumAuthnEpoch: 1n, ...overrides };
}

function viewer(overrides: Partial<AccountActor> = {}): AccountActor {
  return {
    kind: 'account',
    accountId,
    clientId: 'client',
    scopes: ['collection:read'],
    requestedBy: null,
    authnEpoch: 1,
    ...overrides,
  };
}

test('grants a private Collection to the live owner account at the current epoch', () => {
  expect(grantCapable(account(), viewer())).toBe(true);
});

test('denies revoked, fenced or stale authority even when the token is still valid', () => {
  expect(grantCapable(account({ state: 'suspended' }), viewer())).toBe(false);
  expect(grantCapable(account({ fenced: true }), viewer())).toBe(false);
  expect(grantCapable(account({ kind: 'agent' }), viewer())).toBe(false);
  expect(grantCapable(account({ minimumAuthnEpoch: 2n }), viewer({ authnEpoch: 1 }))).toBe(false);
});

test('denies another account, a missing read scope and a non-routable identity', () => {
  const other = '018f0c3e-5a7b-7c1d-9e2f-3a4b5c6d7e90';
  expect(grantCapable(account(), viewer({ accountId: other }))).toBe(false);
  expect(grantCapable(account(), viewer({ scopes: [] }))).toBe(false);
  expect(grantCapable(account(), viewer({ accountId: 'not-a-uuid' }))).toBe(false);
});
