import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { compileEntryRelease } from './support/profile-entry-fixture.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createAccess } from '../../src/access/index.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createCollectionReads, type CollectionView } from '../../src/library/collection-reads.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { restoreCollection } from '../../src/library/collection-store.ts';
import downloadPoint from '../../src/content/read-download-media.sql';
import { capture, checkGrowth } from '../support/growth.ts';
import { seedCollectionGrowthPopulation } from './support/collection-growth-population.ts';
import {
  createCollectionPresentationFixture,
  type CollectionPresentationFixture,
} from './support/collection-presentation-fixture.ts';

let f: CollectionPresentationFixture;
const type = Object.keys(bundledRelease.types).sort()[0]!;
beforeAll(async () => {
  f = await createCollectionPresentationFixture();
}, 120_000);
beforeEach(async () => {
  await f.refresh();
}, 120_000);
afterAll(async () => {
  await f?.close();
}, 120_000);
const path = (id: string) => `/v1/collections/${id}`;
async function value(response: Response, status = 200): Promise<CollectionView> {
  expect(response.status).toBe(status);
  return ((await response.json()) as { collection: CollectionView }).collection;
}
async function read(id: string, bearer: string | null = f.owner.bearer) {
  return value(await f.send(bearer, 'GET', path(id)));
}
async function patch(row: CollectionView, body: Record<string, unknown>, key = randomUUID()) {
  return value(await f.send(f.owner.bearer, 'PATCH', path(row.id), { revision: row.revision, ...body }, key));
}

test('native imported selection retains its original home and rechecks the actual viewer without media grants', async () => {
  const cover = await f.importedCover();
  const before = await f.runtime.mediaBoundary.observe(cover.mediaId);
  let collection = await f.collection({ presentationKind: type, coverMediaId: cover.mediaId, visibility: 'public' });
  expect(collection).toMatchObject({
    presentationKind: type,
    presentationKindSource: 'owner',
    coverSource: 'owner',
    coverMediaId: cover.mediaId,
    memberCount: 0,
  });
  expect(collection.cover).toMatchObject({ media: cover.mediaId, credit: cover.input.credit });
  expect(collection.cover?.variants).toEqual(
    before.variants
      .map(({ format, width }) => ({ format, width }))
      .sort((a, b) => a.width - b.width || a.format.localeCompare(b.format)),
  );
  for (const bearer of [null, f.other.bearer]) {
    const publicRead = await read(collection.id, bearer);
    expect(publicRead.cover?.media).toBe(cover.mediaId);
    expect(publicRead.coverSource).toBe('owner');
    expect(publicRead).not.toHaveProperty('coverMediaId');
    expect(JSON.stringify(publicRead)).not.toContain('m/' + cover.mediaId);
    expect(JSON.stringify(publicRead)).not.toContain(cover.input.sourceUrl);
  }
  const listed = await f.send(f.owner.bearer, 'GET', `/v1/collections?curatorAccountId=${f.owner.accountId}`);
  expect(listed.status).toBe(200);
  expect(
    ((await listed.json()) as { collections: CollectionView[] }).collections.find(({ id }) => id === collection.id),
  ).toMatchObject({ coverSource: 'owner', presentationKind: type });
  const reduced = await f.credential('ordinary', ['collection:read']);
  const limited = await read(collection.id, reduced.bearer);
  expect(limited.cover).toBeNull();
  expect(limited.coverSource).toBe('none'); // A complete empty curated source proves no member fallback.
  const after = await f.runtime.mediaBoundary.observe(cover.mediaId);
  expect(after.row).toEqual(before.row);
  expect(after.transitions).toEqual(before.transitions);
  expect(after.events).toEqual(before.events);
  expect(after.variants).toEqual(before.variants);
  const writerOnly = await f.credential('ordinary', ['collection:create', 'subject:read', 'media:read']);
  const written = await f.collection({ coverMediaId: cover.mediaId }, writerOnly.bearer);
  expect(written).toMatchObject({ coverMediaId: cover.mediaId, cover: null });
  expect((await read(written.id)).cover?.media).toBe(cover.mediaId);
  const member = await f.send(f.owner.bearer, 'POST', `${path(collection.id)}/members`, {
    subjectId: cover.subjectId,
    note: 'Keep this occurrence',
  });
  expect(member.status).toBe(201);
  const memberBefore = await f.send(f.owner.bearer, 'GET', `${path(collection.id)}/members`);
  const members = await memberBefore.json();
  collection = await read(collection.id);
  expect(collection.memberCount).toBe(1);
  for (const group of ['personal_library', 'selling'])
    expect((await f.send(f.manager.bearer, 'POST', `/v1/platform/exposure/${group}:open`)).status).toBe(200);
  expect(
    (await f.send(f.owner.bearer, 'PUT', `/v1/libraryEntries/${cover.subjectId}`, { state: 'planned' })).status,
  ).toBe(201);
  const offerResponse = await f.send(f.owner.bearer, 'POST', '/v1/offers', {
    targetSubjectId: cover.subjectId,
    title: 'Unchanged price',
    currency: 'usd',
    unitAmountMinor: 1500,
    taxCode: 'txcd_10000000',
  });
  expect(offerResponse.status).toBe(201);
  const offer = ((await offerResponse.json()) as { offer: { id: string } }).offer;
  const priceBefore = await f.send(f.owner.bearer, 'GET', `/v1/offers/${offer.id}`);
  expect(priceBefore.status).toBe(200);
  const price = await priceBefore.json();
  const entryBefore = await f.database.admin.query(
    'SELECT * FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3',
    [routeOf(f.owner.accountId), f.owner.accountId, cover.subjectId],
  );
  expect(entryBefore.rows[0]?.library_profile_pin).not.toBeNull();
  const mediaGrantsBefore = await f.database.admin.query(
    'SELECT * FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2',
    [routeOf(cover.mediaId), cover.mediaId],
  );
  collection = await patch(collection, { presentationKind: null, coverMediaId: null });
  expect(collection).toMatchObject({
    presentationKind: null,
    presentationKindSource: 'mixed',
    cover: null,
    coverSource: 'pending',
    memberCount: 1,
  });
  expect(await (await f.send(f.owner.bearer, 'GET', `${path(collection.id)}/members`)).json()).toEqual(members);
  expect(
    (
      await f.database.admin.query('SELECT * FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3', [
        routeOf(f.owner.accountId),
        f.owner.accountId,
        cover.subjectId,
      ])
    ).rows,
  ).toEqual(entryBefore.rows);
  expect(await (await f.send(f.owner.bearer, 'GET', `/v1/offers/${offer.id}`)).json()).toEqual(price);
  expect(
    (
      await f.database.admin.query('SELECT * FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2', [
        routeOf(cover.mediaId),
        cover.mediaId,
      ])
    ).rows,
  ).toEqual(mediaGrantsBefore.rows);
}, 120_000);

