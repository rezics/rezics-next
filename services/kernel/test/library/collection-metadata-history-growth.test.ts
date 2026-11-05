import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { checkGrowth } from '../support/growth.ts';
import { routeOf } from '../../src/route/route.ts';
import metadataHistoryCleanup from '../../src/library/collection-metadata-history-cleanup.sql';
import { seedCollectionGrowthPopulation } from './support/collection-growth-population.ts';
import {
  createCollectionPresentationFixture,
  type CollectionPresentationFixture,
} from './support/collection-presentation-fixture.ts';

let f: CollectionPresentationFixture;
beforeAll(async () => {
  f = await createCollectionPresentationFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
}, 120_000);

type HistoryTarget = { id: string; count: number; initialTitle: string; title: string };

async function addHistory(
  database: CollectionPresentationFixture['database'],
  targets: HistoryTarget[],
  amount: number,
  mediaIds?: readonly string[],
) {
  let remaining = amount;
  let mediaOffset = 0;
  while (remaining > 0) {
    let target = targets.at(-1);
    if (!target || target.count === 128) {
      const created = await f.collection();
      target = { id: created.id, count: 0, initialTitle: created.title, title: created.title };
      targets.push(target);
    }
    const count = Math.min(128 - target.count, remaining);
    const revisions = Array.from({ length: count }, (_, index) => target!.count + index + 2);
    const beforeTitles = revisions.map((revision) =>
      mediaIds ? target!.title : revision === 2 ? target!.initialTitle : `History ${revision - 1}`,
    );
    const afterTitles = revisions.map((revision) => (mediaIds ? target!.title : `History ${revision}`));
    const covers = mediaIds ? mediaIds.slice(mediaOffset, mediaOffset + count) : Array<string>(count).fill('');
    if (mediaIds && covers.length !== count) throw new Error('Media history growth must match its journal rows');
    const coverIds = covers.map((id) => id || null);
    await database.admin.query(
      `INSERT INTO library.collection_metadata_history
        (route,collection_id,curator_account_id,revision,transaction_id,recorded_at,changed_fields,
         before_title,after_title,before_description,after_description,before_visibility,after_visibility,
         before_presentation_kind,after_presentation_kind,before_cover_media_id,after_cover_media_id)
       SELECT $1,$2,$3,events.revision,gen_random_uuid(),clock_timestamp(),ARRAY[$8::text],
              events.before_title,events.after_title,NULL,NULL,'private','private',NULL,NULL,events.cover_media_id,NULL
       FROM unnest($4::integer[],$5::text[],$6::text[],$7::uuid[]) AS events(revision,before_title,after_title,cover_media_id)`,
      [
        routeOf(target.id),
        target.id,
        f.owner.accountId,
        revisions,
        beforeTitles,
        afterTitles,
        coverIds,
        mediaIds ? 'coverMediaId' : 'title',
      ],
    );
    target.count += count;
    if (!mediaIds) target.title = `History ${target.count + 1}`;
    await database.admin.query(
      `UPDATE library.collection SET revision=$3,title=$4,cover_media_id=NULL,
         updated_at=clock_timestamp(),transaction_id=gen_random_uuid()
       WHERE route=$1 AND collection_id=$2 AND curator_account_id=$5`,
      [routeOf(target.id), target.id, target.count + 1, target.title, f.owner.accountId],
    );
    remaining -= count;
    mediaOffset += count;
  }
}

async function readPageAndChange(collectionId: string, revision: number) {
  const base = `/v1/collections/${collectionId}/metadata-history`;
  const pageResponse = await f.send(f.owner.bearer, 'GET', `${base}?limit=25`);
  expect(pageResponse.status).toBe(200);
  const page = (await pageResponse.json()) as {
    items: { revision: number }[];
    next: string | null;
    actions: { review: boolean; reapply: boolean };
  };
  const changeResponse = await f.send(f.owner.bearer, 'GET', `${base}/${revision}`);
  expect(changeResponse.status).toBe(200);
  const change = await changeResponse.json();
  expect(page.items.length).toBeLessThanOrEqual(25);
  expect(page.actions).toEqual({ review: true, reapply: false });
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(12_000);
  expect(Buffer.byteLength(JSON.stringify(change))).toBeLessThan(12_000);
  return change;
}

