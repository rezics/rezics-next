import { expect, test } from 'bun:test';
import {
  createContainerLifecycle,
  mayRetryLifecycle,
  offeredActions,
  unavailableLifecycleAdapter,
  type ContainerLifecycleAdapter,
  type ContainerTarget,
  type LifecycleIntent,
  type LifecycleSnapshot,
} from '../src/community/container-lifecycle';

const target: ContainerTarget = { kind: 'realm', id: '01a17a3b-70ea-712a-9ff7-81fc6a9381b6' };
const contextId = '01a17a3b-70ea-712a-9ff7-81fc6a9381b7';
const firstHead = '01a17a3b-70ea-712a-9ff7-81fc6a9381b8';
const reason = '  Recorded moderation reason\nwith details  ';

// These focused consumer cases exercise the isolated adapter, not native admission or a restore clock.
test('current-authorized removal reason and restore journey preserves target identity, draft and native denial', async () => {
  let snapshot: LifecycleSnapshot = { target, head: firstHead, contextId, state: 'active', actions: ['remove'] };
  let allowed = true;
  let contextReadable = false;
  let keyNumber = 0;
  let destinationReads = 0;
  const requests: LifecycleIntent[] = [];
  const refusal = { kind: 'refused', status: 404, code: 'not_found' } as const;
  const adapter: ContainerLifecycleAdapter = {
    read: async () => ({ kind: 'ready', snapshot }),
    change: async (intent) => {
      requests.push(intent);
      if (!allowed) return refusal;
      snapshot = {
        ...snapshot,
        state: intent.action === 'remove' ? 'removed' : 'active',
        head: `confirmed-head-${requests.length}`,
        actions: intent.action === 'remove' ? ['restore'] : ['remove'],
      };
      return { kind: 'confirmed', target, action: intent.action, head: snapshot.head, contextId };
    },
    destination: async (anchor, pointer) => {
      destinationReads++;
      expect(anchor).toEqual(target);
      expect(pointer).toBe(contextId);
      return contextReadable
        ? { kind: 'available', target, contextId, href: '/en/spaces/reading-room?context=retained' }
        : { kind: 'unavailable' };
    },
  };
  const control = createContainerLifecycle(target, adapter, () => `intent-${++keyNumber}`);
  await control.refresh();
  await control.submit('remove');
  expect(requests).toHaveLength(0);
  control.setReason(reason);
  await control.submit('remove');
  expect(control.getSnapshot().outcome).toBe('confirmed');
  expect(control.getSnapshot().read).toEqual({ kind: 'ready', snapshot });
  expect(requests[0]).toEqual({
    target,
    contextId,
    expectedHead: firstHead,
    reason,
    action: 'remove',
    idempotencyKey: 'intent-1',
  });
  expect(offeredActions(control.getSnapshot())).toEqual(['restore']);
  expect(destinationReads).toBe(0);

  // Current native authority can refuse even a command offered by the preceding read.
  allowed = false;
  await control.submit('restore');
  const refusedIntent = control.getSnapshot().intent;
  expect(control.getSnapshot().problem).toEqual(refusal);
  expect(control.getSnapshot().outcome).toBe('refused');
  expect(control.getSnapshot().reason).toBe(reason);
  expect(control.getSnapshot().destination).toBeNull();
  expect(offeredActions(control.getSnapshot())).toEqual([]);
  snapshot = { ...snapshot, actions: [] };
  await control.refresh();
  expect(control.getSnapshot().intent).toBe(refusedIntent);
  expect(offeredActions(control.getSnapshot())).toEqual([]);

  // A new authoritative read, rather than remover/creator identity or a client clock, admits restoration.
  allowed = true;
  snapshot = { ...snapshot, actions: ['restore'] };
  await control.refresh();
  control.review();
  await control.submit('restore');
  expect(control.getSnapshot().outcome).toBe('confirmed');
  expect(control.getSnapshot().intent?.target).toEqual(target);
  expect(control.getSnapshot().intent?.contextId).toBe(contextId);
  expect(control.getSnapshot().reason).toBe(reason);
  expect(control.getSnapshot().destination).toBeNull();
  contextReadable = true;
  await control.refresh();
  expect(control.getSnapshot().destination).toBe('/en/spaces/reading-room?context=retained');
  snapshot = { ...snapshot, state: 'orphaned', actions: ['remove'] };
  await control.refresh();
  expect(offeredActions(control.getSnapshot())).toEqual([]);
  expect(control.getSnapshot().destination).toBeNull();
  const unavailable = createContainerLifecycle(target, unavailableLifecycleAdapter);
  await unavailable.refresh();
  expect(unavailable.getSnapshot().read.kind).toBe('unavailable');
  expect(offeredActions(unavailable.getSnapshot())).toEqual([]);
});

