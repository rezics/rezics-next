import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { authoritativeTimeValue, mintReadTime, releaseOperationalTime, type AuthoritativeTime } from '../../src/command/command.ts';
import { withConnection } from '../../src/database/pool.ts';
import { readPublicCollectionDiscoverySummaries as hydrate } from '../../src/library/collection-discovery-summaries.ts';
import { createCollectionPublicationEpisodes } from '../../src/library/collection-publication-episodes.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { Access, Actor } from '../../src/request/access.ts';
import { createCollectionRulesFixture, type CollectionRulesFixture } from './support/collection-rules-fixture.ts';

let f: CollectionRulesFixture;
let actor: Actor;
beforeAll(async () => {
  f = await createCollectionRulesFixture();
  actor = await f.runtime.identity.access.authenticate(f.owner, { pool: f.database.pool, deadline: Date.now() + 30000 });
}, 120000);
afterAll(async () => { await f?.close(); });
const context = (id: string, viewer: Actor = { kind: 'anonymous' }) => ({
  actor: viewer, partition: partitionOf(routeOf(id)!), deadline: Date.now() + 120000,
});
const deps = (access = f.runtime.identity.access) => ({ pool: f.database.pool, access });
async function saved() {
  const response = await f.send('POST', '/v1/collections', {
    title: 'Public selection', visibility: 'private', membershipKind: 'dynamic',
    rule: { filter: { owner: { presence: true } }, sort: 'id' },
  });
  expect(response.status).toBe(201);
  return (await response.json()).collection as { id: string; revision: number };
}
async function published() {
  const collection = await saved();
  const response = await f.send('POST', `/v1/collections/${collection.id}:publishSelected`, {
    revision: collection.revision, subjectIds: [],
  });
  expect(response.status).toBe(200);
  return await response.json();
}
function betweenRounds(change: () => Promise<void>): Access {
  const base = f.runtime.identity.access;
  let rounds = 0;
  return { ...base, async prepareReadDecisions(input) {
    if (++rounds === 2) await change();
    return base.prepareReadDecisions!(input);
  } };
}

test('current curated metadata, full identity and destination; hidden, removed and missing keys are omitted', async () => {
  const visible = await f.collection({ visibility: 'public', title: 'Original' });
  const privateRow = await f.collection();
  const unlisted = await f.collection({ visibility: 'unlisted' });
  const removed = await f.collection({ visibility: 'public' });
  expect((await f.send('DELETE', `/v1/collections/${removed.id}?revision=${removed.revision}`)).status).toBe(204);
  expect((await f.send('PATCH', `/v1/collections/${visible.id}`, { revision: visible.revision, title: 'Current title' })).status).toBe(200);
  const ids = [visible.id, privateRow.id, unlisted.id, removed.id, newId(routeOf(visible.id)!), visible.id];
  const result = await hydrate(deps(), ids, context(visible.id, actor));
  expect(result).toMatchObject({ state: 'ready', summaries: [{
    kind: 'collection', id: visible.id, destination: `/collections/${visible.id}`,
    membershipKind: 'curated', title: 'Current title', revision: visible.revision + 1, memberCount: 0,
  }] });
  if (result.state !== 'ready') throw new Error('Native curated discovery must be ready');
  expect(result.summaries).toHaveLength(1);
  for (const key of ['curatorAccountId', 'coverMediaId', 'rule', 'filter', 'pins', 'builtin'])
    expect(result.summaries[0]).not.toHaveProperty(key);
}, 120000);

test('completed A remains selected while a real whole-query B is pending; dynamic cards contain no private/count fields', async () => {
  const a = await published();
  const command = await createCollectionPublicationEpisodes(deps()).begin(actor, {
    collectionId: a.collection.id, revision: a.collection.revision, visibility: 'public',
  }, randomUUID());
  expect(command.value.locator).toBeDefined();
  const result = await hydrate(deps(), [a.collection.id], context(a.collection.id));
  expect(result).toMatchObject({ state: 'ready', summaries: [{
    id: a.collection.id, membershipKind: 'dynamic', outputGeneration: a.publication.generation,
  }] });
  if (result.state !== 'ready') throw new Error('Completed native A must remain readable');
  for (const key of ['curatorAccountId', 'memberCount', 'createdAt', 'updatedAt', 'orderEpoch', 'rule', 'filter', 'workingOutput'])
    expect(result.summaries[0]).not.toHaveProperty(key);
}, 120000);

