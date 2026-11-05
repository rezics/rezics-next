import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  VIEWER_ACTIONS_MISSING_DRIVER,
  VIEWER_ACTIONS_ROUTE,
  type Credential,
  type ResourceReference,
  type ViewerActionsDriver,
  type ViewerActionsFixture,
  type ViewerActionsResponse,
  type ViewerActionsTrace,
  type ViewerResource,
} from './viewer-actions-driver.ts';

setDefaultTimeout(240_000);
let driver: ViewerActionsDriver | undefined;
beforeEach(async () => {
  const location = process.env.VIEWER_ACTIONS_DRIVER;
  if (!location) throw new Error(VIEWER_ACTIONS_MISSING_DRIVER);
  if (!isAbsolute(location) && !location.startsWith('file:'))
    throw new Error('VIEWER_ACTIONS_DRIVER must be absolute or a file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('VIEWER_ACTIONS_DRIVER must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createViewerActionsDriver !== 'function')
    throw new Error('Expected createViewerActionsDriver factory');
  driver = await binding.createViewerActionsDriver();
});
afterEach(async () => {
  const current = driver;
  driver = undefined;
  await current?.close();
});
const native = () => driver!;
const updateOperations = [
  'collection.update',
  'collection_member.create',
  'collection_member.delete',
  'collection_member.move',
  'collection_member.update',
];
const sortedUnique = (values: string[]) => [...new Set(values)].sort();

