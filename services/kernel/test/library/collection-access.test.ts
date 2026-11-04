import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createListPresentationFixture, type ListPresentationFixture } from '../semantic/support/list-presentation-fixture.ts';
import { routeOf } from '../../src/route/route.ts';

let fixture: ListPresentationFixture;

beforeAll(async () => {
  fixture = await createListPresentationFixture({ poolMax: 1 });
  await fixture.checked('POST', '/v1/platform/exposure/collections:open', {}, 'operator');
}, 180_000);

afterAll(async () => {
  await fixture?.close();
}, 180_000);

async function collection(title: string, visibility: 'private' | 'unlisted' | 'public') {
  const created = await fixture.checked(
    'POST',
    '/v1/collections',
    { title, visibility },
    'editor',
  );
  return created.collection as { id: string };
}

test('native Collection reads keep public floors scopeless, private reads curator-only, and denial disclosure concealed', async () => {
  const privateCollection = await collection('Private policy core', 'private');
  const unlistedCollection = await collection('Unlisted policy core', 'unlisted');
  const publicCollection = await collection('Public policy core', 'public');

  expect((await fixture.call('GET', `/v1/collections/${privateCollection.id}`, undefined, 'editor')).status).toBe(200);
  expect((await fixture.call('GET', `/v1/collections/${privateCollection.id}`, undefined, 'reader')).status).toBe(404);
  expect((await fixture.call('GET', `/v1/collections/${privateCollection.id}`, undefined, 'anonymous')).status).toBe(404);
  expect((await fixture.call('GET', `/v1/collections/${unlistedCollection.id}`, undefined, 'anonymous')).status).toBe(200);
  const publicRead = await fixture.call('GET', `/v1/collections/${publicCollection.id}`, undefined, 'anonymous');
  expect(publicRead.status).toBe(200);
  expect(JSON.stringify(publicRead.body)).not.toContain('explanation');
});

test('Collection policy rechecks a prepared grant and rejects a forged preparation object', async () => {
  const privateCollection = await collection('Prepared Collection policy', 'private');
  const { access, actor, deadline, pool } = await fixture.deps('editor');
  const resource = { route: routeOf(privateCollection.id)!, id: privateCollection.id };
  const page = { route: resource.route, resourceType: 'library.collection', ids: [privateCollection.id] };
  const evidence = await access.prepare!(actor, 'collection:read', resource, { pool, deadline });
  const pageEvidence = await access.preparePage!(actor, 'collection:read', page, { pool, deadline });
  const decisions = await access.prepareReadDecisions!({
    actor,
    actions: new Set(['collection:read']),
    context: { pool, deadline },
  });
  const client = await pool.connect();
  try {
    expect(await access.authorize(client, actor, 'collection:read', resource, evidence)).toBe(true);
    expect(await access.authorizeExplicit!(client, actor, 'collection:read', resource, evidence)).toEqual({
      allowed: true,
      explicit: false,
    });
    expect(await access.authorizePage!(client, actor, 'collection:read', page, pageEvidence)).toBe(true);
    expect(
      await decisions.decide(client, {
        action: 'collection:read',
        resourceType: 'library.collection',
        ids: [privateCollection.id],
      }),
    ).toEqual({ [privateCollection.id]: { allowed: true, explicit: false } });
    expect(await access.authorize(client, actor, 'collection:read', resource, { ...(evidence as object) })).toBe(false);
    await client.query(
      `DELETE FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2
       AND subject_kind='identity' AND subject_id=$3 AND subject_role=''
       AND grant_role='library.collection.owner'`,
      [resource.route, resource.id, fixture.accounts.editor],
    );
    expect(await access.authorize(client, actor, 'collection:read', resource, evidence)).toBe(false);
    expect(await access.authorizePage!(client, actor, 'collection:read', page, pageEvidence)).toBe(false);
  } finally {
    client.release();
  }
});