test('metadata history stays bounded as unrelated native Collection rows grow', async () => {
  const cover = await f.importedCover();
  const collection = await f.collection();
  const changed = await f.send(f.owner.bearer, 'PATCH', `/v1/collections/${collection.id}`, {
    revision: collection.revision,
    title: 'Addressed metadata change',
  });
  expect(changed.status).toBe(200);
  const changedCollection = ((await changed.json()) as { collection: { revision: number } }).collection;
  const noChangeKey = randomUUID();
  const noChange = {
    revision: changedCollection.revision,
    title: 'Addressed metadata change',
  };
  expect(
    (await f.send(f.owner.bearer, 'PATCH', `/v1/collections/${collection.id}`, noChange, noChangeKey)).status,
  ).toBe(200);
  expect(
    (await f.send(f.owner.bearer, 'PATCH', `/v1/collections/${collection.id}`, noChange, noChangeKey)).status,
  ).toBe(200);
  const unchangedHistory = await f.send(
    f.owner.bearer,
    'GET',
    `/v1/collections/${collection.id}/metadata-history?limit=25`,
  );
  expect(unchangedHistory.status).toBe(200);
  expect(
    ((await unchangedHistory.json()) as { items: { revision: number }[] }).items.map(({ revision }) => revision),
  ).toEqual([changedCollection.revision]);
  const database = f.database;
  await checkGrowth(database, {
    name: 'Collection metadata history over unrelated Collection, member and Access rows',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    includeBackends: true,
    async grow(db, scale, previous) {
      await seedCollectionGrowthPopulation(db, scale / 1024, previous / 1024, f.owner.accountId, cover.subjectId);
    },
    async operation() {
      const change = await readPageAndChange(collection.id, changedCollection.revision);
      expect(change).toMatchObject({
        revision: changedCollection.revision,
        changedFields: ['title'],
        before: { title: collection.title },
        after: { title: 'Addressed metadata change' },
      });
    },
  });
}, 3_600_000);

test('history cleanup remains a bounded page over independent journal growth', async () => {
  const cleanupTargets: HistoryTarget[] = [];
  const growingTargets: HistoryTarget[] = [];
  await addHistory(f.database, cleanupTargets, 128);
  const cleanupTarget = cleanupTargets[0]!;
  await checkGrowth(f.database, {
    name: 'Bounded Collection metadata history cleanup over growing journal rows',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    includeBackends: true,
    async grow(_db, scale, previous) {
      await addHistory(f.database, growingTargets, scale - previous);
    },
    async prepare(db) {
      const revisions = Array.from({ length: 25 }, (_, index) => index + 2);
      await db.admin.query(
        `INSERT INTO library.collection_metadata_history
          (route,collection_id,curator_account_id,revision,transaction_id,recorded_at,changed_fields,
           before_title,after_title,before_description,after_description,before_visibility,after_visibility,
           before_presentation_kind,after_presentation_kind,before_cover_media_id,after_cover_media_id)
         SELECT $1,$2,$3,events.revision,gen_random_uuid(),clock_timestamp(),ARRAY['title'],
                events.before_title,events.after_title,NULL,NULL,'private','private',NULL,NULL,NULL,NULL
         FROM unnest($4::integer[],$5::text[],$6::text[]) AS events(revision,before_title,after_title)
         ON CONFLICT (route,collection_id,revision) DO NOTHING`,
        [
          routeOf(cleanupTarget.id),
          cleanupTarget.id,
          f.owner.accountId,
          revisions,
          revisions.map((revision) => (revision === 2 ? cleanupTarget.initialTitle : `History ${revision - 1}`)),
          revisions.map((revision) => `History ${revision}`),
        ],
      );
    },
    async operation(db) {
      const removed = await metadataHistoryCleanup.run(db.pool, {
        route: routeOf(cleanupTarget.id)!,
        collection_id: cleanupTarget.id,
      });
      expect(removed.length).toBe(25);
    },
  });
}, 3_600_000);

test('addressed metadata changes stay bounded as immutable history rows grow', async () => {
  const targets: HistoryTarget[] = [];
  await checkGrowth(f.database, {
    name: 'Collection metadata history over independently growing native change rows',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    includeBackends: true,
    async grow(_db, scale, previous) {
      await addHistory(f.database, targets, scale - previous);
    },
    async operation() {
      const target = targets[0];
      if (!target) throw new Error('History growth must seed a target Collection');
      const change = await readPageAndChange(target.id, 2);
      expect(change).toMatchObject({ revision: 2, before: { title: target.initialTitle } });
    },
  });
}, 3_600_000);

test('historical Media disclosure stays bounded as old cover references and Media rows grow', async () => {
  const cover = await f.importedCover();
  const targets: HistoryTarget[] = [];
  let selectedMediaId: string | null = null;
  await checkGrowth(f.database, {
    name: 'Addressed Collection history over independently growing historical cover Media rows',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    includeBackends: true,
    async grow(db, scale, previous) {
      const ids = await f.growCoverHistory(cover.mediaId, scale, previous);
      if (ids.length === 0) return;
      if (selectedMediaId === null) selectedMediaId = ids[0]!;
      await addHistory(db, targets, ids.length, ids);
      if (scale === 64) {
        const erased = await db.admin.query(
          'UPDATE content.media SET erased=true,security_revision=security_revision+1 WHERE route=$1 AND media_id=$2',
          [routeOf(selectedMediaId!), selectedMediaId],
        );
        expect(erased.rowCount).toBe(1);
      }
    },
    async operation() {
      const target = targets[0];
      if (!target || selectedMediaId === null) throw new Error('Historical Media growth must seed an addressed cover');
      const change = await readPageAndChange(target.id, 2);
      expect(change).toMatchObject({ revision: 2, before: { cover: { state: 'unavailable' } } });
    },
  });
}, 3_600_000);
