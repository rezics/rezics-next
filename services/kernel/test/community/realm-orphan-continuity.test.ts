import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { resourceAuthorization } from '../../src/access/index.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { noEffect, principalCommandIdentity, runCommand } from '../../src/command/command.ts';
import { realmGovernanceAuthorization, RealmReadOnlyError, requestRealmClaim } from '../../src/community/realm-continuity.ts';
import { readRealm, updateRealm } from '../../src/community/realm.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createNativeContentSystemWithWriteRateOverrides, type NativeContentSystem } from '../content/support/native-system.ts';
import { HIGH_RATE_OVERRIDES, seedGovernanceAuthority } from '../content/support/disclosure-fixtures.ts';

let system: NativeContentSystem;
let at: string;
const owner = () => system.actors.other;
const context = (idempotencyKey = crypto.randomUUID()) => ({ idempotencyKey, deadline: Date.now() + 30_000 });
const deps = () => ({ pool: system.database.pool, access: system.access, routeKey: system.routeKey, clock: () => new Date(at) });
async function request(method: string, path: string, body?: unknown, key = crypto.randomUUID(), bearer = owner().bearer, headers = {}) {
  return system.kernel.handle(new Request(`https://content.test${path}`, {
    method,
    headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(key) }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}
async function createRealm() {
  const spaceResponse = await request('POST', '/v1/spaces', { title: 'Continuity host' });
  expect(spaceResponse.status).toBe(201);
  const { space } = await spaceResponse.json() as { space: { spaceId: string } };
  const response = await request('POST', '/v1/realms', {
    spaceId: space.spaceId, title: 'Continuity community', visibility: 'public', contextId: GLOBAL_CONTEXT,
  });
  expect(response.status).toBe(201);
  const { realm } = await response.json() as { realm: { realmId: string; headRevisionId: string } };
  return realm;
}
/** Fixture a stored decision only. This is deliberately not proof of native Access succession. */
async function orphan(realmId: string, early = false) {
  await system.database.pool.query(`UPDATE community.realm
    SET ownership_state='orphaned',
        orphaned_at=$3::timestamptz - interval '720 hours' + $4::interval,
        claim_eligible_at=$3::timestamptz + $4::interval
    WHERE route=$1 AND realm_id=$2`, [routeOf(realmId), realmId, at, early ? '1 microsecond' : '0 seconds']);
}

beforeAll(async () => {
  system = await createNativeContentSystemWithWriteRateOverrides({ databaseUrl: process.env.DATABASE_URL! }, HIGH_RATE_OVERRIDES);
  await bootstrapRelease(system.database.pool, bundledRelease);
  await seedGovernanceAuthority(system.database.pool, PLATFORM_RESOURCE.route, PLATFORM_RESOURCE.id, owner().actor.accountId,
    ['space:create', 'realm:create']);
  at = new Date().toISOString();
  await system.clock.setCommandTime(at);
});
afterAll(async () => { await system?.close(); });

test('stored orphan decision preserves public read and discussion admission while metadata and vote governance refuse real owner grants', async () => {
  const realm = await createRealm();
  await orphan(realm.realmId);
  const path = `/v1/realms/${realm.realmId}`;
  const read = await request('GET', path, undefined, undefined, '');
  expect(read.status).toBe(200);
  expect((await read.json() as { realm: object }).realm).toMatchObject({
    ownershipState: 'orphaned', governanceReadOnly: true, contextId: GLOBAL_CONTEXT,
  });
  expect((await request('GET', `${path}/participation`)).status).toBe(204);
  for (const body of [{ title: 'Governance change' }, { votes: { like: 1 } }]) {
    const response = await request('PATCH', path, body, undefined, owner().bearer, { 'if-match': JSON.stringify(realm.headRevisionId) });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('read-only');
  }
  const current = await readRealm(deps(), owner().actor, realm.realmId, { deadline: Date.now() + 30_000 });
  expect(current?.headRevisionId).toBe(realm.headRevisionId);
});

test('one microsecond before the original claim deadline is refused without a pending request', async () => {
  const realm = await createRealm();
  await orphan(realm.realmId, true);
  await expect(requestRealmClaim(deps(), owner().actor, realm.realmId, context())).rejects.toMatchObject({ code: 'conflict' });
  const pending = await system.database.pool.query('SELECT request_id FROM community.realm_claim_request WHERE route=$1 AND realm_id=$2',
    [routeOf(realm.realmId), realm.realmId]);
  expect(pending.rows).toHaveLength(0);
});

test('exact deadline accepts only pending review and retries preserve the deadline, request and native grants', async () => {
  const realm = await createRealm();
  await orphan(realm.realmId);
  const grants = async () => (await system.database.pool.query(
    'SELECT subject_id,role,valid::text FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2 ORDER BY subject_id,role,valid',
    [routeOf(realm.realmId), realm.realmId])).rows;
  const before = await grants();
  const key = crypto.randomUUID();
  const first = await requestRealmClaim(deps(), owner().actor, realm.realmId, context(key));
  expect(first.value.state).toBe('pending');
  expect(Date.parse(first.value.claimEligibleAt)).toBe(Date.parse(at));
  for (const retryKey of [key, crypto.randomUUID()]) {
    const retry = await requestRealmClaim(deps(), owner().actor, realm.realmId, context(retryKey));
    expect(retry.value).toEqual(first.value);
  }
  const restricted = await system.auth.issue({ accountId: owner().actor.accountId,
    clientId: system.auth.ordinaryClient.id, scopes: ['realm:read'] });
  await expect(requestRealmClaim(deps(), restricted.actor, realm.realmId, context(key)))
    .rejects.toMatchObject({ name: 'GrantDeniedError' });
  expect(await grants()).toEqual(before);
  const requests = await system.database.pool.query('SELECT state FROM community.realm_claim_request WHERE route=$1 AND realm_id=$2',
    [routeOf(realm.realmId), realm.realmId]);
  expect(requests.rows).toEqual([{ state: 'pending' }]);
  await expect(system.database.pool.query(`UPDATE community.realm
    SET orphaned_at=orphaned_at + interval '1 second', claim_eligible_at=claim_eligible_at + interval '1 second'
    WHERE route=$1 AND realm_id=$2`, [routeOf(realm.realmId), realm.realmId])).rejects.toMatchObject({ code: '23514' });
});

test('a native decision committed after preparation is rechecked before receipt or governance effects', async () => {
  const realm = await createRealm();
  const route = routeOf(realm.realmId)!;
  const resource = { route, id: realm.realmId };
  const native = resourceAuthorization({
    access: system.access, actor: owner().actor, action: 'realm:manage',
    anchor: { resource, async validate(client) {
      return !!(await client.query('SELECT realm_id FROM community.realm WHERE route=$1 AND realm_id=$2', [route, realm.realmId])).rowCount;
    } }, context: { pool: system.database.pool, deadline: Date.now() + 30_000, partition: partitionOf(route) },
  });
  const checked = realmGovernanceAuthorization(native, resource);
  let executed = false;
  await expect(runCommand(system.database.pool, {
    ...principalCommandIdentity(owner().actor), partition: partitionOf(route), clock: () => new Date(at), deadline: Date.now() + 30_000,
    authorization: { ...checked, async prepare(attempt) {
      const proof = await native.prepare!(attempt);
      await orphan(realm.realmId);
      return proof;
    } },
  }, async () => { executed = true; return noEffect(null); })).rejects.toBeInstanceOf(RealmReadOnlyError);
  expect(executed).toBe(false);
  await expect(updateRealm(deps(), owner().actor, { realmId: realm.realmId, expectedHead: realm.headRevisionId, title: 'Still refused' }, context()))
    .rejects.toBeInstanceOf(RealmReadOnlyError);
});
