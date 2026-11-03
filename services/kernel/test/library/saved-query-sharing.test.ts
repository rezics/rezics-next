import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { newId, routeOf } from '../../src/route/route.ts';
import { createCollectionRulesFixture, type CollectionRulesFixture } from './support/collection-rules-fixture.ts';

let f: CollectionRulesFixture;
const draft = (visibility = 'private') => ({
  membershipKind: 'dynamic',
  title: 'Shared saved books',
  visibility,
  rule: { filter: { owner: { presence: true } } },
});
beforeAll(async () => {
  f = await createCollectionRulesFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
});
const path = (id: string) => `/v1/collections/${id}`;
function privateFieldsAbsent(value: unknown) {
  expect(JSON.stringify(value)).not.toMatch(
    /"(?:rule|filter|pins|releaseDigest|state|progress|holding|memberCount|candidateCount|total)":/,
  );
}
async function members(id: string, bearer: string | null = f.owner) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await f.send('GET', `${path(id)}/members?view=FULL`, undefined, bearer);
    const body = await response.json();
    if (response.status === 200) {
      privateFieldsAbsent(body);
      return body;
    }
    expect([202, 503]).toContain(response.status);
    if (response.status === 202) expect(body).toEqual({ preparing: true });
    else expect(body).toMatchObject({ code: 'dependency_unavailable' });
    await Bun.sleep(10);
  }
  throw new Error('Native Publication did not produce complete shared members');
}

test('owner, another account and anonymous readers share only complete output with current subject access', async () => {
  const ids = [await f.subject('First published book'), await f.subject('Second published book')];
  for (const id of ids) await f.entry(id);
  const created = await f.send('POST', '/v1/collections', draft());
  expect(created.status).toBe(201);
  const privateCollection = (await created.json()).collection;
  for (const bearer of [f.other, null])
    for (const suffix of ['', '/members']) {
      const hidden = await f.send('GET', `${path(privateCollection.id)}${suffix}`, undefined, bearer);
      const unknown = await f.send('GET', `${path(newId(routeOf(privateCollection.id)!))}${suffix}`, undefined, bearer);
      expect(hidden.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect((await hidden.json()).code).toBe((await unknown.json()).code);
    }
  // Visibility alone is not a publication, including for the owner's ordinary shared read.
  expect((await f.send('PATCH', path(privateCollection.id), { revision: 1, visibility: 'public' })).status).toBe(200);
  for (const bearer of [f.owner, f.other, null]) {
    const response = await f.send('GET', `${path(privateCollection.id)}/members`, undefined, bearer);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'dependency_unavailable' });
  }
  const shared: string[] = [];
  for (const visibility of ['public', 'unlisted']) {
    const key = randomUUID(),
      input = draft(visibility);
    const [response, replay] = await Promise.all([
      f.send('POST', '/v1/collections', input, f.owner, key),
      f.send('POST', '/v1/collections', input, f.owner, key),
    ]);
    expect(response.status).toBe(201);
    const body = await response.json(),
      id = body.collection.id;
    privateFieldsAbsent(body);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(body);
    await members(id);
    shared.push(id);
    for (const bearer of [f.owner, f.other, null]) {
      const metadata = await f.send('GET', path(id), undefined, bearer);
      expect(metadata.status).toBe(200);
      privateFieldsAbsent(await metadata.json());
      expect(
        (await members(id, bearer)).members.map((member: { subjectId: string }) => member.subjectId).sort(),
      ).toEqual([...ids].sort());
      const listing = await f.send(
        'GET',
        `/v1/collections?curatorAccountId=${f.runtime.identity.ordinary.accountId}`,
        undefined,
        bearer,
      );
      expect(listing.status).toBe(200);
      const listed = (await listing.json()).collections;
      expect(listed.some((row: { id: string }) => row.id === id)).toBe(bearer === f.owner || visibility === 'public');
      privateFieldsAbsent(listed);
    }
  }
  const later = await f.subject('Private match after publication');
  await f.entry(later);
  expect(
    (await f.send('POST', `/v1/subjects/${ids[0]}:hide`, { reason: 'Current shared subject denial' }, f.manager.bearer))
      .status,
  ).toBe(200);
  for (const id of shared)
    for (const bearer of [f.owner, f.other, null])
      expect((await members(id, bearer)).members.map((member: { subjectId: string }) => member.subjectId)).toEqual([
        ids[1],
      ]);
}, 120_000);

test('failed non-private admission leaves no Collection, Publication operation or receipt', async () => {
  const owner = f.runtime.identity.ordinary.accountId;
  const snapshot = async () =>
    (
      await f.database.admin.query(
        `SELECT
    (SELECT count(*) FROM library.collection WHERE curator_account_id=$1) AS collections,
    (SELECT count(*) FROM library.collection_publication_operation WHERE owner_account_id=$1) AS operations,
    (SELECT count(*) FROM core.receipt WHERE principal_id=$1 AND command_kind='library.collection.publication.begin') AS receipts`,
        [owner],
      )
    ).rows;
  const before = await snapshot();
  const response = await f.send('POST', '/v1/collections', draft('public'), f.reduced);
  expect(response.status).toBe(403);
  expect(await snapshot()).toEqual(before);
}, 120_000);
