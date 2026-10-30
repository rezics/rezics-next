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