function send(credential: Credential | null, resources: readonly ResourceReference[]) {
  return native().request(credential, VIEWER_ACTIONS_ROUTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resources }),
  });
}
async function read(credential: Credential | null, resources: readonly ResourceReference[]) {
  const response = await send(credential, resources);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const body = (await response.json()) as ViewerActionsResponse;
  expect(Object.keys(body)).toEqual(['resources']);
  expect(body.resources.map(({ type, id }) => ({ type, id }))).toEqual([...resources]);
  for (const item of body.resources) {
    if (item.error !== undefined) {
      expect(item).toEqual({ type: item.type, id: item.id, error: 'not_found' });
      continue;
    }
    expect(Object.keys(item).sort()).toEqual(['id', 'type', 'viewerActions']);
    expect(item.viewerActions.map(({ action }) => action)).toEqual(
      sortedUnique(item.viewerActions.map(({ action }) => action)),
    );
    for (const entry of item.viewerActions) {
      expect(Object.keys(entry).sort()).toEqual(['action', 'operations']);
      expect(entry.operations.length).toBeGreaterThan(0);
      expect(entry.operations).toEqual(sortedUnique(entry.operations));
    }
  }
  return body.resources;
}
function operations(resource: ViewerResource, action: string) {
  expect(resource.error).toBeUndefined();
  return resource.viewerActions?.find((entry) => entry.action === action)?.operations ?? [];
}
async function offered(f: ViewerActionsFixture, credential: Credential, expected = updateOperations) {
  const [detail] = await read(credential, [f.collection]);
  expect(operations(detail!, 'collection:update')).toEqual(expected);
  return detail!;
}
async function problem(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  const body = await response.json();
  expect(body).toMatchObject({ status, code, type: `https://rezics.com/problems/${code}` });
  expect(body).not.toHaveProperty('resources');
  expect(body).not.toHaveProperty('viewerActions');
  return body;
}
async function edit(f: ViewerActionsFixture, credential: Credential | null, title: string) {
  const detail = await native().request(f.curator.credential, `/v1/collections/${f.collection.id}`);
  expect(detail.status).toBe(200);
  const { collection } = await detail.json();
  return native().request(credential, `/v1/collections/${f.collection.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ revision: collection.revision, title }),
  });
}
async function detailAndRow(f: ViewerActionsFixture, credential: Credential) {
  const detail = await native().request(credential, `/v1/collections/${f.collection.id}`);
  expect(detail.status).toBe(200);
  const detailBody = await detail.json();
  expect(detailBody.collection.curatorAccountId).toBe(f.curator.accountId);
  expect(detailBody.collection).not.toHaveProperty('viewerActions');
  const single = await offered(f, credential);
  const list = await native().request(credential, `/v1/collections?curatorAccountId=${f.curator.accountId}`);
  expect(list.status).toBe(200);
  const rows = (await list.json()).collections as { id: string; viewerActions?: unknown }[];
  expect(rows.some(({ id }) => id === f.collection.id)).toBe(true);
  for (const row of rows) expect(row).not.toHaveProperty('viewerActions');
  const batch = await read(
    credential,
    rows.map(({ id }) => ({ type: 'library.collection', id })),
  );
  expect(batch.find(({ id }) => id === f.collection.id)).toEqual(single);
}

test('the curator of a Collection with the scope and an admitted gate is offered collection update on the detail read and on its list row', async () => {
  const f = await native().fixture();
  await detailAndRow(f, f.curator.credential);
  const response = await edit(f, f.curator.credential, 'Curator update');
  expect(response.status).toBe(200);
  expect((await response.json()).collection.title).toBe('Curator update');
});

test('a delegated editor who is not the curator is offered the same operations', async () => {
  const f = await native().fixture();
  expect(f.editor.accountId).not.toBe(f.curator.accountId);
  await detailAndRow(f, f.editor.credential);
  expect(operations(await offered(f, f.editor.credential), 'collection:update')).toEqual(
    operations(await offered(f, f.curator.credential), 'collection:update'),
  );
  expect((await edit(f, f.editor.credential, 'Delegated update')).status).toBe(200);
});

test('the same editor after the grant is revoked is offered nothing on the next read with the same bearer and the edit is refused', async () => {
  const f = await native().fixture();
  const bearer = f.editor.credential;
  await offered(f, bearer);
  await native().revoke(f.editor, f.collection, 'collection:update');
  await offered(f, bearer, []);
  await problem(await edit(f, bearer, 'Refused update'), 404, 'not_found');
  const current = await native().request(f.curator.credential, `/v1/collections/${f.collection.id}`);
  expect((await current.json()).collection.title).not.toBe('Refused update');
});

test('a token without the collection update scope is offered no edit operation even with a grant an open gate or gate any', async () => {
  const f = await native().fixture();
  const noScope = await native().authenticate(f.curator, ['collection:read', 'gate:any']);
  expect(noScope.accountId).toBe(f.curator.accountId);
  await offered(f, f.curator.credential);
  await offered(f, noScope.credential, []);
  await problem(await edit(f, noScope.credential, 'Missing consent'), 404, 'not_found');
  await native().grantGate(noScope, 'any');
  await native().gate('collections', false);
  await offered(f, noScope.credential, []);
  await problem(await edit(f, noScope.credential, 'Gate is not scope'), 403, 'platform_closed');
});

test('an anonymous reader of a public Collection is offered no mutation and the answer is private no-store', async () => {
  const f = await native().fixture();
  const response = await native().request(null, `/v1/collections/${f.collection.id}`);
  expect(response.status).toBe(200);
  expect((await response.json()).collection).not.toHaveProperty('viewerActions');
  const [item] = await read(null, [f.collection]);
  expect(item!.viewerActions?.map(({ action }) => action)).toEqual(['collection:read']);
  expect(operations(item!, 'collection:read')).toContain('collection.get');
  expect(operations(item!, 'collection:update')).toEqual([]);
  await problem(await edit(f, null, 'Anonymous edit'), 401, 'authentication_required');
});

test('a suspended account gets its normal refusal and never an old positive or an anonymous answer', async () => {
  const f = await native().fixture();
  const bearer = f.editor.credential;
  await offered(f, bearer);
  await native().suspend(f.editor);
  await problem(await send(bearer, [f.collection]), 401, 'invalid_credentials');
  await problem(await edit(f, bearer, 'Suspended edit'), 401, 'invalid_credentials');
  const [anonymous] = await read(null, [f.collection]);
  expect(operations(anonymous!, 'collection:read')).toContain('collection.get');
});

test('a banned Realm member loses join and participate while unrelated reads keep their own answers', async () => {
  const f = await native().fixture();
  const refs = [f.realm, f.collection];
  const before = await read(f.member.credential, refs);
  expect(operations(before[0]!, 'realm:join')).toContain('realm.join');
  expect(operations(before[0]!, 'realm:participate')).toContain('realm.participation');
  expect(operations(before[0]!, 'realm:read')).toContain('realm.get');
  await native().ban(f.realm, f.member);
  const after = await read(f.member.credential, refs);
  expect(operations(after[0]!, 'realm:join')).toEqual([]);
  expect(operations(after[0]!, 'realm:participate')).toEqual([]);
  expect(operations(after[0]!, 'realm:read')).toEqual(operations(before[0]!, 'realm:read'));
  expect(after[1]).toEqual(before[1]);
  const response = await native().request(f.member.credential, `/v1/realms/${f.realm.id}`);
  expect(response.status).toBe(200);
});

test('an assigned actor whose principal lacks the action or is suspended or whose assignment was revoked is offered nothing for it', async () => {
  for (const cause of ['principal_grant', 'principal_suspension', 'assignment'] as const) {
    const f = await native().fixture();
    const bearer = f.assigned.credential;
    await offered(f, bearer);
    if (cause === 'principal_grant') await native().revoke(f.principal, f.collection, 'collection:update');
    if (cause === 'principal_suspension') await native().suspend(f.principal);
    if (cause === 'assignment') await native().revokeAssignment(f.assigned);
    if (cause === 'principal_grant') await offered(f, bearer, []);
    else await problem(await send(bearer, [f.collection]), 401, 'invalid_credentials');
    const command = await edit(f, bearer, 'Principal refused');
    if (cause === 'principal_grant') await problem(command, 404, 'not_found');
    else await problem(command, 401, 'invalid_credentials');
  }
});

test('opening a closed gate offers nothing to an ungranted caller and the granted caller sees the operation only while the gate admits it', async () => {
  const f = await native().fixture();
  await native().gate('collections', false);
  await offered(f, f.editor.credential, []);
  await offered(f, f.stranger.credential, []);
  await native().gate('collections', true);
  await offered(f, f.editor.credential);
  await offered(f, f.stranger.credential, []);
  await native().gate('collections', false);
  await offered(f, f.editor.credential, []);
  await native().grantGate(f.editor, 'collections');
  await offered(f, f.editor.credential);
  await native().grantGate(f.stranger, 'any');
  await offered(f, f.stranger.credential, []);
});

test('one action behind two differently gated operations offers only the admitted operation', async () => {
  const f = await native().fixture();
  await native().gate('viewer_zulu', false);
  let [item] = await read(f.editor.credential, [f.item]);
  expect(operations(item!, 'viewer_fixture:update')).toEqual(['viewer_fixture.alpha']);
  await native().gate('viewer_alpha', false);
  [item] = await read(f.editor.credential, [f.item]);
  expect(operations(item!, 'viewer_fixture:update')).toEqual([]);
  await native().gate('viewer_zulu', true);
  [item] = await read(f.editor.credential, [f.item]);
  expect(operations(item!, 'viewer_fixture:update')).toEqual(['viewer_fixture.zulu']);
});

test('a visible resource with no allowed action answers an empty list while a failing dependency answers 503 with no partial positives', async () => {
  const f = await native().fixture();
  expect(await read(f.stranger.credential, [f.item])).toEqual([{ ...f.item, viewerActions: [] }]);
  await offered(f, f.editor.credential);
  await native().fault(f.item);
  await problem(await send(f.editor.credential, [f.collection, f.item]), 503, 'dependency_unavailable');
  await native().fault(null);
  const [item] = await read(f.editor.credential, [f.item]);
  expect(operations(item!, 'viewer_fixture:update')).toEqual(['viewer_fixture.alpha', 'viewer_fixture.zulu']);
});

test('a concealed and an unknown resource answer the same not_found item', async () => {
  const f = await native().fixture();
  const body = await read(f.editor.credential, [f.concealed, f.unknown, f.collection]);
  expect(body[0]).toEqual({ ...f.concealed, error: 'not_found' });
  expect(body[1]).toEqual({ ...f.unknown, error: 'not_found' });
  const omitIdentity = ({ type: _type, id: _id, ...rest }: ViewerResource) => rest;
  expect(omitIdentity(body[0]!)).toEqual(omitIdentity(body[1]!));
  expect(operations(body[2]!, 'collection:update')).toEqual(updateOperations);
});

test('malformed duplicate oversized or unsupported references answer 400', async () => {
  const f = await native().fixture();
  const extra = await native().additionalCollections(f.curator, 100);
  const bodies: unknown[] = [
    null,
    {},
    { resources: [] },
    { resources: 'invalid' },
    { resources: [null] },
    { resources: [{ type: 'library.collection' }] },
    { resources: [{ ...f.collection, id: 'not-an-id' }] },
    { resources: [{ ...f.collection, type: 1 }] },
    { resources: [f.collection, f.collection] },
    { resources: [f.collection, ...extra] },
    { resources: [{ ...f.collection, type: 'unsupported.resource' }] },
    { resources: [{ ...f.collection, route: 0 }] },
    { resources: [f.collection], principal: f.curator.accountId },
  ];
  for (const body of [...bodies.map((value) => JSON.stringify(value)), '{']) {
    const result = await native().measure(() =>
      native().request(f.editor.credential, VIEWER_ACTIONS_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
    );
    await problem(result.value, 400, 'invalid_request');
    expect(result.trace.permissionCalls).toBe(0);
    expect(result.trace.formulaPages).toEqual([]);
    expect(result.trace.preparations).toEqual({ actor: 0, principal: 0, gates: 0 });
  }
  expect(await read(f.editor.credential, extra)).toHaveLength(100);
});

test('answers keep request order and are sorted and unique within a resource', async () => {
  const f = await native().fixture();
  const refs = [f.otherCollection, f.item, f.unknown, f.realm, f.collection];
  const body = await read(f.editor.credential, refs);
  expect(body[1]).toEqual({
    ...f.item,
    viewerActions: [
      { action: 'viewer_fixture:inspect', operations: ['viewer_fixture.inspect'] },
      { action: 'viewer_fixture:update', operations: ['viewer_fixture.alpha', 'viewer_fixture.zulu'] },
    ],
  });
  expect(await read(f.editor.credential, [...refs].reverse())).toEqual([...body].reverse());
});

test("two personas never see each other's answers", async () => {
  const f = await native().fixture();
  const refs = [f.collection, f.otherCollection];
  const editor = await read(f.editor.credential, refs);
  const stranger = await read(f.stranger.credential, refs);
  expect(operations(editor[0]!, 'collection:update')).toEqual(updateOperations);
  expect(operations(editor[1]!, 'collection:update')).toEqual([]);
  expect(operations(stranger[0]!, 'collection:update')).toEqual([]);
  expect(operations(stranger[1]!, 'collection:update')).toEqual(updateOperations);
  const simultaneous = await Promise.all([read(f.stranger.credential, refs), read(f.editor.credential, refs)]);
  expect(simultaneous).toEqual([stranger, editor]);
  expect(await read(f.editor.credential, refs)).toEqual(editor);
});

function batchBound(trace: ViewerActionsTrace, refs: ResourceReference[], principal: boolean) {
  expect(trace.preparations).toEqual({ actor: 1, principal: principal ? 1 : 0, gates: 1 });
  expect(trace.readTimes.length).toBeGreaterThan(0);
  expect(new Set(trace.readTimes).size).toBe(1);
  expect(trace.candidateActions.map(({ type }) => type).sort()).toEqual(sortedUnique(refs.map(({ type }) => type)));
  const counts = trace.candidateActions.map(({ count }) => count);
  for (const count of counts) {
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(64);
  }
  expect(trace.formulaPages.length).toBeGreaterThan(0);
  expect(trace.formulaPages.length).toBeLessThanOrEqual(Math.max(...counts) * counts.length);
  for (const page of trace.formulaPages) {
    expect(page.ids.length).toBeGreaterThan(0);
    expect(page.ids.length).toBeLessThanOrEqual(100);
    expect(new Set(page.ids).size).toBe(page.ids.length);
    expect(page.at).toBe(trace.readTimes[0]!);
  }
}
function bounded(traces: ViewerActionsTrace[]) {
  expect(traces).toHaveLength(3);
  const first = traces[0]!;
  expect(first.statements).toBeGreaterThan(0);
  expect(first.examinedRows).toBeGreaterThan(0);
  expect(first.sharedBlocks).toBeGreaterThan(0);
  for (const [index, trace] of traces.entries()) {
    expect(trace.sequentialRelations).toEqual([]);
    expect(trace.statements).toBe(first.statements);
    expect(trace.examinedRows).toBe(first.examinedRows);
    // Existing outcome suites allow 64 shared blocks per doubling for indexed seeks.
    expect(trace.sharedBlocks).toBeLessThanOrEqual(first.sharedBlocks + 64 * Math.log2([1, 4, 16][index]!));
  }
}
test('statements and rows stay constant as unrelated grants resources and history grow', async () => {
  for (const axis of ['unrelated_grants', 'unrelated_resources', 'history'] as const) {
    const f = await native().fixture();
    const extra = await native().additionalCollections(f.curator, 97);
    const refs = [f.collection, f.realm, f.item, ...extra];
    const allowed: ViewerActionsTrace[] = [],
      denied: ViewerActionsTrace[] = [],
      empty: ViewerActionsTrace[] = [],
      unavailable: ViewerActionsTrace[] = [];
    let expected: ViewerResource[] | undefined;
    for (const scale of [1, 4, 16]) {
      await native().seed(f, scale, axis);
      const warm = await read(f.assigned.credential, refs);
      if (expected) expect(warm).toEqual(expected);
      else expected = warm;
      const measured = await native().measure(() => read(f.assigned.credential, refs));
      expect(measured.value).toEqual(expected!);
      batchBound(measured.trace, refs, true);
      allowed.push(measured.trace);
      await read(f.stranger.credential, refs);
      const negative = await native().measure(() => read(f.stranger.credential, refs));
      batchBound(negative.trace, refs, false);
      denied.push(negative.trace);
      await read(f.stranger.credential, [f.item]);
      const zero = await native().measure(() => read(f.stranger.credential, [f.item]));
      expect(zero.value).toEqual([{ ...f.item, viewerActions: [] }]);
      batchBound(zero.trace, [f.item], false);
      empty.push(zero.trace);
      await native().fault(f.item);
      await problem(await send(f.editor.credential, [f.collection, f.item]), 503, 'dependency_unavailable');
      const failed = await native().measure(async () =>
        problem(await send(f.editor.credential, [f.collection, f.item]), 503, 'dependency_unavailable'),
      );
      batchBound(failed.trace, [f.collection, f.item], false);
      unavailable.push(failed.trace);
      await native().fault(null);
    }
    for (const traces of [allowed, denied, empty, unavailable]) bounded(traces);
  }
});