test('metadata CAS and native receipt digests distinguish omission, null, values and targets; failures roll back', async () => {
  let row = await f.collection({ presentationKind: type });
  const key = randomUUID();
  const body = { revision: row.revision, title: 'Omitted selections' };
  const changed = await value(await f.send(f.owner.bearer, 'PATCH', path(row.id), body, key));
  expect(changed.presentationKind).toBe(type);
  expect(await value(await f.send(f.owner.bearer, 'PATCH', path(row.id), body, key))).toEqual(changed);
  for (const extra of [{ presentationKind: null }, { coverMediaId: null }, { presentationKind: type }])
    expect((await f.send(f.owner.bearer, 'PATCH', path(row.id), { ...body, ...extra }, key)).status).toBe(422);
  const other = await f.collection();
  expect((await f.send(f.owner.bearer, 'PATCH', path(other.id), body, key)).status).toBe(422);
  expect(
    (await f.send(f.owner.bearer, 'PATCH', path(row.id), { revision: row.revision, presentationKind: null })).status,
  ).toBe(409);
  const copies = async () =>
    (
      await f.database.admin.query(
        `SELECT (SELECT count(*)::integer FROM core.receipt WHERE partition_no=$1 AND principal_id=$2) AS receipts,
      (SELECT count(*)::integer FROM core.outbox WHERE partition_no=$1 AND subject=$3) AS events`,
        [partitionOf(routeOf(f.owner.accountId)!), f.owner.accountId, row.id],
      )
    ).rows;
  const beforeFailure = await copies();
  for (const bad of ['not-a-Type', 'schema:name']) {
    expect(
      (
        await f.send(f.owner.bearer, 'PATCH', path(row.id), {
          revision: changed.revision,
          title: 'Never committed',
          presentationKind: bad,
        })
      ).status,
    ).toBe(400);
    expect((await read(row.id)).title).toBe(changed.title);
  }
  expect(
    (
      await f.send(f.owner.bearer, 'PATCH', path(row.id), {
        revision: changed.revision,
        title: 'Never committed',
        coverMediaId: newId(routeOf(row.id)!),
      })
    ).status,
  ).toBe(404);
  expect(await copies()).toEqual(beforeFailure);
  expect((await read(row.id)).title).toBe(changed.title);
  expect(
    (await f.send(f.other.bearer, 'PATCH', path(row.id), { revision: changed.revision, presentationKind: type }))
      .status,
  ).toBe(404);
  expect(
    (await f.send(null, 'PATCH', path(row.id), { revision: changed.revision, presentationKind: type })).status,
  ).toBe(401);
  const reduced = await f.credential('ordinary', ['collection:read']);
  expect((await f.send(reduced.bearer, 'PATCH', path(row.id), body, key)).status).toBe(404);
  row = await patch(changed, { presentationKind: null });
  expect(row.presentationKindSource).toBe('mixed');
  const pure = await capture(f.database, () => read(row.id));
  expect(pure.value.presentationKind).toBeNull();
  for (const statement of pure.capture.statements) expect(statement).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
}, 120_000);

