import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { resourceAuthorization } from '../../src/access/index.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { noEffect, principalCommandIdentity, runCommand } from '../../src/command/command.ts';
import {
  realmGovernanceAuthorization,
  RealmReadOnlyError,
  requestRealmClaim,
} from '../../src/community/realm-continuity.ts';
import { readRealm, updateRealm } from '../../src/community/realm.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  createNativeContentSystemWithWriteRateOverrides,
  type NativeContentSystem,
} from '../content/support/native-system.ts';
import { HIGH_RATE_OVERRIDES, seedGovernanceAuthority } from '../content/support/disclosure-fixtures.ts';
import { createPartyLocatorEffect } from '../../src/community/party-locator.ts';
import { eraseAccountCommunityRecordsPage } from '../../src/community/account-erasure-records.ts';
import { accountDeletionRuntime, deletePersona } from '../support/account-deletion.ts';
import { approveRealmClaim } from '../../src/access/realm-claim.ts';
import { applyRealmClaimApproval, lockRealmClaimApprovalSource } from '../../src/community/realm-claim-approval.ts';
import { lockRealmOwnershipSource } from '../../src/community/realm-continuity.ts';
import {
  eraseAccountMembershipsPage,
  eraseAccountRealmOwnership,
} from '../../src/community/account-erasure-memberships.ts';
import { createRealmOwnershipCommands } from '../../src/access/realm-ownership.ts';
import { COMMUNITY_PLATFORM_BASIS } from '../../src/community/party-locator.ts';

