import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFollowDiscovery } from '../../src/library/follow-discovery.ts';
import { routeOf } from '../../src/route/route.ts';
import { createCollectionRulesFixture, type CollectionRulesFixture } from './support/collection-rules-fixture.ts';

let f: CollectionRulesFixture;
beforeAll(async () => {
  f = await createCollectionRulesFixture(['follow:create', 'follow:delete']);
}, 120000);
afterAll(async () => {
  await f?.close();
});

test('private preparation rejects changed edges, respects withdrawn write scopes and fences retired authority', async () => {
  const collection = await f.collection({ visibility: 'public' });
  const actor = await f.runtime.identity.access.authenticate(f.owner, {
    pool: f.database.pool,
    deadline: Date.now() + 30000,
  });
  const base = f.runtime.identity.access;
  const dependencies = { pool: f.database.pool, access: base };
  const targets = [{ targetId: collection.id, targetType: 'collection' as const, source: 'native-source' }];
  let preparations = 0;
  const changing = {
    ...base,
    async prepare(...args: Parameters<NonNullable<typeof base.prepare>>) {
      if (args[1] === 'follow:create' && ++preparations === 2)
        expect((await f.send('PUT', `/v1/follows/${collection.id}`)).status).toBe(200);
      return base.prepare?.(...args);
    },
  };
  expect(await readFollowDiscovery({ ...dependencies, access: changing }, actor, targets, Date.now() + 30000)).toEqual({
    state: 'unavailable',
    reason: 'changed',
  });
  expect(
    await readFollowDiscovery(
      dependencies,
      actor.kind === 'account' ? { ...actor, scopes: [] } : actor,
      targets,
      Date.now() + 30000,
    ),
  ).toMatchObject({ state: 'current', rows: [{ following: true, actions: { follow: false, unfollow: false } }] });
  await f.database.admin.query('UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2', [
    routeOf(actor.accountId),
    actor.accountId,
  ]);
  expect(await readFollowDiscovery(dependencies, actor, targets, Date.now() + 30000)).toEqual({
    state: 'unavailable',
    reason: 'identity',
  });
  expect(await readFollowDiscovery(dependencies, { kind: 'anonymous' }, targets, Date.now() + 30000)).toEqual({
    state: 'signed-out',
  });
  await expect(readFollowDiscovery(dependencies, actor, [...targets, ...targets], Date.now() + 30000)).rejects.toThrow(
    'Invalid bounded follow discovery targets',
  );
}, 120000);
