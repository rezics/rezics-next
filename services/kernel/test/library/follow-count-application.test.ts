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
const time: Readonly<{ nativeTime: string }> = Object.freeze({ nativeTime: 'retained' });
const home = Object.freeze({ nativeHome: 'initial' });
const health = {
  sampledAt: 'sample',
  oldestPendingAt: null,
  consumerObservedAt: 'consumer',
  consumerOldestPendingAt: null,
};

function reads(overrides: Partial<FollowCountReadPorts<typeof time, typeof home>> = {}) {
  const calls: string[] = [];
  const ports: FollowCountReadPorts<typeof time, typeof home> = {
    route: () => 16,
    async admit(actor, deadline, expected) {
      expect(actor).toBe(owner);
      expect(deadline).toBe(123);
      if (expected !== undefined) expect(expected).toBe(home);
      calls.push(expected === undefined ? 'authority' : 'readmit');
      return home;
    },
    async time(deadline) {
      expect(deadline).toBe(123);
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
  expect(calls).toEqual([
    'authority',
    'health',
    'identity',
    'agent',
    'total',
    'health',
    'identity',
    'agent',
    'readmit',
  ]);
  expect(await app.outgoing(owner, 123)).toEqual({ followingCount: 0 });
  expect(calls.slice(-4)).toEqual(['health', 'outgoing', 'health', 'readmit']);
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
    async admit() {
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
  for (const changed of ['epoch', 'binding', 'terminal'] as const) {
    let identities = 0,
      bindings = 0;
    const { app } = reads({
      async destination() {
        const moved = ++identities === 2;
        return {
          route: 16,
          targetId: moved && changed === 'terminal' ? 'relocated' : 'terminal',
          epoch: moved && changed === 'epoch' ? 2n : 1n,
        };
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
  let states = 0;
  const changed = reads({
    async collection() {
      return { state: 'active', visibility: 'private', curatorAccountId: 'curator' };
    },
    async accountState() {
      return ++states === 1 ? 'active' : 'deleted';
    },
  });
  await expect(changed.app.target(owner, collection, 123)).rejects.toBeInstanceOf(FollowCountTargetAbsentError);
  expect(changed.calls).toContain('total');
  expect(changed.calls.at(-1)).toBe('readmit');
});

test('both count reads withhold assembled totals when final caller or stable-home admission fails', async () => {
  for (const operation of ['target', 'outgoing'] as const) {
    let assembled = false;
    const { app, calls } = reads({
      async accountForAgent() {
        return 'managed-account';
      },
      async management() {
        return !assembled;
      },
      async total() {
        assembled = true;
        return '17';
      },
      async outgoing() {
        assembled = true;
        return '19';
      },
      async admit(actor, deadline, expected) {
        expect(actor).toBe(owner);
        expect(deadline).toBe(123);
        if (expected) {
          expect(expected).toBe(home);
          expect(assembled).toBe(true);
          expect(calls.filter((call) => call === 'health')).toHaveLength(2);
          throw new FollowCountReadRefusedError('forbidden');
        }
        return home;
      },
    });
    await expect(
      operation === 'target' ? app.target(owner, target, 123) : app.outgoing(owner, 123),
    ).rejects.toBeInstanceOf(FollowCountReadRefusedError);
  }
});

test('final target management uses a fresh native instant and preserves target-specific authority', async () => {
  const current = { nativeTime: 'current' };
  for (const targetType of ['subject', 'collection', 'space'] as const) {
    let times = 0;
    const checked: string[] = [];
    const { app, calls } = reads({
      async time() {
        return times++ === 0 ? time : current;
      },
      async accountForAgent() {
        return 'managed-account';
      },
      async subjectReadable() {
        return true;
      },
      async management(actor, action, id, at, deadline) {
        expect(actor).toBe(owner);
        expect(deadline).toBe(123);
        checked.push(`${action}:${id}`);
        expect(at).toBe(checked.length === 1 ? time : current);
        return checked.length === 1;
      },
    });
    await expect(app.target(owner, { targetType, targetId: 'original' }, 123)).rejects.toBeInstanceOf(
      FollowCountTargetAbsentError,
    );
    const action = {
      subject: 'account:manage:managed-account',
      collection: 'collection:update:original',
      space: 'space:manage:original',
    }[targetType];
    expect(checked).toEqual([action, action]);
    expect(calls).toContain('total');
    expect(calls.at(-1)).toBe('readmit');
  }
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
