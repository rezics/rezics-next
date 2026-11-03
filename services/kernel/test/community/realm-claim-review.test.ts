import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { approveRealmClaim } from '../../src/access/realm-claim.ts';
import { requestRealmClaim } from '../../src/community/realm-continuity.ts';
import { listRealmClaimRequests, type RealmClaimReviewPage } from '../../src/community/realm-claim-review.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  createNativeContentSystemWithWriteRateOverrides,
  type NativeContentSystem,
} from '../content/support/native-system.ts';
import { HIGH_RATE_OVERRIDES, seedGovernanceAuthority } from '../content/support/disclosure-fixtures.ts';

let system: NativeContentSystem;
let at: string;
const owner = () => system.actors.other;
const reviewer = () => system.actors.moderator;
const deps = () => ({
  pool: system.database.pool,
  access: system.access,
  routeKey: system.routeKey,
  clock: () => new Date(at),
});
const context = () => ({ deadline: Date.now() + 30_000, idempotencyKey: crypto.randomUUID() });
async function request(method: string, path: string, bearer: string, body?: unknown) {
  return system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function realm(early = false) {
  const host = await request('POST', '/v1/spaces', owner().bearer, { title: 'Claim review host' });
  expect(host.status).toBe(201);
  const { space } = await host.json();
  const created = await request('POST', '/v1/realms', owner().bearer, {
    spaceId: space.spaceId,
    title: 'Private operational source',
    summary: 'Never reveal this text',
    visibility: 'protected',
    contextId: GLOBAL_CONTEXT,
  });
  expect(created.status).toBe(201);
  const { realm: value } = await created.json();
  await system.database.pool.query(
    `UPDATE community.realm
    SET ownership_state='orphaned', orphaned_at=$3::timestamptz - interval '720 hours' + $4::interval,
        claim_eligible_at=$3::timestamptz + $4::interval WHERE route=$1 AND realm_id=$2`,
    [routeOf(value.realmId), value.realmId, at, early ? '1 microsecond' : '0 seconds'],
  );
  return value as { realmId: string; headRevisionId: string };
}
async function pending(realmId: string) {
  // The owner has native read/participation in this protected Realm.
  return (await requestRealmClaim(deps(), owner().actor, realmId, context())).value;
}
async function reviewGrant() {
  await seedGovernanceAuthority(
    system.database.pool,
    PLATFORM_RESOURCE.route,
    PLATFORM_RESOURCE.id,
    reviewer().actor.accountId,
    ['realm:approve_claim'],
  );
}
async function revokeReviewGrant() {
  await system.database.pool.query(
    `DELETE FROM access.resource_grant
    WHERE route=$1 AND resource_id=$2 AND subject_kind='identity' AND subject_id=$3
      AND action='realm:approve_claim'`,
    [PLATFORM_RESOURCE.route, PLATFORM_RESOURCE.id, reviewer().actor.accountId],
  );
}

beforeAll(async () => {
  system = await createNativeContentSystemWithWriteRateOverrides(
    { databaseUrl: process.env.DATABASE_URL! },
    HIGH_RATE_OVERRIDES,
  );
  await bootstrapRelease(system.database.pool, bundledRelease);
  at = new Date().toISOString();
  await system.clock.setCommandTime(at);
  await seedGovernanceAuthority(
    system.database.pool,
    PLATFORM_RESOURCE.route,
    PLATFORM_RESOURCE.id,
    owner().actor.accountId,
    ['space:create', 'realm:create'],
  );
  await reviewGrant();
});
afterAll(async () => {
  await system?.close();
});

test('GET native pending Realm claim review, preserving sole Accounts approval', async () => {
  const source = await realm();
  const claim = await pending(source.realmId);
  const grants = async () =>
    (
      await system.database.pool.query(
        `SELECT subject_id,grant_role,valid::text FROM access.resource_role_grant
     WHERE route=$1 AND resource_id=$2 ORDER BY subject_id,grant_role,valid`,
        [routeOf(source.realmId), source.realmId],
      )
    ).rows;
  const before = await grants();
  const path = `/v1/realms/${source.realmId}/claimRequests`;
  const response = await request('GET', path, reviewer().bearer);
  expect(response.status).toBe(200);
  const review = await response.json();
  expect(review.claimRequests).toHaveLength(1);
  expect(review.claimRequests[0]).toMatchObject({
    realmId: source.realmId,
    requestId: claim.requestId,
    claimantAccountId: owner().actor.accountId,
    state: 'pending',
    orphanedAt: new Date(claim.orphanedAt).toISOString(),
    claimEligibleAt: new Date(claim.claimEligibleAt).toISOString(),
    requestedAt: new Date(claim.requestedAt).toISOString(),
    claimant: { label: expect.any(String) },
    approvalAdvice: {
      method: 'POST',
      destination: `${path}/${claim.requestId}:approve`,
      requiredAction: 'realm:approve_claim',
      requiredHeader: 'Idempotency-Key',
    },
  });
  expect(review.selectedRequest).toBeNull();
  expect(review.next).toBeNull();
  expect(review.realmPresentation).toEqual({ state: 'unavailable' });

  const selectedResponse = await request('GET', `${path}?inspectRequestId=${claim.requestId}`, reviewer().bearer);
  expect(selectedResponse.status).toBe(200);
  const selected = await selectedResponse.json();
  expect(selected.selectedRequest).toMatchObject({
    requestId: claim.requestId,
    claimantAccountId: owner().actor.accountId,
    state: 'pending',
    orphanedAt: new Date(claim.orphanedAt).toISOString(),
    claimEligibleAt: new Date(claim.claimEligibleAt).toISOString(),
    currentEpisode: true,
    approvalAdvice: { destination: `${path}/${claim.requestId}:approve` },
  });
  expect(selected.next).toBe(review.next);
  expect(await grants()).toEqual(before);
  const operation = openApiDocument(system.kernel).paths['/v1/realms/{realmId}/claimRequests']!.get!;
  expect(operation).toMatchObject({ 'x-exposure': 'public', 'x-action': 'realm:approve_claim' });
  expect(operation.parameters?.map((parameter) => parameter.name)).toContain('inspectRequestId');
  // Reading grants nothing. The pre-existing Accounts command is the only approval path.
  const approved = await approveRealmClaim(
    deps(),
    reviewer().actor,
    { realmId: source.realmId, requestId: claim.requestId },
    context(),
  );
  expect(approved.state).toBe('owned');
  const readbackResponse = await request('GET', `${path}?inspectRequestId=${claim.requestId}`, reviewer().bearer);
  expect(readbackResponse.status).toBe(200);
  const readback = await readbackResponse.json();
  expect(readback).toMatchObject({
    claimRequests: [],
    next: null,
    selectedRequest: {
      requestId: claim.requestId,
      state: 'approved',
      orphanedAt: new Date(claim.orphanedAt).toISOString(),
      currentEpisode: false,
    },
  });
  expect((await request('GET', path, reviewer().bearer)).status).toBe(404);
});

test('local management, unrelated actors, anonymous, missing and denied sources disclose indistinguishably', async () => {
  const source = await realm();
  await pending(source.realmId);
  // Even the exact action granted on the target is not the direct Global action.
  await seedGovernanceAuthority(
    system.database.pool,
    routeOf(source.realmId)!,
    source.realmId,
    owner().actor.accountId,
    ['realm:approve_claim'],
  );
  const path = `/v1/realms/${source.realmId}/claimRequests`;
  for (const bearer of ['', owner().bearer, system.actors.author.bearer]) {
    const response = await request('GET', path, bearer);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ type: 'https://rezics.com/problems/not_found' });
  }
  const missing = await request(
    'GET',
    `/v1/realms/${newId(routeOf(source.realmId)!)}/claimRequests`,
    reviewer().bearer,
  );
  expect(missing.status).toBe(404);
  const restricted = await system.auth.issue({
    accountId: reviewer().actor.accountId,
    clientId: system.auth.ordinaryClient.id,
    scopes: ['realm:read'],
  });
  expect((await request('GET', path, restricted.bearer)).status).toBe(404);
  await revokeReviewGrant();
  expect((await request('GET', path, reviewer().bearer)).status).toBe(404);
  await reviewGrant();
});

