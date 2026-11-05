import { afterAll, beforeAll, expect, test } from 'bun:test';
import { EXTENSION_FORMAT, termPrefix } from '@rezics/definitions/extension';
import { randomUUID } from 'node:crypto';
import { createAccess } from '../../src/access/index.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { mintReadTime } from '../../src/command/command.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { readSemanticLifecycle } from '../../src/semantic/index.ts';
import { createDeletionFixture } from './support/deletion-fixture.ts';

const fixture = await createDeletionFixture();
beforeAll(fixture.setup);
afterAll(fixture.close);
const { pool, admin, accounts, call, status, clock, setNow, real } = fixture;
const day = 86_400_000;

async function create() {
  const response = await call('POST', '/v1/contexts', 'owner', { labels: { en: 'Retained Context payload' } });
  status(response, 201);
  return response.body.context.id as string;
}
async function state(context: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const nativeT = await mintReadTime(client, clock);
    const evidence = await readSemanticLifecycle(client, {
      target: { kind: 'context', context },
      accountId: accounts.owner,
      nativeT,
    });
    await client.query('COMMIT');
    return evidence;
  } finally {
    client.release();
  }
}
async function evidence(context: string) {
  return (
    await admin.query(
      `SELECT state, deleted_at::text, purge_after::text, security_revision::text,
    labels, settings_id, settings_release, defaults, held
    FROM semantic.context WHERE route=$1 AND context_id=$2`,
      [routeOf(context), context],
    )
  ).rows[0];
}
async function events(context: string) {
  return (
    await admin.query(
      `SELECT jsonb_build_object('id',id,'type',type,'subject',subject,'data',data) AS envelope FROM core.outbox
    WHERE partition_no=$1 AND subject=$2 ORDER BY position`,
      [Math.floor(routeOf(context)! / 16), context],
    )
  ).rows;
}

test('Context receipt replay and fresh no-op preserve the original window and only real transitions emit identities', async () => {
  const context = await create();
  const key = `"${randomUUID()}"`;
  const deletedAt = clock().getTime();
  const deleted = await call('DELETE', `/v1/contexts/${context}`, 'owner', undefined, key);
  status(deleted, 200);
  expect(deleted.body).toEqual({ context: { id: context, state: 'deleted' } });
  const prior = await evidence(context);
  expect(prior.security_revision).toBe('1');
  expect(await state(context)).toEqual({
    target: { kind: 'context', context },
    owner: { kind: 'owner_grant', accountId: accounts.owner },
    state: 'deleted',
    deletedAt: new Date(deletedAt).toISOString().replace('Z', '000Z'),
    purgeAfter: new Date(deletedAt + 30 * day).toISOString().replace('Z', '000Z'),
    held: false,
  });
  const beforeEvents = await events(context);
  expect(beforeEvents).toHaveLength(1);
  expect(beforeEvents[0].envelope).toMatchObject({
    type: 'com.rezics.semantic.record.deleted.v1',
    subject: context,
    data: { kind: 'context', id: context, version: '1' },
  });
  expect(JSON.stringify(beforeEvents)).not.toContain('Retained Context payload');
  setNow(new Date(deletedAt + 29 * day));
  expect(await call('DELETE', `/v1/contexts/${context}`, 'owner', undefined, key)).toEqual(deleted);
  status(await call('DELETE', `/v1/contexts/${context}`, 'owner', {}), 200);
  expect(await evidence(context)).toEqual(prior);
  expect(await events(context)).toEqual(beforeEvents);
  setNow(new Date(deletedAt + 30 * day));
  status(await call('POST', `/v1/contexts/${context}:restore`, 'owner', {}), 409);
  expect(await evidence(context)).toEqual(prior);
  expect(await events(context)).toEqual(beforeEvents);
  // A successful receipt remains replayable at expiry, without restarting availability or the timer.
  status(await call('DELETE', `/v1/contexts/${context}`, 'owner', undefined, key), 200);
});

