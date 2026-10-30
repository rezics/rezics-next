import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { observeSql } from '../content/support/sql-observer.ts';
import {
  addressAtIndependentAnchor,
  addressRoute,
  createSpaceAddressRecoveryFixture,
  type RecoveryActor,
  type RecoveryResponse,
  type RecoverySpace,
  type SpaceAddressRecoveryFixture,
} from './space-address-recovery-fixture.ts';

// `space-address.test.ts` already covers ordinary claim/change and handle impersonation; this suite joins the
// independent anchors at their real HTTP and transaction boundaries.

let fixture: SpaceAddressRecoveryFixture;
let governance: RecoveryActor;

beforeAll(async () => {
  const opened = await createSpaceAddressRecoveryFixture();
  fixture = opened.fixture;
  governance = opened.governance;
}, 60_000);

afterAll(async () => {
  await fixture?.close();
});

async function owner(name: string, actions: readonly string[] = ['space:create']): Promise<RecoveryActor> {
  const actor = await fixture.person(name);
  const granted = await fixture.grantGlobal(governance, actor, actions);
  expect(granted.response.status).toBe(201);
  return actor;
}

async function addressIntent(
  actor: RecoveryActor,
  space: RecoverySpace,
  address: string,
  key: string,
  ifMatch = space.etag,
) {
  return fixture.request('PUT', `/v1/spaces/${space.spaceId}/address`, {
    bearer: actor.bearer,
    key,
    ifMatch,
    body: { address },
  });
}

function headId(space: { head: Record<string, unknown> | null }): string {
  const id = space.head?.head_revision_id;
  if (typeof id !== 'string') throw new Error('Space head is missing from the independent snapshot');
  return id;
}

function errorCode(value: Record<string, unknown>): unknown {
  return value.code;
}

