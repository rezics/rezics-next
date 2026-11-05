import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { populateContextDirectory } from '../../src/semantic/context-directory.ts';
import { routeOf } from '../../src/route/route.ts';
import { createDeletionFixture } from './support/deletion-fixture.ts';

const fixture = await createDeletionFixture();
const { pool, admin, call, status, accounts, clock, setNow } = fixture;
// Source, current foreign Account anchors and final native authorization must never nest checkouts.
pool.options.max = 1;
beforeAll(fixture.setup);
afterAll(fixture.close);
const prepare = () => populateContextDirectory(pool, clock);
const lifecycle = (id: string, persona?: 'owner' | 'editor' | 'stranger') =>
  call('GET', `/v1/contexts/${id}/lifecycle`, persona);
async function create(label: string) {
  const answer = await call('POST', '/v1/contexts', 'owner', { labels: { en: label } });
  status(answer, 201);
  return answer.body.context.id as string;
}
async function actions(id: string, persona: 'owner' | 'stranger') {
  const answer = await call('POST', '/v1/viewerActions', persona, { resources: [{ type: 'semantic.context', id }] });
  status(answer, 200);
  return answer.body.resources[0].viewerActions?.map((entry: { action: string }) => entry.action) ?? [];
}

test('Current authorized Context discovery and lifecycle metadata support real selection and native owner delete restore without private label leakage or a Global fallback', async () => {
  const label = `Directory selection ${randomUUID()}`;
  const id = await create(label);
  // An unfinished native bridge is readiness, never a false empty selector.
  status(await call('GET', `/v1/contexts?query=${encodeURIComponent(label)}`, 'owner'), 503);
  await prepare();
  const listed = await call('GET', `/v1/contexts?query=${encodeURIComponent(label.slice(0, 30))}`, 'owner');
  status(listed, 200);
  expect(listed.body).toEqual({
    contexts: [{ id, kind: 'community', labels: { en: label }, state: 'active', deletedAt: null, purgeAfter: null }],
    next: null,
  });
  expect((await lifecycle(id, 'owner')).body.context).toEqual(listed.body.contexts[0]);
  expect(await actions(id, 'owner')).toContain('context:delete');
  expect(await actions(id, 'owner')).not.toContain('context:restore');
  expect(await actions(id, 'stranger')).not.toContain('context:delete');
  expect(await actions(GLOBAL_CONTEXT, 'owner')).toContain('context:create');
  expect(await actions(GLOBAL_CONTEXT, 'owner')).not.toContain('context:delete');

  status(await call('DELETE', `/v1/contexts/${id}`, 'owner'), 200);
  await prepare();
  status(await lifecycle(id, 'stranger'), 404);
  status(await lifecycle(id), 404);
  const deleted = await lifecycle(id, 'owner');
  status(deleted, 200);
  expect(deleted.body.context.state).toBe('deleted');
  expect(Date.parse(deleted.body.context.purgeAfter) - Date.parse(deleted.body.context.deletedAt)).toBe(30 * 86400000);
  const privatePage = await call('GET', `/v1/contexts?deleted=true&query=${encodeURIComponent(label)}`, 'stranger');
  status(privatePage, 200);
  expect(privatePage.body).toEqual({ contexts: [], next: null });
  expect(JSON.stringify(privatePage.body)).not.toContain(label);
  expect((await call('GET', `/v1/contexts?query=${encodeURIComponent(label)}`, 'owner')).body.contexts).toEqual([]);
  expect(
    (await call('GET', `/v1/contexts?deleted=true&query=${encodeURIComponent(label)}`, 'owner')).body.contexts[0],
  ).toEqual(deleted.body.context);
  expect(await actions(id, 'owner')).toContain('context:restore');
  const advertised = await call('POST', '/v1/viewerActions', 'owner', {
    resources: [{ type: 'semantic.context', id }],
  });
  status(advertised, 200);
  const reads = advertised.body.resources[0].viewerActions.find(
    (entry: { action: string }) => entry.action === 'context:read',
  );
  expect(reads.operations).toContain('context.lifecycle');
  expect(reads.operations).not.toContain('context.get');
  status(await call('POST', `/v1/contexts/${id}:restore`, 'owner', {}), 200);
  await prepare();
  const restored = await lifecycle(id, 'owner');
  status(restored, 200);
  expect(restored.body.context).toEqual(listed.body.contexts[0]);
  const unknown = '00000000-0000-8000-8000-ffffffffffff';
  status(await lifecycle(unknown, 'owner'), 404);
  expect((await call('GET', `/v1/contexts?query=${unknown}`, 'owner')).body).toEqual({ contexts: [], next: null });
  status(await call('GET', '/v1/contexts?limit=101', 'owner'), 400);
});

