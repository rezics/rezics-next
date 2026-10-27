import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { routeOf } from '../services/kernel/src/route/route.ts';
import {
  FOLLOW_COUNTS_MISSING_DRIVER,
  type CountFixture,
  type CountTarget,
  type Credential,
  type FollowCountsDriver,
  type ReadTrace,
} from './follow-counts-driver.ts';

setDefaultTimeout(240_000);
let driver: FollowCountsDriver | undefined;
beforeEach(async () => {
  const location = process.env.FOLLOW_COUNTS_DRIVER;
  if (!location) throw new Error(FOLLOW_COUNTS_MISSING_DRIVER);
  if (!isAbsolute(location) && !location.startsWith('file:'))
    throw new Error('FOLLOW_COUNTS_DRIVER must be absolute or a file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('FOLLOW_COUNTS_DRIVER must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createFollowCountsDriver !== 'function')
    throw new Error('Expected createFollowCountsDriver factory');
  driver = await binding.createFollowCountsDriver();
});
afterEach(async () => {
  const current = driver;
  driver = undefined;
  await current?.close();
});
const native = () => driver!;
const targetPath = (target: CountTarget) => `/v1/followCounts/${target.targetType}/${target.targetId}`;
async function problem(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  const body = await response.json();
  expect(body).toMatchObject({ status, code, type: `https://rezics.com/problems/${code}` });
  expect(body).not.toHaveProperty('followerCount');
  expect(body).not.toHaveProperty('followingCount');
  return body;
}
async function count(f: CountFixture, value: number, credential = f.manager.credential) {
  const response = await native().request(credential, targetPath(f.target));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ ...f.target, followerCount: value });
}
async function outgoing(credential: Credential, value: number) {
  const response = await native().request(credential, '/v1/followCounts/outgoing');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ followingCount: value });
}
async function write(f: CountFixture, intent: 'follow' | 'unfollow', key = crypto.randomUUID()) {
  const response = await native().request(f.follower.credential, `/v1/follows/${f.target.targetId}`, {
    method: intent === 'follow' ? 'PUT' : 'DELETE',
    headers: { 'Idempotency-Key': key },
  });
  expect(response.status).toBe(200);
  return response.json();
}
async function followed(kind: Parameters<FollowCountsDriver['fixture']>[0] = 'collection') {
  const f = await native().fixture(kind);
  await write(f, 'follow');
  await native().reconcile(f.follower, f.target);
  return f;
}

test('follower counts are visible only through existing target management authority and outgoing follows only to their follower', async () => {
  const f = await followed();
  await count(f, 1);
  await count(f, 1, f.granted.credential);
  await problem(await native().request(f.other.credential, targetPath(f.target)), 404, 'not_found');
  await problem(await native().request(f.staff.credential, targetPath(f.target)), 404, 'not_found');
  await problem(await native().request(f.follower.credential, targetPath(f.target)), 404, 'not_found');
  await outgoing(f.follower.credential, 1);
  await outgoing(f.other.credential, 0);
  const page = await native().request(f.follower.credential, '/v1/follows?limit=1');
  expect(page.status).toBe(200);
  expect((await page.json()).follows.map((row: { targetId: string }) => row.targetId)).toEqual([f.target.targetId]);
  const otherPage = await native().request(f.other.credential, '/v1/follows?limit=1');
  expect(otherPage.status).toBe(200);
  expect((await otherPage.json()).follows).toEqual([]);
  await problem(
    await native().request(f.other.credential, `/v1/followCounts/outgoing?accountId=${f.follower.accountId}`),
    400,
    'invalid_request',
  );
});

test('Space management uses its installed role through native Access', async () => {
  const f = await followed('space');
  await count(f, 1, f.granted.credential);
  const measured = await native().measure(() => count(f, 1, f.granted.credential));
  expect(measured.trace.managementChecks).toEqual([
    { action: 'space:manage', resource: { route: routeOf(f.target.targetId)!, id: f.target.targetId } },
  ]);
  await native().revokeManagement(f);
  await problem(await native().request(f.granted.credential, targetPath(f.target)), 404, 'not_found');
});

test('person agent self automated operator and organization owner resolve the actual account before management', async () => {
  for (const kind of ['person', 'automated', 'organization'] as const) {
    const f = await followed(kind);
    expect(f.targetAccountId).not.toBeNull();
    expect(f.targetAccountId).not.toBe(f.target.targetId);
    await count(f, 1);
    if (kind === 'person') expect(f.manager.accountId).toBe(f.targetAccountId!);
    else {
      const result = await native().measure(() => count(f, 1));
      expect(result.trace.managementChecks).toEqual([
        { action: 'account:manage', resource: { route: routeOf(f.targetAccountId!)!, id: f.targetAccountId! } },
      ]);
    }
    await count(f, 1, f.granted.credential);
    await native().revokeManagement(f);
    await problem(await native().request(f.granted.credential, targetPath(f.target)), 404, 'not_found');
  }
});

