import { expect, test } from 'bun:test';
import { createCollectionMutationApplication } from '../../src/library/application/index.ts';
import { createCollectionHistoryPlans, collectionRetentionDisposition } from '../../src/library/core/index.ts';
import type {
  Collection,
  CollectionMutationPorts,
  CollectionMetadataHistorySqlPlan,
} from '../../src/library/contract/index.ts';

const before: Collection = {
  id: 'collection',
  curatorAccountId: 'owner',
  title: 'Before',
  description: null,
  visibility: 'public',
  presentationKind: null,
  coverMediaId: null,
  state: 'active',
  revision: 4,
  memberCount: 2,
  orderEpoch: 7,
  createdAt: '2026-11-07T00:00:00Z',
  updatedAt: '2026-11-07T00:00:00Z',
  membershipKind: 'dynamic',
};
const context = { route: 1, transactionId: 'original-transaction', time: '2026-11-07T01:00:00Z' };
const ceiling = {
  candidateKeys: 1e9,
  nativeRows: 1e9,
  identityMetadataRows: 1e9,
  emptySeeks: 1e9,
  nativePoints: 1e9,
  witnessKeys: 1e9,
  statements: 1e9,
  bytes: 1e9,
  engineRequests: 1e9,
};
const statement = { bytes: 512 };
const plans = createCollectionHistoryPlans(
  {
    append: statement,
    init: statement,
    owner: statement,
    page: statement,
    prune: statement,
    pruned: statement,
    read: statement,
    state: statement,
  },
  ceiling,
);

function fixture() {
  const tx = Object.freeze({ custody: 'original-query-client' });
  const calls: string[] = [];
  const observed: CollectionMetadataHistorySqlPlan[] = [];
  const effect = (name: string, client: typeof tx, plan?: CollectionMetadataHistorySqlPlan) => {
    expect(client).toBe(tx);
    calls.push(name);
    if (plan) observed.push(plan);
  };
  const ports: CollectionMutationPorts<typeof tx> = {
    planCapture: plans.collectionMetadataHistoryCapturePlan,
    async initialize(client) {
      effect('initialize', client);
    },
    async owner(client, plan) {
      effect('owner', client, plan);
    },
    async append(client, plan) {
      effect('append', client, plan);
      return 1;
    },
    async prune(client, plan) {
      effect('prune', client, plan);
      return 1;
    },
    async pruned(client, plan) {
      effect('pruned', client, plan);
    },
  };
  return { tx, calls, observed, app: createCollectionMutationApplication(ports) };
}

const conflict = (): never => {
  throw new Error('CAS conflict');
};

test('creation and immutable metadata history retain the original transaction and planned operands', async () => {
  const f = fixture();
  const draft = { id: before.id, curatorAccountId: 'owner' };
  expect(
    await f.app.create(f.tx, { ...context, collection: draft }, async () => {
      f.calls.push('insert');
      return before;
    }),
  ).toBe(before);
  expect(f.calls).toEqual(['insert', 'initialize']);
  f.calls.length = 0;
  const after = { ...before, title: 'After', revision: 5 };
  const input = { ...context, before, after };
  const plan = plans.collectionMetadataHistoryCapturePlan(input);
  after.title = 'Later mutable caller value';
  await f.app.captureHistory(f.tx, input, plan);
  expect(f.calls).toEqual(['owner', 'append', 'prune', 'pruned']);
  expect(plan.input.after.title).toBe('After');
  expect(plan.changedFields).toEqual(['title']);
  expect(f.observed).toEqual([plan.leaves.owner!, plan.leaves.append!, plan.leaves.prune!, plan.leaves.pruned!]);
  f.calls.length = 0;
  await f.app.captureHistory(f.tx, { ...context, before, after: { ...before, revision: 5 } });
  expect(f.calls).toEqual([]);
});

test('metadata CAS refusal has no effects; visibility changes journal before retiring publication and reducing Source', async () => {
  const f = fixture();
  const after = { ...before, visibility: 'private' as const, revision: 5 };
  const effects = {
    conflict,
    async write() {
      f.calls.push('write');
      return after;
    },
    async retirePublication() {
      f.calls.push('retire');
    },
    async reducePublicSource() {
      f.calls.push('reduce');
    },
    async readCurrent() {
      f.calls.push('reread');
      return after;
    },
  };
  await expect(
    f.app.updateMetadata(
      f.tx,
      {
        ...context,
        before,
        revision: 3,
        changes: after,
      },
      effects,
    ),
  ).rejects.toThrow('CAS conflict');
  expect(f.calls).toEqual([]);
  expect(
    await f.app.updateMetadata(
      f.tx,
      {
        ...context,
        before,
        revision: 4,
        changes: after,
      },
      effects,
    ),
  ).toBe(after);
  expect(f.calls).toEqual(['write', 'owner', 'append', 'prune', 'pruned', 'retire', 'reduce', 'reread']);
});

