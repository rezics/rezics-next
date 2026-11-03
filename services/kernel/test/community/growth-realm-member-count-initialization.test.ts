import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Population } from '../support/growth.ts';
import { checkGrowth, seed } from '../support/growth.ts';
import { newId } from '../../src/route/route.ts';
import { mintReadTime, releaseOperationalTime } from '../../src/command/command.ts';
import { readRealmMemberCount } from '../../src/community/member-count.ts';
import { withConnection } from '../../src/database/pool.ts';
import { createWorkClient } from '../../src/work/client.ts';
import {
  createRealmMemberCountInitializationFixture,
  type RealmMemberCountInitializationFixture,
} from './support/growth-realm-member-count-initialization-fixture.ts';
import { communityFixtureRuntime, restartWorker, worker } from './community-driver.ts';

const scales: [number, number, number] = [256, 1024, 4096];
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
const at = '2020-01-01T00:00:00.000Z';
const COMMUNITY_MEMBER_COUNT_INSTALL_ZERO_UUID = '00000000-0000-0000-0000-000000000000';

type SyntheticRealm = { realmId: string; spaceId: string };
type SyntheticMember = { accountId: string };

let f: RealmMemberCountInitializationFixture;
let inventoryIds = new Map<number, SyntheticRealm>();
let openIds = new Map<number, SyntheticMember>();
let closedIds = new Map<number, SyntheticMember>();

beforeAll(async () => {
  f = await createRealmMemberCountInitializationFixture();
}, 180_000);

afterAll(async () => {
  await f?.close();
}, 180_000);

async function readCurrent() {
  const pool = communityFixtureRuntime().system.database.pool;
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const time = await mintReadTime(client);
    try {
      return await readRealmMemberCount(client, { realmId: f.realmId, at: time });
    } finally {
      releaseOperationalTime(time);
      await client.query('ROLLBACK');
    }
  });
}

function inventoryPopulation(): Population {
  return {
    name: `realm-member-count-inventory-${randomUUID()}`,
    hotPartition: f.partition,
    hotShare: 1,
    rows({ ordinal }) {
      let row = inventoryIds.get(ordinal);
      if (!row) {
        row = { realmId: newId(f.route), spaceId: newId(f.route) };
        inventoryIds.set(ordinal, row);
      }
      const revisionId = newId(f.route);
      const realmRevisionId = newId(f.route);
      const transactionId = newId(f.route);
      return {
        'community.space': [
          {
            route: f.route,
            space_id: row.spaceId,
            state: 'active',
            head_revision_id: revisionId,
            created_at: at,
            creator: f.accounts.owner.id,
          },
        ],
        'community.space_revision': [
          {
            route: f.route,
            space_id: row.spaceId,
            revision_id: revisionId,
            predecessor: null,
            title: 'Unrelated member-count Realm host',
            summary: '',
            created_at: at,
            author: f.accounts.owner.id,
          },
        ],
        'community.realm': [
          {
            route: f.route,
            realm_id: row.realmId,
            space_id: row.spaceId,
            state: 'active',
            visibility: 'public',
            context_id: f.accounts.contextId,
            head_revision_id: realmRevisionId,
            created_at: at,
            creator: f.accounts.owner.id,
          },
        ],
        'community.realm_revision': [
          {
            route: f.route,
            realm_id: row.realmId,
            revision_id: realmRevisionId,
            predecessor: null,
            title: 'Unrelated member-count Realm',
            summary: '',
            visibility: 'public',
            context_id: f.accounts.contextId,
            created_at: at,
            author: f.accounts.owner.id,
          },
        ],
        'access.resource_initialization': [
          {
            route: f.route,
            resource_id: row.realmId,
            resource_type: 'community.realm',
            creator_id: f.accounts.owner.id,
            initialized_at: at,
          },
        ],
        'access.resource_role_grant': [
          {
            route: f.route,
            resource_id: row.realmId,
            subject_kind: 'identity',
            subject_id: f.accounts.owner.id,
            grant_role: 'community.realm.owner',
            valid: '(,)',
            transaction_id: transactionId,
          },
        ],
      };
    },
  };
}

