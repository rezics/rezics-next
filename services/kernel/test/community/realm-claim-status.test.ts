import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { Pool } from 'pg';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { approveRealmClaim } from '../../src/access/realm-claim.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { readOwnRealmClaim, type RealmClaimStatus } from '../../src/community/realm-claim-status.ts';
import { requestRealmClaim } from '../../src/community/realm-continuity.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { HIGH_RATE_OVERRIDES, seedGovernanceAuthority } from '../content/support/disclosure-fixtures.ts';
import {
  createNativeContentSystemWithWriteRateOverrides,
  type NativeContentSystem,
} from '../content/support/native-system.ts';

let system: NativeContentSystem;
let at: string;
const context = () => ({ idempotencyKey: crypto.randomUUID(), deadline: Date.now() + 30_000 });
const deps = () => ({
  pool: system.database.pool,
  access: system.access,
  routeKey: system.routeKey,
  clock: () => new Date(at),
});
const claimant = () => system.actors.author;
const owner = () => system.actors.other;
const base = (realmId: string) => `/v1/realms/${realmId}/claimRequests`;

async function request(
  method: string,
  path: string,
  bearer = claimant().bearer,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function createRealm() {
  const host = await request('POST', '/v1/spaces', owner().bearer, { title: 'Claim status host' });
  expect(host.status).toBe(201);
  const { space } = await host.json();
  const response = await request('POST', '/v1/realms', owner().bearer, {
    spaceId: space.spaceId,
    title: 'Claim status community',
    visibility: 'public',
    contextId: GLOBAL_CONTEXT,
  });
  expect(response.status).toBe(201);
  const { realm } = await response.json();
  return realm as { realmId: string; spaceId: string; headRevisionId: string };
}

/** Fixture the existing source decision, retaining microseconds. These cases
 * exercise receipt disclosure, not proof of the erasure succession producer.
 */
async function orphan(realmId: string) {
  await system.database.pool.query(
    `UPDATE community.realm SET ownership_state='orphaned',
       orphaned_at=$3::timestamptz - interval '720 hours 1 second' + interval '123456 microseconds',
       claim_eligible_at=$3::timestamptz - interval '1 second' + interval '123456 microseconds'
     WHERE route=$1 AND realm_id=$2`,
    [routeOf(realmId), realmId, at],
  );
}

async function status(path: string, bearer = claimant().bearer): Promise<RealmClaimStatus | null> {
  const response = await request('GET', path, bearer);
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json();
  expect(Object.keys(body).sort()).toEqual(['claimRequest', 'currentRealm', 'requestAdvice'].sort());
  expect(Object.keys(body.currentRealm).sort()).toEqual(['ownershipState', 'orphanedAt', 'claimEligibleAt'].sort());
  expect(body.requestAdvice).toMatchObject({
    method: 'POST',
    destination: path.includes('/mine') ? path.replace('/mine', '') : path.slice(0, path.lastIndexOf('/')),
    requiredAction: 'realm:participate',
    requiredHeader: 'Idempotency-Key',
  });
  if (body.claimRequest)
    expect(Object.keys(body.claimRequest).sort()).toEqual(
      ['realmId', 'requestId', 'state', 'orphanedAt', 'requestedAt', 'approvedAt', 'currentEpisode'].sort(),
    );
  return body.claimRequest;
}

beforeAll(async () => {
  system = await createNativeContentSystemWithWriteRateOverrides(
    { databaseUrl: process.env.DATABASE_URL! },
    HIGH_RATE_OVERRIDES,
  );
  await bootstrapRelease(system.database.pool, bundledRelease);
  await seedGovernanceAuthority(
    system.database.pool,
    PLATFORM_RESOURCE.route,
    PLATFORM_RESOURCE.id,
    owner().actor.accountId,
    ['space:create', 'realm:create'],
  );
  at = new Date().toISOString();
  await system.clock.setCommandTime(at);
});
afterAll(async () => system?.close());

test('Native requester claim receipt and current-episode recovery without another approval authority', async () => {
  const realm = await createRealm();
  await orphan(realm.realmId);
  expect(await status(`${base(realm.realmId)}/mine`)).toBeNull();
  const accepted = await request('POST', base(realm.realmId), claimant().bearer, {});
  expect(accepted.status, await accepted.clone().text()).toBe(202);
  const receipt = await accepted.json();
  // A fresh request knows only the Realm: no controller state or request id.
  const recovered = await status(`${base(realm.realmId)}/mine`);
  expect(recovered).toEqual({
    realmId: realm.realmId,
    requestId: receipt.requestId,
    state: 'pending',
    orphanedAt: receipt.orphanedAt,
    requestedAt: receipt.requestedAt,
    approvedAt: null,
    currentEpisode: true,
  });
  expect(await status(`${base(realm.realmId)}/${receipt.requestId}`)).toEqual(recovered);
  const single = new Pool({ ...system.database.pool.options, max: 1 });
  try {
    expect(
      await readOwnRealmClaim({ ...deps(), pool: single }, claimant().actor, { realmId: realm.realmId }, context()),
    ).toEqual(recovered);
  } finally {
    await single.end();
  }
  const refused = await request('POST', `${base(realm.realmId)}/${receipt.requestId}:approve`);
  expect(refused.status).toBe(403);
  expect(await status(`${base(realm.realmId)}/mine`)).toEqual(recovered);
});

test('own status conceals unrelated, denied and removed native points while known absence alone is null', async () => {
  const realm = await createRealm();
  await orphan(realm.realmId);
  const pending = await requestRealmClaim(deps(), claimant().actor, realm.realmId, context());
  const exact = `${base(realm.realmId)}/${pending.value.requestId}`;
  const mine = `${base(realm.realmId)}/mine`;
  expect((await request('GET', exact, '')).status).toBe(401);
  await seedGovernanceAuthority(
    system.database.pool,
    PLATFORM_RESOURCE.route,
    PLATFORM_RESOURCE.id,
    owner().actor.accountId,
    ['realm:approve_claim'],
  );
  // Even the creator with genuine platform review authority is not this claimant.
  expect((await request('GET', exact, owner().bearer)).status).toBe(404);
  expect(await status(mine, owner().bearer)).toBeNull();
  expect((await request('GET', `${base(realm.realmId)}/${newId(routeOf(realm.realmId)!)}`)).status).toBe(404);
  expect((await request('GET', `${base(newId(routeOf(realm.realmId)!))}/mine`)).status).toBe(404);
  const readOnly = await system.auth.issue({
    accountId: claimant().actor.accountId,
    clientId: system.auth.ordinaryClient.id,
    scopes: ['realm:read', 'space:read'],
  });
  for (const path of [exact, mine]) expect((await request('GET', path, readOnly.bearer)).status).toBe(404);
  await system.database.pool.query(`UPDATE community.realm SET visibility='protected' WHERE route=$1 AND realm_id=$2`, [
    routeOf(realm.realmId),
    realm.realmId,
  ]);
  for (const path of [exact, mine]) expect((await request('GET', path)).status).toBe(404);
  await system.database.pool.query(
    `UPDATE community.realm SET visibility='public', state='removed' WHERE route=$1 AND realm_id=$2`,
    [routeOf(realm.realmId), realm.realmId],
  );
  for (const path of [exact, mine]) expect((await request('GET', path)).status).toBe(404);
  await system.database.pool.query(`UPDATE community.realm SET state='active' WHERE route=$1 AND realm_id=$2`, [
    routeOf(realm.realmId),
    realm.realmId,
  ]);
  await system.database.pool.query(`UPDATE community.space SET state='removed' WHERE route=$1 AND space_id=$2`, [
    routeOf(realm.spaceId),
    realm.spaceId,
  ]);
  for (const path of [exact, mine]) expect((await request('GET', path)).status).toBe(404);
});

test('obsolete pending and approved receipts preserve original facts across native episodes with submillisecond identity', async () => {
  const realm = await createRealm();
  await orphan(realm.realmId);
  const first = await requestRealmClaim(deps(), claimant().actor, realm.realmId, context());
  const original = await status(`${base(realm.realmId)}/${first.value.requestId}`);
  if (!original) throw new Error('The original native claim receipt is missing');
  // A later actual source episode can differ by less than JavaScript Date precision.
  await system.database.pool.query(
    `UPDATE community.realm SET ownership_state='owned', orphaned_at=NULL, claim_eligible_at=NULL
     WHERE route=$1 AND realm_id=$2`,
    [routeOf(realm.realmId), realm.realmId],
  );
  await system.database.pool.query(
    `UPDATE community.realm SET ownership_state='orphaned',
       orphaned_at=$3::timestamptz + interval '1 microsecond',
       claim_eligible_at=$3::timestamptz + interval '720 hours 1 microsecond'
     WHERE route=$1 AND realm_id=$2`,
    [routeOf(realm.realmId), realm.realmId, first.value.orphanedAt],
  );
  expect(await status(`${base(realm.realmId)}/mine`)).toBeNull();
  expect(await status(`${base(realm.realmId)}/${first.value.requestId}`)).toEqual({
    ...original,
    currentEpisode: false,
  });
  const second = await requestRealmClaim(deps(), claimant().actor, realm.realmId, context());
  expect(second.value.requestId).not.toBe(first.value.requestId);
  const current = await status(`${base(realm.realmId)}/mine`);
  if (!current) throw new Error('The current native claim receipt is missing');
  expect(current).toMatchObject({ requestId: second.value.requestId, currentEpisode: true });
  expect(current?.orphanedAt).toBe(original?.orphanedAt);
  await seedGovernanceAuthority(
    system.database.pool,
    PLATFORM_RESOURCE.route,
    PLATFORM_RESOURCE.id,
    owner().actor.accountId,
    ['realm:approve_claim'],
  );
  const approved = await approveRealmClaim(
    deps(),
    owner().actor,
    { realmId: realm.realmId, requestId: second.value.requestId },
    context(),
  );
  expect(await status(`${base(realm.realmId)}/mine`)).toBeNull();
  const result = await status(`${base(realm.realmId)}/${second.value.requestId}`);
  expect(result).toEqual({
    ...current,
    state: 'approved',
    approvedAt: new Date(approved.approvedAt).toISOString(),
    currentEpisode: false,
  });
  // Remove the native owner role: a historical approved receipt still reads,
  // while the actual governance operation independently refuses this actor.
  await system.database.pool.query(
    `DELETE FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2
       AND subject_kind='identity' AND subject_id=$3 AND grant_role='community.realm.owner'`,
    [routeOf(realm.realmId), realm.realmId, claimant().actor.accountId],
  );
  expect(await status(`${base(realm.realmId)}/${second.value.requestId}`)).toEqual(result);
  const governance = await request(
    'PATCH',
    `/v1/realms/${realm.realmId}`,
    claimant().bearer,
    {
      title: 'Historical approval cannot edit',
    },
    { 'if-match': JSON.stringify(realm.headRevisionId) },
  );
  expect(governance.status).toBe(403);
});

test('fresh final authority and source failures never turn into a receipt or empty recovery', async () => {
  const realm = await createRealm();
  await orphan(realm.realmId);
  await requestRealmClaim(deps(), claimant().actor, realm.realmId, context());
  for (const mode of ['unavailable', 'removed'] as const) {
    let preparations = 0;
    const access = deriveAccess(system.access, {
      async prepare(actor, action, resource, preparation) {
        if (action === 'realm:read' && ++preparations === 2) {
          if (mode === 'unavailable') throw new AccessUnavailableError('overloaded');
          await system.database.pool.query(
            `UPDATE community.space SET state='removed' WHERE route=$1 AND space_id=$2`,
            [routeOf(realm.spaceId), realm.spaceId],
          );
        }
        return system.access.prepare!(actor, action, resource, preparation);
      },
    });
    await expect(
      readOwnRealmClaim({ ...deps(), access }, claimant().actor, { realmId: realm.realmId }, context()),
    ).rejects.toMatchObject(
      mode === 'unavailable' ? { name: 'AccessUnavailableError', reason: 'overloaded' } : { code: 'not_found' },
    );
    expect(preparations).toBe(2);
  }
});
