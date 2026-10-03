import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { AccessMemberships, MembershipDenied, MembershipStale,
  type MembershipChange } from '../src/modules/access/memberships.ts';
import { accessMembershipRoutes } from '../src/routes/access-memberships.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { AccountAssertionDenied, AccountAssertionInsufficientScope } from '../src/modules/account/verify-assertion.ts';

const member = 'https://rezics.com/id/00000000-0000-8000-8000-000000000963';
const realm = 'https://rezics.com/id/00000000-0000-8000-8000-000000000964';
const principalId = '00000000-0000-8000-8000-000000000965';
const membershipId = '00000000-0000-8000-8000-000000000966';
const input: MembershipChange = { principal: { issuer: 'https://account.test', subject: 'member' },
  kind: 'realm', ownerSubject: realm, memberSubject: member, action: 'leave',
  expectedGeneration: '1', expectedPolicyRevision: '1', idempotencyKey: 'leave', requestDigest: 'a'.repeat(64) };

function fixture(controlled = true) {
  let epoch = '4';
  const queries: string[] = [];
  const membership = { id: membershipId, state: 'joined', generation: '1',
    policy_revision: '1', terms_revision: 'terms-1' as string | null,
    consent_reference: '00000000-0000-8000-8000-000000000967' as string | null };
  const receipts = new Map<string, Record<string, unknown>>();
  const history = new Map<string, Record<string, unknown>>();
  history.set('1', { ...membership });
  let historyWrites = 0;
  const query = async (sql: string, args: unknown[] = []) => {
    queries.push(sql);
    let rows: Record<string, unknown>[] = [];
    if (sql.includes('FROM access.recovery_fence')) rows = [{ open: true }];
    else if (sql.includes('FROM access.scope_gate')) rows = [{ authority_epoch: epoch, open: true, dispatch_open: true }];
    else if (sql.includes('SELECT id FROM access.principal')) rows = [{ id: principalId }];
    else if (sql.includes('FROM access.membership_change_receipt')) rows = receipts.has(String(args[1])) ? [receipts.get(String(args[1]))!] : [];
    else if (sql.includes('FROM access.representation r')) rows = controlled && args[1] === member ? [{ id: 'controller' }] : [];
    else if (sql.includes('FROM access.principal p')) rows = []; // No Realm management grant.
    else if (sql.includes('FROM access.membership_policy')) rows = [{ revision: '2', terms_revision: 'new-terms', open: false }];
    else if (sql.includes('SELECT id FROM access.authority_subject')) rows = [{ id: member }];
    else if (sql.includes('FROM access.membership m JOIN access.membership_history')) {
      rows = [{ kind: 'realm', owner_subject: realm, member_subject: member, ...history.get(String(args[1]))! }];
    } else if (sql.includes('FROM access.membership WHERE')) rows = [{ ...membership }];
    else if (sql.startsWith('UPDATE access.membership SET')) {
      membership.state = String(args[1]); membership.generation = String(args[2]);
      membership.policy_revision = String(args[3]); membership.terms_revision = args[4] as string | null;
      membership.consent_reference = args[5] as string | null;
    } else if (sql.includes('UPDATE access.scope_gate SET')) {
      epoch = (BigInt(epoch) + 1n).toString(); rows = [{ authority_epoch: epoch }];
    } else if (sql.includes('INSERT INTO access.membership_history')) {
      historyWrites++; history.set(String(args[1]), { state: args[2], policy_revision: args[3],
        terms_revision: args[4], consent_reference: args[5] });
    } else if (sql.includes('INSERT INTO access.membership_change_receipt')) {
      receipts.set(String(args[1]), { request_digest: args[2], membership_id: args[3],
        result_generation: args[4], result_authority_epoch: args[5], action: 'leave',
        acting_subject: null, representation_id: null, grant_id: null, selector_id: null, private_membership_id: null });
    }
    return { rows, rowCount: rows.length };
  };
  const owner = new AccessMemberships({ connect: async () => ({ query, release() {} }) } as unknown as Pool);
  return { owner, queries, membership, history, get historyWrites() { return historyWrites; } };
}

test('G-963: a controlled member leaves a closed Realm after its terms change, with one ended episode', async () => {
  const f = fixture();
  expect(await f.owner.change(input)).toMatchObject({ state: 'left', generation: '2', policyRevision: '2', replayed: false });
  expect(f.historyWrites).toBe(1);
  expect(f.history.get('1')).toMatchObject({ state: 'joined', terms_revision: 'terms-1' });
  expect(f.queries.some(sql => sql.includes('FROM access.membership_ban'))).toBe(false);
  expect(f.queries.some(sql => sql.includes('DELETE FROM access.membership'))).toBe(false);
  expect(await f.owner.change(input)).toMatchObject({ state: 'left', generation: '2', replayed: true });
  expect(await f.owner.change({ ...input, expectedGeneration: '2', idempotencyKey: 'leave-again',
    requestDigest: 'b'.repeat(64) })).toMatchObject({ state: 'left', generation: '2', authorityEpoch: '5' });
  expect(f.historyWrites).toBe(1);
});

test('G-963: a consent mandate or control of another Agent cannot authorize self-leave', async () => {
  await expect(fixture(false).owner.change(input)).rejects.toBeInstanceOf(MembershipDenied);
  const f = fixture();
  await expect(f.owner.change({ ...input, memberSubject: realm })).rejects.toBeInstanceOf(MembershipDenied);
  expect(f.membership.state).toBe('joined');
  expect(f.historyWrites).toBe(0);
});

test('G-963: a stale leave cannot end a different membership episode', async () => {
  const f = fixture();
  f.membership.generation = '3';
  await expect(f.owner.change(input)).rejects.toBeInstanceOf(MembershipStale);
  expect(f.membership.state).toBe('joined');
  expect(f.historyWrites).toBe(0);
});

test('G-963: a member can self-leave with the same OAuth scope as Join, without management scope', async () => {
  const f = fixture();
  const verified: string[][] = [];
  const app = accessMembershipRoutes({ memberships: f.owner, account: {
    verify: async (_request: Request, scopes: string[]) => {
      verified.push(scopes);
      if (scopes.includes('access:manage')) throw new AccountAssertionInsufficientScope('scope missing');
      return input.principal;
    },
  } } as unknown as MainWorkDependencies);
  const request = (memberSubject = member) => new Request('http://main.local/v1/access/membership-changes', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'self-leave' },
    body: JSON.stringify({ profile: 'access-membership-change-v1', kind: 'realm', ownerSubject: realm,
      memberSubject, action: 'leave', expectedGeneration: '1', expectedPolicyRevision: '1' }),
  });
  const denied = await app.handle(request(realm));
  expect(denied.status).toBe(403);
  const response = await app.handle(request());
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({ state: 'left', generation: '2' });
  expect(verified.slice(-2)).toEqual([['access:manage'], ['access:membership-consent']]);
});

test('G-963: authentication failure cannot fall back to self-leave scope', async () => {
  let probes = 0;
  const app = accessMembershipRoutes({ account: { verify: async () => {
    probes++; throw new AccountAssertionDenied('invalid bearer');
  } } } as unknown as MainWorkDependencies);
  const response = await app.handle(new Request('http://main.local/v1/access/membership-changes', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'denied' },
    body: JSON.stringify({ profile: 'access-membership-change-v1', kind: 'realm', ownerSubject: realm,
      memberSubject: member, action: 'leave', expectedGeneration: '1', expectedPolicyRevision: '1' }),
  }));
  expect(response.status).toBe(401);
  expect(probes).toBe(1);
});