test('one indexed episode seek examines at most twenty without refill, count, history or extra metadata', async () => {
  const source = await realm();
  const route = routeOf(source.realmId)!;
  const ids = Array.from({ length: 21 }, () => newId(route)).sort();
  // Twenty early requests consume the whole examined budget; the eligible row
  // behind them must wait for continuation, rather than filling the response.
  for (let i = 0; i < ids.length; i++) {
    await system.database.pool.query(
      `INSERT INTO community.realm_claim_request
      (route,realm_id,request_id,account_id,orphaned_at,requested_at)
      VALUES ($1,$2,$3,$4,$5::timestamptz - interval '720 hours',
              $5::timestamptz - $6::interval)`,
      [route, source.realmId, ids[i], newId(route), at, i < 20 ? '1 microsecond' : '0 seconds'],
    );
  }
  // Old pending episodes and resolved current rows cannot enter the pending seek.
  await system.database.pool.query(
    `INSERT INTO community.realm_claim_request
    (route,realm_id,request_id,account_id,orphaned_at,requested_at,state,approved_at)
    VALUES ($1,$2,$3,$4,$5::timestamptz - interval '721 hours',$5,'pending',NULL),
           ($1,$2,$6,$7,$5::timestamptz - interval '720 hours',$5,'approved',$5)`,
    [route, source.realmId, newId(route), newId(route), at, newId(route), newId(route)],
  );
  const first = await listRealmClaimRequests(
    deps(),
    reviewer().actor,
    { realmId: source.realmId, limit: 100 },
    context(),
  );
  expect(first.claimRequests).toEqual([]);
  expect(first.next).toBeString();
  const second = await listRealmClaimRequests(
    deps(),
    reviewer().actor,
    { realmId: source.realmId, limit: 100, cursor: first.next! },
    context(),
  );
  expect(second.claimRequests.map((item) => item.requestId)).toEqual([ids[20]!]);
  expect(second.next).toBeNull();
  const index = await system.database.pool.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname='community' AND indexname='realm_claim_request_pending_review'`,
  );
  expect(index.rows[0]!.indexdef).toContain('(route, realm_id, orphaned_at, request_id)');
  expect(index.rows[0]!.indexdef).toContain("WHERE (state = 'pending'::text)");

  const one = await listRealmClaimRequests(deps(), reviewer().actor, { realmId: source.realmId, limit: 1 }, context());
  const other = await realm();
  for (const input of [
    { realmId: source.realmId, limit: 2, cursor: one.next! },
    { realmId: other.realmId, limit: 1, cursor: one.next! },
    { realmId: source.realmId, limit: 1, cursor: one.next! + 'x' },
  ])
    await expect(listRealmClaimRequests(deps(), reviewer().actor, input, context())).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
  await seedGovernanceAuthority(
    system.database.pool,
    PLATFORM_RESOURCE.route,
    PLATFORM_RESOURCE.id,
    system.actors.author.actor.accountId,
    ['realm:approve_claim'],
  );
  await expect(
    listRealmClaimRequests(
      deps(),
      system.actors.author.actor,
      { realmId: source.realmId, limit: 1, cursor: one.next! },
      context(),
    ),
  ).rejects.toMatchObject({ code: 'invalid_cursor' });
});

test('final disclosure rechecks actual Global permission and concurrent restore, approval and re-orphaning', async () => {
  for (const change of ['revoke', 'restore', 'approve', 're-orphan'] as const) {
    const source = await realm();
    const claim = await pending(source.realmId);
    let prepared = 0;
    const access = deriveAccess(system.access, {
      async prepare(actor, action, resource, preparation) {
        expect(actor).toBe(reviewer().actor);
        expect(action).toBe('realm:approve_claim');
        expect(resource).toEqual(PLATFORM_RESOURCE);
        const evidence = await system.access.prepare?.(actor, action, resource, preparation);
        if (++prepared === 2) {
          if (change === 'revoke') await revokeReviewGrant();
          else if (change === 'approve')
            await approveRealmClaim(
              deps(),
              reviewer().actor,
              { realmId: source.realmId, requestId: claim.requestId },
              context(),
            );
          else {
            await system.database.pool.query(
              `UPDATE community.realm SET ownership_state='owned',
              orphaned_at=NULL,claim_eligible_at=NULL WHERE route=$1 AND realm_id=$2`,
              [routeOf(source.realmId), source.realmId],
            );
            if (change === 're-orphan')
              await system.database.pool.query(
                `UPDATE community.realm
              SET ownership_state='orphaned',orphaned_at=$3::timestamptz - interval '721 hours',
                  claim_eligible_at=$3::timestamptz - interval '1 hour'
              WHERE route=$1 AND realm_id=$2`,
                [routeOf(source.realmId), source.realmId, at],
              );
          }
        }
        return evidence;
      },
    });
    await expect(
      listRealmClaimRequests({ ...deps(), access }, reviewer().actor, { realmId: source.realmId }, context()),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(prepared).toBe(2);
    await reviewGrant();
  }
});

test('original eligibility, active lifecycle and cursor episode stay current', async () => {
  const source = await realm();
  await pending(source.realmId);
  const first: RealmClaimReviewPage = await listRealmClaimRequests(
    deps(),
    reviewer().actor,
    { realmId: source.realmId, limit: 1 },
    context(),
  );
  expect(first.next).toBeString();
  await system.database.pool.query(
    `UPDATE community.realm SET ownership_state='owned',
    orphaned_at=NULL,claim_eligible_at=NULL WHERE route=$1 AND realm_id=$2`,
    [routeOf(source.realmId), source.realmId],
  );
  await system.database.pool.query(
    `UPDATE community.realm SET ownership_state='orphaned',
    orphaned_at=$3::timestamptz - interval '721 hours',claim_eligible_at=$3::timestamptz - interval '1 hour'
    WHERE route=$1 AND realm_id=$2`,
    [routeOf(source.realmId), source.realmId, at],
  );
  await expect(
    listRealmClaimRequests(
      deps(),
      reviewer().actor,
      { realmId: source.realmId, limit: 1, cursor: first.next! },
      context(),
    ),
  ).rejects.toMatchObject({ code: 'stale_cursor' });
  expect(
    (await listRealmClaimRequests(deps(), reviewer().actor, { realmId: source.realmId }, context())).claimRequests,
  ).toEqual([]);
  await system.database.pool.query(
    `UPDATE community.realm SET state='removed',
    removed_at=$3::timestamptz,removed_by=$4,remover_role='owner',removal_reason='Fixture removal'
    WHERE route=$1 AND realm_id=$2`,
    [routeOf(source.realmId), source.realmId, at, owner().actor.accountId],
  );
  await expect(
    listRealmClaimRequests(deps(), reviewer().actor, { realmId: source.realmId }, context()),
  ).rejects.toMatchObject({ code: 'not_found' });
  const early = await realm(true);
  await expect(
    listRealmClaimRequests(deps(), reviewer().actor, { realmId: early.realmId }, context()),
  ).rejects.toMatchObject({ code: 'not_found' });
});