function memberPopulation(kind: 'open' | 'closed'): Population {
  const ids = kind === 'open' ? openIds : closedIds;
  return {
    name: `realm-member-count-${kind}-${randomUUID()}`,
    hotPartition: f.partition,
    hotShare: 1,
    rows({ ordinal }) {
      let member = ids.get(ordinal);
      if (!member) {
        member = { accountId: newId(f.route) };
        ids.set(ordinal, member);
      }
      const reservationId = newId(f.route);
      const transactionId = newId(f.route);
      return {
        'access.account': [
          {
            route: f.route,
            account_id: member.accountId,
            kind: 'actor',
            state: 'active',
            transaction_id: transactionId,
          },
        ],
        'community.realm_member': [
          {
            route: f.route,
            realm_id: f.realmId,
            account_id: member.accountId,
            role: 'member',
            valid: kind === 'open' ? '[2020-01-01 00:00:00+00,)' : '[2020-01-01 00:00:00+00,2020-01-02 00:00:00+00)',
            reservation_id: reservationId,
            transaction_id: transactionId,
            member_count_key: null,
          },
        ],
      };
    },
  };
}

function maxInventoryId(scale: number): string {
  const ids = [...inventoryIds.entries()]
    .filter(([ordinal]) => ordinal < scale)
    .map(([, row]) => row.realmId)
    .sort();
  return ids.at(-1) ?? f.realmId;
}

async function transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await f.database.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role='replica'");
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function resetInstall(frontierId: string, clearRouteControls = false): Promise<void> {
  await transaction(async (client) => {
    if (clearRouteControls) await client.query('DELETE FROM community.realm_member_count WHERE route=$1', [f.route]);
    await client.query(
      `INSERT INTO community.realm_member_count_install
         (partition_no,cursor_route,cursor_id,frontier_route,frontier_id,complete)
       VALUES($1,$2,$3,$2,$4,false)
       ON CONFLICT(partition_no) DO UPDATE SET
         cursor_route=EXCLUDED.cursor_route,cursor_id=EXCLUDED.cursor_id,
         frontier_route=EXCLUDED.frontier_route,frontier_id=EXCLUDED.frontier_id,complete=false`,
      [f.partition, f.route, COMMUNITY_MEMBER_COUNT_INSTALL_ZERO_UUID, frontierId],
    );
  });
}

async function resetLegacySelectedSource(): Promise<void> {
  await transaction(async (client) => {
    await client.query(
      `UPDATE community.realm_member SET member_count_key=NULL
        WHERE route=$1 AND realm_id=$2 AND upper_inf(valid)`,
      [f.route, f.realmId],
    );
    await client.query(
      `UPDATE community.realm_member SET member_count_key=NULL
        WHERE route=$1 AND realm_id=$2 AND NOT upper_inf(valid)`,
      [f.route, f.realmId],
    );
    await client.query('DELETE FROM community.realm_member_count WHERE route=$1 AND realm_id=$2', [f.route, f.realmId]);
    await client.query(
      `INSERT INTO community.realm_member_count_install
         (partition_no,cursor_route,cursor_id,frontier_route,frontier_id,complete)
       VALUES($1,$2,$3,$2,$4,false)
       ON CONFLICT(partition_no) DO UPDATE SET
         cursor_route=EXCLUDED.cursor_route,cursor_id=EXCLUDED.cursor_id,
         frontier_route=EXCLUDED.frontier_route,frontier_id=EXCLUDED.frontier_id,complete=false`,
      [f.partition, f.route, COMMUNITY_MEMBER_COUNT_INSTALL_ZERO_UUID, f.realmId],
    );
  });
  // Real registered inventory selection creates the selected count control. The
  // segment measured by checkGrowth is a subsequent registered source segment.
  await f.runSegment();
}

