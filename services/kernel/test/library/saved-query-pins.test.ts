import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { activeRelease } from '../../src/semantic/definitions.ts';
import { createCollectionRulesFixture, type CollectionRulesFixture } from './support/collection-rules-fixture.ts';

let f: CollectionRulesFixture;
beforeAll(async () => { f = await createCollectionRulesFixture(); }, 120_000);
afterAll(async () => { await f?.close(); });

test('saved meaning survives activation and metadata edits; explicit edits fence cursors, CAS and retries', async () => {
  const a = await activeRelease(f.runtime.database.pool);
  if (!a) throw new Error('Native Definitions release required');
  const ids = [await f.subject('Pinned first book'), await f.subject('Pinned second book')];
  for (const id of ids) await f.entry(id);
  const presence = { owner: { presence: true } };
  const filter = { and: [presence, { saved: 'book/all' }] };
  const created = await f.send('POST', '/v1/collections', {
    membershipKind: 'dynamic', title: 'Accepted books', visibility: 'private', rule: { filter },
  });
  expect(created.status).toBe(201);
  const { collection } = await created.json();
  const path = `/v1/collections/${collection.id}`;
  const readRule = async () => {
    const response = await f.send('GET', `${path}/rule`);
    expect(response.status).toBe(200);
    return (await response.json()).rule;
  };
  const original = await readRule();
  expect(original).toMatchObject({ revision: 1, collectionRevision: 1, releaseDigest: a.digest });
  expect((await f.page(collection.id)).members.map((row: { subjectId: string }) => row.subjectId).sort()).toEqual(ids.sort());
  const first = await f.send('GET', `${path}/members?limit=1`);
  expect(first.status).toBe(200);
  const cursor = (await first.json()).next;
  expect(cursor).toBeString();

  // The same named filter now means television. The retained expanded Book AST still means books.
  const release = { ...structuredClone(a.release), filters: { ...a.release.filters,
    'book/all': { ...a.release.filters!['book/all']!, filter: { type: { in: ['schema:TVSeries'] } } },
  } };
  const published = await f.send('POST', '/v1/definitions/releases', { release }, f.manager.bearer);
  expect(published.status).toBe(201);
  const b = (await published.json()).digest;
  expect((await f.send('POST', `/v1/definitions/releases/${b}:activate`, { expected_head: a.head }, f.manager.bearer)).status).toBe(200);
  expect(await readRule()).toEqual(original);
  expect((await f.page(collection.id)).members).toHaveLength(2);
  expect((await f.send('PATCH', path, { revision: 1, title: 'Renamed books' })).status).toBe(200);
  expect(await readRule()).toEqual({ ...original, collectionRevision: 2 });
  expect((await f.page(collection.id)).members).toHaveLength(2);

  const key = randomUUID();
  const input = { revision: 2, filter };
  const changed = await f.send('PUT', `${path}/rule`, input, f.owner, key);
  expect(changed.status).toBe(200);
  const effect = await changed.json();
  const edited = await readRule();
  expect(edited).toMatchObject({ revision: 2, collectionRevision: 3, releaseDigest: b,
    sourceGeneration: String(BigInt(original.sourceGeneration) + 1n),
    filter: { and: [presence, { type: { in: ['schema:TVSeries'] } }] },
  });
  expect((await f.page(collection.id)).members).toEqual([]);
  const stale = await f.send('GET', `${path}/members?limit=1&cursor=${encodeURIComponent(cursor)}`);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: 'stale_cursor' });
  for (const excluded of ['library_entry:read', 'progress_session:read', 'copy:read']) {
    const bearer = await f.credential('ordinary', [
      'collection:read', 'collection:update', 'library_entry:read', 'progress_session:read', 'copy:read',
    ].filter((scope) => scope !== excluded));
    expect((await f.send('PUT', `${path}/rule`, input, bearer, key)).status).toBe(403);
  }
  const newer = await f.send('PUT', `${path}/rule`, { revision: 3, filter: presence });
  expect(newer.status).toBe(200);
  const latest = await readRule();
  expect(latest).toMatchObject({ revision: 3, collectionRevision: 4,
    sourceGeneration: String(BigInt(original.sourceGeneration) + 2n),
  });
  const retry = await f.send('PUT', `${path}/rule`, input, f.owner, key);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual(effect);
  expect((await f.send('PUT', `${path}/rule`, input)).status).toBe(409);
  expect((await f.send('PUT', `${path}/rule`, { revision: 3, filter: presence }, f.owner, key)).status).toBe(422);
  expect(await readRule()).toEqual(latest);
}, 180_000);
