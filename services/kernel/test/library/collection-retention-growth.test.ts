import { expect, test } from 'bun:test';
import {
  pageDueCollectionDeletions,
  purgeExpiredCollectionPage,
  type CollectionDeletionKey,
} from '../../src/library/collection-retention.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { seedCollectionGrowthPopulation } from './support/collection-growth-population.ts';
import { createProfileEntryFixture } from './support/profile-entry-fixture.ts';

test('Collection due seek retains one selected episode while unrelated owner, Collection and history populations grow', async () => {
  let now = Date.now();
  const clock = () => new Date(now);
  const db = await openGrowthDatabase();
  const f = await createProfileEntryFixture({ pool: db.pool, clock });
  try {
    const owner = await f.identity(['subject:read', 'collection:create', 'collection:read', 'collection:delete']);
    expect((await f.send('steward', 'POST', '/v1/platform/exposure/collections:open')).status).toBe(200);
    const subjectId = await f.createSubject('game');
    const made = await f.send(owner.bearer, 'POST', '/v1/collections', {
      title: 'Fixed due target',
      visibility: 'private',
    });
    expect(made.status).toBe(201);
    const selected = (await made.json()).collection;
    expect(
      (
        await f.send(
          owner.bearer,
          'DELETE',
          `/v1/collections/${selected.id}?revision=${selected.revision}`,
          undefined,
          crypto.randomUUID(),
        )
      ).status,
    ).toBe(204);
    const retained = (
      await f.pool.query<{ purgeAfter: string; deletionId: string; revision: number }>(
        'SELECT purge_after::text AS "purgeAfter", deletion_id::text AS "deletionId", revision FROM library.collection WHERE route=$1 AND collection_id=$2',
        [routeOf(selected.id), selected.id],
      )
    ).rows[0]!;
    const key: CollectionDeletionKey = {
      ...retained,
      route: routeOf(selected.id)!,
      collectionId: selected.id,
      accountId: owner.actor.accountId,
    };
    now = Date.parse(key.purgeAfter);

    const report = await checkGrowth(db, {
      name: 'Collection due partition seek with a fixed selected deletion',
      scales: [1, 8, 64],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow: (database, scale, previous) =>
        seedCollectionGrowthPopulation(database, scale, previous, owner.actor.accountId, subjectId),
      operation: async () => {
        const page = await pageDueCollectionDeletions(db.pool, {
          partition: partitionOf(key.route),
          cutoff: key.purgeAfter,
          after: null,
        });
        expect(page).toContainEqual(key);
        expect(page.length).toBeLessThanOrEqual(8);
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096);
      },
    });
    expect(report.samples).toHaveLength(3);

    async function createExpired(count: number): Promise<CollectionDeletionKey> {
      const created = await f.send(owner.bearer, 'POST', '/v1/collections', {
        title: `Selected cleanup ${count}`,
        visibility: 'private',
      });
      expect(created.status).toBe(201);
      const collection = (await created.json()).collection;
      const route = routeOf(collection.id)!;
      const occurrences = Array.from({ length: count }, (_, index) => {
        const memberId = newId(route);
        return {
          member_id: memberId,
          subject_id: subjectId,
          ordinal_key: index.toString(16).padStart(8, '0'),
          transaction_id: memberId,
          added_at: clock().toISOString(),
        };
      });
      await f.pool.query(
        `WITH owner AS (
           UPDATE library.collection
           SET member_count=$3::integer, revision=revision+$3::integer,
               source_generation=source_generation+$3::integer
           WHERE route=$1::integer AND collection_id=$2::uuid AND state='active'
           RETURNING route, collection_id
         ), occurrences AS (
           SELECT * FROM jsonb_to_recordset($4::jsonb) AS item(
             member_id uuid, subject_id uuid, ordinal_key text, transaction_id uuid, added_at timestamptz
           )
         )
         INSERT INTO library.collection_member
           (route, collection_id, member_id, subject_id, ordinal_key, transaction_id, added_at)
         SELECT owner.route, owner.collection_id, occurrences.member_id, occurrences.subject_id,
                occurrences.ordinal_key, occurrences.transaction_id, occurrences.added_at
         FROM owner CROSS JOIN occurrences ORDER BY occurrences.ordinal_key`,
        [route, collection.id, count, JSON.stringify(occurrences)],
      );
      const deleted = await f.send(
        owner.bearer,
        'DELETE',
        `/v1/collections/${collection.id}?revision=${collection.revision + count}`,
        undefined,
        crypto.randomUUID(),
      );
      expect(deleted.status).toBe(204);
      const retained = (
        await f.pool.query<{ purgeAfter: string; deletionId: string; revision: number }>(
          'SELECT purge_after::text AS "purgeAfter", deletion_id::text AS "deletionId", revision FROM library.collection WHERE route=$1 AND collection_id=$2',
          [route, collection.id],
        )
      ).rows[0]!;
      const selectedKey = {
        ...retained,
        route,
        collectionId: collection.id,
        accountId: owner.actor.accountId,
      } satisfies CollectionDeletionKey;
      now = Date.parse(selectedKey.purgeAfter);
      return selectedKey;
    }

    async function drain(key: CollectionDeletionKey): Promise<{ pages: number; removed: number }> {
      let pages = 0;
      let removed = 0;
      for (;;) {
        const result = await purgeExpiredCollectionPage({ pool: f.pool, clock }, key);
        pages += 1;
        removed += result.removed;
        if (result.status === 'purged') return { pages, removed };
        expect(result.status).toBe('progress');
      }
    }

    let activeKey!: CollectionDeletionKey;
    const perPage = await checkGrowth(db, {
      name: 'Collection retention page with independently growing selected children',
      scales: [1, 8, 64],
      repetitions: 1,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow: async () => {},
      prepare: async (_database, scale) => {
        activeKey = await createExpired(scale * 64);
      },
      warmup: async (_database, scale) => {
        const target = await createExpired(scale * 64);
        await drain(target);
      },
      operation: async () => {
        const result = await purgeExpiredCollectionPage({ pool: f.pool, clock }, activeKey);
        expect(result).toEqual({ status: 'progress', removed: 64 });
        return result;
      },
      verify: async (_database, scale, _repetition, result) => {
        expect(result).toEqual({ status: 'progress', removed: 64 });
        expect(await drain(activeKey)).toEqual({ pages: scale + 1, removed: scale * 64 + 1 });
      },
    });
    expect(perPage.samples).toHaveLength(3);

    const total = await checkGrowth(db, {
      name: 'Collection retention total child progress is change-proportional',
      scales: [1, 8, 64],
      repetitions: 1,
      bounds: { rows: 'linear', statements: 'linear', blocks: 'linear' },
      grow: async () => {},
      prepare: async (_database, scale) => {
        activeKey = await createExpired(scale * 64);
      },
      warmup: async (_database, scale) => {
        const target = await createExpired(scale * 64);
        await drain(target);
      },
      operation: async (_database, scale) => {
        const progress = await drain(activeKey);
        expect(progress).toEqual({ pages: scale + 1, removed: scale * 64 + 1 });
        return progress;
      },
      verify: async (_database, scale, _repetition, result) => {
        expect(result).toEqual({ pages: scale + 1, removed: scale * 64 + 1 });
      },
    });
    expect(total.samples).toHaveLength(3);

    let target = key;
    for (;;) {
      const result = await purgeExpiredCollectionPage({ pool: f.pool, clock }, target);
      if (result.status === 'purged') break;
      expect(result.status).toBe('progress');
    }
  } finally {
    await f.close();
    await db.close();
  }
}, 3600000);
