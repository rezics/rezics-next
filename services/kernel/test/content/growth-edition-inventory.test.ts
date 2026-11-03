import { expect, test } from 'bun:test';
import candidatePage from '../../src/content/edition-index-page.sql';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { assertGrowthAccessPaths, checkGrowth } from '../support/growth.ts';
import { observeSql } from './support/sql-observer.ts';
import {
  createGrowthEditionInventoryFixture,
  inventoryLimit,
  inventoryScales,
  type InventoryAxis,
  type InventoryPage,
} from './support/growth-edition-inventory-fixture.ts';

const indexedRelations = [
  'content.creator_edition',
  'content.edition',
  'content.post',
  'content.revision',
  'content.thread',
  'semantic.subject',
  'access.resource_grant',
  'access.resource_role_grant',
  'access.resource_denial',
];

for (const axis of [
  'creator-candidates',
  'unrelated-homes',
  'source-history',
  'subject-history',
  'access-history',
] satisfies InventoryAxis[]) {
  for (const shape of ['populated', 'deep', 'terminal-empty', 'hidden'] satisfies InventoryPage[]) {
    test(`native creator inventory ${shape} page stays bounded as ${axis} grows`, async () => {
      const f = await createGrowthEditionInventoryFixture();
      try {
        const report = await checkGrowth(f.db, {
          name: `native creator edition inventory: ${axis}, ${shape}`,
          scales: inventoryScales,
          bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
          grow: (_db, scale, previous) => f.grow(axis, shape, scale, previous),
          // Exactly one real HTTP request, including native authentication, owning source
          // readers, actual Access and the inventory's second disclosure pass.
          operation: () => f.observedPage(),
        });
        expect(report.samples.map(({ scale }) => scale)).toEqual([...inventoryScales]);
        for (const sample of report.samples) {
          for (const cost of sample.repetitions) {
            expect(cost.rows).toBeGreaterThan(0);
            expect(cost.blocks).toBeGreaterThan(0);
            expect(cost.statements).toBeGreaterThan(0);
            const candidates = cost.relations['content.creator_edition'];
            expect(candidates, 'native candidate range must be captured').toBeDefined();
            // Native plans charge filtered rows too. Tiny relations may choose a sequential
            // scan; preserve the shared access-path rule rather than forcing a planner choice.
            expect(candidates!.rows).toBeGreaterThanOrEqual(shape === 'terminal-empty' ? 0 : inventoryLimit);
            expect(cost.backgroundStatements ?? 0).toBe(0);
          }
          // The harness records actual rows, shared blocks and statements, never DTO counts.
          console.info(
            JSON.stringify({
              operation: report.name,
              scale: sample.scale,
              cost: sample.cost,
              repetitions: sample.repetitions,
              verdicts: report.verdicts,
            }),
          );
        }
        assertGrowthAccessPaths(report.name, report.samples, indexedRelations);
      } finally {
        await f.close();
      }
    }, 3_600_000);
  }
}

test('native inventory retains account concealment, draft and withdrawn bindings, and sealed cursor admission', async () => {
  const f = await createGrowthEditionInventoryFixture();
  try {
    const all = [...f.editions.keys()].sort();
    const first = await f.page();
    const second = await f.page(first.next!);
    expect([...first.editions, ...second.editions]).toEqual(all.map((id) => f.editions.get(id)!));
    expect([...first.editions, ...second.editions].map(({ state }) => state)).toContain('draft');
    expect([...first.editions, ...second.editions].map(({ state }) => state)).toContain('published');
    expect([...first.editions, ...second.editions].map(({ state }) => state)).toContain('withdrawn');
    expect(await f.page(second.next!)).toEqual({ editions: [], next: null });
    expect((await f.request(f.path(), { person: f.other })).response.status).toBe(404);
    expect((await f.request(f.path(f.other.accountId))).response.status).toBe(404);
    expect(await f.page(undefined, f.other)).toEqual({ editions: [], next: null });
    const cursor = first.next!;
    expect((await f.request(f.path(f.author.accountId, inventoryLimit + 1, cursor))).response.status).toBe(400);
    expect(
      (await f.request(f.path(f.other.accountId, inventoryLimit, cursor), { person: f.other })).response.status,
    ).toBe(400);
    expect((await f.request(f.path(f.author.accountId, inventoryLimit, 'forged'))).response.status).toBe(400);

    f.setCursorTime(Date.now() + 16 * 60_000);
    expect((await f.request(f.path(f.author.accountId, inventoryLimit, cursor))).response.status).toBe(400);
    f.setCursorTime(Date.now());
    const partition = partitionOf(routeOf(f.author.accountId)!);
    // A home-epoch change is infrastructure state, never fabricated selected Content state.
    await f.db.admin.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1', [partition]);
    try {
      expect((await f.request(f.path(f.author.accountId, inventoryLimit, cursor))).response.status).toBe(400);
    } finally {
      await f.db.admin.query('UPDATE core.partition SET epoch=epoch-1 WHERE partition_no=$1', [partition]);
    }
    const trace = observeSql(f.pool);
    try {
      expect((await f.request(f.path(f.author.accountId, 100))).response.status).toBe(200);
      const range = trace.records.filter(({ statement }) => statement === candidatePage.sql);
      expect(range).toHaveLength(1);
      expect(range[0]!.parameters[candidatePage.params.indexOf('limit')]).toBe(20);
    } finally {
      await trace.close();
    }
  } finally {
    await f.close();
  }
}, 120_000);

test('native inventory conceals a source revoked during FINAL and propagates retryable home failures', async () => {
  const f = await createGrowthEditionInventoryFixture();
  try {
    const control = await f.page();
    expect(control.editions).toHaveLength(inventoryLimit);
    let reads = 0;
    f.onEditionPrepare(async () => {
      // Both first-pass candidates were read. Revoke the common source during the
      // first final metadata pass, using the source owner's supported erase command.
      if (++reads === inventoryLimit + 1) {
        await f.command(`/v1/posts/${f.selectedSource.postId}`, undefined, 200, 'DELETE');
      }
    });
    const revoked = await f.page();
    expect(reads).toBe(inventoryLimit + 1);
    expect(revoked.editions).toEqual([]);
    expect(revoked.next).toBeString();
    f.onEditionPrepare();
    const continued = await f.page(revoked.next!);
    expect(continued.editions).toEqual([]);
    expect(continued.next).toBeString();
    expect(await f.page(continued.next!)).toEqual({ editions: [], next: null });
    const serialized = JSON.stringify(revoked);
    for (const id of f.editions.keys()) expect(serialized).not.toContain(id);

    const partitions = new Set([
      partitionOf(routeOf(f.author.accountId)!),
      partitionOf(routeOf(f.selectedSource.postId)!),
    ]);
    for (const partition of partitions) {
      await f.db.admin.query("UPDATE core.partition SET write_state='moved',moved_to='other' WHERE partition_no=$1", [
        partition,
      ]);
      try {
        const unavailable = await f.request(f.path());
        expect(unavailable.response.status, unavailable.text).toBe(503);
        expect(unavailable.value).toMatchObject({ code: 'partition_unavailable', retryable: true });
        expect(unavailable.response.headers.get('retry-after')).not.toBeNull();
      } finally {
        await f.db.admin.query("UPDATE core.partition SET write_state='active',moved_to=NULL WHERE partition_no=$1", [
          partition,
        ]);
      }
    }
  } finally {
    await f.close();
  }
}, 120_000);