test('uncertain-response retry preserves intent and conflict keeps the original head until explicit review', async () => {
  const spaceTarget: ContainerTarget = { kind: 'space', id: target.id };
  let head = firstHead;
  let calls = 0;
  let keys = 0;
  const requests: LifecycleIntent[] = [];
  const adapter: ContainerLifecycleAdapter = {
    read: async () => ({
      kind: 'ready',
      snapshot: { target: spaceTarget, head, contextId: null, state: 'active', actions: ['remove'] },
    }),
    change: async (intent) => {
      requests.push(intent);
      if (++calls === 1) throw new Error('Response lost after possible commit');
      return { kind: 'refused', status: 412, code: 'precondition_failed' };
    },
    destination: async () => {
      throw new Error('A failed command must never request a destination');
    },
  };
  const control = createContainerLifecycle(spaceTarget, adapter, () => `intent-${++keys}`);
  await control.refresh();
  control.setReason(reason);
  await control.submit('remove');
  const intent = control.getSnapshot().intent;
  expect(control.getSnapshot().outcome).toBe('uncertain');
  expect(mayRetryLifecycle(control.getSnapshot())).toBe(true);
  head = 'new-real-head';
  await control.refresh();
  control.review();
  control.setReason('Must not overwrite an unresolved request');
  await control.submit('remove');
  expect(requests).toHaveLength(1);
  await control.retry();
  expect(requests[1]).toBe(requests[0]);
  expect(control.getSnapshot().intent).toBe(intent);
  expect(intent?.expectedHead).toBe(firstHead);
  expect(control.getSnapshot().outcome).toBe('conflict');
  expect(control.getSnapshot().reason).toBe(reason);
  control.review();
  expect(control.getSnapshot().intent).toBe(intent);
  await control.refresh();
  control.review();
  await control.submit('remove');
  expect(requests[2]).toEqual({ ...intent, expectedHead: head, idempotencyKey: 'intent-2' });
  expect(keys).toBe(2);
});

import { createKernelClient } from '@rezics/client';
import { nativeContainerLifecycleAdapter } from '../src/community/container-lifecycle-native';
import recordedRealm from '../src/kernel/recorded/realm.json';
import recordedSpace from '../src/kernel/recorded/space.json';

