import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createKernelClient, zoneCollections } from '@rezics/client';
import type { Access } from '../../src/request/access.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { decodeListCursor, encodeListCursor } from '../../src/tokens/list-cursor.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { suspendAccount } from '../support/native-suspension-driver.ts';
import { createBody, problem, resourceFixture, type ResourceFixture } from './resource-fixture.ts';

let f: ResourceFixture;
const global = { route: 0, id: GLOBAL_CONTEXT };
const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(74)]]) };
const cursorRoute = 'GET /v1/zones/{id}/collections';

beforeAll(async () => {
  f = await resourceFixture({ scopes: ['gate:any'] });
  await f.available();
  await f.access.grant(global, 'owner', 'collection:create');
  await f.access.grant(global, 'operator', 'access:grant');
  await f.access.grant(global, 'operator', 'gate:any');
  await openSources('editor');
}, 120_000);

afterAll(async () => {
  await f?.close();
});

async function openSources(who: 'editor' | 'other') {
  const answer = await f.call('operator', 'POST', '/v1/grants', {
    resource: global,
    subject: { kind: 'account', id: f.accounts[who] },
    actions: ['gate:zone_sources'],
    valid: '(,)',
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
}

async function collection(title: string, visibility: 'private' | 'unlisted' | 'public') {
  const answer = await f.call('owner', 'POST', '/v1/collections', { title, visibility });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return answer.body.collection as { id: string; revision: number; title: string; visibility: string };
}

async function zone(mounts: string[]) {
  const body = createBody();
  body.configuration.scope = [];
  body.mounts = mounts;
  const created = await f.create(body);
  const published = await f.call(
    'owner',
    'POST',
    `/v1/zones/${created.id}:publish`,
    { visibility: 'public' },
    f.conditional(created.revision),
  );
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  return { ...created, revision: published.body.zone.revision as string };
}

function list(id: string, who: 'anonymous' | 'editor' | 'other' = 'editor', query = '') {
  return f.call(who, 'GET', `/v1/zones/${id}/collections${query}`);
}

function page(answer: Awaited<ReturnType<ResourceFixture['call']>>) {
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  expect(answer.headers.get('cache-control')).toBe('private, no-store');
  expect(Object.keys(answer.body).sort()).toEqual(['collections', 'next']);
  return answer.body as { collections: Array<Record<string, unknown> & { id: string }>; next: string | null };
}

test('native mounted Collection pages preserve current Access, safe summaries, bounded cursors and installed receiving', async () => {
  const empty = await zone([]);
  expect(page(await list(empty.id))).toEqual({ collections: [], next: null });

  const hiddenZone = await f.create();
  const concealed = await f.call('other', 'GET', `/v1/zones/${hiddenZone.id}/collections`);
  expect(concealed.status).toBe(404);
  expect(problem(concealed.body).code).toBe('not_found');

  const anonymous = await list(empty.id, 'anonymous');
  expect(anonymous.status).toBe(403);
  expect(problem(anonymous.body).code).toBe('platform_closed');
  const deniedAccount = await list(empty.id, 'other');
  expect(deniedAccount.status).toBe(403);
  expect(problem(deniedAccount.body).code).toBe('platform_closed');
  const invalidBearer = await f.call('anonymous', 'GET', `/v1/zones/${empty.id}/collections`, undefined, {
    authorization: 'Bearer invalid',
  });
  expect(invalidBearer.status).toBe(401);
  expect(problem(invalidBearer.body).code).toBe('invalid_credentials');

  await openSources('other');
  expect(page(await list(empty.id, 'other'))).toEqual({ collections: [], next: null });
  const opened = await f.call('operator', 'POST', '/v1/platform/exposure/zone_sources:open', {});
  expect(opened.status).toBe(200);
  const singleSource = await collection('single-unlisted', 'unlisted');
  const single = await zone([singleSource.id]);
  const one = page(await list(single.id, 'editor', '?limit=100'));
  expect(one.collections.map(({ id }) => id)).toEqual([singleSource.id]);
  expect(one.next).toBeNull();

  const visibilities = Array.from({ length: 16 }, (_, index) =>
    index === 1 ? 'unlisted' : index === 8 || index === 14 ? 'public' : 'private',
  ) as Array<'private' | 'unlisted' | 'public'>;
  const sources = await Promise.all(visibilities.map((visibility, index) => collection(`mount-${index}`, visibility)));
  const sharedSubject = await f.call('owner', 'POST', '/v1/subjects', {
    type: 'schema:Book',
    labels: { en: 'Shared mount member' },
  });
  expect(sharedSubject.status).toBe(201);
  for (const source of [sources[1]!, sources[8]!]) {
    const added = await f.call('owner', 'POST', `/v1/collections/${source.id}/members`, {
      subjectId: sharedSubject.body.subject.id,
      note: 'private occurrence note',
    });
    expect(added.status).toBe(201);
  }
  const mounted = await zone(sources.map(({ id }) => id));
  const readable = [sources[1]!, sources[8]!, sources[14]!];
  const before = f.access.readChecks.length;
  const defaultPage = page(await list(mounted.id));
  expect(defaultPage.collections.map(({ id }) => id)).toEqual(readable.map(({ id }) => id));
  expect(defaultPage.collections.map(({ memberCount }) => memberCount)).toEqual([1, 1, 0]);
  expect(defaultPage.next).toBeNull();
  expect(defaultPage).not.toHaveProperty('total');
  for (const item of defaultPage.collections) {
    expect(item).not.toHaveProperty('members');
    expect(item).not.toHaveProperty('sourcePosition');
    expect(item).not.toHaveProperty('allowedVisibilityActions');
  }
  const inspected = f.access.readChecks.slice(before).filter(({ action }) => action === 'collection:read');
  expect(inspected).toHaveLength(32);
  const serialized = JSON.stringify(defaultPage);
  expect(serialized).not.toContain(sharedSubject.body.subject.id);
  expect(serialized).not.toContain('private occurrence note');
  for (const source of sources.filter((_, index) => ![1, 8, 14].includes(index))) {
    expect(serialized).not.toContain(source.id);
    expect(serialized).not.toContain(source.title);
  }

  const first = page(await list(mounted.id, 'editor', '?limit=1'));
  expect(first.collections.map(({ id }) => id)).toEqual([readable[0]!.id]);
  expect(first.next).toEqual(expect.any(String));
  const binding = { route: cursorRoute, viewer: f.accounts.editor, query: { zoneId: mounted.id, limit: 1 } };
  const decoded = await decodeListCursor(ring, binding, first.next!, f.clock());
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) throw new Error('Expected a current default-profile cursor');
  expect(decoded.after).toHaveLength(3);
  expect(decoded.after[0]).toBe(readable[0]!.id);
  expect(sources.filter((_, index) => ![1, 8, 14].includes(index)).some(({ id }) => decoded.after.includes(id))).toBe(
    false,
  );

  const second = page(await list(mounted.id, 'editor', `?limit=1&cursor=${encodeURIComponent(first.next!)}`));
  expect(second.collections.map(({ id }) => id)).toEqual([readable[1]!.id]);
  expect(page(await list(mounted.id, 'editor', `?limit=1&cursor=${encodeURIComponent(first.next!)}`))).toEqual(second);
  const third = page(await list(mounted.id, 'editor', `?limit=1&cursor=${encodeURIComponent(second.next!)}`));
  expect(third.collections.map(({ id }) => id)).toEqual([readable[2]!.id]);
  expect(third.next).toBeNull();
  const raw = await f.raw(mounted.id);
  const finalCursor = await encodeListCursor(
    ring,
    binding,
    {
      epoch: 1,
      after: [readable[2]!.id, String(raw!.revision), String(raw!.lifecycle_revision)],
    },
    f.clock(),
  );
  expect(page(await list(mounted.id, 'editor', `?limit=1&cursor=${encodeURIComponent(finalCursor)}`))).toEqual({
    collections: [],
    next: null,
  });
  expect((await list(mounted.id, 'editor', '?limit=0')).status).toBe(400);
  expect(problem((await list(mounted.id, 'editor', '?cursor=invalid')).body).code).toBe('invalid_cursor');

  const anonymousFirst = page(await list(mounted.id, 'anonymous', '?limit=1'));
  expect(anonymousFirst.collections.map(({ id }) => id)).toEqual([sources[1]!.id]);
  const anonymousReplay = page(await list(mounted.id, 'anonymous', '?limit=1'));
  expect(anonymousReplay.next).toBe(anonymousFirst.next);
  const anonymousBinding = { route: cursorRoute, viewer: null, query: { zoneId: mounted.id, limit: 1 } };
  const anonymousCursor = await decodeListCursor(ring, anonymousBinding, anonymousFirst.next!, f.clock());
  expect(anonymousCursor.ok && anonymousCursor.after[0]).toBe(sources[1]!.id);
  const anonymousSecond = page(
    await list(mounted.id, 'anonymous', `?limit=1&cursor=${encodeURIComponent(anonymousFirst.next!)}`),
  );
  expect(anonymousSecond.collections.map(({ id }) => id)).toEqual([sources[8]!.id]);

  const fetcher: typeof fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => f.app.handle(new Request(input, init)),
    { preconnect() {} },
  );
  const client = createKernelClient('http://kernel.test', {
    headers: { authorization: `Bearer ${f.access.bearer('editor')}` },
    fetch: fetcher,
  });
  const received = await zoneCollections(client, mounted.id).get();
  expect(received.status).toBe(200);
  expect(received.error).toBeNull();
  expect(received.data?.collections.map(({ id }) => id)).toEqual(readable.map(({ id }) => id));
  const receivedEmpty = await zoneCollections(client, empty.id).get();
  expect(receivedEmpty.status).toBe(200);
  expect(receivedEmpty.data).toEqual({ collections: [], next: null });
  const receivedConcealed = await zoneCollections(client, hiddenZone.id).get();
  expect(receivedConcealed.status).toBe(404);
  expect(receivedConcealed.data).toBeNull();
  expect(receivedConcealed.error?.value).toMatchObject({ code: 'not_found', status: 404 });

  const changed = await f.call('owner', 'PATCH', `/v1/collections/${readable[0]!.id}`, {
    revision: readable[0]!.revision,
    visibility: 'private',
  });
  expect(changed.status).toBe(200);
  const hiddenAnchor = await list(mounted.id, 'editor', `?limit=1&cursor=${encodeURIComponent(first.next!)}`);
  expect(hiddenAnchor.status).toBe(409);
  expect(problem(hiddenAnchor.body).code).toBe('stale_cursor');

  const current = await f.configuration(mounted.id);
  const configured = await f.call(
    'owner',
    'PUT',
    `/v1/zones/${mounted.id}/configuration`,
    { configuration: current.body.configuration, mounts: current.body.mounts },
    f.conditional(current.body.zone.revision),
  );
  expect(configured.status).toBe(200);
  const changedBasis = await list(mounted.id, 'editor', `?limit=1&cursor=${encodeURIComponent(first.next!)}`);
  expect(changedBasis.status).toBe(409);
  expect(problem(changedBasis.body).code).toBe('stale_cursor');

  let unavailableId: string | null = null;
  let revokeAtFinal: { id: string; attempts: number } | null = null;
  const nativeAccess = f.access.access.bind(f.access);
  f.access.access = (config) => {
    const currentAccess = nativeAccess(config);
    return new Proxy(currentAccess, {
      get(target, property, receiver) {
        if (property !== 'prepare' || !target.prepare) return Reflect.get(target, property, receiver);
        const prepare = target.prepare.bind(target);
        const intercepted: NonNullable<Access['prepare']> = async (actor, action, resource, context) => {
          if (action === 'collection:read' && resource.id === unavailableId) {
            unavailableId = null;
            throw new ProblemError('dependency_unavailable', { headers: { 'retry-after': '7' } });
          }
          if (action === 'collection:read' && revokeAtFinal?.id === resource.id) {
            revokeAtFinal.attempts++;
            if (revokeAtFinal.attempts === 2) {
              const sourceRoute = routeOf(resource.id)!;
              revokeAtFinal = null;
              await f.access.revoke({ route: sourceRoute, id: resource.id }, 'editor', 'collection:read');
            }
          }
          return prepare(actor, action, resource, context);
        };
        return intercepted;
      },
    });
  };

  unavailableId = readable[1]!.id;
  const unavailable = await list(mounted.id);
  expect(unavailable.status).toBe(503);
  expect(problem(unavailable.body).code).toBe('dependency_unavailable');
  expect(unavailable.headers.get('retry-after')).toBe('7');
  expect(unavailable.headers.get('cache-control')).toBe('private, no-store');
  unavailableId = readable[1]!.id;
  const receivedUnavailable = await zoneCollections(client, mounted.id).get();
  expect(receivedUnavailable.status).toBe(503);
  expect(receivedUnavailable.data).toBeNull();
  expect(receivedUnavailable.error?.value).toMatchObject({ code: 'dependency_unavailable', status: 503 });

  const finalWindowSource = await collection('final-window-private', 'private');
  const sourceRoute = routeOf(finalWindowSource.id)!;
  await f.access.grant({ route: sourceRoute, id: finalWindowSource.id }, 'editor', 'collection:read');
  const finalWindowZone = await zone([finalWindowSource.id]);
  revokeAtFinal = { id: finalWindowSource.id, attempts: 0 };
  const revokedDuringRead = await list(finalWindowZone.id);
  expect(revokedDuringRead.status).toBe(409);
  expect(problem(revokedDuringRead.body).code).toBe('conflict');
  expect(JSON.stringify(revokedDuringRead.body)).not.toContain(finalWindowSource.id);

  const revokedBetweenPages = await Promise.all([
    collection('revoked-anchor', 'private'),
    collection('after-revoked-anchor', 'private'),
  ]);
  for (const source of revokedBetweenPages)
    await f.access.grant({ route: routeOf(source.id)!, id: source.id }, 'editor', 'collection:read');
  const permissionZone = await zone(revokedBetweenPages.map(({ id }) => id));
  const permissionPage = page(await list(permissionZone.id, 'editor', '?limit=1'));
  expect(permissionPage.collections[0]!.id).toBe(revokedBetweenPages[0]!.id);
  await f.access.revoke(
    { route: routeOf(revokedBetweenPages[0]!.id)!, id: revokedBetweenPages[0]!.id },
    'editor',
    'collection:read',
  );
  const revokedCursor = await list(
    permissionZone.id,
    'editor',
    `?limit=1&cursor=${encodeURIComponent(permissionPage.next!)}`,
  );
  expect(revokedCursor.status).toBe(409);
  expect(problem(revokedCursor.body).code).toBe('stale_cursor');

  const lifecycleZone = await zone([sources[8]!.id, sources[14]!.id]);
  const lifecyclePage = page(await list(lifecycleZone.id, 'editor', '?limit=1'));
  const lifecycleCursor = lifecyclePage.next!;
  const currentSource = await f.call('owner', 'GET', `/v1/collections/${sources[8]!.id}`);
  const deletedSource = await f.call(
    'owner',
    'DELETE',
    `/v1/collections/${sources[8]!.id}?revision=${currentSource.body.collection.revision}`,
  );
  expect(deletedSource.status).toBe(204);
  const deletedContinuation = await list(
    lifecycleZone.id,
    'editor',
    `?limit=1&cursor=${encodeURIComponent(lifecycleCursor)}`,
  );
  expect(deletedContinuation.status).toBe(409);
  expect(problem(deletedContinuation.body).code).toBe('stale_cursor');
  const restoredSource = await f.call('owner', 'POST', `/v1/collections/${sources[8]!.id}:restore`, {
    deletionId: deletedSource.headers.get('library-collection-deletion-id'),
    revision: Number(deletedSource.headers.get('library-collection-deletion-revision')),
  });
  expect(restoredSource.status).toBe(200);
  const restoredContinuation = page(
    await list(lifecycleZone.id, 'editor', `?limit=1&cursor=${encodeURIComponent(lifecycleCursor)}`),
  );
  expect(restoredContinuation.collections.map(({ id }) => id)).toEqual([sources[14]!.id]);

  await suspendAccount(f.db.admin, f.accounts.owner);
  const suspendedOwner = await list(mounted.id);
  expect(suspendedOwner.status).toBe(404);
  expect(problem(suspendedOwner.body).code).toBe('not_found');
}, 240_000);
