import { expect, test } from 'bun:test';
import {
  createFollowCountReadApplication,
  deliverFollowCountApplication,
  runFollowCountPartition,
} from '../../src/library/application/index.ts';
import {
  FollowCountReadRefusedError,
  FollowCountTargetAbsentError,
  FollowCountUnavailableError,
  type CountKey,
  type FollowCountDeliveryPorts,
  type FollowCountReadPorts,
  type LibraryAccountActor,
} from '../../src/library/contract/index.ts';
import { followCountHealthCurrent } from '../../src/library/core/index.ts';

const owner: LibraryAccountActor = {
  kind: 'account',
  accountId: 'owner',
  clientId: 'client',
  scopes: ['follow:list'],
  requestedBy: null,
  authnEpoch: 1,
};
const target = { targetType: 'subject', targetId: 'original' } as const;
const key: CountKey = { ...target, accountId: owner.accountId };
const time = Object.freeze({ nativeTime: 'retained' });
const health = {
  sampledAt: 'sample',
  oldestPendingAt: null,
  consumerObservedAt: 'consumer',
  consumerOldestPendingAt: null,
};

function reads(overrides: Partial<FollowCountReadPorts<typeof time>> = {}) {
  const calls: string[] = [];
  const ports: FollowCountReadPorts<typeof time> = {
    route: () => 16,
    async authenticate(actor, deadline) {
      expect(actor).toBe(owner);
      expect(deadline).toBe(123);
      calls.push('authority');
      return time;
    },
    async health() {
      calls.push('health');
      return health;
    },
    async within(deadline, body) {
      expect(deadline).toBe(123);
      return body();
    },
    async destination() {
      calls.push('identity');
      return { route: 16, targetId: 'terminal', epoch: 1n };
    },
    async subjectReadable(actor, id, at) {
      expect(actor).toBe(owner);
      expect(id).toBe('original');
      expect(at).toBe(time);
      return true;
    },
    async accountForAgent(id) {
      expect(id).toBe('terminal');
      calls.push('agent');
      return owner.accountId;
    },
    async collection() {
      return { state: 'active', visibility: 'public', curatorAccountId: null };
    },
    async accountState() {
      return 'active';
    },
    async spaceExists() {
      return true;
    },
    async management(actor, action, id, at, deadline) {
      expect(actor).toBe(owner);
      expect(at).toBe(time);
      expect(deadline).toBe(123);
      calls.push(`${action}:${id}`);
      return true;
    },
    async total() {
      calls.push('total');
      return '0';
    },
    async outgoing() {
      calls.push('outgoing');
      return '0';
    },
    ...overrides,
  };
  return { calls, ports, app: createFollowCountReadApplication(ports) };
}

test('private counts admit current authority, retain native time and distinguish ready zero from unknown', async () => {
  const { app, calls } = reads();
  expect(await app.target(owner, target, 123)).toEqual({ ...target, followerCount: 0 });
  expect(calls).toEqual(['authority', 'health', 'identity', 'agent', 'total', 'identity', 'agent', 'health']);
  expect(await app.outgoing(owner, 123)).toEqual({ followingCount: 0 });
  for (const value of [undefined, '-1', '1.5', '9007199254740992']) {
    const { app } = reads({
      async total() {
        return value;
      },
      async outgoing() {
        return value;
      },
    });
    await expect(app.target(owner, target, 123)).rejects.toBeInstanceOf(FollowCountUnavailableError);
    await expect(app.outgoing(owner, 123)).rejects.toBeInstanceOf(FollowCountUnavailableError);
  }
  const denied = reads({
    async authenticate() {
      throw new Error('revoked');
    },
  });
  await expect(denied.app.outgoing(owner, 123)).rejects.toThrow('revoked');
  expect(denied.calls).toEqual([]);
  await expect(app.outgoing({ kind: 'anonymous' }, 123)).rejects.toBeInstanceOf(FollowCountReadRefusedError);
});

test('final health, identity epoch and agent binding can each withhold a provisional scalar', async () => {
  let samples = 0;
  const unhealthy = reads({
    async health() {
      if (++samples === 2) throw new FollowCountUnavailableError();
      return health;
    },
  });
  await expect(unhealthy.app.outgoing(owner, 123)).rejects.toBeInstanceOf(FollowCountUnavailableError);
  expect(unhealthy.calls).toEqual(['authority', 'outgoing']);
  for (const changed of ['epoch', 'binding'] as const) {
    let identities = 0,
      bindings = 0;
    const { app } = reads({
      async destination() {
        return { route: 16, targetId: 'terminal', epoch: ++identities === 2 && changed === 'epoch' ? 2n : 1n };
      },
      async accountForAgent() {
        return ++bindings === 2 && changed === 'binding' ? 'other' : owner.accountId;
      },
    });
    await expect(app.target(owner, target, 123)).rejects.toBeInstanceOf(FollowCountUnavailableError);
  }
  const missing = reads({
    async accountForAgent() {
      return null;
    },
  });
  await expect(missing.app.target(owner, target, 123)).rejects.toBeInstanceOf(FollowCountTargetAbsentError);
  expect(missing.calls).not.toContain('total');
});