async function removeInventoryPressure(): Promise<void> {
  const ids = [...inventoryIds.values()];
  if (!ids.length) return;
  const realmIds = ids.map((row) => row.realmId);
  const spaceIds = ids.map((row) => row.spaceId);
  await transaction(async (client) => {
    await client.query('DELETE FROM community.realm_member_count WHERE route=$1 AND realm_id=ANY($2::uuid[])', [
      f.route,
      realmIds,
    ]);
    await client.query('DELETE FROM community.realm_revision WHERE route=$1 AND realm_id=ANY($2::uuid[])', [
      f.route,
      realmIds,
    ]);
    await client.query('DELETE FROM community.realm WHERE route=$1 AND realm_id=ANY($2::uuid[])', [f.route, realmIds]);
    await client.query('DELETE FROM access.resource_initialization WHERE route=$1 AND resource_id=ANY($2::uuid[])', [
      f.route,
      realmIds,
    ]);
    await client.query('DELETE FROM access.resource_role_grant WHERE route=$1 AND resource_id=ANY($2::uuid[])', [
      f.route,
      realmIds,
    ]);
    await client.query('DELETE FROM community.space_revision WHERE route=$1 AND space_id=ANY($2::uuid[])', [
      f.route,
      spaceIds,
    ]);
    await client.query('DELETE FROM community.space WHERE route=$1 AND space_id=ANY($2::uuid[])', [f.route, spaceIds]);
  });
  inventoryIds = new Map();
  await resetInstall(f.realmId, true);
  await f.runSegment();
}

async function removeLegacyOpenPressure(): Promise<void> {
  const accountIds = [...openIds.values()].map((member) => member.accountId);
  if (!accountIds.length) return;
  await transaction(async (client) => {
    await client.query(
      'DELETE FROM community.realm_member WHERE route=$1 AND realm_id=$2 AND account_id=ANY($3::uuid[])',
      [f.route, f.realmId, accountIds],
    );
  });
  openIds = new Map();
  await resetLegacySelectedSource();
}

test.serial(
  `registered member-count initialization keeps its selected segments bounded at ${scales.join(', ')}`,
  async () => {
    const inventory = inventoryPopulation();
    const inventoryReport = await checkGrowth(f.database, {
      name: 'community Realm member-count inventory selection',
      scales,
      bounds,
      async grow(db, scale, previous) {
        await seed(db, inventory, { from: previous, to: scale });
        await resetInstall(maxInventoryId(scale), true);
      },
      async prepare() {
        await resetInstall(maxInventoryId(scales.at(-1)!), true);
      },
      async operation() {
        return f.runSegment();
      },
    });
    expect(inventoryReport.samples.map((sample) => sample.scale)).toEqual(scales);
    const inventoryProgress = await f.database.admin.query<{ complete: boolean; cursor_id: string }>(
      'SELECT complete,cursor_id::text FROM community.realm_member_count_install WHERE partition_no=$1',
      [f.partition],
    );
    expect(inventoryProgress.rows[0]?.complete).toBe(false);
    const page = [f.realmId, ...[...inventoryIds.values()].map((row) => row.realmId)].sort();
    expect(inventoryProgress.rows[0]?.cursor_id).toBe(page[49]);
    expect(await readCurrent()).toBeNull();

    await removeInventoryPressure();

    const openPopulation = memberPopulation('open');
    const openReport = await checkGrowth(f.database, {
      name: 'community Realm member-count legacy open-key assignment',
      scales,
      bounds,
      async grow(db, scale, previous) {
        await seed(db, openPopulation, { from: previous, to: scale });
        await resetLegacySelectedSource();
      },
      async prepare() {
        await resetLegacySelectedSource();
      },
      async operation() {
        return f.runSegment();
      },
    });
    expect(openReport.samples.map((sample) => sample.scale)).toEqual(scales);
    const assigned = await f.database.admin.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM community.realm_member
        WHERE route=$1 AND realm_id=$2 AND upper_inf(valid) AND member_count_key IS NOT NULL`,
      [f.route, f.realmId],
    );
    expect(assigned.rows[0]?.count).toBe(50);
    expect(await readCurrent()).toBeNull();

    await removeLegacyOpenPressure();

    const closedPopulation = memberPopulation('closed');
    const closedReport = await checkGrowth(f.database, {
      name: 'community Realm member-count closed-history filtering',
      scales,
      bounds,
      async grow(db, scale, previous) {
        await seed(db, closedPopulation, { from: previous, to: scale });
        await resetLegacySelectedSource();
      },
      async prepare() {
        await resetLegacySelectedSource();
      },
      async operation() {
        return f.runSegment();
      },
    });
    expect(closedReport.samples.map((sample) => sample.scale)).toEqual(scales);
    const closedKeys = await f.database.admin.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM community.realm_member
        WHERE route=$1 AND realm_id=$2 AND NOT upper_inf(valid) AND member_count_key IS NOT NULL`,
      [f.route, f.realmId],
    );
    expect(closedKeys.rows[0]?.count).toBe(0);
    expect(await readCurrent()).toBeNull();
  },
  360_000,
);