test.serial(
  'Realms and Spaces: independent address/Space anchors preserve uniqueness and replay after partial progress.',
  async () => {
    const firstOwner = await owner('race-first');
    const secondOwner = await owner('race-second');
    const firstSpace = await fixture.createSpace(firstOwner, 'First concurrent owner');
    const secondSpace = await fixture.createSpace(secondOwner, 'Second concurrent owner');
    const address = addressAtIndependentAnchor('shared-independent-anchor', [firstSpace.spaceId, secondSpace.spaceId]);
    const addressAnchor = addressRoute(address);
    const firstSpaceRoute = routeOf(firstSpace.spaceId)!;
    const secondSpaceRoute = routeOf(secondSpace.spaceId)!;

    expect(addressAnchor).not.toBe(firstSpaceRoute);
    expect(addressAnchor).not.toBe(secondSpaceRoute);
    expect(partitionOf(addressAnchor)).not.toBe(partitionOf(firstSpaceRoute));
    expect(partitionOf(addressAnchor)).not.toBe(partitionOf(secondSpaceRoute));

    const beforeFirst = await fixture.spaceState(firstSpace.spaceId);
    const beforeSecond = await fixture.spaceState(secondSpace.spaceId);
    const firstKey = randomUUID();
    const secondKey = randomUUID();
    const results = await Promise.all([
      addressIntent(firstOwner, firstSpace, address, firstKey),
      addressIntent(secondOwner, secondSpace, address, secondKey),
    ]);
    expect(results.map(({ response }) => response.status).sort((a, b) => a - b)).toEqual([200, 409]);
    const winnerIndex = results.findIndex(({ response }) => response.status === 200);
    const loserIndex = 1 - winnerIndex;
    const winnerOwner = winnerIndex === 0 ? firstOwner : secondOwner;
    const loserOwner = loserIndex === 0 ? firstOwner : secondOwner;
    const winnerSpace = winnerIndex === 0 ? firstSpace : secondSpace;
    const loserSpace = loserIndex === 0 ? firstSpace : secondSpace;
    const winnerKey = winnerIndex === 0 ? firstKey : secondKey;
    const loserKey = loserIndex === 0 ? firstKey : secondKey;
    const winnerResponse = results[winnerIndex]!;
    const loserResponse = results[loserIndex]!;

    expect(errorCode(loserResponse.value)).toBe('conflict');
    const won = winnerResponse.value.space as Record<string, unknown>;
    expect(won).toMatchObject({ spaceId: winnerSpace.spaceId, address });
    expect(winnerResponse.response.headers.get('etag')).toBe(JSON.stringify(won.headRevisionId));

    const [firstAfter, secondAfter, claim] = await Promise.all([
      fixture.spaceState(firstSpace.spaceId),
      fixture.spaceState(secondSpace.spaceId),
      fixture.addressClaim(address),
    ]);
    expect(firstAfter.revisions).toHaveLength(winnerIndex === 0 ? 2 : 1);
    expect(secondAfter.revisions).toHaveLength(winnerIndex === 1 ? 2 : 1);
    expect(headId(firstAfter)).toBe(winnerIndex === 0 ? String(won.headRevisionId) : firstSpace.headRevisionId);
    expect(headId(secondAfter)).toBe(winnerIndex === 1 ? String(won.headRevisionId) : secondSpace.headRevisionId);
    expect(firstAfter.head).toBeDefined();
    expect(secondAfter.head).toBeDefined();
    expect(firstAfter.head?.head_revision_id).toBe(
      winnerIndex === 0 ? won.headRevisionId : beforeFirst.head?.head_revision_id,
    );
    expect(secondAfter.head?.head_revision_id).toBe(
      winnerIndex === 1 ? won.headRevisionId : beforeSecond.head?.head_revision_id,
    );
    expect(claim).toMatchObject({ state: 'active', normalized_address: address, space_id: winnerSpace.spaceId });

    const addressPartition = partitionOf(addressAnchor);
    const winnerPartition = partitionOf(routeOf(winnerSpace.spaceId)!);
    const loserPartition = partitionOf(routeOf(loserSpace.spaceId)!);
    const [pending, changed, activated, loserPending, loserChanged, loserActivated] = await Promise.all([
      fixture.receipt(addressPartition, winnerOwner, winnerKey, 'community.space.address.pending'),
      fixture.receipt(winnerPartition, winnerOwner, winnerKey, 'community.space.address'),
      fixture.receipt(addressPartition, winnerOwner, winnerKey, 'community.space.address.activate'),
      fixture.receipt(addressPartition, loserOwner, loserKey, 'community.space.address.pending'),
      fixture.receipt(loserPartition, loserOwner, loserKey, 'community.space.address'),
      fixture.receipt(addressPartition, loserOwner, loserKey, 'community.space.address.activate'),
    ]);
    expect(pending).toMatchObject({ partition_no: addressPartition, idempotency_key: winnerKey });
    expect(changed).toMatchObject({ partition_no: winnerPartition, idempotency_key: winnerKey });
    expect(activated).toMatchObject({ partition_no: addressPartition, idempotency_key: winnerKey });
    expect(loserPending).toBeNull();
    expect(loserChanged).toBeNull();
    expect(loserActivated).toBeNull();

    const resolved = await fixture.request('GET', `/v1/spaceAddresses/${address}`);
    expect(resolved.response.status).toBe(200);
    expect(resolved.value).toEqual({ spaceId: winnerSpace.spaceId });
  },
);