test('current source-hidden, tuple and media revocation withhold descriptors without changing configured choice', async () => {
  for (const revoke of ['subject', 'tuple', 'media'] as const) {
    const cover = await f.importedCover();
    let row = await f.collection({ coverMediaId: cover.mediaId, visibility: 'public' });
    expect((await read(row.id, null)).cover?.media).toBe(cover.mediaId);
    expect(
      (await f.send(f.owner.bearer, 'POST', `${path(row.id)}/members`, { subjectId: cover.subjectId })).status,
    ).toBe(201);
    row = await read(row.id);
    const body = { revision: row.revision, presentationKind: type };
    const key = randomUUID();
    row = await value(await f.send(f.owner.bearer, 'PATCH', path(row.id), body, key));
    const response =
      revoke === 'subject'
        ? await f.send(f.manager.bearer, 'POST', `/v1/subjects/${cover.subjectId}:hide`, {
            reason: 'Current source hidden',
          })
        : revoke === 'tuple'
          ? await f.send(f.manager.bearer, 'POST', '/v1/sourceFences:takedown', {
              source: cover.input.provenance.source,
              externalId: cover.input.provenance.external_id,
              fieldGroup: 'cover',
              reason: 'Current tuple revoked',
            })
          : await f.send(f.manager.bearer, 'POST', `/v1/media/${cover.mediaId}:takeDown`, {
              reason: 'Current media revoked',
            });
    expect(response.status).toBe(200);
    const current = await read(row.id, null);
    expect(current).toMatchObject({ cover: null, coverSource: 'pending', presentationKind: type, memberCount: 1 });
    expect(current).not.toHaveProperty('coverMediaId');
    expect(JSON.stringify(current)).not.toContain(cover.mediaId);
    // Current metadata survives loss of the foreign cover. Replaying does not validate a new choice.
    const replay = await value(await f.send(f.owner.bearer, 'PATCH', path(row.id), body, key));
    expect(replay.revision).toBe(row.revision);
    expect(replay.coverMediaId).toBe(cover.mediaId);
    if (revoke !== 'subject') {
      expect(replay.cover).toBeNull();
      const denied = await f.send(f.owner.bearer, 'PATCH', path(row.id), {
        revision: row.revision,
        title: 'Must roll back',
        coverMediaId: cover.mediaId,
      });
      expect(denied.status).toBe(404);
      expect((await read(row.id)).title).toBe(row.title);
    }
  }
}, 240_000);

test('a real foreign-home wait cannot disclose a Collection whose native visibility changed', async () => {
  const cover = await f.importedCover();
  const row = await f.collection({ coverMediaId: cover.mediaId, visibility: 'public' });
  const pool = f.database.openPool({ max: 1 });
  const secondary = createKernel({
    pool,
    routeKey: f.runtime.identity.routeKey,
    tokens: f.runtime.identity.tokenKeys,
    access: (configuration) => createAccess({ ...configuration, auth: f.runtime.identity.accessConfig.auth! }),
  });
  let pending = true;
  const installed = new WeakSet<PoolClient>();
  const observe = (client: PoolClient) => {
    if (installed.has(client)) return;
    installed.add(client);
    const original = client.query.bind(client);
    client.query = ((...args: unknown[]) => {
      if (
        pending &&
        (typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text) === downloadPoint.sql
      ) {
        pending = false;
        return patch(row, { visibility: 'private' }).then(() => Reflect.apply(original, client, args));
      }
      return Reflect.apply(original, client, args);
    }) as typeof client.query;
  };
  pool.on('acquire', observe);
  const result = await secondary.handle(new Request(`https://collection.test${path(row.id)}`));
  expect(pending).toBe(false);
  expect(result.status).toBe(404);
  expect(await result.text()).not.toContain(cover.mediaId);
  pool.off('acquire', observe);
}, 120_000);