test('revoked Collection management and ordinary unowned subjects conceal follower counts', async () => {
  const f = await followed();
  await count(f, 1, f.granted.credential);
  await native().revokeManagement(f);
  await problem(await native().request(f.granted.credential, targetPath(f.target)), 404, 'not_found');
  const ordinary = await followed('ordinary');
  expect(ordinary.targetAccountId).toBeNull();
  for (const actor of [ordinary.manager, ordinary.granted, ordinary.follower, ordinary.other])
    await problem(await native().request(actor.credential, targetPath(ordinary.target)), 404, 'not_found');
  await outgoing(ordinary.follower.credential, 1);
});

test('anonymous suspended no-scope and closed gate requests fail closed without disclosing counts', async () => {
  const f = await followed();
  for (const path of [targetPath(f.target), '/v1/followCounts/outgoing', '/v1/follows']) {
    await problem(await native().request(null, path), 401, 'authentication_required');
    await problem(await native().request(f.suspended.credential, path), 401, 'invalid_credentials');
    await problem(await native().request(f.noScope.credential, path), 403, 'forbidden');
  }
  await problem(await native().request(f.manager.credential, targetPath(f.unknown)), 404, 'not_found');
  await native().gate(false);
  for (const path of [targetPath(f.target), '/v1/followCounts/outgoing', '/v1/follows'])
    await problem(await native().request(f.manager.credential, path), 404, 'not_found');
  await native().gate(true);
});

test('outgoing keyset cursors stay signed and bound to the authenticated follower', async () => {
  const f = await followed();
  await native().additionalOutgoing(f.follower);
  await outgoing(f.follower.credential, 2);
  const first = await native().request(f.follower.credential, '/v1/follows?limit=1');
  expect(first.status).toBe(200);
  const page = await first.json();
  expect(page.follows).toHaveLength(1);
  expect(typeof page.next).toBe('string');
  const seek = `/v1/follows?limit=1&cursor=${encodeURIComponent(page.next)}`;
  const second = await native().request(f.follower.credential, seek);
  expect(second.status).toBe(200);
  const next = await second.json();
  expect(next.follows).toHaveLength(1);
  expect(next.follows[0].targetId).not.toBe(page.follows[0].targetId);
  expect(next.next).toBeNull();
  await problem(await native().request(f.other.credential, seek), 400, 'invalid_cursor');
  await problem(await native().request(f.follower.credential, `${seek}x`), 400, 'invalid_cursor');
});

test('hidden account agent resolution is empty and cannot be replaced with guessed ownership', async () => {
  const f = await followed('person');
  await native().accountState(f.targetAccountId!, 'suspended');
  await problem(await native().request(f.granted.credential, targetPath(f.target)), 404, 'not_found');
  await native().accountState(f.targetAccountId!, 'active');
  await count(f, 1, f.granted.credential);
  await native().accountState(f.targetAccountId!, 'deleted');
  await problem(await native().request(f.granted.credential, targetPath(f.target)), 404, 'not_found');
});

test('one management authorization is performed per count page independent of follower edges', async () => {
  const f = await followed();
  for (const scale of [1, 4, 16]) {
    await native().seed(f, scale, 'target_followers');
    const result = await native().measure(() => count(f, 1 + 128 * scale));
    expect(result.trace.managementChecks).toEqual([
      { action: 'collection:update', resource: { route: routeOf(f.target.targetId)!, id: f.target.targetId } },
    ]);
  }
});

test('follow unfollow receipt replay and duplicate projection effects preserve a single source edge', async () => {
  const f = await native().fixture('collection');
  const key = crypto.randomUUID();
  const first = await write(f, 'follow', key);
  const observation = await native().capture(f.follower, f.target);
  await native().deliver(observation);
  await count(f, 1);
  const before = await native().inspect(f.follower, f.target);
  expect(await write(f, 'follow', key)).toEqual(first);
  await native().deliver(observation);
  const after = await native().inspect(f.follower, f.target);
  expect(after.targetRows).toEqual(before.targetRows);
  expect(after.effects).toEqual(before.effects);
  await outgoing(f.follower.credential, 1);
  await write(f, 'unfollow');
  await native().reconcile(f.follower, f.target);
  expect((await native().inspect(f.follower, f.target)).source?.state).toBe('unfollowed');
  await count(f, 0);
  await outgoing(f.follower.credential, 0);
});

test('explicit unfollow wins over later implied library follow until a new explicit follow', async () => {
  const f = await followed('person');
  await write(f, 'unfollow');
  await native().libraryFollow(f.follower, f.target);
  await native().reconcile(f.follower, f.target);
  const row = (await native().inspect(f.follower, f.target)).source;
  expect(row).toMatchObject({ state: 'unfollowed', reason: 'explicit' });
  await count(f, 0);
  await outgoing(f.follower.credential, 0);
  await write(f, 'follow');
  await native().reconcile(f.follower, f.target);
  await count(f, 1);
});

