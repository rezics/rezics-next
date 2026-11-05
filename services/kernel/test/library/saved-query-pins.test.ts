import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createCollectionRulesFixture, type CollectionRulesFixture } from './support/collection-rules-fixture.ts';

let f: CollectionRulesFixture;
beforeAll(async () => {
  f = await createCollectionRulesFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
});

async function json(response: Response, status = 200) {
  expect(response.status).toBe(status);
  return response.json();
}

test('saved meaning survives activation and metadata edits; explicit edits fence cursors, CAS and retries', async () => {
  const { activeRelease } = await import('../../src/semantic/definitions.ts');
  const a = await activeRelease(f.runtime.database.pool);
  if (!a) throw new Error('Native Definitions release required');
  const ids = [await f.subject('Pinned first book'), await f.subject('Pinned second book')];
  for (const id of ids) await f.entry(id);
  const presence = { owner: { presence: true } };
  const filter = { and: [presence, { saved: 'book/all' }] };
  const created = await f.send('POST', '/v1/collections', {
    membershipKind: 'dynamic',
    title: 'Accepted books',
    visibility: 'private',
    rule: { filter },
  });
  expect(created.status).toBe(201);
  const { collection } = await created.json();
  const path = `/v1/collections/${collection.id}`;
  const readRule = async () => (await json(await f.send('GET', `${path}/rule`))).rule;
  const original = await readRule();
  expect(original).toMatchObject({ revision: 1, collectionRevision: 1, releaseDigest: a.digest });
  expect((await f.page(collection.id)).members.map((row: { subjectId: string }) => row.subjectId).sort()).toEqual(
    ids.sort(),
  );
  const { next: cursor } = await json(await f.send('GET', `${path}/members?limit=1`));
  expect(cursor).toBeString();

  // The same named filter now means television. The retained expanded Book AST still means books.
  const release = {
    ...structuredClone(a.release),
    filters: {
      ...a.release.filters,
      'book/all': { ...a.release.filters!['book/all']!, filter: { type: { in: ['schema:TVSeries'] } } },
    },
  };
  const { digest: b } = await json(
    await f.send('POST', '/v1/definitions/releases', { release }, f.manager.bearer),
    201,
  );
  expect(
    (await f.send('POST', `/v1/definitions/releases/${b}:activate`, { expected_head: a.head }, f.manager.bearer))
      .status,
  ).toBe(200);
  expect(await readRule()).toEqual(original);
  expect((await f.page(collection.id)).members).toHaveLength(2);
  expect((await f.send('PATCH', path, { revision: 1, title: 'Renamed books' })).status).toBe(200);
  expect(await readRule()).toEqual({ ...original, collectionRevision: 2 });
  expect((await f.page(collection.id)).members).toHaveLength(2);

  const key = randomUUID();
  const input = { revision: 2, filter };
  const effect = await json(await f.send('PUT', `${path}/rule`, input, f.owner, key));
  const edited = await readRule();
  expect(edited).toMatchObject({
    revision: 2,
    collectionRevision: 3,
    releaseDigest: b,
    sourceGeneration: String(BigInt(original.sourceGeneration) + 1n),
    filter: { and: [presence, { type: { in: ['schema:TVSeries'] } }] },
  });
  expect((await f.page(collection.id)).members).toEqual([]);
  const stale = await f.send('GET', `${path}/members?limit=1&cursor=${encodeURIComponent(cursor)}`);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: 'stale_cursor' });
  const families = ['library_entry:read', 'progress_session:read', 'copy:read'];
  for (const excluded of families) {
    const scopes = ['collection:read', 'collection:update', ...families.filter((scope) => scope !== excluded)];
    const bearer = await f.credential('ordinary', scopes);
    expect((await f.send('PUT', `${path}/rule`, input, bearer, key)).status).toBe(403);
  }
  await json(await f.send('PUT', `${path}/rule`, { revision: 3, filter: presence }));
  const latest = await readRule();
  expect(latest).toMatchObject({
    revision: 3,
    collectionRevision: 4,
    sourceGeneration: String(BigInt(original.sourceGeneration) + 2n),
  });
  expect(await json(await f.send('PUT', `${path}/rule`, input, f.owner, key))).toEqual(effect);
  expect((await f.send('PUT', `${path}/rule`, input)).status).toBe(409);
  expect((await f.send('PUT', `${path}/rule`, { revision: 3, filter: presence }, f.owner, key)).status).toBe(422);
  expect(await readRule()).toEqual(latest);
}, 180_000);
