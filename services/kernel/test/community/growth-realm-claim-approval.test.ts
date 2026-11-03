import { afterAll, beforeAll, expect, test } from 'bun:test';
import { approveRealmClaim } from '../../src/access/realm-claim.ts';
import { requestRealmClaim } from '../../src/community/realm-continuity.ts';
import { createClaimApprovalFixture, type ClaimApprovalFixture } from './support/growth-realm-claim-approval-fixture.ts';

let f: ClaimApprovalFixture;
beforeAll(async () => {
  f = await createClaimApprovalFixture();
}, 180_000);
afterAll(async () => {
  await f?.close();
});

const context = (idempotencyKey = crypto.randomUUID()) => ({ idempotencyKey, deadline: Date.now() + 30_000 });

// Native succession is a hard prerequisite for the growth series. A stored orphan row or a direct call to
// eraseAccountRealmOwnership would bypass the missing registered producer and make this acceptance misleading.
test('native orphan succession binds the original episode before real claim approval, stale refusal and exact replay', async () => {
  const selected = await f.orphanThroughNativeErasure();
  let at = new Date(Date.parse(selected.eligibleAt) - 1);
  const deps = { pool: f.pool, access: f.system.access, clock: () => at, routeKey: f.system.routeKey };
  await f.system.clock.setCommandTime(at.toISOString());
  await expect(requestRealmClaim(deps, f.claimant.actor, selected.realmId, context())).rejects.toMatchObject({
    code: 'conflict',
  });
  expect((await f.pool.query(
    'SELECT request_id FROM community.realm_claim_request WHERE route=$1 AND realm_id=$2',
    [selected.route, selected.realmId],
  )).rows).toEqual([]);
  at = new Date(selected.eligibleAt);
  await f.system.clock.setCommandTime(at.toISOString());
  const requestContext = context();
  const pending = await requestRealmClaim(deps, f.claimant.actor, selected.realmId, requestContext);
  expect(pending.value.state).toBe('pending');
  expect(Date.parse(pending.value.orphanedAt)).toBe(Date.parse(selected.erasedAt));
  expect(Date.parse(pending.value.claimEligibleAt)).toBe(at.getTime());
  expect((await requestRealmClaim(deps, f.claimant.actor, selected.realmId, requestContext)).value).toEqual(pending.value);

  const input = { realmId: selected.realmId, requestId: pending.value.requestId };
  const key = crypto.randomUUID();
  const before = await f.state(input.realmId, input.requestId);
  await expect(approveRealmClaim(deps, f.denied.actor, input, context(key))).rejects.toMatchObject({
    name: 'GrantDeniedError',
  });
  expect(await f.state(input.realmId, input.requestId)).toEqual(before);
  await f.grant(f.approver.actor.accountId, ['realm:approve_claim']);
  const first = await approveRealmClaim(deps, f.approver.actor, input, context(key));
  expect(first).toMatchObject({ ...input, claimantAccountId: f.claimant.actor.accountId, state: 'owned' });
  expect(first.orphanedAt).toBe(pending.value.orphanedAt);
  const applied = await f.state(input.realmId, input.requestId);
  expect(applied.state).toEqual([{
    ownership_state: 'owned', orphaned_at: null, claim_eligible_at: null, state: 'approved', approved_at: first.approvedAt,
  }]);
  expect(applied.grants).toHaveLength(1);
  expect(applied.receipts).toHaveLength(1);
  expect(applied.receipts[0]?.response).toEqual(first);
  // A fresh attempt cannot apply the consumed source or leave a second owner grant/receipt behind.
  await expect(approveRealmClaim(deps, f.approver.actor, input, context())).rejects.toMatchObject({ code: 'conflict' });
  expect(await f.state(input.realmId, input.requestId)).toEqual(applied);
  expect(await approveRealmClaim(deps, f.approver.actor, input, context(key))).toEqual(first);
  expect(await f.state(input.realmId, input.requestId)).toEqual(applied);
}, 180_000);
