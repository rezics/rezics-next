import { expect } from 'bun:test';
import type { Account, CommunityDriver } from '../../../../../specs/community-driver.ts';
import { PLATFORM_RESOURCE } from '../../../src/access/bootstrap-governance.ts';
import { routeOf, partitionOf } from '../../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { accountDeletionRuntime, deletePersona } from '../../support/account-deletion.ts';
import { contentGovernanceCredential } from '../../content/support/system.ts';
import { closeCommunityDrivers, communityFixtureRuntime, createCommunityDriver } from '../community-driver.ts';

export async function createClaimApprovalFixture() {
  const driver: CommunityDriver = await createCommunityDriver();
  await driver.provision();
  const { system } = communityFixtureRuntime();
  const pool = system.database.pool;
  const governance = await contentGovernanceCredential(system);
  const grantor = { id: governance.actor.accountId, bearer: governance.bearer };
  const deletion = accountDeletionRuntime(system);

  async function call<T>(actor: Account, path: string, body?: unknown): Promise<T> {
    const response = await driver.request({
      actor,
      method: 'POST',
      path,
      key: JSON.stringify(crypto.randomUUID()),
      ...(body === undefined ? {} : { body }),
    });
    const value: unknown = await response.json();
    expect({ status: response.status, value }).toMatchObject({ status: 201 });
    return value as T;
  }

  async function grant(accountId: string, actions: string[]) {
    await call(grantor, '/v1/grants', {
      resource: PLATFORM_RESOURCE,
      subject: { kind: 'account', id: accountId },
      actions,
      valid: '(,)',
    });
  }

  /** No stored-state orphan helper: the registered producer must establish this episode. */
  async function orphanThroughNativeErasure() {
    const person = await deletion.person();
    const owner = { id: person.accountId, bearer: person.bearer };
    await grant(owner.id, ['space:create', 'realm:create']);
    const { space } = await call<{ space: { spaceId: string } }>(owner, '/v1/spaces', {
      title: 'Claim growth host',
    });
    const { realm } = await call<{ realm: { realmId: string; headRevisionId: string } }>(owner, '/v1/realms', {
      spaceId: space.spaceId,
      contextId: GLOBAL_CONTEXT,
      title: 'Claim growth selected Realm',
      visibility: 'public',
    });
    const route = routeOf(realm.realmId)!;
    const original = await pool.query(
      `SELECT ownership_state,orphaned_at,claim_eligible_at FROM community.realm
       WHERE route=$1 AND realm_id=$2`,
      [route, realm.realmId],
    );
    expect(original.rows).toEqual([{ ownership_state: 'owned', orphaned_at: null, claim_eligible_at: null }]);
    expect(
      (
        await pool.query(
          `SELECT subject_id::text FROM access.resource_role_grant
         WHERE route=$1 AND resource_id=$2 AND grant_role='community.realm.owner'
           AND subject_kind='identity' AND subject_id=$3 AND upper_inf(valid)`,
          [route, realm.realmId, owner.id],
        )
      ).rows,
    ).toEqual([{ subject_id: owner.id }]);
    // Finish the actual creation events before committing the account erasure root.
    await driver.settle();
    const erased = await deletePersona({ pool, auth: deletion.auth }, person);
    // This drains the normally registered worker, rather than calling the succession adapter directly.
    await driver.settle();
    const episode = (
      await pool.query<{
        ownership_state: string;
        original_root: boolean;
        original_deadline: boolean;
        claim_eligible_at: string | null;
      }>(
        `SELECT ownership_state,orphaned_at=$3::timestamptz AS original_root,
              claim_eligible_at=orphaned_at + interval '720 hours' AS original_deadline,
              claim_eligible_at::text
       FROM community.realm WHERE route=$1 AND realm_id=$2`,
        [route, realm.realmId, erased.at],
      )
    ).rows[0];
    expect(
      episode,
      'Native prerequisite: the registered membership eraser must apply Realm ownership succession before retiring the owner locator',
    ).toMatchObject({ ownership_state: 'orphaned', original_root: true, original_deadline: true });
    if (!episode?.claim_eligible_at) throw new Error('Native Realm orphan episode has no claim deadline');
    return { ...realm, route, ownerId: owner.id, erasedAt: erased.at, eligibleAt: episode.claim_eligible_at };
  }

  return {
    system,
    pool,
    driver,
    claimant: system.actors.other,
    approver: system.actors.moderator,
    denied: system.actors.author,
    grant,
    orphanThroughNativeErasure,
    async state(realmId: string, requestId: string) {
      const route = routeOf(realmId)!;
      const state = await pool.query(
        `SELECT r.ownership_state,r.orphaned_at::text,r.claim_eligible_at::text,
                c.state,c.approved_at::text FROM community.realm r
         JOIN community.realm_claim_request c USING(route,realm_id)
         WHERE r.route=$1 AND r.realm_id=$2 AND c.request_id=$3`,
        [route, realmId, requestId],
      );
      const grants = await pool.query(
        `SELECT subject_id::text,valid::text,transaction_id::text FROM access.resource_role_grant
         WHERE route=$1 AND resource_id=$2 AND grant_role='community.realm.owner'
           AND subject_kind='identity' AND subject_id=$3 ORDER BY valid,transaction_id`,
        [route, realmId, system.actors.other.actor.accountId],
      );
      const receipts = await pool.query(
        `SELECT transaction_id::text,epoch,position::text,response FROM core.receipt
         WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
           AND command_kind='access.realm.claim.approve'
           AND response->>'realmId'=$3 AND response->>'requestId'=$4 ORDER BY transaction_id`,
        [partitionOf(route), system.actors.moderator.actor.accountId, realmId, requestId],
      );
      return { state: state.rows, grants: grants.rows, receipts: receipts.rows };
    },
    close: closeCommunityDrivers,
  };
}

export type ClaimApprovalFixture = Awaited<ReturnType<typeof createClaimApprovalFixture>>;
