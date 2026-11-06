import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { interval, loadAccess, parseChange, writeAccess, type Change } from '../src/accounts/resource-access/data';
import { AccessRecovery } from '../src/accounts/resource-access/recovery';
import { snapshot, resourceId, readerId } from '../src/stories/pages/accounts-resource-access/fixtures';

const change: Omit<Change, 'key'> = {
  resourceId,
  operation: 'change',
  kind: 'direct',
  subject: { kind: 'account', id: readerId },
  role: null,
  actions: ['collection:update'],
  valid: '[,)',
  previous: { actions: ['collection:read'], role: null, valid: snapshot.grants[0]!.valid },
};

test('generated grant transports use exact target, current authority, native compare values and one key after a lost response', async () => {
  const calls: { path: string; method: string; authorization: string | null; key: string | null; body: unknown }[] = [];
  let writes = 0;
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      calls.push({
        path: new URL(request.url).pathname,
        method: request.method,
        authorization: request.headers.get('authorization'),
        key: request.headers.get('idempotency-key'),
        body: request.method === 'GET' ? null : await request.json(),
      });
      if (request.method === 'GET') return Response.json(snapshot);
      if (++writes === 1) throw new Error('Lost response');
      return Response.json({ grant: { ...change, resource: { id: resourceId, route: 1 } } });
    }) as typeof fetch,
  });
  const recovery = new AccessRecovery(
    { status: 'ready', page: snapshot },
    {
      read: () => loadAccess(client, 'Bearer current', resourceId),
      save: (input) => writeAccess(client, 'Bearer current', input),
      lookup: async () => null,
    },
  );
  await recovery.submit(change);
  expect(recovery.snapshot().phase).toBe('uncertain');
  const pending = structuredClone(recovery.snapshot().pending);
  await recovery.submit({ ...change, actions: ['collection:delete'] });
  expect(writes).toBe(1);
  await recovery.reload();
  expect(recovery.snapshot().pending).toEqual(pending);
  await recovery.retry();
  expect(recovery.snapshot().phase).toBe('saved');
  expect(recovery.snapshot().pending).toBeNull();
  const posts = calls.filter((call) => call.method === 'POST');
  expect(posts.map((call) => call.path)).toEqual(['/v1/grants:change', '/v1/grants:change']);
  expect(posts[0]!.key).toBe(posts[1]!.key);
  expect(posts[0]!.body).toEqual(posts[1]!.body);
  expect(posts[0]!.body).toEqual({
    resource: { route: 1, id: resourceId },
    subject: change.subject,
    actions: change.actions,
    valid: change.valid,
    previous: { actions: change.previous!.actions, valid: change.previous!.valid },
  });
  expect(calls.every((call) => call.authorization === 'Bearer current')).toBe(true);
  expect(calls.at(-1)!.method).toBe('GET');
});

test('native refusal refreshes current authority; a stranger never receives a successful empty ACL', async () => {
  let reads = 0;
  let posts = 0;
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      if (request.method !== 'GET') {
        posts++;
        return Response.json({ type: 'forbidden' }, { status: 403 });
      }
      return ++reads === 1 ? Response.json(snapshot) : Response.json({ type: 'not_found' }, { status: 404 });
    }) as typeof fetch,
  });
  const recovery = new AccessRecovery(
    { status: 'ready', page: snapshot },
    {
      read: () => loadAccess(client, 'Bearer current', resourceId),
      save: (input) => writeAccess(client, 'Bearer current', input),
      lookup: async () => null,
    },
  );
  await recovery.submit(change);
  expect(posts).toBe(1);
  expect(recovery.snapshot().phase).toBe('refused');
  expect(recovery.snapshot().page).toEqual({ status: 'denied' });
  expect(await writeAccess(client, 'Bearer current', { ...change, key: crypto.randomUUID() })).toEqual({
    status: 'denied',
  });
  expect(posts).toBe(1);
});

test('role commands preserve native role and interval; Realm ownership guard absence never dispatches a mutation', async () => {
  let guarded = false;
  const paths: string[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      paths.push(new URL(request.url).pathname);
      if (request.method === 'GET')
        return Response.json({ ...snapshot, mutationState: guarded ? 'realm_guard_unavailable' : 'ready' });
      const body = (await request.json()) as { role: string; previous: { role: string; valid: string } };
      expect(body.role).toBe('library.collection.owner');
      expect(body.previous).toEqual({ role: 'library.collection.owner', valid: snapshot.grants[0]!.valid });
      return Response.json({ grant: body });
    }) as typeof fetch,
  });
  const roleChange: Change = {
    ...change,
    key: crypto.randomUUID(),
    kind: 'role',
    role: 'library.collection.owner',
    previous: { ...change.previous!, role: 'library.collection.owner' },
  };
  expect(await writeAccess(client, 'Bearer current', roleChange)).toEqual({ status: 'saved' });
  expect(paths).toEqual(['/v1/grants', '/v1/roleGrants:change']);
  guarded = true;
  expect(await writeAccess(client, 'Bearer current', roleChange)).toEqual({ status: 'preparing' });
  expect(paths.at(-1)).toBe('/v1/grants');
});

test('intervals and closed input projection reject malformed values without accepting supplied authority', () => {
  expect(interval('2026-11-02T10:00', '2026-11-01T10:00')).toBeNull();
  expect(interval('', '')).toBe('[,)');
  expect(
    parseChange({ ...change, key: crypto.randomUUID(), subject: { kind: 'realm', id: resourceId, role: 'member' } }),
  ).toBeNull();
  expect(
    parseChange({ ...change, key: crypto.randomUUID(), actor: { accountId: readerId }, resource: { route: 99 } }),
  ).toEqual({ ...change, key: expect.any(String) });
  expect(
    parseChange({ ...change, key: crypto.randomUUID(), subject: { kind: 'account', id: 'not-an-id' } }),
  ).toBeNull();
});
