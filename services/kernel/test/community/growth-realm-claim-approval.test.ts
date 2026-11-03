import { afterAll, beforeAll, expect, test } from 'bun:test';
import { checkGrowth } from '../support/growth.ts';
import { approveRealmClaim } from '../../src/access/realm-claim.ts';
import ownRealm from '../../src/community/realm-claim-approval-own.sql';
import { requestRealmClaim } from '../../src/community/realm-continuity.ts';
import { newId } from '../../src/route/route.ts';
import {
  claimApprovalGrowthAxes,
  claimApprovalGrowthScales,
  createClaimApprovalFixture,
  type ClaimApprovalFixture,
} from './support/growth-realm-claim-approval-fixture.ts';

let f: ClaimApprovalFixture;
beforeAll(async () => {
  f = await createClaimApprovalFixture();
}, 180_000);
afterAll(async () => {
  await f?.close();
});

const context = (idempotencyKey = crypto.randomUUID()) => ({ idempotencyKey, deadline: Date.now() + 30_000 });
const statementWork = (
  entries: readonly { readonly rows: number; readonly blocks: number; readonly count: number }[],
) =>
  entries.reduce(
    (total, entry) => ({
      rows: total.rows + entry.rows,
      blocks: total.blocks + entry.blocks,
      statements: total.statements + entry.count,
    }),
    { rows: 0, blocks: 0, statements: 0 },
  );