test.serial('an ambiguous reservation commit replays the same HTTP intent through activation once', async () => {
  const actor = await owner('commit-recovery');
  const space = await fixture.createSpace(actor, 'Commit boundary recovery');
  const address = addressAtIndependentAnchor('commit-recovery-address', [space.spaceId]);
  const key = randomUUID();
  const before = await fixture.spaceState(space.spaceId);
  const observer = observeSql(fixture.database.pool);
  const transport = Object.assign(new Error('connection failure after durable COMMIT'), { code: '08006' });
  // The request's read-only Access decision commits first; hold the native reservation commit next.
  observer.armFault({ match: { statement: 'COMMIT', occurrence: 2 }, boundary: 'after', error: transport });

  let first: RecoveryResponse | undefined;
  try {
    first = await addressIntent(actor, space, address, key);
  } finally {
    await observer.close();
  }
  expect(first!.response.status).toBe(503);
  expect(first!.value).toMatchObject({ retryable: true });

  const pendingClaim = await fixture.addressClaim(address);
  const pendingState = await fixture.spaceState(space.spaceId);
  expect(pendingClaim).toMatchObject({ state: 'pending', normalized_address: address, space_id: space.spaceId });
  expect(pendingState.revisions).toHaveLength(before.revisions.length);
  expect(headId(pendingState)).toBe(space.headRevisionId);
  expect(
    await fixture.receipt(partitionOf(addressRoute(address)), actor, key, 'community.space.address.pending'),
  ).not.toBeNull();
  expect(await fixture.receipt(partitionOf(routeOf(space.spaceId)!), actor, key, 'community.space.address')).toBeNull();
  expect(
    await fixture.receipt(partitionOf(addressRoute(address)), actor, key, 'community.space.address.activate'),
  ).toBeNull();

  const replay = await addressIntent(actor, space, address, key);
  expect(replay.response.status).toBe(200);
  const body = replay.value.space as Record<string, unknown>;
  expect(body).toMatchObject({ spaceId: space.spaceId, address });
  const after = await fixture.spaceState(space.spaceId);
  expect(after.revisions).toHaveLength(before.revisions.length + 1);
  expect(after.revisions.filter((revision) => revision.address === address)).toHaveLength(1);
  expect(headId(after)).toBe(String(body.headRevisionId));
  expect(await fixture.addressClaim(address)).toMatchObject({ state: 'active', space_id: space.spaceId });
  expect(
    await fixture.receipt(partitionOf(routeOf(space.spaceId)!), actor, key, 'community.space.address'),
  ).not.toBeNull();
  expect(
    await fixture.receipt(partitionOf(addressRoute(address)), actor, key, 'community.space.address.activate'),
  ).not.toBeNull();
  const resolved = await fixture.request('GET', `/v1/spaceAddresses/${address}`);
  expect(resolved.response.status).toBe(200);
  expect(resolved.value).toEqual({ spaceId: space.spaceId });
});

test.serial('stale Space head recovery preserves a pending reservation until its exact expiry', async () => {
  const actor = await owner('stale-head-recovery');
  const space = await fixture.createSpace(actor, 'Stale head recovery');
  const address = addressAtIndependentAnchor('stale-head-address', [space.spaceId]);
  const key = randomUUID();
  const initial = fixture.now;
  const observer = observeSql(fixture.database.pool);
  const barrier = observer.hold({ statement: 'COMMIT', occurrence: 2 }, 'after');
  const pendingIntent = addressIntent(actor, space, address, key);
  let stale: RecoveryResponse | undefined;
  try {
    await barrier.entered;
    const reservation = await fixture.addressClaim(address);
    expect(reservation).toMatchObject({ state: 'pending', space_id: space.spaceId });

    fixture.setTime(new Date(initial.getTime() + 1_000));
    const competingEdit = await fixture.request('PATCH', `/v1/spaces/${space.spaceId}`, {
      bearer: actor.bearer,
      key: randomUUID(),
      ifMatch: space.etag,
      body: { title: 'Competing committed edit' },
    });
    expect(competingEdit.response.status).toBe(200);
    barrier.release();
    stale = await pendingIntent;
  } finally {
    barrier.release();
    await observer.close();
  }
  expect(stale!.response.status).toBe(409);
  expect(errorCode(stale!.value)).toBe('conflict');
  const editedSpace = stale!.value;
  const editEtag = JSON.stringify((await fixture.spaceState(space.spaceId)).head?.head_revision_id);
  expect(editEtag).not.toBe(space.etag);

  const replay = await addressIntent(actor, space, address, key);
  expect(replay.response.status).toBe(409);
  expect(errorCode(replay.value)).toBe('conflict');
  const expiryClaim = await fixture.addressClaim(address);
  expect(expiryClaim?.state).toBe('pending');
  const expiry = new Date(String(expiryClaim?.expires_at)).getTime();
  expect(Number.isFinite(expiry)).toBe(true);
  const beforeRepair = await fixture.spaceState(space.spaceId);
  expect(beforeRepair.revisions).toHaveLength(2);
  expect(headId(beforeRepair)).not.toBe(space.headRevisionId);
  expect(editedSpace).toBeDefined();

  fixture.setTime(new Date(expiry - 1));
  const tooEarlyKey = randomUUID();
  const tooEarly = await addressIntent(actor, space, address, tooEarlyKey, editEtag);
  expect(tooEarly.response.status).toBe(409);
  expect(errorCode(tooEarly.value)).toBe('conflict');
  expect(
    await fixture.receipt(partitionOf(addressRoute(address)), actor, tooEarlyKey, 'community.space.address.pending'),
  ).toBeNull();
  expect(await fixture.addressClaim(address)).toMatchObject({ state: 'pending', space_id: space.spaceId });
  expect((await fixture.spaceState(space.spaceId)).revisions).toHaveLength(2);

  fixture.setTime(new Date(expiry));
  const repairKey = randomUUID();
  const repaired = await addressIntent(actor, space, address, repairKey, editEtag);
  expect(repaired.response.status).toBe(200);
  const repairedBody = repaired.value.space as Record<string, unknown>;
  expect(repairedBody).toMatchObject({ spaceId: space.spaceId, address });
  const final = await fixture.spaceState(space.spaceId);
  expect(final.revisions).toHaveLength(3);
  expect(final.revisions.at(-1)).toMatchObject({ predecessor: headId(beforeRepair), address });
  expect(await fixture.addressClaim(address)).toMatchObject({ state: 'active', space_id: space.spaceId });
  expect(
    await fixture.receipt(partitionOf(addressRoute(address)), actor, repairKey, 'community.space.address.pending'),
  ).not.toBeNull();
  expect(
    await fixture.receipt(partitionOf(routeOf(space.spaceId)!), actor, repairKey, 'community.space.address'),
  ).not.toBeNull();
});

