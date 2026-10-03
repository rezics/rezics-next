import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { AccessPrivateMemberships, PRIVATE_MEMBERSHIP_LEAVE_COST, type PrivateMembershipChange } from '../src/modules/access/private-memberships.ts';
import { MembershipDenied, MembershipStale } from '../src/modules/access/memberships.ts';
import { accessMembershipRoutes } from '../src/routes/access-memberships.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { AccountAssertionDenied, AccountAssertionInsufficientScope } from '../src/modules/account/verify-assertion.ts';

const ownerSubject = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const membershipId = '00000000-0000-4000-8000-000000000002', principalId = '00000000-0000-4000-8000-000000000003';
const input: PrivateMembershipChange = { principal: { issuer: 'test', subject: 'member' }, kind: 'realm', ownerSubject,
  action: 'leave', expectedGeneration: '1', expectedPolicyRevision: '1', membershipId,
  idempotencyKey: 'leave', requestDigest: 'a'.repeat(64) };
function fixture() {
  const member = { id: membershipId, principal_id: principalId, kind: 'realm', owner_subject: ownerSubject,
    state: 'joined', generation: '1', policy_revision: '1' };
  const history = new Map<string, Record<string, unknown>>([['1', { state: 'joined', policy_revision: '1', terms_revision: 'terms' }]]);
  const receipts = new Map<string, Record<string, unknown>>(), queries: string[] = [];
  let epoch = '4';
  const query = async (sql: string, args: unknown[] = []) => {
    queries.push(sql);
    let rows: Record<string, unknown>[] = [];
    if (sql.includes('FROM access.recovery_fence')) rows = [{ open: true }];
    else if (sql.includes('FROM access.scope_gate')) rows = [{ authority_epoch: epoch, open: true, dispatch_open: true }];
    else if (sql.includes('FROM access.principal WHERE')) rows = [{ id: args[1] === 'member' ? principalId : membershipId, enforcement_epoch: '0' }];
    else if (sql.includes('FROM access.principal p')) rows = []; // No management mandate.
    else if (sql.includes('FROM access.private_membership_change_receipt')) rows = receipts.has(String(args[1])) ? [receipts.get(String(args[1]))!] : [];
    else if (sql.includes('JOIN access.private_membership_history')) rows = [{ ...member, ...history.get(String(args[1]))! }];
    else if (sql.includes('FROM access.membership_policy')) rows = [{ revision: '2', terms_revision: 'new-terms', open: false }];
    else if (sql.includes('FROM access.private_membership')) rows = args[3] === member.principal_id ? [{ ...member }] : [];
    else if (sql.startsWith('UPDATE access.private_membership SET')) {
      member.state = 'left'; member.generation = String(args[1]); member.policy_revision = String(args[2]);
    } else if (sql.includes('UPDATE access.scope_gate SET')) { epoch = String(Number(epoch) + 1); rows = [{ authority_epoch: epoch }]; }
    else if (sql.includes('INSERT INTO access.private_membership_history')) history.set(String(args[1]), { state: args[2], policy_revision: args[3], terms_revision: args[4] });
    else if (sql.includes('INSERT INTO access.private_membership_change_receipt')) receipts.set(String(args[1]), {
      request_digest: args[2], membership_id: args[3], result_generation: args[4], result_authority_epoch: args[5], action: 'leave' });
    return { rows, rowCount: rows.length };
  };
  return { owner: new AccessPrivateMemberships({ connect: async () => ({ query, release() {} }) } as unknown as Pool), member, history, queries };
}
test('G-964: the private recipient can leave closed/changed admission and retry without another episode, preserving bans', async () => {
  const f = fixture();
  expect(await f.owner.change(input)).toMatchObject({ state: 'left', generation: '2', policyRevision: '2', replayed: false });
  expect(await f.owner.change(input)).toMatchObject({ state: 'left', generation: '2', replayed: true });
  expect(await f.owner.change({ ...input, expectedGeneration: '2', idempotencyKey: 'again', requestDigest: 'b'.repeat(64) }))
    .toMatchObject({ state: 'left', generation: '2', authorityEpoch: '5' });
  expect(f.history.size).toBe(2);
  expect(f.queries.some(sql => sql.includes('private_membership_ban'))).toBe(false);
  expect(PRIVATE_MEMBERSHIP_LEAVE_COST.dependentAuthorityRows).toBe(256);
});
test('G-964: private self-leave denies other recipients and stale episodes', async () => {
  await expect(fixture().owner.change({ ...input, principal: { issuer: 'test', subject: 'outsider' } })).rejects.toBeInstanceOf(MembershipDenied);
  const f = fixture();
  f.member.generation = '3';
  await expect(f.owner.change(input)).rejects.toBeInstanceOf(MembershipStale);
  expect(f.member.state).toBe('joined');
});
test('G-964: private self-leave accepts consent OAuth scope only after insufficient management scope; invalid authentication never falls back', async () => {
  const f = fixture(), scopes: string[][] = [];
  const app = accessMembershipRoutes({ privateMemberships: f.owner, account: { verify: async (_request: Request, required: string[]) => {
    scopes.push(required);
    if (required.includes('access:manage')) throw new AccountAssertionInsufficientScope('missing scope');
    return input.principal;
  } } } as unknown as MainWorkDependencies);
  const request = () => new Request('http://main.local/v1/access/private-membership-changes', { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'leave' }, body: JSON.stringify({
      profile: 'access-private-membership-change-v1', kind: 'realm', ownerSubject, membershipId,
      action: 'leave', expectedGeneration: '1', expectedPolicyRevision: '1' }) });
  const response = await app.handle(request());
  expect(response.status, await response.clone().text()).toBe(200);
  expect(scopes).toEqual([['access:manage'], ['access:membership-consent']]);
  let probes = 0;
  const denied = accessMembershipRoutes({ account: { verify: async () => { probes++; throw new AccountAssertionDenied('invalid bearer'); } } } as unknown as MainWorkDependencies);
  expect((await denied.handle(request())).status).toBe(401);
  expect(probes).toBe(1);
});
