import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readPublicCollectionDiscoverySummaries as hydrate } from '../../src/library/collection-discovery-summaries.ts';
import { readFollowDiscovery } from '../../src/library/follow-discovery.ts';
import { createCollectionPublicationEpisodes } from '../../src/library/collection-publication-episodes.ts';
import { routeOf, partitionOf } from '../../src/route/route.ts';
import {
  createCollectionRulesFixture,
  type CollectionRulesFixture,
} from '../library/support/collection-rules-fixture.ts';

let f: CollectionRulesFixture;
beforeAll(async () => {
  f = await createCollectionRulesFixture(['follow:read', 'follow:create', 'follow:delete']);
}, 120000);
afterAll(async () => {
  await f?.close();
});
const dependencies = () => ({
  pool: f.database.pool,
  access: f.runtime.identity.access,
  routeKey: f.runtime.identity.routeKey,
});
async function cards(id: string, native = true) {
  const deps = dependencies();
  return hydrate(native ? deps : { pool: deps.pool, access: deps.access }, [id], {
    actor: { kind: 'anonymous' },
    partition: partitionOf(routeOf(id)!),
    deadline: Date.now() + 120000,
    languages: ['en'],
  });
}
async function card(id: string) {
  const result = await cards(id);
  if (result.state !== 'ready' || !result.summaries[0]) throw new Error('Expected current public card');
  return result.summaries[0];
}

test('public curator and bounded ordered occurrences stay separate from account-home following and native writes', async () => {
  const collection = await f.collection({ visibility: 'public', title: 'Native selection' });
  const subjects = await Promise.all(['First', 'Second', 'Third', 'Fourth'].map((label) => f.subject(label)));
  for (const subjectId of subjects)
    expect((await f.send('POST', `/v1/collections/${collection.id}/members`, { subjectId })).status).toBe(201);
  const current = await card(collection.id);
  expect(current).toMatchObject({
    membershipKind: 'curated',
    memberCount: 4,
    presentationKind: null,
    presentationKindSource: 'mixed',
    curator: { state: 'available', id: f.runtime.identity.ordinary.accountId },
    preview: { state: 'available', partial: false, truncated: true },
  });
  if (current.preview.state !== 'available') throw new Error('Expected preview');
  expect(current.preview.members.map((member) => member.subject.id)).toEqual(subjects.slice(0, 3));
  expect(current.preview.members.every((member) => member.subject.type === 'schema:Book')).toBe(true);
  expect(current).not.toHaveProperty('following');
  const baseAccess = f.runtime.identity.access;
  const hidden = new Set(subjects.slice(1));
  const access = {
    ...baseAccess,
    authorize: ((client, actor, action, resource, ...rest) =>
      hidden.has(resource.id)
        ? Promise.resolve(false)
        : baseAccess.authorize(client, actor, action, resource, ...rest)) satisfies typeof baseAccess.authorize,
  };
  const preview = () =>
    hydrate({ ...dependencies(), access }, [collection.id], {
      actor: { kind: 'anonymous' },
      partition: partitionOf(routeOf(collection.id)!),
      deadline: Date.now() + 30000,
    });
  expect(await preview()).toMatchObject({
    summaries: [
      {
        memberCount: 4,
        preview: { state: 'available', members: [{ subject: { id: subjects[0] } }], partial: true, truncated: true },
      },
    ],
  });
  hidden.add(subjects[0]!);
  expect(await preview()).toMatchObject({ summaries: [{ memberCount: 4, preview: { state: 'withheld' } }] });
  const actor = await f.runtime.identity.access.authenticate(f.owner, {
    pool: f.database.pool,
    deadline: Date.now() + 30000,
  });
  const targets = [{ targetId: collection.id, targetType: 'collection' as const, source: current.sourceGeneration }];
  const follows = () => readFollowDiscovery(dependencies(), actor, targets, Date.now() + 30000);
  expect(await follows()).toMatchObject({
    state: 'current',
    accountId: f.runtime.identity.ordinary.accountId,
    partition: partitionOf(routeOf(f.runtime.identity.ordinary.accountId)!),
    rows: [{ following: false, actions: { follow: true, unfollow: true } }],
  });
  const key = randomUUID();
  for (let replay = 0; replay < 2; replay++)
    expect((await f.send('PUT', `/v1/follows/${collection.id}`, undefined, f.owner, key)).status).toBe(200);
  expect(await follows()).toMatchObject({ rows: [{ following: true }] });
  expect((await f.send('DELETE', `/v1/follows/${collection.id}`)).status).toBe(200);
  expect(await follows()).toMatchObject({ rows: [{ following: false }] });
  expect(await cards(collection.id)).not.toHaveProperty('collectionFollows');
  expect(await readFollowDiscovery(dependencies(), { kind: 'anonymous' }, targets, Date.now() + 30000)).toEqual({
    state: 'signed-out',
  });
  expect(
    await readFollowDiscovery(
      dependencies(),
      actor.kind === 'account' ? { ...actor, scopes: ['follow:read'] } : actor,
      targets,
      Date.now() + 30000,
    ),
  ).toMatchObject({ rows: [{ following: false, actions: { follow: false, unfollow: false } }] });
}, 120000);