test('native fixed selection branches and first/deep keyset reads stay bounded over unrelated history', async () => {
  const cover = await f.importedCover();
  let row = await f.collection({ presentationKind: type, coverMediaId: cover.mediaId, visibility: 'public' });
  let deep: string | null = null;
  let reduced = await f.credential('ordinary', ['collection:read']);
  await checkGrowth(f.database, {
    name: 'owner-selected Collection presentation, native existing cover and exact replay',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    includeBackends: true,
    async grow(db, scale, previous) {
      f.owner.bearer = (await f.credential('ordinary')).bearer;
      f.other.bearer = (await f.credential('another')).bearer;
      reduced = await f.credential('ordinary', ['collection:read']);
      // The shared population helper's unit is 1024 rows; these are exactly 64/512/4096 unrelated rows per family.
      await seedCollectionGrowthPopulation(db, scale / 1024, previous / 1024, f.owner.accountId, cover.subjectId);
      const actor = await f.runtime.identity.access.authenticate(f.owner.bearer, {
        pool: db.pool,
        deadline: Date.now() + 5_000,
      });
      await f.growCoverHistory(cover.mediaId, scale, previous);
      const reads = createCollectionReads({
        pool: db.pool,
        access: f.runtime.identity.access,
        tokens: f.runtime.identity.tokenKeys,
        routeKey: f.runtime.identity.routeKey,
      });
      let cursor: string | null = null;
      do {
        deep = cursor;
        const page = await reads.listCollections(actor, {
          curatorAccountId: f.owner.accountId,
          limit: 8,
          ...(cursor ? { cursor } : {}),
        });
        cursor = page.next;
      } while (cursor !== null);
    },
    async operation() {
      const body = { revision: row.revision, presentationKind: type };
      const key = randomUUID();
      row = await value(await f.send(f.owner.bearer, 'PATCH', path(row.id), body, key));
      expect(row.cover?.media).toBe(cover.mediaId);
      expect(await value(await f.send(f.owner.bearer, 'PATCH', path(row.id), body, key))).toEqual(row);
      expect((await f.send(f.owner.bearer, 'PATCH', path(row.id), body)).status).toBe(409);
      expect(
        (await f.send(f.other.bearer, 'PATCH', path(row.id), { revision: row.revision, presentationKind: type }))
          .status,
      ).toBe(404);
      expect((await read(row.id)).cover?.media).toBe(cover.mediaId);
      expect((await read(row.id, null)).cover?.media).toBe(cover.mediaId);
      expect((await read(row.id, reduced.bearer)).cover).toBeNull();
      for (const cursor of [null, deep]) {
        const page = await f.send(
          f.owner.bearer,
          'GET',
          `/v1/collections?curatorAccountId=${f.owner.accountId}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        expect(page.status).toBe(200);
        expect(((await page.json()) as { collections: unknown[] }).collections).toHaveLength(1);
      }
    },
  });
}, 240_000);

test('a later active release lacking the stored Type preserves the owner choice as data', async () => {
  const replacement = await compileEntryRelease('replacement');
  const missing = Object.keys(bundledRelease.types).find((id) => !Object.hasOwn(replacement.types, id))!;
  expect(missing).toBeString();
  const row = await f.collection({ presentationKind: missing });
  await f.grant(f.manager.accountId, ['definitions:publish', 'definitions:activate']);
  const before = (await (await f.send(null, 'GET', '/v1/definitions/active')).json()) as {
    digest: string;
    head: number;
  };
  const published = await f.send(f.manager.bearer, 'POST', '/v1/definitions/releases', { release: replacement });
  expect(published.status).toBe(200);
  const { digest } = (await published.json()) as { digest: string };
  expect(
    (
      await f.send(f.manager.bearer, 'POST', `/v1/definitions/releases/${digest}:activate`, {
        expected_head: before.head,
      })
    ).status,
  ).toBe(200);
  try {
    expect(await read(row.id)).toMatchObject({ presentationKind: missing, presentationKindSource: 'owner' });
    expect(
      (await f.send(f.owner.bearer, 'PATCH', path(row.id), { revision: row.revision, presentationKind: missing }))
        .status,
    ).toBe(400);
    expect((await patch(row, { title: 'Omitted historical choice' })).presentationKind).toBe(missing);
  } finally {
    const current = (await (await f.send(null, 'GET', '/v1/definitions/active')).json()) as { head: number };
    expect(
      (
        await f.send(f.manager.bearer, 'POST', `/v1/definitions/releases/${before.digest}:activate`, {
          expected_head: current.head,
        })
      ).status,
    ).toBe(200);
  }
}, 120_000);

test('ordinary native deletion and the existing restore port retain selected fields', async () => {
  const cover = await f.importedCover();
  const row = await f.collection({ presentationKind: type, coverMediaId: cover.mediaId });
  const response = await f.send(f.owner.bearer, 'DELETE', `${path(row.id)}?revision=${row.revision}`);
  expect(response.status).toBe(204);
  const deletionId = response.headers.get('Library-Collection-Deletion-Id');
  expect(deletionId).toBeString();
  if (deletionId === null) throw new Error('Committed deletion lacks its exact episode ID');
  expect((await f.send(f.owner.bearer, 'GET', path(row.id))).status).toBe(404);
  const retained = (
    await f.database.admin.query(
      'SELECT presentation_kind,cover_media_id,revision,deleted_at,purge_after FROM library.collection WHERE route=$1 AND collection_id=$2',
      [routeOf(row.id), row.id],
    )
  ).rows[0];
  expect(retained).toMatchObject({ presentation_kind: type, cover_media_id: cover.mediaId });
  expect(new Date(retained.purge_after).getTime() - new Date(retained.deleted_at).getTime()).toBe(720 * 60 * 60 * 1000);
  // Exercise the existing retention store port, not an invented public restore endpoint.
  const restored = await restoreCollection(f.database.admin, routeOf(row.id)!, row.id, retained.revision, deletionId, {
    transactionId: randomUUID(),
    time: new Date().toISOString(),
  });
  expect(restored).toMatchObject({ presentationKind: type, coverMediaId: cover.mediaId, state: 'active' });
  expect(await read(row.id)).toMatchObject({
    presentationKind: type,
    coverSource: 'owner',
    coverMediaId: cover.mediaId,
  });
}, 120_000);

test('current role revocation and suspension fence old receipts before replay', async () => {
  const cover = await f.importedCover();
  const row = await f.collection({ presentationKind: type, coverMediaId: cover.mediaId, visibility: 'public' });
  const key = randomUUID();
  const body = { revision: row.revision, presentationKind: null };
  await value(await f.send(f.owner.bearer, 'PATCH', path(row.id), body, key));
  const role = (
    await f.database.admin.query<{ valid: string }>(
      'SELECT valid::text FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND grant_role=$4',
      [routeOf(row.id), row.id, f.owner.accountId, 'library.collection.owner'],
    )
  ).rows[0]!;
  expect(role).toBeDefined();
  const revoke = await f.send(f.manager.bearer, 'POST', '/v1/roleGrants:revoke', {
    resource: { route: routeOf(row.id), id: row.id },
    subject: { kind: 'account', id: f.owner.accountId },
    role: 'library.collection.owner',
    valid: role.valid,
  });
  expect(revoke.status).toBe(200);
  expect((await f.send(f.owner.bearer, 'PATCH', path(row.id), body, key)).status).toBe(404);
  expect(await read(row.id)).not.toHaveProperty('coverMediaId');
  const suspended = await f.collection();
  const suspension = await f.send(f.manager.bearer, 'POST', `/v1/accounts/${f.owner.accountId}:suspend`, {
    reason: 'Native current-account fence',
  });
  expect(suspension.status).toBe(200);
  expect([401, 404]).toContain(
    (
      await f.send(f.owner.bearer, 'PATCH', path(suspended.id), {
        revision: suspended.revision,
        presentationKind: type,
      })
    ).status,
  );
  expect([401, 404]).toContain((await f.send(f.owner.bearer, 'GET', path(suspended.id))).status);
}, 120_000);