// Native succession is a hard prerequisite for the growth series. A stored orphan row or a direct call to
// eraseAccountRealmOwnership would bypass the missing registered producer and make this acceptance misleading.
test('native orphan succession binds the original episode before real claim approval and independent growth', async () => {
  const selected = await f.orphanThroughNativeErasure();
  let at = new Date(Date.parse(selected.eligibleAt) - 1);
  const deps = { pool: f.pool, access: f.system.access, clock: () => at, routeKey: f.system.routeKey };
  await f.system.clock.setCommandTime(at.toISOString());
  await expect(requestRealmClaim(deps, f.claimant.actor, selected.realmId, context())).rejects.toMatchObject({
    code: 'conflict',
  });
  expect(
    (
      await f.pool.query('SELECT request_id FROM community.realm_claim_request WHERE route=$1 AND realm_id=$2', [
        selected.route,
        selected.realmId,
      ])
    ).rows,
  ).toEqual([]);
  at = new Date(selected.eligibleAt);
  await f.system.clock.setCommandTime(at.toISOString());
  const requestContext = context();
  const pending = await requestRealmClaim(deps, f.claimant.actor, selected.realmId, requestContext);
  expect(pending.value.state).toBe('pending');
  expect(Date.parse(pending.value.orphanedAt)).toBe(Date.parse(selected.erasedAt));
  expect(Date.parse(pending.value.claimEligibleAt)).toBe(at.getTime());
  expect((await requestRealmClaim(deps, f.claimant.actor, selected.realmId, requestContext)).value).toEqual(
    pending.value,
  );

  const input = { realmId: selected.realmId, requestId: pending.value.requestId };
  const key = crypto.randomUUID();
  const before = await f.state(input.realmId, input.requestId);
  await expect(approveRealmClaim(deps, f.denied.actor, input, context(key))).rejects.toMatchObject({
    name: 'GrantDeniedError',
  });
  expect(await f.state(input.realmId, input.requestId)).toEqual(before);
  await f.grant(f.approver.actor.accountId, ['realm:approve_claim']);

  const rollbackBefore = await f.state(input.realmId, input.requestId);
  const rollbackError = new Error('forced stale Content conditional update');
  f.growthObserver.armFault({ match: { statement: ownRealm }, boundary: 'after', error: rollbackError });
  await expect(
    approveRealmClaim(
      { pool: f.growth.pool, access: f.system.access, clock: () => at },
      f.approver.actor,
      input,
      context(),
    ),
  ).rejects.toThrow(rollbackError.message);
  expect(f.growthObserver.records.some(({ statement }) => statement === ownRealm)).toBe(true);
  expect(await f.state(input.realmId, input.requestId)).toEqual(rollbackBefore);

  const first = await approveRealmClaim(deps, f.approver.actor, input, context(key));
  expect(first).toMatchObject({ ...input, claimantAccountId: f.claimant.actor.accountId, state: 'owned' });
  expect(first.orphanedAt).toBe(pending.value.orphanedAt);
  const applied = await f.state(input.realmId, input.requestId);
  expect(applied.state).toEqual([
    {
      ownership_state: 'owned',
      orphaned_at: null,
      claim_eligible_at: null,
      state: 'approved',
      approved_at: first.approvedAt,
    },
  ]);
  expect(applied.grants).toHaveLength(1);
  expect(applied.receipts).toHaveLength(1);
  expect(applied.receipts[0]?.response).toEqual(first);
  // A fresh attempt cannot apply the consumed source or leave a second owner grant/receipt behind.
  await expect(approveRealmClaim(deps, f.approver.actor, input, context())).rejects.toMatchObject({ code: 'conflict' });
  expect(await f.state(input.realmId, input.requestId)).toEqual(applied);
  await expect(
    approveRealmClaim(deps, f.approver.actor, { realmId: input.realmId, requestId: newId(selected.route) }, context()),
  ).rejects.toMatchObject({ name: 'GrantDeniedError' });
  expect(await f.state(input.realmId, input.requestId)).toEqual(applied);
  expect(await approveRealmClaim(deps, f.approver.actor, input, context(key))).toEqual(first);
  expect(await f.state(input.realmId, input.requestId)).toEqual(applied);

  const pressure = await f.pressure(selected);
  const growthDeps = { pool: pressure.database.pool, access: f.system.access, clock: () => at };
  for (const axis of claimApprovalGrowthAxes) {
    await pressure.resetApproval(input.requestId);
    const contentRows: number[] = [];
    const contentStatements: number[] = [];
    const accountRows: number[] = [];
    const accountStatements: number[] = [];
    const approve = (key: string) => approveRealmClaim(growthDeps, f.approver.actor, input, context(key));
    const report = await checkGrowth(pressure.database, {
      name: `Realm claim approval: ${axis}`,
      scales: claimApprovalGrowthScales,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      indexProbes: 8,
      repetitions: 3,
      grow: (_database, scale, previous) => pressure.grow(axis, scale, previous),
      warmup: async (_database, _scale, repetition) => {
        await pressure.resetApproval(input.requestId);
        const value = await approve(`growth-warmup-${axis}-${repetition}-${crypto.randomUUID()}`);
        expect(value).toMatchObject({ ...input, claimantAccountId: f.claimant.actor.accountId, state: 'owned' });
        return value;
      },
      prepare: () => pressure.resetApproval(input.requestId),
      operation: async (_database, scale, repetition) => {
        const value = await approve(`growth-${axis}-${scale}-${repetition}-${crypto.randomUUID()}`);
        expect(value).toMatchObject({ ...input, claimantAccountId: f.claimant.actor.accountId, state: 'owned' });
        return value;
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([...claimApprovalGrowthScales]);
    for (const sample of report.samples) {
      for (const cost of sample.repetitions) {
        expect(cost.statements).toBeGreaterThan(0);
        expect(cost.rows).toBeGreaterThan(0);
        expect(cost.blocks).toBeGreaterThan(0);
        expect(cost.plans).toBeGreaterThan(0);
        expect(cost.backgroundStatements ?? 0).toBe(0);
      }
      for (const run of sample.statementRepetitions) {
        const ownerRoleRead = (statement: string) =>
          /select exists\s*\(\s*select 1\s+from access\.resource_role_grant/i.test(statement);
        const content = statementWork(
          run.filter(({ statement }) => /\bcommunity\.(?:realm|realm_claim_request)\b/i.test(statement)),
        );
        const contentUpdates = run
          .filter(({ statement }) =>
            /^\s*update\s+community\.(?:realm|realm_claim_request)\b/i.test(statement),
          )
          .reduce((total, { count }) => total + count, 0);
        const nativeOwnerRoleReads = run
          .filter(({ statement }) => ownerRoleRead(statement))
          .reduce((total, { count }) => total + count, 0);
        const ownerRole = statementWork(run.filter(({ statement }) => ownerRoleRead(statement)));
        const accounts = statementWork(
          run.filter(
            ({ statement }) =>
              /\b(?:access|core|editorial)\./i.test(statement) && !ownerRoleRead(statement),
          ),
        );
        expect(content.statements).toBeGreaterThan(0);
        expect(content.rows).toBeGreaterThan(0);
        expect(content.blocks).toBeGreaterThan(0);
        expect(contentUpdates).toBe(2);
        expect(nativeOwnerRoleReads).toBe(1);
        expect(ownerRole.rows).toBeGreaterThan(0);
        expect(ownerRole.blocks).toBeGreaterThan(0);
        expect(ownerRole.statements).toBe(1);
        expect(accounts.statements).toBeGreaterThan(0);
        expect(accounts.rows).toBeGreaterThan(0);
        expect(accounts.blocks).toBeGreaterThan(0);
        contentRows.push(content.rows);
        contentStatements.push(content.statements);
        accountRows.push(accounts.rows);
        accountStatements.push(accounts.statements);
      }
    }
    expect(new Set(contentRows).size).toBe(1);
    expect(new Set(contentStatements).size).toBe(1);
    expect(new Set(accountRows).size).toBe(1);
    expect(new Set(accountStatements).size).toBe(1);
  }
}, 1_200_000);