test('unchanged pinned rules preserve their revision; a fresh rule retires pending output before rereading', async () => {
  const f = fixture();
  let unchanged = true;
  const effects = {
    conflict,
    async unchanged() {
      f.calls.push('meaning');
      return unchanged;
    },
    async write() {
      f.calls.push('write');
    },
    async retirePublication() {
      f.calls.push('retire');
    },
    async readCurrent() {
      f.calls.push('reread');
      return { ...before, revision: 5 };
    },
    async reducePublicSource() {
      f.calls.push('reduce');
    },
  };
  await expect(f.app.updateRule(f.tx, { before, revision: 3 }, effects)).rejects.toThrow('CAS conflict');
  expect(f.calls).toEqual([]);
  expect(await f.app.updateRule(f.tx, { before, revision: 4 }, effects)).toEqual({ value: before, changed: false });
  expect(f.calls).toEqual(['meaning']);
  f.calls.length = 0;
  unchanged = false;
  expect((await f.app.updateRule(f.tx, { before, revision: 4 }, effects)).changed).toBe(true);
  expect(f.calls).toEqual(['meaning', 'write', 'retire', 'reread', 'reduce']);
});

test('retention preserves custody, executes ordered child occurrences, and retires the fence after the head', async () => {
  const f = fixture();
  let removed = 0;
  const child = async () => {
    f.calls.push('child');
    return removed;
  };
  const effects = {
    async retireCapture() {
      f.calls.push('capture');
      return { status: 'retired' as const, removed: 0 };
    },
    children: [child, child],
    async removeHead() {
      f.calls.push('head');
      return true;
    },
    async retireFence() {
      f.calls.push('fence');
    },
  };
  expect(await f.app.removeRetainedPage(f.tx, { publicCustody: true, sourceCustody: true }, effects)).toMatchObject({
    status: 'retained',
    custody: 'collection_source_and_destination_disposition',
  });
  expect(f.calls).toEqual([]);
  removed = 2;
  expect(await f.app.removeRetainedPage(f.tx, { publicCustody: false, sourceCustody: true }, effects)).toEqual({
    status: 'progress',
    removed: 2,
  });
  expect(f.calls).toEqual(['capture', 'child']);
  f.calls.length = 0;
  removed = 0;
  expect(await f.app.removeRetainedPage(f.tx, { publicCustody: false, sourceCustody: false }, effects)).toEqual({
    status: 'purged',
    removed: 1,
  });
  expect(f.calls).toEqual(['child', 'child', 'head', 'fence']);
  const key = { accountId: 'owner', deletionId: 'episode', revision: 5 };
  const head = {
    ...key,
    state: 'deleted',
    sourceGeneration: '8',
    deadlineMatches: true,
    due: false,
    publicCustody: false,
    sourceCustody: false,
  };
  expect(collectionRetentionDisposition(false, head, key)).toBe('account_fence');
  expect(collectionRetentionDisposition(true, { ...head, deletionId: 'replacement' }, key)).toBe('stale');
  expect(collectionRetentionDisposition(true, head, key)).toBe('not_due');
  expect(collectionRetentionDisposition(true, { ...head, due: true }, key)).toBe('remove');
});

test('publication refusal cancels only the exact output after current admission and a successful phase CAS', async () => {
  const f = fixture();
  let admitted = false,
    changed = false;
  const effects = {
    async admit() {
      f.calls.push('admit');
      return admitted;
    },
    async current() {
      f.calls.push('current');
      return { generation: 'pending-B' };
    },
    async compareAndSet() {
      f.calls.push('CAS');
      return changed;
    },
    async cancel(generation: string) {
      f.calls.push(`cancel:${generation}`);
    },
  };
  expect(await f.app.advancePublication(f.tx, 'staging', 'refused', effects)).toBe(false);
  expect(f.calls).toEqual(['admit']);
  f.calls.length = 0;
  admitted = true;
  expect(await f.app.advancePublication(f.tx, 'staging', 'refused', effects)).toBe(false);
  expect(f.calls).toEqual(['admit', 'current', 'CAS']);
  f.calls.length = 0;
  changed = true;
  expect(await f.app.advancePublication(f.tx, 'staging', 'refused', effects)).toBe(true);
  expect(f.calls).toEqual(['admit', 'current', 'CAS', 'cancel:pending-B']);
});

test('ordinary composition installs native mutation effects and preserves an explicit application override', async () => {
  const { composeLibraryDomain, peekLibraryDomain, bindLibraryDomain, unbindLibraryDomain } =
    await import('../../src/composition/library.ts');
  const previous = peekLibraryDomain();
  try {
    const native = composeLibraryDomain();
    expect(typeof native.collectionMutations?.create).toBe('function');
    expect(typeof native.collectionRuleAuthority?.readAccount).toBe('function');
    const originalClient = {
      async query(text: string, values: unknown[]) {
        expect(text).toContain('authn_fenced AS fenced');
        expect(values).toEqual([0x1234, 'owner']);
        return { rows: [], fields: [] };
      },
    };
    expect(await native.collectionRuleAuthority!.readAccount(originalClient, 0x1234, 'owner')).toBeNull();
    expect(typeof native.collectionRetentionNative?.retireCapture).toBe('function');
    expect(typeof native.collectionPublicationNative?.createCommands).toBe('function');
    const override = createCollectionMutationApplication<unknown>({
      async initialize() {},
      planCapture: plans.collectionMetadataHistoryCapturePlan,
      async owner() {},
      async append() {
        return 1;
      },
      async prune() {
        return 0;
      },
      async pruned() {},
    });
    expect(composeLibraryDomain({ capabilities: { collectionMutations: override } }).collectionMutations).toBe(
      override,
    );
  } finally {
    if (previous) bindLibraryDomain(previous);
    else unbindLibraryDomain();
  }
});
