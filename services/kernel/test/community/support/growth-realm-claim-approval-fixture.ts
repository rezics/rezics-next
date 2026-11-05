import { expect } from 'bun:test';
import type { Account, CommunityDriver } from '../../../../../specs/community-driver.ts';
import { PLATFORM_RESOURCE } from '../../../src/access/bootstrap-governance.ts';
import { newId, routeOf, partitionOf } from '../../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { accountDeletionRuntime, deletePersona } from '../../support/account-deletion.ts';
import { contentGovernanceCredential } from '../../content/support/system.ts';
import { observeSql, type SqlObserver } from '../../content/support/sql-observer.ts';
import { openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../../support/growth.ts';
import { closeCommunityDrivers, communityFixtureRuntime, createCommunityDriver } from '../community-driver.ts';

export const claimApprovalGrowthScales = [256, 1024, 4096] as const;
export const claimApprovalGrowthAxes = ['realms', 'requests', 'grants', 'history'] as const;
export type ClaimApprovalGrowthAxis = (typeof claimApprovalGrowthAxes)[number];

const baseline = claimApprovalGrowthScales[0];
const orphanRoot = '2026-01-01T00:00:00.000Z';
const orphanDeadline = '2026-01-31T00:00:00.000Z';
const requestTime = '2026-02-01T00:00:00.000Z';

type SelectedOrphan = {
  readonly realmId: string;
  readonly route: number;
  readonly spaceId: string;
  readonly ownerId: string;
  readonly claimantId: string;
  readonly erasedAt: string;
  readonly eligibleAt: string;
};

async function insertPressureRealm(
  growth: GrowthDatabase,
  selected: SelectedOrphan,
  realmId: string,
  ownership: 'owned' | 'orphaned',
): Promise<void> {
  const spaceId = newId(selected.route);
  const spaceRevisionId = newId(selected.route);
  const revisionId = newId(selected.route);
  const creator = selected.claimantId;
  const client = await growth.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query(
      `INSERT INTO community.space (route,space_id,state,head_revision_id,created_at,creator)
       VALUES ($1,$2,'active',$3,$4,$5)`,
      [selected.route, spaceId, spaceRevisionId, orphanRoot, creator],
    );
    await client.query(
      `INSERT INTO community.space_revision (route,space_id,revision_id,predecessor,title,summary,created_at,author)
       VALUES ($1,$2,$3,NULL,'Claim pressure Space','',$4,$5)`,
      [selected.route, spaceId, spaceRevisionId, orphanRoot, creator],
    );
    await client.query(
      `INSERT INTO community.realm
         (route,realm_id,space_id,state,visibility,context_id,head_revision_id,created_at,creator,
          ownership_state,orphaned_at,claim_eligible_at)
       VALUES ($1,$2,$3,'active','public',$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz)`,
      [
        selected.route,
        realmId,
        spaceId,
        GLOBAL_CONTEXT,
        revisionId,
        orphanRoot,
        creator,
        ownership,
        ownership === 'orphaned' ? orphanRoot : null,
        ownership === 'orphaned' ? orphanDeadline : null,
      ],
    );
    await client.query(
      `INSERT INTO community.realm_revision
         (route,realm_id,revision_id,predecessor,title,summary,visibility,context_id,created_at,author)
       VALUES ($1,$2,$3,NULL,'Claim pressure host','', 'public',$4,$5,$6)`,
      [selected.route, realmId, revisionId, GLOBAL_CONTEXT, orphanRoot, creator],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function realmPopulation(selected: SelectedOrphan, ids: string[]): Population {
  return {
    name: `realm-claim-unrelated-realms-${crypto.randomUUID()}`,
    hotPartition: partitionOf(selected.route),
    hotShare: 1,
    rows: ({ ordinal }) => {
      const spaceId = newId(selected.route);
      const spaceRevisionId = newId(selected.route);
      const realmId = newId(selected.route);
      const revisionId = newId(selected.route);
      ids[ordinal] = realmId;
      return {
        'community.space': [
          {
            route: selected.route,
            space_id: spaceId,
            state: 'active',
            head_revision_id: spaceRevisionId,
            created_at: orphanRoot,
            creator: selected.claimantId,
          },
        ],
        'community.space_revision': [
          {
            route: selected.route,
            space_id: spaceId,
            revision_id: spaceRevisionId,
            predecessor: null,
            title: 'Unrelated claim growth Space',
            summary: '',
            created_at: orphanRoot,
            author: selected.claimantId,
          },
        ],
        'community.realm': [
          {
            route: selected.route,
            realm_id: realmId,
            space_id: spaceId,
            state: 'active',
            visibility: 'public',
            context_id: GLOBAL_CONTEXT,
            head_revision_id: revisionId,
            created_at: orphanRoot,
            creator: selected.claimantId,
          },
        ],
        'community.realm_revision': [
          {
            route: selected.route,
            realm_id: realmId,
            revision_id: revisionId,
            predecessor: null,
            title: 'Unrelated claim growth Realm',
            summary: '',
            visibility: 'public',
            context_id: GLOBAL_CONTEXT,
            created_at: orphanRoot,
            author: selected.claimantId,
          },
        ],
      };
    },
  };
}

function requestPopulation(selected: SelectedOrphan, realmId: string): Population {
  return {
    name: `realm-claim-unrelated-requests-${crypto.randomUUID()}`,
    hotPartition: partitionOf(selected.route),
    hotShare: 1,
    rows: () => ({
      'community.realm_claim_request': [
        {
          route: selected.route,
          realm_id: realmId,
          request_id: newId(selected.route),
          account_id: newId(selected.route),
          orphaned_at: orphanRoot,
          requested_at: requestTime,
          state: 'pending',
          approved_at: null,
        },
      ],
    }),
  };
}

function grantPopulation(selected: SelectedOrphan, realmId: string): Population {
  return {
    name: `realm-claim-unrelated-grants-${crypto.randomUUID()}`,
    hotPartition: partitionOf(selected.route),
    hotShare: 1,
    rows: () => ({
      'access.resource_role_grant': [
        {
          route: selected.route,
          resource_id: realmId,
          subject_kind: 'identity',
          subject_id: newId(selected.route),
          subject_role: '',
          grant_role: 'community.realm.member',
          valid: '(,)',
          transaction_id: crypto.randomUUID(),
        },
      ],
    }),
  };
}

function historyPopulation(
  selected: SelectedOrphan,
  principalId: string,
  clientId: string,
  position: () => number,
): Population {
  return {
    name: `realm-claim-retained-history-${crypto.randomUUID()}`,
    hotPartition: partitionOf(selected.route),
    hotShare: 1,
    rows: ({ ordinal }) => {
      const transactionId = crypto.randomUUID();
      const currentPosition = position() + ordinal + 1;
      const key = `seed-history-${ordinal}`;
      const value = { realmId: selected.realmId, requestId: newId(selected.route), state: 'owned' };
      return {
        'core.receipt': [
          {
            partition_no: partitionOf(selected.route),
            principal_kind: 'account',
            principal_id: principalId,
            command_kind: 'access.realm.claim.approve',
            idempotency_key: key,
            request_digest: Buffer.alloc(32),
            epoch: 1,
            position: currentPosition,
            transaction_id: transactionId,
            response: value,
          },
        ],
        'core.outbox': [
          {
            partition_no: partitionOf(selected.route),
            position: currentPosition,
            event_seq: 0,
            event_count: 1,
            epoch: 1,
            id: crypto.randomUUID(),
            type: 'com.rezics.access.realm.claim.approve.v1',
            subject: selected.realmId,
            data: value,
          },
        ],
        'editorial.write_basis': [
          {
            partition_no: partitionOf(selected.route),
            transaction_id: transactionId,
            epoch: 1,
            position: currentPosition,
            principal_kind: 'account',
            principal_id: principalId,
            client_id: clientId,
            requested_by: null,
            recorded_at: orphanRoot,
          },
        ],
      };
    },
    async finish(admin) {
      await admin.query(
        'UPDATE core.partition SET position=(SELECT max(position) FROM core.outbox WHERE partition_no=$1) WHERE partition_no=$1',
        [partitionOf(selected.route)],
      );
    },
  };
}

export async function createClaimApprovalFixture() {
  const driver: CommunityDriver = await createCommunityDriver();
  await driver.provision();
  const { system } = communityFixtureRuntime();
  const pool = system.database.pool;
  const databaseUrl = pool.options.connectionString;
  if (!databaseUrl) throw new Error('Community fixture database URL is missing');
  const growth = await openGrowthDatabase(databaseUrl);
  const growthObserver: SqlObserver = observeSql(growth.pool);
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
    return {
      ...realm,
      spaceId: space.spaceId,
      route,
      ownerId: owner.id,
      claimantId: system.actors.other.actor.accountId,
      erasedAt: erased.at,
      eligibleAt: episode.claim_eligible_at,
    };
  }

  async function pressure(selected: SelectedOrphan) {
    const requestHost = newId(selected.route);
    const grantHost = newId(selected.route);
    await insertPressureRealm(growth, selected, requestHost, 'orphaned');
    await insertPressureRealm(growth, selected, grantHost, 'owned');

    const realmIds: string[] = [];
    const realms = realmPopulation(selected, realmIds);
    const requests = requestPopulation(selected, requestHost);
    const grants = grantPopulation(selected, grantHost);
    let historyPosition = 0;
    let baselineSeeded = false;
    const history = historyPopulation(
      selected,
      system.actors.moderator.actor.accountId,
      system.actors.moderator.actor.clientId,
      () => historyPosition,
    );

    async function readPartitionPosition(): Promise<number> {
      const result = await growth.admin.query<{ position: string }>(
        'SELECT position::text FROM core.partition WHERE partition_no=$1',
        [partitionOf(selected.route)],
      );
      const value = result.rows[0]?.position;
      if (value === undefined) throw new Error('Realm claim growth partition is missing');
      return Number(value);
    }

    async function seedHistory(from: number, to: number): Promise<void> {
      historyPosition = await readPartitionPosition();
      await seed(growth, history, { from, to });
    }

    async function count(): Promise<{ realms: number; requests: number; grants: number; history: number }> {
      const result = await growth.admin.query<{
        realms: number;
        requests: number;
        grants: number;
        history: number;
      }>(
        `SELECT
           (SELECT count(*)::integer FROM community.realm WHERE route=$1 AND realm_id=ANY($2::uuid[])) AS realms,
           (SELECT count(*)::integer FROM community.realm_claim_request WHERE route=$1 AND realm_id=$3) AS requests,
           (SELECT count(*)::integer FROM access.resource_role_grant
              WHERE route=$1 AND resource_id=$4 AND grant_role='community.realm.member') AS grants,
           (SELECT count(*)::integer FROM core.receipt
              WHERE partition_no=$5 AND principal_kind='account' AND principal_id=$6
                AND command_kind='access.realm.claim.approve' AND idempotency_key LIKE 'seed-history-%') AS history`,
        [
          selected.route,
          realmIds,
          requestHost,
          grantHost,
          partitionOf(selected.route),
          system.actors.moderator.actor.accountId,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Realm claim growth populations are missing');
      return row;
    }

    async function grow(axis: ClaimApprovalGrowthAxis, scale: number, previous: number): Promise<void> {
      if (!baselineSeeded) {
        await seed(growth, realms, { from: 0, to: baseline });
        await seed(growth, requests, { from: 0, to: baseline });
        await seed(growth, grants, { from: 0, to: baseline });
        await seedHistory(0, baseline);
        baselineSeeded = true;
      }
      const from = Math.max(previous, baseline);
      if (scale > from) {
        if (axis === 'history') await seedHistory(from, scale);
        else await seed(growth, { realms, requests, grants }[axis], { from, to: scale });
      }
      const actual = await count();
      const expectedCount = (name: ClaimApprovalGrowthAxis) =>
        name === axis
          ? scale
          : claimApprovalGrowthAxes.indexOf(name) < claimApprovalGrowthAxes.indexOf(axis)
            ? claimApprovalGrowthScales[2]
            : baseline;
      const expected = {
        realms: expectedCount('realms'),
        requests: expectedCount('requests'),
        grants: expectedCount('grants'),
        history: expectedCount('history'),
      };
      expect(actual).toEqual(expected);
    }

    async function resetApproval(requestId: string): Promise<void> {
      await growth.admin.query(
        `UPDATE community.realm
         SET ownership_state='orphaned',orphaned_at=$3::timestamptz,
             claim_eligible_at=$3::timestamptz + interval '720 hours'
         WHERE route=$1 AND realm_id=$2`,
        [selected.route, selected.realmId, selected.erasedAt],
      );
      await growth.admin.query(
        `UPDATE community.realm_claim_request SET state='pending',approved_at=NULL
         WHERE route=$1 AND realm_id=$2 AND request_id=$3`,
        [selected.route, selected.realmId, requestId],
      );
      await growth.admin.query(
        `DELETE FROM access.resource_role_grant
         WHERE route=$1 AND resource_id=$2 AND grant_role='community.realm.owner'
           AND subject_kind='identity' AND subject_id=$3`,
        [selected.route, selected.realmId, selected.claimantId],
      );
    }

    return { database: growth, count, grow, resetApproval };
  }

  return {
    system,
    pool,
    growth,
    growthObserver,
    driver,
    claimant: system.actors.other,
    approver: system.actors.moderator,
    denied: system.actors.author,
    grant,
    orphanThroughNativeErasure,
    pressure,
    async close() {
      try {
        try {
          await growthObserver.close();
        } finally {
          await growth.close();
        }
      } finally {
        await closeCommunityDrivers();
      }
    },
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
  };
}

export type ClaimApprovalFixture = Awaited<ReturnType<typeof createClaimApprovalFixture>>;