test('current native read denial and owner revocation defeat an already indexed Context', async () => {
  const label = `Private match ${randomUUID()}`;
  const id = await create(label);
  await prepare();
  await admin.query(
    `INSERT INTO access.resource_denial(route,resource_id,subject_id,subject_role,action,reason,valid,transaction_id)
    VALUES($1,$2,$3,'','context:read','resource','(,)',$4)`,
    [routeOf(id), id, accounts.stranger, randomUUID()],
  );
  const page = await call('GET', `/v1/contexts?query=${encodeURIComponent(label)}`, 'stranger');
  status(page, 200);
  expect(page.body).toEqual({ contexts: [], next: null });
  status(await lifecycle(id, 'stranger'), 404);
  status(await call('DELETE', `/v1/contexts/${id}`, 'owner'), 200);
  await prepare();
  const role = (
    await admin.query(
      'SELECT valid::text FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND grant_role=$4',
      [routeOf(id), id, accounts.owner, 'semantic.context.owner'],
    )
  ).rows[0];
  status(
    await call('POST', '/v1/roleGrants:revoke', 'owner', {
      resource: { route: routeOf(id), id },
      subject: { kind: 'account', id: accounts.owner },
      role: 'semantic.context.owner',
      valid: role.valid,
    }),
    200,
  );
  status(await lifecycle(id, 'owner'), 404);
  status(await call('POST', `/v1/contexts/${id}:restore`, 'owner', {}), 403);
});

test('native deadline is exclusive and active paging cursors bind the current viewer and query', async () => {
  const id = await create(`Deadline ${randomUUID()}`);
  await prepare();
  const first = await call('GET', '/v1/contexts?limit=1', 'owner');
  status(first, 200);
  expect(first.body.next).toBeString();
  status(await call('GET', `/v1/contexts?limit=1&cursor=${first.body.next}`, 'stranger'), 400);
  status(await call('GET', `/v1/contexts?limit=1&query=changed&cursor=${first.body.next}`, 'owner'), 400);
  status(await call('DELETE', `/v1/contexts/${id}`, 'owner'), 200);
  const metadata = await lifecycle(id, 'owner');
  status(metadata, 200);
  const previous = clock();
  setNow(new Date(metadata.body.context.purgeAfter));
  try {
    status(await lifecycle(id, 'owner'), 404);
    status(await call('POST', `/v1/contexts/${id}:restore`, 'owner', {}), 409);
  } finally {
    setNow(previous);
  }
});

test('the fixed Global row is discoverable and multilingual prefix paging emits each Context once', async () => {
  const prefix = `Shared ${randomUUID()}`;
  const created = await call('POST', '/v1/contexts', 'owner', { labels: { en: prefix, fr: prefix } });
  status(created, 201);
  await prepare();
  const global = await lifecycle(GLOBAL_CONTEXT, 'owner');
  status(global, 200);
  const exact = await call('GET', `/v1/contexts?query=${GLOBAL_CONTEXT}`, 'owner');
  status(exact, 200);
  expect(exact.body.contexts).toEqual([global.body.context]);
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let step = 0; step < 3; step++) {
    const page = await call(
      'GET',
      `/v1/contexts?query=${encodeURIComponent(prefix)}&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
      'owner',
    );
    status(page, 200);
    ids.push(...page.body.contexts.map((entry: { id: string }) => entry.id));
    cursor = page.body.next;
    if (!cursor) break;
  }
  expect(cursor).toBeNull();
  expect(ids).toEqual([created.body.context.id]);
});