test.serial('revoking Space management after reservation blocks replay without altering committed state', async () => {
  const actor = await owner('revoked-management');
  const space = await fixture.createSpace(actor, 'Revoked management recovery');
  const address = addressAtIndependentAnchor('revoked-management-address', [space.spaceId]);
  const key = randomUUID();
  fixture.setTime(new Date(fixture.now.getTime() + 5_000));
  const observer = observeSql(fixture.database.pool);
  const barrier = observer.hold({ statement: 'COMMIT', occurrence: 2 }, 'after');
  const intent = addressIntent(actor, space, address, key);
  let first;
  try {
    await barrier.entered;
    const committedReservation = await fixture.addressClaim(address);
    expect(committedReservation).toMatchObject({
      state: 'pending',
      normalized_address: address,
      space_id: space.spaceId,
    });
    const revoked = await fixture.revokeOwner(governance, space.spaceId, actor);
    expect(revoked.response.status).toBe(200);
    barrier.release();
    first = await intent;
  } finally {
    barrier.release();
    await observer.close();
  }
  expect(first!.response.status).toBe(403);
  expect(first!.value).not.toHaveProperty('space');
  const afterDenied = await fixture.spaceState(space.spaceId);
  expect(afterDenied.revisions).toHaveLength(1);
  expect(headId(afterDenied)).toBe(space.headRevisionId);
  const committed = await fixture.addressClaim(address);
  expect(committed).toMatchObject({ state: 'pending', normalized_address: address, space_id: space.spaceId });
  expect(
    await fixture.receipt(partitionOf(addressRoute(address)), actor, key, 'community.space.address.pending'),
  ).not.toBeNull();
  expect(await fixture.receipt(partitionOf(routeOf(space.spaceId)!), actor, key, 'community.space.address')).toBeNull();
  expect(
    await fixture.receipt(partitionOf(addressRoute(address)), actor, key, 'community.space.address.activate'),
  ).toBeNull();

  const retry = await addressIntent(actor, space, address, key);
  expect(retry.response.status).toBe(403);
  expect(retry.value).not.toHaveProperty('space');
  expect(await fixture.addressClaim(address)).toEqual(committed);
  expect((await fixture.spaceState(space.spaceId)).revisions).toHaveLength(1);
});

