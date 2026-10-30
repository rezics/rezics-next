import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createCollectionRulesFixture } from './support/collection-rules-fixture.ts';

test('native Everything/state/Liked discovery remains immutable when saved rule editing is available', async () => {
  const f = await createCollectionRulesFixture();
  try {
    const subjectId = await f.subject('Builtin source remains independent of saved rules');
    await f.entry(subjectId);
    const path = `/v1/collections?curatorAccountId=${f.runtime.identity.ordinary.accountId}&limit=100`;
    const discovered = await f.send('GET', path);
    expect(discovered.status).toBe(200);
    const before = await discovered.json();
    expect(before.next).toBeNull();
    for (const kind of ['everything', 'state', 'liked']) {
      const builtins = before.collections.filter((value: { builtinKind?: string }) => value.builtinKind === kind);
      expect(builtins.length).toBeGreaterThan(0);
      for (const collection of builtins) {
        expect(collection.membershipKind).toBe('dynamic');
        expect(collection.revision).toBe(0);
        const edit = await f.send('PUT', `/v1/collections/${collection.id}/rule`, {
          revision: 0,
          filter: { not: { owner: { presence: true } } },
        });
        expect(edit.status).toBe(409);
        expect(await edit.json()).toMatchObject({ code: 'dynamic_membership_immutable' });
        const hidden = await f.send(
          'PUT',
          `/v1/collections/${collection.id}/rule`,
          {
            revision: 0,
            filter: { owner: { presence: true } },
          },
          f.other,
        );
        expect(hidden.status).toBe(404);
      }
    }
    const everything = before.collections.find((value: { builtinKind?: string }) => value.builtinKind === 'everything');
    expect((await f.page(everything.id)).members).toContainEqual({ kind: 'dynamic', subjectId });
    const after = await f.send('GET', path);
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual(before);
  } finally {
    await f.close();
  }
}, 120_000);

import type { HttpResponse } from '../../../../specs/semantic-driver.ts';
import { builtinCollectionId } from '../../src/library/builtin-identity.ts';
import { discoveryKey } from '../support/released-discovery.ts';
import { createReleasedLibraryPopulation, type ReleasedLibraryPopulation } from './support/released-library-population.ts';

let world: ReleasedLibraryPopulation;
beforeAll(async () => {
  world = await createReleasedLibraryPopulation();
  await world.base.setup.openFeatures(['personal_library', 'reading_progress']);
}, 180_000);
afterAll(async () => { await world?.close(); }, 180_000);

function status(response: HttpResponse, code = 200) {
  expect(response.status, JSON.stringify(response.body)).toBe(code);
}
function everything() {
  return builtinCollectionId(world.base.personas.alice.accountId, { kind: 'everything' });
}
async function page(id = everything(), query = 'limit=100') {
  const response = await world.request('alice', 'GET', `/v1/collections/${id}/members?${query}`);
  status(response);
  expect(response.headers.get('cache-control')).toContain('private');
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(Array.isArray(response.body.members)).toBe(true);
  const items = response.body.members as Record<string, unknown>[];
  for (const item of items) {
    expect(item.kind).toBe('dynamic');
    expect(typeof item.subjectId).toBe('string');
    for (const key of ['id', 'memberId', 'note', 'addedAt']) expect(item).not.toHaveProperty(key);
  }
  return { response, ids: items.map(item => String(item.subjectId)) };
}

test('empty owner discovers stable logical Everything without materialization', async () => {
  const account = world.base.personas.alice.accountId;
  const before = await world.base.inspect('SELECT count(*)::int AS n FROM library.collection WHERE curator_account_id=$1', [account]);
  const response = await world.request('alice', 'GET', `/v1/collections?curatorAccountId=${account}&limit=100`);
  status(response);
  const collections = response.body.collections as Record<string, unknown>[];
  const descriptor = collections.find(item => item.id === everything());
  expect(descriptor).toMatchObject({ membershipKind: 'dynamic', builtinKind: 'everything', visibility: 'private' });
  for (const key of ['memberCount', 'createdAt', 'updatedAt', 'orderEpoch']) expect(descriptor).not.toHaveProperty(key);
  const empty = await page();
  expect(empty.ids).toEqual([]);
  expect(empty.response.body.next).toBeNull();
  status(await world.request('alice', 'GET', `/v1/collections/${everything()}`));
  const after = await world.base.inspect('SELECT count(*)::int AS n FROM library.collection WHERE curator_account_id=$1', [account]);
  expect(after.rows).toEqual(before.rows);
});

test('native Everything is the exact independent entry label session and holding union', async () => {
  const state = await world.state();
  const labels = await world.labels();
  const sessions = await world.sessions();
  const holding = await world.holdings();
  await world.controls();
  const expected = [state.subject.id, labels.subject.id, labels.recipe.id,
    sessions.active.subject.id, sessions.history.subject.id, holding.subject.id].sort();
  const result = await page();
  expect(result.ids).toEqual(expected);
  expect(result.response.body.next).toBeNull();
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const part = await page(everything(), `limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    seen.push(...part.ids);
    cursor = part.response.body.next as string | null;
    if (cursor) expect(part.ids).toHaveLength(2);
    expect(seen.length).toBeLessThanOrEqual(expected.length);
  } while (cursor);
  expect(seen).toEqual(expected);
  const anonymous = await world.request('anonymous', 'GET', `/v1/collections/${everything()}/members`);
  status(anonymous, 404);
  status(await world.request('bob', 'GET', `/v1/collections/${everything()}/members`), 404);
}, 180_000);

test('state identities include supported siblings and membership uses the actual accepted state', async () => {
  const own = await world.state();
  const set = own.accepted.profile.entryStateSet!;
  const account = world.base.personas.alice.accountId;
  const response = await world.request('alice', 'GET', `/v1/collections?curatorAccountId=${account}&limit=100`);
  status(response);
  const collections = response.body.collections as Record<string, unknown>[];
  for (const state of set.states) {
    const id = builtinCollectionId(account, { kind: 'state', profileId: own.accepted.pin.profileId,
      stateSetId: set.id, stateId: state.id });
    expect(collections.find(item => item.id === id)).toMatchObject({ membershipKind: 'dynamic', builtinKind: 'state' });
    const result = await page(id);
    expect(result.ids).toEqual(state.id === own.entry.state ? [own.subject.id] : []);
  }
  status(await world.request('alice', 'POST', `/v1/collections/${everything()}/members`,
    { subjectId: own.subject.id }, discoveryKey()), 409);
});
