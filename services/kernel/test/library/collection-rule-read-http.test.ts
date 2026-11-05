import { afterAll, beforeAll, expect, test } from 'bun:test';
import { activeRelease } from '../../src/semantic/definitions.ts';
import { builtinCollectionId } from '../../src/library/builtin-identity.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createCollectionRulesFixture, type CollectionRulesFixture } from './support/collection-rules-fixture.ts';

let f: CollectionRulesFixture;
beforeAll(async () => {
  f = await createCollectionRulesFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
});

/** Seed an already stored definition without pretending that the unavailable execution producer admitted a create. */
async function stored(filter: unknown) {
  const response = await f.send('POST', '/v1/collections', {
    title: 'Private saved definition',
    visibility: 'private',
  });
  expect(response.status).toBe(201);
  const { collection } = await response.json();
  const release = await activeRelease(f.runtime.database.pool);
  if (!release) throw new Error('Native release required');
  await f.runtime.database.pool.query(
    `UPDATE library.collection SET membership_kind='dynamic', rule_filter=$3::jsonb, rule_sort='id', rule_source='owner',
      rule_release_digest=$4, rule_revision=1 WHERE route=$1 AND collection_id=$2`,
    [routeOf(collection.id), collection.id, JSON.stringify(filter), release.digest],
  );
  return { id: collection.id as string, digest: release.digest };
}

test('private definition GET retains stored meaning and release without new admission or public DTO criteria', async () => {
  const filter = { and: [{ owner: { presence: true } }, { not: { type: { in: ['retired:Meaning'] } } }] };
  const saved = await stored(filter);
  const response = await f.send('GET', `/v1/collections/${saved.id}/rule`);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toMatchObject({
    rule: { filter, sort: 'id', revision: 1, collectionRevision: 1, releaseDigest: saved.digest },
  });
  const metadata = await f.send('GET', `/v1/collections/${saved.id}`);
  expect(metadata.status).toBe(200);
  const body = await metadata.json();
  for (const key of ['filter', 'rule', 'releaseDigest', 'sourceGeneration'])
    expect(body.collection).not.toHaveProperty(key);
}, 120_000);

test('GET admits every private leaf even in a true OR, and conceals foreign, absent, curated and builtin rules', async () => {
  const saved = await stored({ or: [{ type: { in: ['schema:Book'] } }, { owner: { presence: true } }] });
  const path = `/v1/collections/${saved.id}/rule`;
  expect((await f.send('GET', path, undefined, f.reduced)).status).toBe(403);
  for (const bearer of [f.other, f.manager.bearer]) {
    const response = await f.send('GET', path, undefined, bearer);
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain('presence');
  }
  expect((await f.send('GET', path, undefined, null)).status).toBe(401);
  const curated = await f.send('POST', '/v1/collections', { title: 'Curated', visibility: 'private' });
  const { collection } = await curated.json();
  for (const id of [
    collection.id,
    newId(routeOf(saved.id)!),
    builtinCollectionId(f.runtime.identity.ordinary.accountId, { kind: 'everything' }),
  ])
    expect((await f.send('GET', `/v1/collections/${id}/rule`)).status).toBe(404);
}, 120_000);

test('admitted private definition creation is independent of result readiness and retains native grammar admission', async () => {
  const base = { membershipKind: 'dynamic', title: 'Draft', visibility: 'private' };
  const created = await f.send('POST', '/v1/collections', {
    ...base,
    rule: { filter: { owner: { presence: true } }, sort: 'id' },
  });
  expect(created.status).toBe(201);
  const { collection } = await created.json();
  expect(collection).toMatchObject({
    membershipKind: 'dynamic',
    title: base.title,
    visibility: 'private',
    curatorAccountId: f.runtime.identity.ordinary.accountId,
    revision: 1,
  });
  expect(routeOf(collection.id)).toBe(routeOf(f.runtime.identity.ordinary.accountId));
  for (const field of [
    'filter',
    'rule',
    'pins',
    'releaseDigest',
    'sourceGeneration',
    'memberCount',
    'orderEpoch',
    'createdAt',
    'updatedAt',
    'builtinKind',
  ])
    expect(collection).not.toHaveProperty(field);
  const invalid = await f.send('POST', '/v1/collections', {
    ...base,
    rule: { filter: { not: { owner: { unknown: true } } } },
  });
  expect(invalid.status).toBe(400);
  const ordinal = await f.send('POST', '/v1/collections', {
    ...base,
    rule: { filter: { owner: { presence: true } }, sort: 'ordinal' },
  });
  expect(ordinal.status).toBe(422);
}, 120_000);

test('a bearer issued before native suspension cannot disclose saved criteria', async () => {
  const saved = await stored({ owner: { presence: true } });
  expect(
    (
      await f.send(
        'POST',
        `/v1/accounts/${f.runtime.identity.ordinary.accountId}:suspend`,
        { reason: 'Current private definition read' },
        f.manager.bearer,
      )
    ).status,
  ).toBe(200);
  const denied = await f.send('GET', `/v1/collections/${saved.id}/rule`);
  expect(denied.status).toBe(401);
  expect(await denied.json()).toMatchObject({ code: 'invalid_credentials' });
}, 120_000);