// Generated-client HTTP fixtures verify the consumer binding, not native role/clock correctness.
test('the assigned real current-authorized journey binds its native source while privacy retry and request bounds remain meaningful', async () => {
  const spaceId = recordedSpace.space.spaceId;
  let state: 'active' | 'removed' = 'active';
  let version = 0n;
  let spaceVersion = 0n;
  let contextReadable = false;
  let cycleHost = false;
  let catalogueOperation = 'realm.remove';
  let nativeRemove = true;
  const requests: { path: string; method: string; body: unknown }[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const body = request.method === 'POST' ? await request.json() : null;
      requests.push({ path, method: request.method, body });
      expect(request.headers.get('authorization')).toBe('Bearer current-viewer');
      const json = (value: unknown, status = 200) => Response.json(value, { status });
      if (path === `/v1/realms/${target.id}/lifecycle`)
        return json({
          container: {
            ...target,
            state,
            headRevisionId: firstHead,
            version: String(version),
            removedAt: state === 'removed' ? '2026-10-31T00:00:00Z' : null,
            reason: state === 'removed' ? reason : null,
            removerRole: state === 'removed' ? 'moderator' : null,
            mayRemove: nativeRemove && state === 'active',
            mayRestore: state === 'removed',
          },
        });
      if (path === `/v1/spaces/${spaceId}/lifecycle`)
        return json({
          container: {
            kind: 'space',
            id: spaceId,
            state: 'active',
            headRevisionId: recordedSpace.space.headRevisionId,
            version: String(spaceVersion),
            removedAt: null,
            reason: null,
            removerRole: null,
            mayRemove: false,
            mayRestore: false,
          },
        });
      if (path === `/v1/realms/${target.id}`)
        return state === 'removed'
          ? json({ code: 'not_found' }, 404)
          : json({
              realm: {
                ...recordedRealm.realm,
                realmId: target.id,
                spaceId,
                contextId,
                headRevisionId: firstHead,
                state,
                ownershipState: 'owned',
                governanceReadOnly: false,
              },
            });
      if (path === `/v1/spaces/${spaceId}`) return json({ space: { ...recordedSpace.space, realmId: target.id } });
      if (path === '/v1/viewerActions') {
        expect(body).toEqual({ resources: [{ type: 'community.realm', id: target.id }] });
        return json({
          resources: [
            {
              type: 'community.realm',
              id: target.id,
              viewerActions: [{ action: 'moderation:takedown', operations: [catalogueOperation] }],
            },
          ],
        });
      }
      if (path === `/v1/contexts/${contextId}`) {
        if (cycleHost) spaceVersion += 2n;
        return contextReadable
          ? json({ context: { id: contextId, kind: 'community', labels: {}, settings: null, defaults: {} } })
          : json({ code: 'not_found' }, 404);
      }
      if (path === `/v1/realms/${target.id}/removal` || path === `/v1/realms/${target.id}/restoration`) {
        const remove = path.endsWith('/removal');
        expect(request.method).toBe('POST');
        expect(request.headers.get('if-match')).toBe(JSON.stringify(firstHead));
        expect(request.headers.get('idempotency-key')).toBe(
          JSON.stringify(remove ? '018e8b20-1000-7000-8000-000000000001' : '018e8b20-1000-7000-8000-000000000002'),
        );
        expect(body).toEqual(
          remove ? { expectedVersion: String(version), reason } : { expectedVersion: String(version) },
        );
        state = remove ? 'removed' : 'active';
        version++;
        return json({ container: { ...target, state, headRevisionId: firstHead, version: String(version) } });
      }
      throw new Error(`Unexpected lifecycle request: ${request.method} ${path}`);
    }) as typeof fetch,
  });
  let keys = 0;
  const control = createContainerLifecycle(
    target,
    nativeContainerLifecycleAdapter(client, 'Bearer current-viewer', 'en'),
    () => `018e8b20-1000-7000-8000-${String(++keys).padStart(12, '0')}`,
  );
  await control.refresh();
  expect(requests).toHaveLength(5);
  expect(offeredActions(control.getSnapshot())).toEqual(['remove']);
  control.setReason(reason);
  await control.submit('remove');
  expect(control.getSnapshot().outcome).toBe('confirmed');
  expect(control.getSnapshot().intent?.expectedVersion).toBe('0');
  expect(control.getSnapshot().intent?.contextId).toBe(contextId);
  expect(control.getSnapshot().read).toMatchObject({
    kind: 'ready',
    snapshot: { version: '1', contextId, state: 'removed' },
  });
  expect(offeredActions(control.getSnapshot())).toEqual(['restore']);
  expect(requests).toHaveLength(7);
  await control.submit('restore');
  expect(control.getSnapshot().outcome).toBe('confirmed');
  expect(control.getSnapshot().intent?.expectedVersion).toBe('1');
  expect(control.getSnapshot().destination).toBeNull();
  expect(control.getSnapshot().reason).toBe(reason);
  expect(requests).toHaveLength(19);
  contextReadable = true;
  await control.refresh();
  expect(control.getSnapshot().destination).toBe(`/en/realms/${target.id}`);
  expect(requests).toHaveLength(35);
  // A host lifecycle cycle changes no editorial head or Context pointer, but invalidates the prepared link.
  cycleHost = true;
  await control.refresh();
  expect(control.getSnapshot().destination).toBeNull();
  expect(requests).toHaveLength(51);
  cycleHost = false;
  control.review();
  catalogueOperation = 'realm:remove';
  await control.refresh();
  expect(offeredActions(control.getSnapshot())).toEqual([]);
  catalogueOperation = 'realm.remove';
  nativeRemove = false;
  await control.refresh();
  expect(offeredActions(control.getSnapshot())).toEqual([]);
  expect(requests.filter((request) => request.path.endsWith('/removal'))).toHaveLength(1);
});