test('Context restoration is a new mutation preserving retained fields and receipt identity', async () => {
  const context = await create();
  const original = await evidence(context);
  const deletion = `"${randomUUID()}"`;
  const restoration = `"${randomUUID()}"`;
  const at = clock().getTime();
  status(await call('DELETE', `/v1/contexts/${context}`, 'owner', undefined, deletion), 200);
  setNow(new Date(at + 30 * day - 1));
  const restored = await call('POST', `/v1/contexts/${context}:restore`, 'owner', {}, restoration);
  status(restored, 200);
  expect(restored.body).toEqual({ context: { id: context, state: 'active' } });
  const after = await evidence(context);
  expect(after).toMatchObject({
    ...original,
    state: 'active',
    security_revision: '2',
    deleted_at: expect.any(String),
    purge_after: expect.any(String),
  });
  expect((await state(context))?.state).toBe('active');
  const emitted = await events(context);
  expect(emitted).toHaveLength(2);
  expect(emitted[1].envelope).toMatchObject({
    type: 'com.rezics.semantic.record.restored.v1',
    data: { kind: 'context', id: context, version: '2' },
  });
  // Replaying an earlier DELETE returns its original tombstone, without deleting the restored Context.
  status(await call('DELETE', `/v1/contexts/${context}`, 'owner', undefined, deletion), 200);
  expect(await evidence(context)).toEqual(after);
  expect(await call('POST', `/v1/contexts/${context}:restore`, 'owner', {}, restoration)).toEqual(restored);
  status(await call('POST', `/v1/contexts/${context}:restore`, 'owner', {}), 200);
  expect(await evidence(context)).toEqual(after);
  expect(await events(context)).toEqual(emitted);
});

test('Context failures are inert and a direct action grant is not current ownership', async () => {
  const context = await create();
  const resource = { route: routeOf(context)!, id: context };
  for (const action of ['context:delete', 'context:restore']) await real.grant(resource, 'stranger', action);
  const prior = await evidence(context);
  const beforeEvents = await events(context);
  for (const method of ['DELETE', 'POST']) {
    const path = `/v1/contexts/${context}${method === 'POST' ? ':restore' : ''}`;
    status(await call(method, path, 'stranger', {}), 403);
    status(await call(method, path, undefined, {}), 401);
    status(await call(method, path, 'owner', { purge: true }), 400);
    status(await call(method, `/v1/contexts/${newId(21000)}${method === 'POST' ? ':restore' : ''}`, 'owner', {}), 404);
    status(
      await call(method, `/v1/contexts/${GLOBAL_CONTEXT}${method === 'POST' ? ':restore' : ''}`, 'owner', {}),
      403,
    );
  }
  expect(await evidence(context)).toEqual(prior);
  expect(await events(context)).toEqual(beforeEvents);
});

test('a receipt write failure rolls back Context availability and its event atomically', async () => {
  const context = await create();
  const prior = await evidence(context);
  const key = `"${randomUUID()}"`;
  await admin.query(`CREATE FUNCTION public.reject_context_lifecycle_receipt() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'Context receipt fault'; END $$`);
  await admin.query(`CREATE TRIGGER reject_context_lifecycle_receipt BEFORE INSERT ON core.receipt
    FOR EACH ROW EXECUTE FUNCTION public.reject_context_lifecycle_receipt()`);
  try {
    status(await call('DELETE', `/v1/contexts/${context}`, 'owner', undefined, key), 500);
    expect(await evidence(context)).toEqual(prior);
    expect(await events(context)).toEqual([]);
  } finally {
    await admin.query('DROP TRIGGER reject_context_lifecycle_receipt ON core.receipt');
    await admin.query('DROP FUNCTION public.reject_context_lifecycle_receipt()');
  }
  status(await call('DELETE', `/v1/contexts/${context}`, 'owner', undefined, key), 200);
  expect((await evidence(context)).security_revision).toBe('1');
  expect(await events(context)).toHaveLength(1);
});