test('nonpublic Collection counts retain curator terminal fencing and native management checks', async () => {
  const collection = { targetType: 'collection', targetId: 'collection' } as const;
  const { app, calls } = reads();
  expect(await app.target(owner, collection, 123)).toEqual({ ...collection, followerCount: 0 });
  expect(calls).toContain('collection:update:collection');
  const withdrawn = reads({
    async collection() {
      return { state: 'active', visibility: 'private', curatorAccountId: 'curator' };
    },
    async accountState() {
      return 'deleted';
    },
  });
  await expect(withdrawn.app.target(owner, collection, 123)).rejects.toBeInstanceOf(FollowCountTargetAbsentError);
  expect(withdrawn.calls).not.toContain('total');
});

test('delivery re-reads current source, retains the receiving locator before apply and never ACKs a failed commit', async () => {
  const calls: string[] = [];
  const replacement = { ...key, revision: '9', eligible: false };
  const destination = { route: 16, targetId: 'terminal', epoch: 5n };
  const ports: FollowCountDeliveryPorts = {
    async destination(input) {
      expect(input).toBe(key);
      calls.push('identity');
      return destination;
    },
    async reconcile(input) {
      expect(input).toBe(key);
      calls.push('source');
      return replacement;
    },
    async stage(input, current, target) {
      expect(input).toBe(key);
      expect(current).toBe(replacement);
      expect(target).toBe(destination);
      calls.push('retain');
      return true;
    },
    async apply(current, target) {
      expect(current).toBe(replacement);
      expect(target).toBe(destination);
      calls.push('commit');
    },
    async acknowledge(current) {
      expect(current).toBe(replacement);
      calls.push('ack');
    },
  };
  await deliverFollowCountApplication(ports, key);
  expect(calls).toEqual(['identity', 'source', 'retain', 'commit', 'ack']);
  calls.length = 0;
  await expect(
    deliverFollowCountApplication(
      {
        ...ports,
        async apply() {
          throw new Error('target failed');
        },
      },
      key,
    ),
  ).rejects.toThrow('target failed');
  expect(calls).toEqual(['identity', 'source', 'retain']);
  calls.length = 0;
  await deliverFollowCountApplication(
    {
      ...ports,
      async stage() {
        return false;
      },
    },
    key,
  );
  expect(calls).toEqual(['identity', 'source']);
});

test('partition segments retain the bounded account drain, locator delivery cap and failure health sample', async () => {
  let pages = 0,
    deliveries = 0,
    samples = 0;
  const ports = {
    async targets() {
      return { examined: 0, complete: true };
    },
    async discover() {
      return { examined: 0, complete: true };
    },
    async owner() {
      return { examined: 0, complete: true };
    },
    async accountKey() {
      return owner.accountId;
    },
    async accountPage() {
      pages++;
      return { examined: 100, complete: false };
    },
    async pending() {
      return Array.from({ length: 100 }, () => key);
    },
    async deliver() {
      deliveries++;
    },
    async sample() {
      samples++;
    },
  };
  expect(await runFollowCountPartition(ports, 1)).toBe(true);
  expect([pages, deliveries, samples]).toEqual([16, 70, 1]);
  await expect(
    runFollowCountPartition(
      {
        ...ports,
        async deliver() {
          throw new Error('retry');
        },
      },
      1,
    ),
  ).rejects.toThrow('retry');
  expect(samples).toBe(2);
  const now = 1_000_000;
  const current = {
    now,
    sampledAt: now - 295_000,
    oldestPendingAt: null,
    consumer: { observedAt: now, oldestPendingAt: null },
  };
  expect(followCountHealthCurrent(current)).toBe(true);
  expect(followCountHealthCurrent({ ...current, sampledAt: current.sampledAt - 1 })).toBe(false);
  expect(followCountHealthCurrent({ ...current, consumer: null })).toBe(false);
});

test('default Library composition supplies executable Follow producers', async () => {
  const { composeLibraryDomain, peekLibraryDomain, bindLibraryDomain, unbindLibraryDomain } =
    await import('../../src/composition/library.ts');
  const previous = peekLibraryDomain();
  try {
    const runtime = composeLibraryDomain().followCounts!;
    const reads = runtime.reads({}, {});
    await expect(reads.outgoing({ kind: 'anonymous' }, 123)).rejects.toMatchObject({ code: 'authentication_required' });
    expect(
      await runtime.destination({}, { targetType: 'collection', targetId: '00000000-0000-7000-8000-001000000001' }),
    ).toEqual({
      targetId: '00000000-0000-7000-8000-001000000001',
      route: 16,
      epoch: null,
    });
    expect(runtime.validAccountEvent('com.rezics.access.account.suspended.v1', {})).toBe(false);
  } finally {
    if (previous) bindLibraryDomain(previous);
    else unbindLibraryDomain();
  }
});