test('native Space retry retains the exact reason, quoted key, head and lifecycle version through privacy loss and CAS conflict', async () => {
  const anchor: ContainerTarget = { kind: 'space', id: recordedSpace.space.spaceId };
  let version = 9007199254740993n;
  let state: 'active' | 'removed' = 'active';
  let hidden = false;
  let keys = 0;
  const writes: { body: unknown; match: string | null; key: string | null }[] = [];
  let reads = 0;
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      expect(request.headers.get('authorization')).toBe('Bearer current-owner');
      if (path === `/v1/spaces/${anchor.id}/removal`) {
        writes.push({
          body: await request.json(),
          match: request.headers.get('if-match'),
          key: request.headers.get('idempotency-key'),
        });
        if (writes.length === 1) {
          version++;
          throw new Error('Response lost after possible commit');
        }
        if (writes.length === 2) return Response.json({ code: 'precondition_failed' }, { status: 412 });
        expect(writes.at(-1)?.body).toEqual({ expectedVersion: String(version), reason });
        state = 'removed';
        version++;
        return Response.json({ container: { ...anchor, state, headRevisionId: firstHead, version: String(version) } });
      }
      reads++;
      if (path === `/v1/spaces/${anchor.id}/lifecycle`)
        return hidden
          ? Response.json({ code: 'not_found' }, { status: 404 })
          : Response.json({
              container: {
                ...anchor,
                state,
                headRevisionId: firstHead,
                version: String(version),
                removedAt: null,
                removerRole: null,
                reason: null,
                mayRemove: state === 'active',
                mayRestore: false,
              },
            });
      if (path === `/v1/spaces/${anchor.id}`)
        return Response.json({ space: { ...recordedSpace.space, realmId: null, headRevisionId: firstHead } });
      if (path === '/v1/viewerActions')
        return Response.json({
          resources: [
            {
              type: 'community.space',
              id: anchor.id,
              viewerActions: [{ action: 'space:manage', operations: ['space.remove'] }],
            },
          ],
        });
      throw new Error(`Unexpected lifecycle request: ${request.method} ${path}`);
    }) as typeof fetch,
  });
  const control = createContainerLifecycle(
    anchor,
    nativeContainerLifecycleAdapter(client, 'Bearer current-owner', 'en'),
    () => `018e8b20-1000-7000-8000-${String(++keys).padStart(12, '0')}`,
  );
  await control.refresh();
  control.setReason(reason);
  await control.submit('remove');
  const intent = control.getSnapshot().intent;
  expect(intent?.expectedVersion).toBe('9007199254740993');
  expect(control.getSnapshot().outcome).toBe('uncertain');
  hidden = true;
  await control.refresh();
  expect(control.getSnapshot().read).toEqual({ kind: 'refused', status: 404, code: 'not_found' });
  await control.retry();
  expect(writes).toHaveLength(1);
  expect(mayRetryLifecycle(control.getSnapshot())).toBe(false);
  hidden = false;
  await control.refresh();
  control.setReason('Must retain the original request');
  await control.retry();
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[0]).toEqual({
    body: { expectedVersion: '9007199254740993', reason },
    match: JSON.stringify(firstHead),
    key: JSON.stringify('018e8b20-1000-7000-8000-000000000001'),
  });
  expect(control.getSnapshot().intent).toBe(intent);
  expect(control.getSnapshot().outcome).toBe('conflict');
  control.review();
  await control.submit('remove');
  expect(writes).toHaveLength(2);
  await control.refresh();
  control.review();
  await control.submit('remove');
  expect(writes[2]?.match).toBe(writes[0]?.match);
  expect(writes[2]?.key).toBe(JSON.stringify('018e8b20-1000-7000-8000-000000000002'));
  expect(control.getSnapshot().outcome).toBe('confirmed');
  expect(control.getSnapshot().reason).toBe(reason);
  expect(reads).toBe(17);
  expect(keys).toBe(2);
});
