import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Compile } from 'typebox/compile';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { newId } from '../../src/route/route.ts';
import { ZonePageResponseSchema } from '../../src/zones/contract.ts';
import { createBody, page, problem, resourceFixture, type ResourceFixture } from './resource-fixture.ts';

let f: ResourceFixture;
beforeAll(async () => {
  f = await resourceFixture({ scopes: ['gate:any'] });
  await f.available();
  // Native grant administration, without an exposure opening or a synthetic identity.
  await f.access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'operator', 'access:grant');
  await f.access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'operator', 'gate:any');
}, 120_000);
afterAll(async () => {
  await f?.close();
});
const global = { route: 0, id: GLOBAL_CONTEXT };
function closed(answer: Awaited<ReturnType<ResourceFixture['call']>>) {
  expect(answer.status, JSON.stringify(answer.body)).toBe(403);
  expect(answer.headers.get('retry-after')).toBeNull();
  expect(problem(answer.body)).toEqual({
    type: 'https://rezics.com/problems/platform_closed',
    title: 'Platform Closed',
    status: 403,
    code: 'platform_closed',
    retryable: false,
    effect_status: 'not_applicable',
  });
  expect(answer.body.request_id).toEqual(expect.any(String));
}
async function gate(who: 'owner' | 'editor', valid = '(,)') {
  const result = await f.call('operator', 'POST', '/v1/grants', {
    resource: global,
    subject: { kind: 'account', id: f.accounts[who] },
    actions: ['gate:zone_sources'],
    valid,
  });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
}
async function published(body = createBody()) {
  const zone = await f.create(body);
  const result = await f.call(
    'owner',
    'POST',
    `/v1/zones/${zone.id}:publish`,
    { visibility: 'public' },
    f.conditional(zone.revision),
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body.zone as { id: string; revision: string };
}
function notReady(answer: Awaited<ReturnType<ResourceFixture['call']>>) {
  expect(answer.status, JSON.stringify(answer.body)).toBe(503);
  expect(answer.headers.get('retry-after')).toBe('1');
  expect(problem(answer.body)).toEqual({
    type: 'https://rezics.com/problems/semantic_not_ready',
    title: 'Semantic Layer Not Ready',
    status: 503,
    code: 'semantic_not_ready',
    retryable: true,
    effect_status: 'not_applicable',
  });
  expect(answer.body.request_id).toEqual(expect.any(String));
  expect(answer.body).not.toHaveProperty('document');
  expect(answer.body).not.toHaveProperty('next');
}

test('native static configured pages are public while direct targets and source-dependent lists require explicit platform grants', async () => {
  const body = createBody();
  body.configuration.scope = [];
  body.configuration.pages = [{ route: '', document: page('Public static page') }];
  const staticZone = await published(body);
  const dynamicZone = await published();
  const before = {
    receipts: await f.receipts(),
    static: await f.events(staticZone.id),
    dynamic: await f.events(dynamicZone.id),
  };
  for (const who of ['anonymous', 'owner', 'editor'] as const) {
    const result = await f.read(staticZone.id, who);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(Compile(ZonePageResponseSchema).Check(result.body)).toBe(true);
    expect(result.body.document).toEqual(body.configuration.pages[0]!.document);
    expect(result.body.reads).toEqual({});
    closed(await f.read(staticZone.id, who, { subject: newId(0x7111) }));
    closed(await f.read(dynamicZone.id, who));
  }
  expect(await f.receipts()).toBe(before.receipts);
  expect(await f.events(staticZone.id)).toEqual(before.static);
  expect(await f.events(dynamicZone.id)).toEqual(before.dynamic);
  // Existing ordinary grant APIs register and delegate exact gate actions; no second registry is needed.
  await gate('editor');
  const reads = f.access.readChecks.length;
  notReady(await f.read(dynamicZone.id, 'editor'));
  notReady(await f.read(staticZone.id, 'editor', { subject: newId(0x7111) }));
  expect(f.access.readChecks.slice(reads).every((check) => check.action === 'zone:read')).toBe(true);
  closed(await f.read(dynamicZone.id, 'owner'));
  closed(await f.read(dynamicZone.id, 'anonymous'));
  const invalid = await f.call(
    'anonymous',
    'POST',
    `/v1/zones/${dynamicZone.id}:readPage`,
    { target: { route: '' } },
    { authorization: 'Bearer invalid' },
  );
  expect(invalid.status).toBe(401);
  expect(invalid.body.code).toBe('invalid_credentials');
  const publicDocument = await f.call('anonymous', 'GET', '/v1/openapi.json');
  expect(publicDocument.status).toBe(200);
  expect(publicDocument.body.paths['/v1/zones/{id}:readPage'].post['x-exposure']).toBe('public');
  expect(publicDocument.body.paths['/v1/zones/{id}:readPage'].post['x-action']).toBe('zone:read');
}, 180_000);

test('platform admission preserves Zone concealment, source authority and the configured clock', async () => {
  const privateZone = await f.create();
  const unknown = newId(0x7111);
  for (const target of [{ route: '' }, { subject: newId(0x7111) }]) {
    const missing = await f.read(unknown, 'editor', target);
    expect(missing.status).toBe(404);
    const denied = await f.read(privateZone.id, 'editor', target);
    expect(denied.status).toBe(404);
    expect(problem(denied.body)).toEqual(problem(missing.body));
    expect(JSON.stringify(denied.body)).not.toContain(privateZone.id);
  }
  // Ownership permits Zone reads, but never supplies the platform grant.
  closed(await f.read(privateZone.id, 'owner'));
  const until = new Date(f.clock().getTime() + 1_000).toISOString();
  await gate('owner', `(,${until})`);
  const receipts = await f.receipts();
  const events = await f.events(privateZone.id);
  notReady(await f.read(privateZone.id, 'owner'));
  notReady(await f.read(privateZone.id, 'owner', { subject: newId(0x7111) }));
  f.advance(1_001);
  closed(await f.read(privateZone.id, 'owner'));
  expect(await f.receipts()).toBe(receipts);
  expect(await f.events(privateZone.id)).toEqual(events);
  const revoked = await f.call('operator', 'POST', '/v1/grants:revoke', {
    resource: global,
    subject: { kind: 'account', id: f.accounts.editor },
    actions: ['gate:zone_sources'],
    valid: '(,)',
  });
  expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
  const zone = await published();
  closed(await f.read(zone.id, 'editor'));
}, 180_000);