test.serial(
  'old-address reservation expires at thirty days and case-normalized reads keep a protected Realm private',
  async () => {
    const firstOwner = await owner('old-address-owner', ['space:create', 'realm:create']);
    const nextOwner = await owner('reserved-address-taker');
    const firstSpace = await fixture.createSpace(firstOwner, 'Address change owner');
    const nextSpace = await fixture.createSpace(nextOwner, 'Address reservation taker');
    const oldAddress = addressAtIndependentAnchor('old-case-address', [firstSpace.spaceId]);
    const normalizedOld = oldAddress.toLowerCase();
    const initialClaim = await addressIntent(firstOwner, firstSpace, oldAddress.toUpperCase(), randomUUID());
    expect(initialClaim.response.status).toBe(200);
    const claimed = initialClaim.value.space as Record<string, unknown>;
    expect(claimed.address).toBe(normalizedOld);

    const realm = await fixture.request('POST', '/v1/realms', {
      bearer: firstOwner.bearer,
      key: randomUUID(),
      body: {
        spaceId: firstSpace.spaceId,
        title: 'Protected carried Realm',
        summary: '',
        visibility: 'protected',
        contextId: GLOBAL_CONTEXT,
      },
    });
    expect(realm.response.status).toBe(201);
    const realmBody = realm.value.realm as Record<string, unknown>;
    expect(realmBody).toMatchObject({ spaceId: firstSpace.spaceId, visibility: 'protected', state: 'active' });
    const publicSpace = await fixture.request('GET', `/v1/spaces/${firstSpace.spaceId}`);
    expect(publicSpace.response.status).toBe(200);
    expect((publicSpace.value.space as Record<string, unknown>).realmId).toBeNull();
    const normalizedRead = await fixture.request('GET', `/v1/spaceAddresses/${oldAddress.toUpperCase()}`);
    expect(normalizedRead.response.status).toBe(200);
    expect(normalizedRead.value).toEqual({ spaceId: firstSpace.spaceId });

    fixture.setTime(new Date(fixture.now.getTime() + 1_000));
    const currentAddress = addressAtIndependentAnchor('new-current-address', [firstSpace.spaceId]);
    const changed = await addressIntent(
      firstOwner,
      { ...firstSpace, etag: initialClaim.response.headers.get('etag')! },
      currentAddress,
      randomUUID(),
      initialClaim.response.headers.get('etag')!,
    );
    expect(changed.response.status).toBe(200);
    expect((changed.value.space as Record<string, unknown>).address).toBe(currentAddress);
    const oldClaim = await fixture.addressClaim(oldAddress);
    expect(oldClaim).toMatchObject({
      state: 'reserved',
      normalized_address: normalizedOld,
      space_id: firstSpace.spaceId,
    });
    const reservedUntil = new Date(String(oldClaim?.reserved_until)).getTime();
    expect(Number.isFinite(reservedUntil)).toBe(true);

    const afterChange = await fixture.spaceState(firstSpace.spaceId);
    const nextBefore = await fixture.spaceState(nextSpace.spaceId);
    fixture.setTime(new Date(reservedUntil - 1));
    const beforeBoundaryKey = randomUUID();
    const beforeBoundary = await addressIntent(nextOwner, nextSpace, oldAddress.toUpperCase(), beforeBoundaryKey);
    expect(beforeBoundary.response.status).toBe(409);
    expect(errorCode(beforeBoundary.value)).toBe('conflict');
    expect(await fixture.addressClaim(oldAddress)).toEqual(oldClaim);
    expect((await fixture.spaceState(nextSpace.spaceId)).head?.head_revision_id).toBe(
      nextBefore.head?.head_revision_id,
    );

    fixture.setTime(new Date(reservedUntil));
    const boundaryKey = randomUUID();
    const reclaimed = await addressIntent(nextOwner, nextSpace, oldAddress.toUpperCase(), boundaryKey);
    expect(reclaimed.response.status).toBe(200);
    expect((reclaimed.value.space as Record<string, unknown>).address).toBe(normalizedOld);
    expect(await fixture.addressClaim(oldAddress)).toMatchObject({
      state: 'active',
      normalized_address: normalizedOld,
      space_id: nextSpace.spaceId,
      reserved_until: null,
    });
    expect((await fixture.spaceState(firstSpace.spaceId)).head?.head_revision_id).toBe(
      afterChange.head?.head_revision_id,
    );
  },
);