test('unknown native output authority is unavailable, never a fabricated ready-empty output', async () => {
  const row = await saved();
  expect((await f.send('PATCH', `/v1/collections/${row.id}`, { revision: row.revision, visibility: 'public' })).status).toBe(200);
  expect(await hydrate(deps(), [row.id], context(row.id))).toEqual({ state: 'unavailable', reason: 'native_authority' });
}, 120000);

test('withdrawal, removal and native revision changes between admission and disclosure win', async () => {
  for (const change of ['private', 'deleted', 'title'] as const) {
    const row = await f.collection({ visibility: 'public' });
    const access = betweenRounds(async () => {
      const response = change === 'deleted'
        ? await f.send('DELETE', `/v1/collections/${row.id}?revision=${row.revision}`)
        : await f.send('PATCH', `/v1/collections/${row.id}`, {
          revision: row.revision, ...(change === 'private' ? { visibility: 'private' } : { title: 'Changed' }),
        });
      expect(response.status).toBe(change === 'deleted' ? 204 : 200);
    });
    expect(await hydrate(deps(access), [row.id], context(row.id))).toEqual(change === 'title'
      ? { state: 'unavailable', reason: 'changed' } : { state: 'ready', summaries: [] });
  }
}, 120000);

test('Access scope denial and a terminal curator fence never disclose a public card', async () => {
  const row = await f.collection({ visibility: 'public' });
  const bearer = await f.credential('ordinary', ['subject:read']);
  const denied = await f.runtime.identity.access.authenticate(bearer, { pool: f.database.pool, deadline: Date.now() + 30000 });
  expect(await hydrate(deps(), [row.id], context(row.id, denied))).toEqual({ state: 'ready', summaries: [] });
  const access = betweenRounds(async () => {
    // Negative terminal evidence only; no retained output or positive authority is fabricated.
    await f.database.admin.query('UPDATE access.account SET state=\'deleted\' WHERE route=$1 AND account_id=$2',
      [routeOf(f.runtime.identity.ordinary.accountId), f.runtime.identity.ordinary.accountId]);
  });
  try {
    expect(await hydrate(deps(access), [row.id], context(row.id))).toEqual({ state: 'unavailable', reason: 'native_authority' });
  } finally {
    await f.database.admin.query('UPDATE access.account SET state=\'active\' WHERE route=$1 AND account_id=$2',
      [routeOf(f.runtime.identity.ordinary.accountId), f.runtime.identity.ordinary.accountId]);
  }
}, 120000);

test('validation precedes native I/O, including full-key partition bounds and the duplicate-inclusive limit', async () => {
  const id = newId(0x0123);
  const unavailablePool = { connect() { throw new Error('Unexpected native read'); } } as unknown as typeof f.database.pool;
  const dependencies = { ...deps(), pool: unavailablePool };
  for (const ids of [['bad-key'], [newId(0x0130)], Array(101).fill(id)])
    await expect(hydrate(dependencies, ids, context(id))).rejects.toBeInstanceOf(RangeError);
  expect(await hydrate(dependencies, [], context(id))).toEqual({ state: 'ready', summaries: [] });
});

test('read times are released by their owner and unrelated native infrastructure failures propagate', async () => {
  const row = await f.collection({ visibility: 'public' });
  const base = f.runtime.identity.access;
  const captured: AuthoritativeTime[] = [];
  const access: Access = { ...base, async prepareReadDecisions(input) {
    const native = await base.prepareReadDecisions!(input);
    return { ...native, async decide(client, batch, time) {
      captured.push(time!);
      return native.decide(client, batch, time);
    } };
  } };
  expect((await hydrate(deps(access), [row.id], context(row.id))).state).toBe('ready');
  expect(captured).toHaveLength(2);
  for (const time of captured) expect(() => authoritativeTimeValue(time)).toThrow();
  const time = await withConnection(f.database.pool, (client) => mintReadTime(client));
  try {
    expect((await hydrate(deps(access), [row.id], { ...context(row.id), time })).state).toBe('ready');
    expect(authoritativeTimeValue(time)).toBeString();
  } finally { releaseOperationalTime(time); }
  const failure = new Error('Native owner checkout failed');
  const broken = { connect: async () => { throw failure; } } as unknown as typeof f.database.pool;
  await expect(hydrate({ ...deps(), pool: broken }, [row.id], context(row.id))).rejects.toBe(failure);
}, 120000);