let system: NativeContentSystem;
let at: string;
const owner = () => system.actors.other;
const context = (idempotencyKey = crypto.randomUUID()) => ({ idempotencyKey, deadline: Date.now() + 30_000 });
const deps = () => ({
  pool: system.database.pool,
  access: system.access,
  routeKey: system.routeKey,
  clock: () => new Date(at),
});
async function request(
  method: string,
  path: string,
  body?: unknown,
  key = crypto.randomUUID(),
  bearer = owner().bearer,
  headers = {},
) {
  return system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(key) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function createRealm() {
  const spaceResponse = await request('POST', '/v1/spaces', { title: 'Continuity host' });
  expect(spaceResponse.status).toBe(201);
  const { space } = (await spaceResponse.json()) as { space: { spaceId: string } };
  const response = await request('POST', '/v1/realms', {
    spaceId: space.spaceId,
    title: 'Continuity community',
    visibility: 'public',
    contextId: GLOBAL_CONTEXT,
  });
  expect(response.status).toBe(201);
  const { realm } = (await response.json()) as { realm: { realmId: string; headRevisionId: string } };
  return realm;
}
/** Fixture a stored decision only. This is deliberately not proof of native Access succession. */
async function orphan(realmId: string, early = false) {
  await system.database.pool.query(
    `UPDATE community.realm
    SET ownership_state='orphaned',
        orphaned_at=$3::timestamptz - interval '720 hours' + $4::interval,
        claim_eligible_at=$3::timestamptz + $4::interval
    WHERE route=$1 AND realm_id=$2`,
    [routeOf(realmId), realmId, at, early ? '1 microsecond' : '0 seconds'],
  );
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
afterAll(async () => {
  await system?.close();
});

test('stored orphan decision preserves public read and discussion admission while metadata and vote governance refuse real owner grants', async () => {
  const realm = await createRealm();
  await orphan(realm.realmId);
  const path = `/v1/realms/${realm.realmId}`;
  const read = await request('GET', path, undefined, undefined, '');
  expect(read.status).toBe(200);
  expect(((await read.json()) as { realm: object }).realm).toMatchObject({
    ownershipState: 'orphaned',
    governanceReadOnly: true,
    contextId: GLOBAL_CONTEXT,
  });
  expect((await request('GET', `${path}/participation`)).status).toBe(204);
  for (const body of [{ title: 'Governance change' }, { votes: { like: 1 } }]) {
    const response = await request('PATCH', path, body, undefined, owner().bearer, {
      'if-match': JSON.stringify(realm.headRevisionId),
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('read-only');
  }
  const current = await readRealm(deps(), owner().actor, realm.realmId, { deadline: Date.now() + 30_000 });
  expect(current?.headRevisionId).toBe(realm.headRevisionId);
});

test('one microsecond before the original claim deadline is refused without a pending request', async () => {
  const realm = await createRealm();
  await orphan(realm.realmId, true);
  await expect(requestRealmClaim(deps(), owner().actor, realm.realmId, context())).rejects.toMatchObject({
    code: 'conflict',
  });
  const pending = await system.database.pool.query(
    'SELECT request_id FROM community.realm_claim_request WHERE route=$1 AND realm_id=$2',
    [routeOf(realm.realmId), realm.realmId],
  );
  expect(pending.rows).toHaveLength(0);
});

test('exact deadline accepts only pending review and retries preserve the deadline, request and native grants', async () => {
  const realm = await createRealm();
  await orphan(realm.realmId);
  const grants = async () =>
    (
      await system.database.pool.query(
        'SELECT subject_id,role,valid::text FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2 ORDER BY subject_id,role,valid',
        [routeOf(realm.realmId), realm.realmId],
      )
    ).rows;
  const before = await grants();
  const key = crypto.randomUUID();
  const first = await requestRealmClaim(deps(), owner().actor, realm.realmId, context(key));
  expect(first.value.state).toBe('pending');
  expect(Date.parse(first.value.claimEligibleAt)).toBe(Date.parse(at));
  for (const retryKey of [key, crypto.randomUUID()]) {
    const retry = await requestRealmClaim(deps(), owner().actor, realm.realmId, context(retryKey));
    expect(retry.value).toEqual(first.value);
  }
  const restricted = await system.auth.issue({
    accountId: owner().actor.accountId,
    clientId: system.auth.ordinaryClient.id,
    scopes: ['realm:read'],
  });
  await expect(requestRealmClaim(deps(), restricted.actor, realm.realmId, context(key))).rejects.toMatchObject({
    name: 'GrantDeniedError',
  });
  expect(await grants()).toEqual(before);
  const requests = await system.database.pool.query(
    'SELECT state FROM community.realm_claim_request WHERE route=$1 AND realm_id=$2',
    [routeOf(realm.realmId), realm.realmId],
  );
  expect(requests.rows).toEqual([{ state: 'pending' }]);
  await expect(
    system.database.pool.query(
      `UPDATE community.realm
    SET orphaned_at=orphaned_at + interval '1 second', claim_eligible_at=claim_eligible_at + interval '1 second'
    WHERE route=$1 AND realm_id=$2`,
      [routeOf(realm.realmId), realm.realmId],
    ),
  ).rejects.toMatchObject({ code: '23514' });
});

test('a native decision committed after preparation is rechecked before receipt or governance effects', async () => {
  const realm = await createRealm();
  const route = routeOf(realm.realmId)!;
  const resource = { route, id: realm.realmId };
  const native = resourceAuthorization({
    access: system.access,
    actor: owner().actor,
    action: 'realm:manage',
    anchor: {
      resource,
      async validate(client) {
        return !!(
          await client.query('SELECT realm_id FROM community.realm WHERE route=$1 AND realm_id=$2', [
            route,
            realm.realmId,
          ])
        ).rowCount;
      },
    },
    context: { pool: system.database.pool, deadline: Date.now() + 30_000, partition: partitionOf(route) },
  });
  const checked = realmGovernanceAuthorization(native, resource);
  let executed = false;
  await expect(
    runCommand(
      system.database.pool,
      {
        ...principalCommandIdentity(owner().actor),
        partition: partitionOf(route),
        clock: () => new Date(at),
        deadline: Date.now() + 30_000,
        authorization: {
          ...checked,
          async prepare(attempt) {
            const proof = await native.prepare!(attempt);
            await orphan(realm.realmId);
            return proof;
          },
        },
      },
      async () => {
        executed = true;
        return noEffect(null);
      },
    ),
  ).rejects.toBeInstanceOf(RealmReadOnlyError);
  expect(executed).toBe(false);
  await expect(
    updateRealm(
      deps(),
      owner().actor,
      { realmId: realm.realmId, expectedHead: realm.headRevisionId, title: 'Still refused' },
      context(),
    ),
  ).rejects.toBeInstanceOf(RealmReadOnlyError);
});

test('pending requester custody uses the existing erasure obligation and event replay cannot restore it', async () => {
  const realm = await createRealm();
  await orphan(realm.realmId);
  const runtime = accountDeletionRuntime(system);
  const person = await runtime.person();
  const requester = await system.auth.issue({
    accountId: person.accountId,
    clientId: system.auth.ordinaryClient.id,
    scopes: ['realm:read', 'realm:participate'],
  });
  const requestedAt = new Date().toISOString();
  await system.clock.setCommandTime(requestedAt);
  const outcome = await requestRealmClaim(
    { ...deps(), clock: () => new Date(requestedAt) },
    requester.actor,
    realm.realmId,
    context(),
  );
  const eventRow = (
    await system.database.pool.query<{ id: string; data: unknown; recorded_at: Date }>(
      `SELECT id::text,data,recorded_at FROM core.outbox
     WHERE partition_no=$1 AND position=$2 AND type='com.rezics.community.realm.claim-requested.v1'`,
      [outcome.partition, outcome.position.toString()],
    )
  ).rows[0];
  if (!eventRow) throw new Error('Native claim command did not emit its custody source event');
  const event = {
    specversion: '1.0' as const,
    id: eventRow.id,
    source: `urn:rezics:log:${outcome.partition}.${outcome.epoch}`,
    type: 'com.rezics.community.realm.claim-requested.v1',
    subject: realm.realmId,
    time: eventRow.recorded_at.toISOString(),
    datacontenttype: 'application/json' as const,
    sequence: outcome.position.toString().padStart(19, '0'),
    data: eventRow.data,
  };
  const effect = createPartyLocatorEffect(system.database.pool);
  await effect.run(event);
  await effect.run(event);
  const locator = await system.database.pool.query(
    `SELECT kind,owner_id::text,key FROM community.party_locator
     WHERE route=$1 AND account_id=$2 AND kind='claim_request'`,
    [routeOf(person.accountId), person.accountId],
  );
  expect(locator.rows).toEqual([{ kind: 'claim_request', owner_id: realm.realmId, key: outcome.value.requestId }]);

  const erased = await deletePersona({ pool: system.database.pool, auth: runtime.auth }, person);
  const disposition = await eraseAccountCommunityRecordsPage({ pool: system.database.pool }, person.accountId, {
    erasedAt: erased.at,
  });
  expect(disposition.pending).toBe(0);
  await effect.run(event);
  expect(
    (
      await system.database.pool.query(
        'SELECT request_id FROM community.realm_claim_request WHERE route=$1 AND realm_id=$2 AND request_id=$3',
        [routeOf(realm.realmId), realm.realmId, outcome.value.requestId],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await system.database.pool.query(
        `SELECT key FROM community.party_locator WHERE route=$1 AND account_id=$2 AND kind='claim_request'`,
        [routeOf(person.accountId), person.accountId],
      )
    ).rows,
  ).toEqual([]);
});

test('native claim source refuses clones and another command, and approval state rolls back with its writer', async () => {
  at = new Date().toISOString();
  await system.clock.setCommandTime(at);
  const realm = await createRealm();
  await orphan(realm.realmId);
  const pending = await requestRealmClaim(deps(), owner().actor, realm.realmId, context());
  const options = {
    partition: partitionOf(routeOf(realm.realmId)!),
    basis: COMMUNITY_PLATFORM_BASIS,
    clock: () => new Date(at),
    deadline: Date.now() + 30_000,
  };
  const input = { realmId: realm.realmId, requestId: pending.value.requestId };
  const saved = await runCommand(system.database.pool, options, async (tx) => {
    const source = await lockRealmClaimApprovalSource(tx, input);
    if (!source) throw new Error('Native pending claim source is missing');
    return noEffect(source);
  });
  await expect(
    runCommand(system.database.pool, options, async (tx) => {
      await applyRealmClaimApproval(tx, saved.value);
      return noEffect(null);
    }),
  ).rejects.toMatchObject({ code: 'conflict' });
  const rollback = new Error('Rollback after native claim application');
  await expect(
    runCommand(system.database.pool, options, async (tx) => {
      const source = await lockRealmClaimApprovalSource(tx, input);
      if (!source) throw new Error('Native pending claim source is missing');
      expect(source.orphanedAt).toBe(pending.value.orphanedAt);
      await expect(applyRealmClaimApproval(tx, { ...source })).rejects.toMatchObject({ code: 'conflict' });
      const applied = await applyRealmClaimApproval(tx, source);
      expect(applied).toMatchObject({ ...input, state: 'owned', orphanedAt: pending.value.orphanedAt });
      const current = await lockRealmOwnershipSource(tx, realm.realmId);
      expect(current).toMatchObject({ ownershipState: 'owned', orphanedAt: null, claimEligibleAt: null });
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  const row = (
    await system.database.pool.query(
      `SELECT r.ownership_state,r.orphaned_at::text,r.claim_eligible_at::text,c.state,c.approved_at
     FROM community.realm r JOIN community.realm_claim_request c USING(route,realm_id)
     WHERE r.route=$1 AND r.realm_id=$2 AND c.request_id=$3`,
      [routeOf(realm.realmId), realm.realmId, pending.value.requestId],
    )
  ).rows[0];
  expect(row).toEqual({
    ownership_state: 'orphaned',
    orphaned_at: pending.value.orphanedAt,
    claim_eligible_at: pending.value.claimEligibleAt,
    state: 'pending',
    approved_at: null,
  });
});

test('native platform claim approval installs a real owner, replays after its state change and rechecks current direct Global authority', async () => {
  at = new Date().toISOString();
  await system.clock.setCommandTime(at);
  const realm = await createRealm();
  await orphan(realm.realmId);
  const claimant = system.actors.author;
  const approver = system.actors.moderator;
  const pending = await requestRealmClaim(deps(), claimant.actor, realm.realmId, context());
  const input = { realmId: realm.realmId, requestId: pending.value.requestId };
  const key = crypto.randomUUID();
  await expect(approveRealmClaim(deps(), owner().actor, input, context(key))).rejects.toMatchObject({
    name: 'GrantDeniedError',
  });
  await seedGovernanceAuthority(
    system.database.pool,
    PLATFORM_RESOURCE.route,
    PLATFORM_RESOURCE.id,
    approver.actor.accountId,
    ['realm:approve_claim'],
  );
  const first = await approveRealmClaim(deps(), approver.actor, input, context(key));
  expect(first).toMatchObject({
    ...input,
    claimantAccountId: claimant.actor.accountId,
    state: 'owned',
    orphanedAt: pending.value.orphanedAt,
  });
  const receipts = async () =>
    (
      await system.database.pool.query(
        `SELECT transaction_id::text,epoch,position::text,response FROM core.receipt
         WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
           AND command_kind='access.realm.claim.approve' AND response->>'realmId'=$3
           AND response->>'requestId'=$4 ORDER BY transaction_id`,
        [partitionOf(routeOf(realm.realmId)!), approver.actor.accountId, realm.realmId, input.requestId],
      )
    ).rows;
  const originalReceipt = await receipts();
  expect(originalReceipt).toHaveLength(1);
  expect(originalReceipt[0].response).toEqual(first);
  const replay = await approveRealmClaim(deps(), approver.actor, input, context(key));
  expect(replay).toEqual(first);
  expect(await receipts()).toEqual(originalReceipt);
  const row = (
    await system.database.pool.query(
      `SELECT r.ownership_state,r.orphaned_at,r.claim_eligible_at,c.state,c.approved_at::text
     FROM community.realm r JOIN community.realm_claim_request c USING(route,realm_id)
     WHERE r.route=$1 AND r.realm_id=$2 AND c.request_id=$3`,
      [routeOf(realm.realmId), realm.realmId, pending.value.requestId],
    )
  ).rows[0];
  expect(row).toEqual({
    ownership_state: 'owned',
    orphaned_at: null,
    claim_eligible_at: null,
    state: 'approved',
    approved_at: first.approvedAt,
  });
  expect(
    (
      await system.database.pool.query(
        `SELECT grant_role FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2
     AND subject_kind='identity' AND subject_id=$3 AND subject_role=''
     AND grant_role='community.realm.owner' AND valid @> $4::timestamptz`,
        [routeOf(realm.realmId), realm.realmId, claimant.actor.accountId, at],
      )
    ).rows,
  ).toEqual([{ grant_role: 'community.realm.owner' }]);
  const http = await request(
    'POST',
    `/v1/realms/${realm.realmId}/claimRequests/${input.requestId}:approve`,
    undefined,
    key,
    approver.bearer,
  );
  expect(http.status).toBe(200);
  expect(await http.json()).toEqual({
    claim: {
      ...first,
      orphanedAt: new Date(first.orphanedAt).toISOString(),
      approvedAt: new Date(first.approvedAt).toISOString(),
    },
  });
  expect(await receipts()).toEqual(originalReceipt);
  await system.database.pool.query(
    `DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_kind='identity'
     AND subject_id=$3 AND action='realm:approve_claim'`,
    [PLATFORM_RESOURCE.route, PLATFORM_RESOURCE.id, approver.actor.accountId],
  );
  await expect(approveRealmClaim(deps(), approver.actor, input, context(key))).rejects.toMatchObject({
    name: 'GrantDeniedError',
  });
});

test('default committed-erasure succession uses the original root instant and retains the exact orphan episode on retry', async () => {
  const runtime = accountDeletionRuntime(system);
  const person = await runtime.person();
  at = new Date().toISOString();
  await system.clock.setCommandTime(at);
  await seedGovernanceAuthority(system.database.pool, PLATFORM_RESOURCE.route, PLATFORM_RESOURCE.id, person.accountId, [
    'space:create',
    'realm:create',
  ]);
  const spaceResponse = await request(
    'POST',
    '/v1/spaces',
    { title: 'Erasure succession host' },
    undefined,
    person.bearer,
  );
  expect(spaceResponse.status).toBe(201);
  const { space } = await spaceResponse.json();
  const realmResponse = await request(
    'POST',
    '/v1/realms',
    {
      spaceId: space.spaceId,
      title: 'Erasure succession Realm',
      visibility: 'public',
      contextId: GLOBAL_CONTEXT,
    },
    undefined,
    person.bearer,
  );
  expect(realmResponse.status).toBe(201);
  const { realm } = await realmResponse.json();
  const erased = await deletePersona({ pool: system.database.pool, auth: runtime.auth }, person);
  const read = async () =>
    (
      await system.database.pool.query(
        `SELECT ownership_state,orphaned_at::text,claim_eligible_at::text,
       orphaned_at=$3::timestamptz AS original_root,
       claim_eligible_at=orphaned_at + interval '720 hours' AS original_deadline
     FROM community.realm WHERE route=$1 AND realm_id=$2`,
        [routeOf(realm.realmId), realm.realmId, erased.at],
      )
    ).rows[0];
  await eraseAccountMembershipsPage({ pool: system.database.pool, access: system.access }, person.accountId, null);
  const first = await read();
  expect(first).toMatchObject({ ownership_state: 'orphaned', original_root: true, original_deadline: true });
  await eraseAccountMembershipsPage({ pool: system.database.pool, access: system.access }, person.accountId, null);
  expect(await read()).toEqual(first);
});

test('native erasure segment rolls grants and continuity back together and replays the original orphan episode', async () => {
  const runtime = accountDeletionRuntime(system);
  const person = await runtime.person();
  at = new Date().toISOString();
  await system.clock.setCommandTime(at);
  await seedGovernanceAuthority(system.database.pool, PLATFORM_RESOURCE.route, PLATFORM_RESOURCE.id, person.accountId, [
    'space:create',
    'realm:create',
  ]);
  const spaceResponse = await request(
    'POST',
    '/v1/spaces',
    { title: 'Native succession host' },
    undefined,
    person.bearer,
  );
  expect(spaceResponse.status).toBe(201);
  const { space } = await spaceResponse.json();
  const realmResponse = await request(
    'POST',
    '/v1/realms',
    {
      spaceId: space.spaceId,
      title: 'Native succession Realm',
      visibility: 'public',
      contextId: GLOBAL_CONTEXT,
    },
    undefined,
    person.bearer,
  );
  expect(realmResponse.status).toBe(201);
  const { realm } = await realmResponse.json();
  const erased = await deletePersona({ pool: system.database.pool, auth: runtime.auth }, person);
  const input = { realmId: realm.realmId, accountId: person.accountId };
  const nativeDeps = { pool: system.database.pool, access: system.access };
  const commands = createRealmOwnershipCommands(nativeDeps);
  const route = routeOf(realm.realmId)!;
  const read = async () =>
    (
      await system.database.pool.query(
        `SELECT r.ownership_state,r.orphaned_at::text,r.claim_eligible_at::text,
       r.orphaned_at=$3::timestamptz AS original_root,
       r.claim_eligible_at=r.orphaned_at + interval '720 hours' AS original_deadline,
       EXISTS (SELECT 1 FROM access.resource_role_grant g WHERE g.route=r.route AND g.resource_id=r.realm_id
         AND g.subject_kind='identity' AND g.subject_id=$4 AND g.subject_role=''
         AND g.grant_role='community.realm.owner' AND upper_inf(g.valid)) AS erased_owner
       FROM community.realm r WHERE r.route=$1 AND r.realm_id=$2`,
        [route, realm.realmId, erased.at, person.accountId],
      )
    ).rows[0];
  const before = await read();
  expect(before).toMatchObject({ ownership_state: 'owned', erased_owner: true });
  const rollback = new Error('Rollback native succession segment');
  await expect(
    runCommand(
      system.database.pool,
      {
        partition: partitionOf(route),
        deadline: Date.now() + 30_000,
        authorization: commands.erasureSuccessionAuthorization({
          resource: { route, id: realm.realmId },
          accountId: person.accountId,
        }),
      },
      async (tx) => {
        const applied = await commands.applyErasureSuccession(tx);
        expect(applied.status).toBe('orphaned');
        expect(await lockRealmOwnershipSource(tx, realm.realmId)).toMatchObject({ ownershipState: 'orphaned' });
        throw rollback;
      },
    ),
  ).rejects.toBe(rollback);
  expect(await read()).toEqual(before);
  const first = await eraseAccountRealmOwnership(nativeDeps, input, { deadline: Date.now() + 30_000 });
  if (first.value.status === 'pending') throw new Error(`Native succession remained pending: ${first.value.reason}`);
  expect(first.value).toMatchObject({ status: 'orphaned', replayed: false, source: { accountId: person.accountId } });
  const orphaned = await read();
  expect(orphaned).toMatchObject({
    ownership_state: 'orphaned',
    original_root: true,
    original_deadline: true,
    erased_owner: false,
  });
  const replay = await eraseAccountRealmOwnership(nativeDeps, input, { deadline: Date.now() + 30_000 });
  expect(replay.value).toEqual({ ...first.value, replayed: true });
  expect(await read()).toEqual(orphaned);
});
