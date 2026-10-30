import { afterAll, beforeAll, expect, test } from 'bun:test';
import { pageActiveAccounts } from '../../src/access/active-account-page.ts';
import { readPublicIdentities } from '../../src/access/account-data.ts';
import { withConnection } from '../../src/database/pool.ts';
import { newId } from '../../src/route/route.ts';
import { admittedAccess } from '../support/admitted-access.ts';
import { LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { capture, checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import type { AccountDiscoveryNative, AccountDiscoveryNativeOptions } from './account-discovery-contract.test.ts';

const route = 23;
const after = '00000000-0000-8000-8000-001700000000';
const selected = Array.from({ length: 3 }, (_, index) =>
  `00000000-0000-8000-8000-0017${(index + 1).toString(16).padStart(8, '0')}`);
let db: GrowthDatabase;
beforeAll(async () => { db = await openGrowthDatabase(); });
afterAll(async () => db?.close());

async function seed(database: GrowthDatabase) {
  await database.admin.query('TRUNCATE access.account CASCADE');
  await database.admin.query('TRUNCATE access.lifecycle_fence_receipt');
  await database.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,display_name,transaction_id)
     SELECT $1,id,'actor','active','Selected discovery account',id FROM unnest($2::uuid[]) seed(id)`,
    [route, selected]);
}

for (const axis of ['unrelated-live', 'excluded', 'history'] as const) {
  test(`fixed native Account discovery input stays bounded as ${axis} grows independently`, async () => {
    const report = await checkGrowth(db, {
      name: `Account discovery native ${axis}`,
      scales: [64, 512, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      indexProbes: 4,
      async grow(database, scale, previous) {
        if (previous === 0) await seed(database);
        const keys = Array.from({ length: scale - previous }, () => newId(route));
        if (axis === 'history') {
          // Actual native history keys; selected current rows remain fixed at all scales.
          await database.admin.query(
            `INSERT INTO access.lifecycle_fence_receipt
               (route,account_id,receipt_id,minimum_authn_epoch,kind,transaction_id)
             SELECT $1,$2,id,ordinal,'fence',id FROM unnest($3::uuid[]) WITH ORDINALITY seed(id,ordinal)`,
            [route, selected[0], keys]);
        } else {
          await database.admin.query(
            `INSERT INTO access.account(route,account_id,kind,state,authn_fenced,transaction_id)
             SELECT $1,id,'actor',CASE WHEN $3 AND ordinal%3=0 THEN 'pending'
               WHEN $3 AND ordinal%3=1 THEN 'deleted' ELSE 'active' END,
               $3 AND ordinal%3=2,id FROM unnest($2::uuid[]) WITH ORDINALITY seed(id,ordinal)`,
            [route, keys, axis === 'excluded']);
        }
      },
      async operation(database) {
        const page = await withConnection(database.pool, (client) => pageActiveAccounts(client, {
          afterRoute: route, afterAccountId: after, limit: 3,
        }));
        expect(page).toEqual(selected.map((accountId) => ({ route, accountId })));
        const identities = await readPublicIdentities(database.pool, [route, route, route], selected);
        expect(identities.map(({ id }) => id)).toEqual(selected);
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([64, 512, 4096]);
    for (const { cost } of report.samples) {
      expect(cost.statements).toBe(2);
      expect(cost.relations['access.account']?.rows).toBeLessThanOrEqual(6);
      expect(cost.relations['access.account']?.sequentialScans).toBe(0);
      expect(cost.relations['access.lifecycle_fence_receipt']).toBeUndefined();
    }
    const { capture: raw } = await capture(db, () => withConnection(db.pool, (client) => pageActiveAccounts(client, {
      afterRoute: route, afterAccountId: after, limit: 3,
    })));
    expect(JSON.stringify(raw.plans)).toContain('"Index Name":"account_active_pages"');
  }, 60_000);
}

async function openNative(): Promise<AccountDiscoveryNative> {
  const path = new URL('../search/support/account-discovery-native.ts', import.meta.url).pathname;
  if (!(await Bun.file(path).exists()))
    throw new Error('Native Account discovery growth is not delivered: Search must supply test/search/support/account-discovery-native.ts (openAccountDiscoveryNative) with actual engine/SQL/Access capture');
  const module = await import(path) as {
    openAccountDiscoveryNative: (options: AccountDiscoveryNativeOptions) => Promise<AccountDiscoveryNative>;
  };
  return module.openAccountDiscoveryNative({ pool: db.pool, routeKey: new Uint8Array(32).fill(83),
    access: admittedAccess({ actions: LIFECYCLE_ACTIONS }), clock: () => new Date() });
}

for (const axis of ['matches', 'corpus', 'kinds', 'copies'] as const) {
  test(`future native mixed Account page measures real ${axis} growth at fixed selected page`, async () => {
    const d = await openNative();
    try {
      const report = await checkGrowth(db, {
        name: `Mixed Account discovery ${axis}`,
        scales: [64, 512, 4096],
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        counted: {
          read(value) { return { iteratorSteps: (value as { iteratorSteps: number }).iteratorSteps }; },
          bounds: { iteratorSteps: 'logarithmic' },
        },
        async grow(_database, scale, previous) {
          await d.grow(axis, scale, previous);
          await d.settle();
        },
        async operation() {
          const page = await d.query({ text: 'Native discovery growth', limit: 3 });
          expect(page.status).toBe(200);
          expect(page.hits).toHaveLength(3);
          expect(new Set(page.hits.map(({ key }) => `${key.kind}:${key.id}`)).size).toBe(3);
          expect(page.hits.some(({ key }) => key.kind === 'account')).toBe(true);
          const physical = await d.physical();
          // Existing one-read ceilings, not the proposed mixed-planner constants.
          expect(physical.rounds).toBeLessThanOrEqual(3);
          expect(physical.engineSearches).toBeLessThanOrEqual(6);
          expect(physical.ownerSeeks).toBeLessThanOrEqual(3);
          expect(physical.rawCandidates).toBeLessThanOrEqual(3 * (2 * 3 + 1));
          expect(physical.accessPoints).toBeLessThanOrEqual(16 + 8 * physical.rawCandidates);
          expect(physical.examinedRows).toBeLessThanOrEqual(64 + 16 * physical.rawCandidates);
          expect(physical.responseBytes).toBeLessThanOrEqual(16 * 1024 + 4 * 1024 * physical.rawCandidates);
          expect(physical.requestBytes).toBeLessThanOrEqual(64 * 1024 + 1024 * physical.rawCandidates);
          expect(physical.sqlPerBackend.every((count) => count <= 12)).toBe(true);
          expect(physical.connectionsPerBackend.every((count) => count <= 1)).toBe(true);
          // Includes all shards and sparse/excluded work, not returned hits or terminate_after.
          expect(physical.iteratorSteps).toBeGreaterThan(0);
          for (const count of page.kinds) {
            if (!('unavailable' in count) && !count.exact) expect(count.value).toBeGreaterThan(0);
          }
          return { iteratorSteps: physical.iteratorSteps };
        },
      });
      expect(report.samples.map(({ scale }) => scale)).toEqual([64, 512, 4096]);
    } finally { await d.close(); }
  }, 120_000);
}
