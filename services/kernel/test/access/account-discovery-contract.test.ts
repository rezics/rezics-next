import { afterAll, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { pageActiveAccounts } from '../../src/access/active-account-page.ts';
import { readAccount, readPublicIdentities, readPublicAccountByHandle } from '../../src/access/account-data.ts';
import { readPublicViews } from '../../src/access/public-views.ts';
import {
  createLifecycleCommands,
  createLifecycleInternals,
  HANDLE_REDIRECT_TTL_MS,
  LIFECYCLE_ACTIONS,
  LifecycleDeniedError,
} from '../../src/access/lifecycle.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import type { Access } from '../../src/request/access.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';

/** Proposed TEST assembly, not an existing production export. See account-discovery-contract.md. */
export type AccountDiscoveryNative = {
  close(): Promise<void>;
  settle(): Promise<void>;
  source: {
    read(partition: number, ids: readonly string[]): Promise<{
      partition: number;
      position: bigint;
      accounts: { id: string; accountKind: 'actor' | 'organization'; handle: string | null;
        displayName: string | null; revision: bigint }[];
    }>;
  };
  query(input: { text?: string; kinds?: string[]; limit: number; cursor?: string; filter?: unknown },
    viewer?: string): Promise<{
      status: number;
      hits: { key: { owner: string; kind: string; route: number; id: string };
        summary: { kind: string; value: { id: string; handle?: string | null; displayName?: string | null;
          avatar?: unknown; verifiedAgent?: unknown; automated?: boolean; operatorId?: string | null } } }[];
      kinds: ({ kind: string; value: number; exact: boolean } | { kind: string; unavailable: true })[];
      next: string | null;
    }>;
  /** Real native principal grants and client scope, independently; returns a signed request identity. */
  viewer(accountId: string, allow: { principal: boolean; client: boolean }): Promise<string>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Hold/release an ACTUAL producer batch, never inject an indexed document. */
  captureProducer(accountId: string): Promise<string>;
  replayProducer(batch: string): Promise<void>;
  /** Retain native PIT/immutable observation, then query that observation through production disclosure. */
  retain(input: { text: string; limit: number; filter?: unknown }): Promise<string>;
  queryRetained(observation: string): ReturnType<AccountDiscoveryNative['query']>;
  applyFence(accountId: string, kind: DiscoveryFence): Promise<{ at: string; receiptId: string }>;
  restoreFence(accountId: string, receiptId: string): Promise<void>;
  createCataloguePerson(label: string): Promise<{ id: string; kind: string }>;
  /** Ordinary profile/media/verification workflows with native foreign target ownership controls. */
  profile(accountId: string, scenario: 'public' | 'private-lists' | 'avatar-removed' | 'agent-hidden' |
    'agent-unverified' | 'foreign-operator'): Promise<void>;
  rollbackMutation(accountId: string, patch: { displayName: string }): Promise<void>;
  backup(): Promise<string>;
  restore(backup: string): Promise<void>;
  erase(accountId: string): Promise<void>;
  copies(accountId: string): Promise<{ store: string; live: number; retained: number }[]>;
  /** Native fixture mutation and physical instrumentation owned by Search, not a candidate array. */
  grow(axis: 'matches' | 'corpus' | 'kinds' | 'copies', scale: number, previous: number): Promise<void>;
  physical(): Promise<{ rawCandidates: number; engineSearches: number; ownerSeeks: number;
    accessPoints: number; examinedRows: number; responseBytes: number; requestBytes: number;
    iteratorSteps: number; rounds: number; sqlPerBackend: number[]; connectionsPerBackend: number[] }>;

};
export type DiscoveryFence = 'recovery' | 'credential-reset' | 'consent-reduction' | 'session-revocation' |
  'operator-transfer' | 'operator-removal' | 'suspension' | 'deletion';
export type AccountDiscoveryNativeOptions = {
  pool: Pool; access: Access; routeKey: Uint8Array; clock: () => Date;
};

/** Missing production delivery is deliberately native red, with no substitute source or ACK. */
export async function openNative(options: AccountDiscoveryNativeOptions): Promise<AccountDiscoveryNative> {
  const path = new URL('../search/support/account-discovery-native.ts', import.meta.url).pathname;
  if (!(await Bun.file(path).exists()))
    throw new Error('Native Account discovery is not delivered: Search must supply test/search/support/account-discovery-native.ts (openAccountDiscoveryNative) using real source/index/HTTP/Access');
  const module = await import(path) as {
    openAccountDiscoveryNative: (options: AccountDiscoveryNativeOptions) => Promise<AccountDiscoveryNative>;
  };
  expect(typeof module.openAccountDiscoveryNative).toBe('function');
  return module.openAccountDiscoveryNative(options);
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const routeKey = new Uint8Array(32).fill(83);
const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
let instant = Date.now();
const clock = () => new Date(instant);
const proofs = new Map<object, { accountId: string; registrationId: string; authIdentityId: string; authnEpoch: number }>();
const recovery = new Map<object, {
  accountId: string; receiptId: string; minimumAuthnEpoch: string; authnEpoch: number; establishmentId: string;
}>();
const internal = createLifecycleInternals({
  pool, routeKey, clock,
  provisioningEvidence: async (proof) => proofs.get(proof as object) ?? null,
  recoveryEvidence: async (proof) => recovery.get(proof as object) ?? null,
});
const commands = createLifecycleCommands({ pool, access, clock });
const key = () => Bun.randomUUIDv7();
const handle = () => `discovery_${key().replaceAll('-', '')}`;
afterAll(() => pool.end());

async function pending() {
  const registrationKey = key();
  const accountId = internal.registrationTarget(registrationKey);
  const spelling = handle();
  const claim = (await internal.reserveHandle({ accountId, handle: spelling, key: registrationKey })).value;
  await internal.createPending({ accountId, handle: spelling, reservationId: claim.reservationId, key: key() });
  const evidence = {};
  proofs.set(evidence, { accountId, registrationId: claim.reservationId, authIdentityId: accountId, authnEpoch: 1 });
  return { accountId, spelling, claim, evidence };
}
async function person(displayName?: string) {
  const row = await pending();
  await internal.claimHandle({ accountId: row.accountId, handle: row.spelling,
    reservationId: row.claim.reservationId, evidence: row.evidence, key: key() });
  await internal.activate({ accountId: row.accountId, evidence: row.evidence, key: key() });
  if (displayName) await commands.updateAccount(await context(row.accountId), {
    accountId: row.accountId, patch: { displayName }, key: key(),
  });
  return row;
}
async function context(accountId: string) {
  const deadline = Date.now() + 30_000;
  const account = await readAccount(pool, routeOf(accountId)!, accountId);
  const actor = await authenticateAccount(access, { pool, deadline }, {
    accountId, clientId: 'discovery-native', scopes: [...LIFECYCLE_ACTIONS.keys()],
    requestedBy: null, authnEpoch: Number(account!.minimumAuthnEpoch),
  });
  return { actor, account, deadline };
}
async function rename(accountId: string, oldHandle: string, newHandle: string) {
  const claim = (await internal.reserveHandle({ accountId, handle: newHandle, key: key() })).value;
  const input = { accountId, handle: newHandle, expectedHandle: oldHandle,
    reservationId: claim.reservationId, operationId: key(), key: key() };
  await internal.holdHandle(input);
  await commands.transitionAccountHandle(await context(accountId), input);
  await internal.finalizeHandleTransition({ ...input, key: key() });
  await internal.redirectTransitionHandle({ ...input, key: key() });
  await internal.completeHandleTransition({ ...input, key: key() });
}
async function activeAt(id: string) {
  const route = routeOf(id)!;
  return withConnection(pool, (client) => pageActiveAccounts(client, {
    afterRoute: route, afterAccountId: '00000000-0000-0000-0000-000000000000', limit: 100,
  }));
}
async function native() { return openNative({ pool, access, routeKey, clock }); }
const ids = (page: Awaited<ReturnType<AccountDiscoveryNative['query']>>) => page.hits.map(({ key }) => key.id);
function exact(page: Awaited<ReturnType<AccountDiscoveryNative['query']>>, kind: string, count: number) {
  expect(page.status).toBe(200);
  expect(page.kinds.find((entry) => entry.kind === kind)).toEqual({ kind, value: count, exact: true });
}

// Current native primitives: these do not assert Account discovery exists in SubjectSource.
test('native creation, pending omission and attribution are separate from active unfenced enumeration', async () => {
  const p = await pending();
  const a = await person();
  expect(await readPublicIdentities(pool, [routeOf(p.accountId)!], [p.accountId])).toEqual([]);
  expect(await activeAt(a.accountId)).toContainEqual({ route: routeOf(a.accountId), accountId: a.accountId });
  expect(await activeAt(p.accountId)).not.toContainEqual({ route: routeOf(p.accountId), accountId: p.accountId });
  await internal.raiseFence({ accountId: a.accountId, key: key() });
  expect(await activeAt(a.accountId)).not.toContainEqual({ route: routeOf(a.accountId), accountId: a.accountId });
  expect(await readPublicIdentities(pool, [routeOf(a.accountId)!], [a.accountId])).toMatchObject([
    { id: a.accountId, state: 'active' },
  ]);
  expect((await readPublicViews(pool, [a.accountId])).get(a.accountId)).toEqual({ posts: false, reviews: false, collections: false });
  const source = await subjectSource(pool, routeKey).read(partitionOf(routeOf(a.accountId)!), [a.accountId]);
  expect(source.subjects).toEqual([]);
});

test('native recovery evidence cannot lower a later fence; a current proof restores active enumeration', async () => {
  const a = await person();
  const first = (await internal.raiseFence({ accountId: a.accountId, key: key() })).value;
  const second = (await internal.raiseFence({ accountId: a.accountId, key: key() })).value;
  const proof = (receipt: typeof first) => {
    const evidence = {};
    recovery.set(evidence, { accountId: a.accountId, receiptId: receipt.receiptId,
      minimumAuthnEpoch: receipt.minimumAuthnEpoch, authnEpoch: Number(receipt.minimumAuthnEpoch), establishmentId: key() });
    return evidence;
  };
  await expect(internal.clearFence({ accountId: a.accountId, key: key(), evidence: proof(first) })).rejects.toBeInstanceOf(LifecycleDeniedError);
  expect(await activeAt(a.accountId)).not.toContainEqual({ route: routeOf(a.accountId), accountId: a.accountId });
  await internal.clearFence({ accountId: a.accountId, key: key(), evidence: proof(second) });
  expect(await activeAt(a.accountId)).toContainEqual({ route: routeOf(a.accountId), accountId: a.accountId });
});

test('native rename forwards attribution while former spelling stays retired after its forwarding lifetime', async () => {
  const a = await person();
  const next = handle();
  await rename(a.accountId, a.spelling, next);
  expect(await readPublicAccountByHandle(pool, a.spelling, clock())).toMatchObject([{ id: a.accountId, handle: next }]);
  instant += HANDLE_REDIRECT_TTL_MS + 1;
  expect(await readPublicAccountByHandle(pool, a.spelling, clock())).toEqual([]);
  const b = await person();
  await expect(internal.reserveHandle({ accountId: b.accountId, handle: a.spelling, key: key() })).rejects.toBeInstanceOf(LifecycleDeniedError);
  instant = Date.now();
});

test('future native source and mixed query count real accounts and catalogue people independently', async () => {
  const label = `Discovery ${key()}`;
  const a = await person(label);
  const b = await person(label);
  const p = await pending();
  const d = await native();
  try {
    const catalogue = await d.createCataloguePerson(label);
    await d.settle();
    const snapshot = await d.source.read(partitionOf(routeOf(a.accountId)!), [a.accountId, a.accountId]);
    expect(snapshot.accounts).toHaveLength(1);
    expect(snapshot.accounts[0]).toMatchObject({ id: a.accountId, handle: a.spelling, displayName: label });
    expect(snapshot.accounts[0]!.revision).toBeGreaterThan(0n);
    const page = await d.query({ text: label, limit: 20 });
    expect(new Set(ids(page))).toEqual(new Set([a.accountId, b.accountId, catalogue.id]));
    expect(ids(page)).not.toContain(p.accountId);
    exact(page, 'account', 2);
    exact(page, catalogue.kind, 1);
    expect(page.next).toBeNull();
    expect(page.hits.find(({ key }) => key.id === a.accountId)).toMatchObject({
      key: { owner: 'accounts', kind: 'account', id: a.accountId },
      summary: { kind: 'account', value: { id: a.accountId, handle: a.spelling, displayName: label } },
    });
    const onlyAccount = await d.query({ text: label, kinds: ['account'], limit: 1 });
    expect(ids(onlyAccount)).toHaveLength(1);
    exact(onlyAccount, 'account', 2);
    exact(onlyAccount, catalogue.kind, 1); // disjunctive designated kind leaf only
    const continued = await d.query({ text: label, kinds: ['account'], limit: 1, cursor: onlyAccount.next! });
    expect(new Set([...ids(onlyAccount), ...ids(continued)])).toEqual(new Set([a.accountId, b.accountId]));
  } finally { await d.close(); }
});

for (const kind of ['recovery', 'credential-reset', 'consent-reduction', 'session-revocation',
  'operator-transfer', 'operator-removal', 'suspension', 'deletion'] as const) {
  test(`future native ${kind} fence removes all text/count/order contributions at T before worker repair`, async () => {
    const label = `Fence ${key()}`;
    const a = await person(label);
    const d = await native();
    try {
      await d.settle();
      exact(await d.query({ text: label, limit: 3 }), 'account', 1);
      const old = await d.retain({ text: label, limit: 3 });
      const zero = await d.retain({ text: `-${a.spelling} ${label}`, limit: 3 });
      await d.pause();
      const receipt = await d.applyFence(a.accountId, kind);
      expect(Number.isFinite(Date.parse(receipt.at))).toBe(true);
      expect(await activeAt(a.accountId)).not.toContainEqual({ route: routeOf(a.accountId), accountId: a.accountId });
      const current = await d.query({ text: label, limit: 3 });
      expect(ids(current)).not.toContain(a.accountId);
      expect([200, 409, 503]).toContain(current.status);
      if (current.status === 200) exact(current, 'account', 0);
      for (const observation of [old, zero]) {
        const retained = await d.queryRetained(observation);
        expect(ids(retained)).not.toContain(a.accountId);
        expect([409, 503]).toContain(retained.status);
      }
      expect(JSON.stringify(current)).not.toMatch(/authn|suspension_reason|receiptId|minimumAuthnEpoch/);
      await d.resume();
      await d.settle();
      exact(await d.query({ text: label, limit: 3 }), 'account', 0);
      if (kind !== 'deletion') {
        await d.restoreFence(a.accountId, receipt.receiptId);
        await d.settle();
        const restored = await d.query({ text: label, limit: 3 });
        expect(ids(restored)).toEqual([a.accountId]);
        exact(restored, 'account', 1);
      }
    } finally { await d.close(); }
  });
}

test('future native principal and client denials are independent of public candidate eligibility', async () => {
  const a = await person(`Admission ${key()}`);
  const viewer = await person();
  const d = await native();
  try {
    await d.settle();
    for (const allow of [{ principal: false, client: true }, { principal: true, client: false }]) {
      const denied = await d.query({ text: a.spelling, limit: 3 }, await d.viewer(viewer.accountId, allow));
      expect(denied.status).toBe(403);
      expect(denied.hits).toEqual([]);
      expect(denied.kinds).toEqual([]);
    }
    const allowed = await d.query({ text: a.spelling, limit: 3 }, await d.viewer(viewer.accountId, { principal: true, client: true }));
    expect(ids(allowed)).toEqual([a.accountId]);
    exact(allowed, 'account', 1);
  } finally { await d.close(); }
});

test('future native text uses only displayName and exact current active handle, never history or private profile', async () => {
  const label = `Public ${key()}`;
  const secret = `Private ${key()}`;
  const a = await person(label);
  await commands.updateAccount(await context(a.accountId), { accountId: a.accountId, key: key(), patch: { biography: secret } });
  const d = await native();
  try {
    await d.settle();
    expect(ids(await d.query({ text: secret, limit: 3 }))).not.toContain(a.accountId);
    const old = await d.captureProducer(a.accountId);
    await d.pause();
    const next = handle();
    await rename(a.accountId, a.spelling, next);
    expect(ids(await d.query({ text: a.spelling, limit: 3 }))).not.toContain(a.accountId);
    await d.resume();
    await d.settle();
    expect(ids(await d.query({ text: next, limit: 3 }))).toEqual([a.accountId]);
    exact(await d.query({ text: a.spelling, limit: 3 }), 'account', 0);
    await d.replayProducer(old);
    await d.settle();
    expect(ids(await d.query({ text: a.spelling, limit: 3 }))).toEqual([]);
    expect(ids(await d.query({ text: label, limit: 3 }))).toEqual([a.accountId]);
  } finally { await d.close(); }
});

test('future native hydration rejects stale media/verification and foreign ownership without losing eligible identity', async () => {
  const a = await person(`Summary ${key()}`);
  const d = await native();
  try {
    await d.profile(a.accountId, 'public');
    await d.settle();
    const live = await d.query({ text: a.spelling, limit: 3 });
    expect(live.hits[0]!.summary.value.avatar).not.toBeNull();
    expect(live.hits[0]!.summary.value.verifiedAgent).not.toBeNull();
    await d.pause();
    for (const scenario of ['private-lists', 'avatar-removed', 'agent-hidden', 'agent-unverified', 'foreign-operator'] as const) {
      await d.profile(a.accountId, scenario);
      const page = await d.query({ text: a.spelling, limit: 3 });
      expect(page.status).toBe(200);
      expect(ids(page)).toEqual([a.accountId]);
      if (scenario === 'avatar-removed') expect(page.hits[0]!.summary.value.avatar).toBeNull();
      if (scenario === 'agent-hidden' || scenario === 'agent-unverified') expect(page.hits[0]!.summary.value.verifiedAgent).toBeNull();
      expect(JSON.stringify(page)).not.toMatch(/birth_date|controller_id|content_preferences|suspension_reason/);
      exact(page, 'account', 1);
    }
  } finally { await d.close(); }
});

test('future native unknown/missing/foreign source keys and inapplicable subject predicates never broaden Accounts', async () => {
  const a = await person(`Domain ${key()}`);
  const d = await native();
  try {
    await d.settle();
    const partition = partitionOf(routeOf(a.accountId)!);
    expect((await d.source.read(partition, [newId(routeOf(a.accountId)!)])).accounts).toEqual([]);
    await expect(d.source.read((partition + 1) % 4096, [a.accountId])).rejects.toThrow();
    await expect(d.source.read(partition, ['not-a-route'])).rejects.toThrow();
    await expect(d.source.read(partition, Array(101).fill(a.accountId))).rejects.toThrow();
    const unknown = await d.query({ text: a.spelling, kinds: ['missing-owner-kind'], limit: 3 });
    expect(unknown.status).toBe(422);
    expect(unknown.hits).toEqual([]);
    // Actual released Subject type grammar remains unknown/not-applicable for Account under NOT.
    const subjectOnly = await d.query({ text: a.spelling, limit: 3, filter: { not: { type: { in: ['schema:Person'] } } } });
    expect(ids(subjectOnly)).not.toContain(a.accountId);
  } finally { await d.close(); }
});

test('future native rollback, lowering race, late producer and backup restore preserve current fences and erasure', async () => {
  const label = `Restore ${key()}`;
  const a = await person(label);
  const d = await native();
  try {
    await d.settle();
    const before = await d.source.read(partitionOf(routeOf(a.accountId)!), [a.accountId]);
    await d.rollbackMutation(a.accountId, { displayName: `Rolled back ${key()}` });
    expect(await d.source.read(before.partition, [a.accountId])).toEqual(before);
    const batch = await d.captureProducer(a.accountId);
    const backup = await d.backup();
    const first = await d.applyFence(a.accountId, 'recovery');
    const later = await d.applyFence(a.accountId, 'credential-reset');
    await expect(d.restoreFence(a.accountId, first.receiptId)).rejects.toThrow();
    await d.replayProducer(batch);
    await d.settle();
    exact(await d.query({ text: label, limit: 3 }), 'account', 0);
    await d.restoreFence(a.accountId, later.receiptId);
    await d.settle();
    expect(ids(await d.query({ text: label, limit: 3 }))).toEqual([a.accountId]);
    await d.erase(a.accountId);
    await d.replayProducer(batch);
    await d.restore(backup);
    await d.settle();
    const erased = await d.query({ text: label, limit: 3 });
    expect(ids(erased)).toEqual([]);
    exact(erased, 'account', 0);
    expect((await d.source.read(before.partition, [a.accountId])).accounts).toEqual([]);
    const copies = await d.copies(a.accountId);
    expect(copies.length).toBeGreaterThan(0);
    expect(copies.every((copy) => copy.live === 0 && copy.retained === 0)).toBe(true);
  } finally { await d.close(); }
});


test('future native exact-claim guards reject a missing, reserved or foreign-owned handle without suppressing displayName', async () => {
  const label = `Claim ${key()}`;
  const a = await person(label);
  const b = await person();
  const claimRoute = createHash('sha256').update(a.spelling).digest().readUInt16BE(0);
  const d = await native();
  try {
    await d.settle();
    await d.pause();
    for (const state of ['reserved', 'foreign', 'missing'] as const) {
      // Native fault fixtures exercise cross-anchor publication failures, not a synthetic discovery source.
      if (state === 'reserved') await pool.query(
        "UPDATE access.handle_claim SET state='reserved',reserved_until=now()+interval '30 days' WHERE route=$1 AND normalized_handle=$2",
        [claimRoute, a.spelling]);
      if (state === 'foreign') await pool.query(
        "UPDATE access.handle_claim SET state='active',reserved_until=NULL,account_id=$3 WHERE route=$1 AND normalized_handle=$2",
        [claimRoute, a.spelling, b.accountId]);
      if (state === 'missing') await pool.query(
        'DELETE FROM access.handle_claim WHERE route=$1 AND normalized_handle=$2', [claimRoute, a.spelling]);
      const read = await d.source.read(partitionOf(routeOf(a.accountId)!), [a.accountId]);
      expect(read.accounts).toHaveLength(1);
      expect(read.accounts[0]).toMatchObject({ id: a.accountId, handle: null, displayName: label });
      const page = await d.query({ text: label, limit: 3 });
      expect(ids(page)).toEqual([a.accountId]);
      expect(page.hits[0]!.summary.value.handle).toBeNull();
      exact(page, 'account', 1);
      const handlePage = await d.query({ text: a.spelling, limit: 3 });
      expect(ids(handlePage)).toEqual([]);
      exact(handlePage, 'account', 0);
    }
  } finally { await d.close(); }
});