test.serial(
  'the native count queue resumes after a finite cut and publishes the live version after completion',
  async () => {
    const sourcePopulation = memberPopulation('open');
    await seed(f.database, sourcePopulation, { from: 0, to: 123 });
    await resetLegacySelectedSource();

    // Inventory is installed by the registered path; three raw source pages
    // assign 50, 50 and 25 open keys and establish the finite cut.
    expect(await f.runSegment()).toBe(true);
    expect(await f.runSegment()).toBe(true);
    expect(await f.runSegment()).toBe(true);
    expect(await readCurrent()).toBeNull();
    const progress = await f.database.admin.query<{ keyed: boolean; initialized: boolean }>(
      'SELECT keyed,initialized FROM community.realm_member_count WHERE route=$1 AND realm_id=$2',
      [f.route, f.realmId],
    );
    expect(progress.rows[0]).toEqual({ keyed: true, initialized: false });

    await f.stopComposer();
    await restartWorker();
    const join = await f.driver.request({
      actor: f.accounts.outsider,
      method: 'POST',
      path: `/v1/realms/${f.realmId}/membership`,
      key: JSON.stringify(randomUUID()),
    });
    expect(join.status).toBe(202);
    await f.driver.settle();
    expect(await readCurrent()).toBeNull();

    await worker.crash();
    await restartWorker();
    const client = await createWorkClient(f.database.url, f.database.openPool({ max: 4 }));
    try {
      const workflowId = randomUUID();
      const handle = await client.enqueue<(partition: number) => Promise<void>>(
        {
          queueName: 'maintenance',
          workflowName: 'community.member-count.continue',
          workflowID: workflowId,
        },
        f.partition,
      );
      await handle.getResult({ pollingIntervalMs: 10 });
      const steps = (await client.listWorkflowSteps(workflowId))?.map((step) => step.name) ?? [];
      const segmentCount = steps.filter((name) => name === 'community.member-count.segment').length;
      expect(segmentCount).toBeLessThanOrEqual(50);
      if (f.partition + 50 < 4096) expect(steps).toContain('community.member-count.enqueue');
      const completed = await f.database.admin.query<{ complete: boolean }>(
        'SELECT complete FROM community.realm_member_count_install WHERE partition_no=$1',
        [f.partition],
      );
      expect(completed.rows[0]?.complete).toBe(true);
      expect(await readCurrent()).toEqual({ count: 125, version: '1' });
    } finally {
      await client.close();
    }
  },
  360_000,
);