test('current owner evidence cannot bypass token scope, and lifecycle responses carry the native Session component', async () => {
  const context = await create();
  const native = createKernel({
    pool,
    clock,
    routeKey: fixture.routeKey,
    access: (config) => createAccess({ ...config, auth: fixture.auth }),
    writeRate: real.writeRate,
  });
  const request = async (method: string, suffix: string, scopes: string[]) =>
    native.handle(
      new Request(`http://kernel.test/v1/contexts/${context}${suffix}`, {
        method,
        headers: {
          authorization: `Bearer ${await fixture.bearer(accounts.owner, scopes)}`,
          'idempotency-key': `"${randomUUID()}"`,
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
      }),
    );
  const prior = await evidence(context);
  expect((await request('DELETE', '', ['context:read'])).status).toBe(403);
  expect(await evidence(context)).toEqual(prior);
  const deleted = await request('DELETE', '', ['context:delete']);
  expect(deleted.status).toBe(200);
  expect(deleted.headers.get('rezics-session-token')).toBeTruthy();
  expect(await deleted.json()).toEqual({ context: { id: context, state: 'deleted' } });
  expect((await request('POST', ':restore', ['context:delete'])).status).toBe(403);
  // The explicit grant branch cannot bypass the owning reader's availability point check.
  await real.grant({ route: routeOf(context)!, id: context }, 'owner', 'context:read');
  status(await call('GET', `/v1/contexts/${context}`, 'owner'), 404);
  status(await call('GET', `/v1/contexts/${context}/definitions`, 'owner'), 404);
  const restored = await request('POST', ':restore', ['context:restore']);
  expect(restored.status).toBe(200);
  expect(restored.headers.get('rezics-session-token')).toBeTruthy();
  expect(await restored.json()).toEqual({ context: { id: context, state: 'active' } });
});

test('deleted Contexts deny extension receipt replay while retained term birth evidence and Global adoptions survive', async () => {
  const context = await create();
  for (const id of [context, GLOBAL_CONTEXT])
    for (const action of ['definitions:publish', 'definitions:activate'])
      await real.grant({ route: routeOf(id)!, id }, 'owner', action);
  const term = `${termPrefix(context)}:related`;
  const terms = {
    [term]: {
      description: { en: 'A retained relation meaning' },
      labels: { en: 'related' },
      domain: ['schema:Person'],
      targets: ['schema:Person'],
      multivalued: true,
      relation: { group: 'association', inverse: 'none' },
    },
  };
  const extension = { format: EXTENSION_FORMAT, context, terms };
  const publishKey = `"${randomUUID()}"`;
  const activationKey = `"${randomUUID()}"`;
  const published = await call(
    'POST',
    `/v1/contexts/${context}/definitions/extensions`,
    'owner',
    { extension },
    publishKey,
  );
  status(published, 201);
  const activationPath = `/v1/contexts/${context}/definitions/extensions/${published.body.digest}:activate`;
  status(await call('POST', activationPath, 'owner', { expected_head: null }, activationKey), 200);
  const current = await call('GET', `/v1/contexts/${context}/definitions`, 'owner');
  status(current, 200);
  status(await call('DELETE', `/v1/contexts/${context}`, 'owner'), 200);
  status(await call('POST', `/v1/contexts/${context}/definitions/extensions`, 'owner', { extension }, publishKey), 404);
  status(await call('POST', activationPath, 'owner', { expected_head: null }, activationKey), 404);
  status(await call('GET', `/v1/contexts/${context}/definitions`, 'owner'), 404);
  const global = { format: EXTENSION_FORMAT, context: GLOBAL_CONTEXT, terms };
  const adoption = await call('POST', `/v1/contexts/${GLOBAL_CONTEXT}/definitions/extensions`, 'owner', {
    extension: global,
  });
  status(adoption, 201);
  status(
    await call(
      'POST',
      `/v1/contexts/${GLOBAL_CONTEXT}/definitions/extensions/${adoption.body.digest}:activate`,
      'owner',
      { expected_head: null },
    ),
    200,
  );
  const globalRead = await call('GET', `/v1/contexts/${GLOBAL_CONTEXT}/definitions`, 'owner');
  status(globalRead, 200);
  expect(globalRead.body.extension.terms).toEqual(terms);
  status(await call('POST', `/v1/contexts/${context}:restore`, 'owner', {}), 200);
  expect(await call('GET', `/v1/contexts/${context}/definitions`, 'owner')).toEqual(current);
});