test('a delayed reverse positive cannot beat a newer negative even on its first target application', async () => {
  const f = await native().fixture('collection');
  await write(f, 'follow');
  const old = await native().capture(f.follower, f.target);
  await write(f, 'unfollow');
  await native().reconcile(f.follower, f.target);
  const before = await native().inspect(f.follower, f.target);
  await native().deliver(old);
  expect((await native().inspect(f.follower, f.target)).targetRows).toEqual(before.targetRows);
  await count(f, 0);
});

test('suspension and reactivation reconcile current truth and never resurrect explicit unfollow', async () => {
  const f = await followed();
  const old = await native().capture(f.follower, f.target);
  await native().accountState(f.follower.accountId, 'suspended');
  await native().reconcile(f.follower, f.target);
  await native().deliver(old);
  await count(f, 0);
  await native().accountState(f.follower.accountId, 'active');
  f.follower = await native().reauthenticate(f.follower);
  await native().reconcile(f.follower, f.target);
  await count(f, 1);
  await write(f, 'unfollow');
  await native().deliver(old);
  await native().reconcile(f.follower, f.target);
  await count(f, 0);
});

test('a positive first application rechecks current account state without waiting for its notification', async () => {
  const f = await native().fixture('collection');
  await write(f, 'follow');
  const old = await native().capture(f.follower, f.target);
  await native().accountState(f.follower.accountId, 'suspended');
  await native().deliver(old);
  await count(f, 0);
});

test('terminal account event starts bounded private purge immediately and all old work remains fenced', async () => {
  const f = await followed();
  const old = await native().capture(f.follower, f.target);
  await native().accountState(f.follower.accountId, 'deleted');
  await native().accountSignal(f.follower.accountId);
  const result = await native().purge(f.follower.accountId);
  expect(result.complete).toBe(true);
  expect(result.pages).toBeGreaterThan(0);
  expect(result.maxRows).toBeLessThanOrEqual(100);
  const state = await native().inspect(f.follower, f.target);
  expect(state.source).toBeNull();
  expect(state.privatePayloads).toEqual([]);
  expect(state.terminalFences).toContainEqual({ accountId: f.follower.accountId });
  await native().deliver(old);
  await native().accountSignal(f.follower.accountId);
  await count(f, 0);
  expect((await native().inspect(f.follower, f.target)).privatePayloads).toEqual([]);
});

test('unready projection and unavailable Access never masquerade as observed zero', async () => {
  const f = await followed();
  for (const fault of ['projection_unready', 'access_unavailable'] as const) {
    await native().fault(fault);
    for (const path of [targetPath(f.target), '/v1/followCounts/outgoing'])
      await problem(await native().request(f.manager.credential, path), 503, 'dependency_unavailable');
    await native().fault('clear');
    await count(f, 1);
  }
});

test('private follow data never enters public responses FTS public counts sitemaps or notifications', async () => {
  const f = await native().fixture('collection');
  const before = await native().publicArtifacts();
  await write(f, 'follow');
  await native().reconcile(f.follower, f.target);
  await count(f, 1);
  await outgoing(f.follower.credential, 1);
  const artifacts = await native().publicArtifacts();
  // Inspection is scoped to public follow effects; fixture creation is excluded.
  expect(artifacts).toEqual(before);
  expect(new Set(artifacts.map((row) => row.surface))).toEqual(
    new Set(['responses', 'fts', 'counts', 'sitemaps', 'notifications']),
  );
});

function bounded(traces: ReadTrace[]) {
  expect(traces).toHaveLength(3);
  const first = traces[0]!;
  expect(first.statements).toBeGreaterThan(0);
  expect(first.examinedRows).toBeGreaterThan(0);
  expect(first.sharedBlocks).toBeGreaterThan(0);
  for (const trace of traces) {
    expect(trace.sequentialRelations).toEqual([]);
    expect(trace.statements).toBe(first.statements);
    expect(trace.examinedRows).toBeLessThanOrEqual(first.examinedRows + 8);
    expect(trace.sharedBlocks).toBeLessThanOrEqual(first.sharedBlocks + 64 * Math.log2(16));
  }
}
test('three legal geometric growth scales bound target and outgoing rows blocks and statements', async () => {
  for (const axis of ['unrelated_followers', 'unrelated_targets', 'history', 'target_followers'] as const) {
    const f = await followed();
    const targets: ReadTrace[] = [],
      outgoingReads: ReadTrace[] = [];
    for (const scale of [1, 4, 16]) {
      await native().seed(f, scale, axis);
      const expected = axis === 'target_followers' ? 1 + 128 * scale : 1;
      await count(f, expected); // warm up real reads, separate from measured counters
      targets.push((await native().measure(() => count(f, expected))).trace);
      await outgoing(f.follower.credential, 1);
      outgoingReads.push((await native().measure(() => outgoing(f.follower.credential, 1))).trace);
    }
    bounded(targets);
    bounded(outgoingReads);
  }
});