test('empty, unavailable projection, retained de-identification and changed source have honest outcomes', async () => {
  const collection = await f.collection({ visibility: 'public' });
  expect(await card(collection.id)).toMatchObject({ preview: { state: 'empty' }, curator: { state: 'available' } });
  expect(await cards(collection.id, false)).toMatchObject({
    summaries: [{ preview: { state: 'unavailable' }, curator: { state: 'unavailable', reason: 'native_projection' } }],
  });
  await f.database.admin.query(
    'UPDATE library.collection SET curator_account_id=NULL WHERE route=$1 AND collection_id=$2',
    [routeOf(collection.id), collection.id],
  );
  expect(await card(collection.id)).toMatchObject({
    curator: { state: 'unavailable', reason: 'deidentified' },
    preview: { state: 'empty' },
  });
  const base = f.runtime.identity.access;
  let rounds = 0;
  const access = {
    ...base,
    async prepareReadDecisions(input: Parameters<NonNullable<typeof base.prepareReadDecisions>>[0]) {
      if (++rounds === 2)
        await f.database.admin.query(
          'UPDATE library.collection SET revision=revision+1 WHERE route=$1 AND collection_id=$2',
          [routeOf(collection.id), collection.id],
        );
      return base.prepareReadDecisions!(input);
    },
  };
  expect(
    await hydrate({ ...dependencies(), access }, [collection.id], {
      actor: { kind: 'anonymous' },
      partition: partitionOf(routeOf(collection.id)!),
      deadline: Date.now() + 30000,
    }),
  ).toEqual({ state: 'unavailable', reason: 'changed' });
}, 120000);

test('dynamic context uses only the admitted published output and never exposes the saved rule', async () => {
  const subjects = await Promise.all(['Selected A', 'Selected B'].map((title) => f.subject(title)));
  for (const id of subjects) await f.entry(id);
  const response = await f.send('POST', '/v1/collections', {
    title: 'Published selection',
    visibility: 'private',
    membershipKind: 'dynamic',
    rule: { filter: { owner: { presence: true } }, sort: 'id' },
  });
  expect(response.status).toBe(201);
  const { collection } = await response.json();
  const publication = await f.send('POST', `/v1/collections/${collection.id}:publishSelected`, {
    revision: collection.revision,
    subjectIds: subjects,
  });
  expect(publication.status).toBe(200);
  const published = await publication.json();
  const actor = await f.runtime.identity.access.authenticate(f.owner, {
    pool: f.database.pool,
    deadline: Date.now() + 30000,
  });
  await createCollectionPublicationEpisodes(dependencies()).begin(
    actor,
    { collectionId: collection.id, revision: published.collection.revision, visibility: 'public' },
    randomUUID(),
  );
  const current = await card(collection.id);
  expect(current).toMatchObject({
    membershipKind: 'dynamic',
    outputGeneration: published.publication.generation,
    preview: { state: 'available', partial: false, truncated: false },
  });
  if (current.preview.state !== 'available') throw new Error('Expected published preview');
  expect(current.preview.members.map((member) => member.subject.id)).toEqual([...subjects].sort());
  for (const field of ['rule', 'filter', 'memberCount', 'orderEpoch']) expect(current).not.toHaveProperty(field);
}, 120000);
