import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Account, Command, CommunityDriver, Realm, Space } from '../../../../specs/community-driver.ts';
import { createCurrentConsentReader } from '../../../auth/src/current-consent.ts';
import { createInitiatorRestorer } from '../../src/access/durable-initiator.ts';
import { ResourceAccessWriteDeniedError } from '../../src/access/resource-denials.ts';
import { REALM_OWNER_ROLE } from '../../src/access/realm-ownership.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import {
  createRealmMembership,
  readMembershipInitiator,
  readRealmMembershipInterval,
} from '../../src/community/membership.ts';
import { routeOf } from '../../src/route/route.ts';
import { observeSql } from '../content/support/sql-observer.ts';
import {
  closeCommunityDrivers,
  communityFixtureRuntime,
  createCommunityDriver,
  queryCommunityDatabase,
  restartWorker,
  worker,
} from './community-driver.ts';

setDefaultTimeout(180_000);
let driver: CommunityDriver;
let fixture: Awaited<ReturnType<CommunityDriver['provision']>>;

beforeAll(async () => {
  driver = await createCommunityDriver();
  fixture = await driver.provision();
});
afterAll(async () => {
  await driver?.close();
  await closeCommunityDrivers();
});

async function call(method: Command['method'], path: string, actor: Account, body?: unknown) {
  const response = await driver.request({ method, path, actor, body, key: JSON.stringify(crypto.randomUUID()) });
  const value = await response.clone().json();
  return { response, value };
}

async function createRealm(): Promise<Realm> {
  const host = await call('POST', '/v1/spaces', fixture.owner, { title: 'Ownership continuity host' });
  expect(host.response.status).toBe(201);
  const space: Space = host.value.space;
  const result = await call('POST', '/v1/realms', fixture.owner, {
    spaceId: space.spaceId,
    title: 'Ownership continuity Realm',
    visibility: 'public',
    contextId: fixture.contextId,
  });
  expect(result.response.status).toBe(201);
  return result.value.realm;
}

async function join(realm: Realm, member = fixture.owner) {
  const accepted = await call('POST', `/v1/realms/${realm.realmId}/membership`, member);
  expect(accepted.response.status).toBe(202);
  await driver.settle();
  const interval = await readRealmMembershipInterval(
    communityFixtureRuntime().system.database.pool,
    realm.realmId,
    member.id,
    new Date().toISOString(),
  );
  expect(interval).not.toBeNull();
  return interval!;
}

async function ownerGrant(realm: Realm, member: Account, valid = '(,)', revoke = false) {
  const result = await call('POST', `/v1/roleGrants${revoke ? ':revoke' : ''}`, fixture.owner, {
    resource: { route: routeOf(realm.realmId), id: realm.realmId },
    subject: { kind: 'account', id: member.id },
    role: REALM_OWNER_ROLE,
    valid,
  });
  expect(result.response.status, JSON.stringify(result.value)).toBe(revoke ? 200 : 201);
}

/** Observe the original effects, including inverse/terminal state; never seed roles or implement a transition. */
async function footprint(realm: Realm, member = fixture.owner) {
  const rows = await queryCommunityDatabase<{
    operations: unknown;
    receipts: unknown;
    events: unknown;
    members: unknown;
    terminals: unknown;
    inverse: unknown;
    workflows: unknown;
  }>(
    `SELECT
      (SELECT jsonb_agg(to_jsonb(o)) FROM community.realm_membership_operation o
        WHERE realm_id=$1 AND member_account_id=$2) AS operations,
      (SELECT jsonb_agg(to_jsonb(r)) FROM core.receipt r WHERE principal_id=$2
        AND command_kind IN ('community.realm.leave','community.realm.membership')) AS receipts,
      (SELECT jsonb_agg(to_jsonb(e)) FROM core.outbox e WHERE subject=$1::text
        AND type LIKE 'com.rezics.community.realm.membership.%') AS events,
      (SELECT jsonb_agg(to_jsonb(m)) FROM community.realm_member m
        WHERE realm_id=$1 AND account_id=$2) AS members,
      (SELECT jsonb_agg(to_jsonb(t)) FROM community.realm_member_terminal t
        WHERE realm_id=$1 AND account_id=$2) AS terminals,
      (SELECT jsonb_agg(to_jsonb(i)) FROM access.membership_inverse i
        WHERE account_id=$2 AND kind='realm' AND group_id=$1) AS inverse,
      (SELECT jsonb_agg(ws.workflow_uuid ORDER BY ws.workflow_uuid)
        FROM dbos.workflow_status ws JOIN dbos.workflow_input wi USING (workflow_uuid)
        WHERE wi.inputs::jsonb #>> '{json,0,realmId}'=$1::text
           OR wi.inputs::jsonb #>> '{json,0,principal,id}'=$1::text) AS workflows`,
    [realm.realmId, member.id],
  );
  return rows[0]!;
}

test.serial(
  'an admitted sole explicit owner gets the private standard refusal before any leave effect or enqueue',
  async () => {
    const realm = await createRealm();
    await join(realm);
    const before = await footprint(realm);
    const result = await call('DELETE', `/v1/realms/${realm.realmId}/membership`, fixture.owner);
    expect(result.response.status, JSON.stringify(result.value)).toBe(409);
    expect(result.response.headers.get('content-type')).toContain('application/problem+json');
    expect(result.value).toEqual({
      type: 'https://rezics.com/problems/realm_last_owner',
      title: 'Realm Ownership Transfer Required',
      status: 409,
      code: 'realm_last_owner',
      retryable: false,
      effect_status: 'not_applied',
      request_id: expect.any(String),
    });
    expect(await footprint(realm)).toEqual(before);
  },
);

test.serial(
  'ordinary non-owner leave and leave with an additional open-ended explicit owner use the existing workflow',
  async () => {
    for (const explicitOwner of [false, true]) {
      const realm = await createRealm();
      const member = explicitOwner ? fixture.owner : fixture.member;
      await join(realm, member);
      if (explicitOwner) await ownerGrant(realm, fixture.member);
      const accepted = await call('DELETE', `/v1/realms/${realm.realmId}/membership`, member);
      expect(accepted.response.status, JSON.stringify(accepted.value)).toBe(202);
      await driver.settle();
      expect(
        await readRealmMembershipInterval(
          communityFixtureRuntime().system.database.pool,
          realm.realmId,
          member.id,
          new Date().toISOString(),
        ),
      ).toBeNull();
    }
  },
);

test.serial('a scheduled expiring alternative owner cannot satisfy native continuity', async () => {
  const realm = await createRealm();
  await join(realm);
  await ownerGrant(realm, fixture.member, '(,2100-01-01)');
  const before = await footprint(realm);
  const result = await call('DELETE', `/v1/realms/${realm.realmId}/membership`, fixture.owner);
  expect(result.response.status, JSON.stringify(result.value)).toBe(409);
  expect(result.value.code).toBe('realm_last_owner');
  expect(await footprint(realm)).toEqual(before);
});

test.serial(
  'missing membership, current admission denial and native ownership source failure never become owner refusal',
  async () => {
    const realm = await createRealm();
    const missing = await call('DELETE', `/v1/realms/${realm.realmId}/membership`, fixture.owner);
    expect(missing.response.status).toBe(404);
    expect(missing.value.code).toBe('not_found');
    await join(realm);
    const { system } = communityFixtureRuntime();
    const observer = observeSql(system.database.pool);
    try {
      // Capture the genuine native lock statement, then fail that exact source boundary.
      await call('DELETE', `/v1/realms/${realm.realmId}/membership`, fixture.owner);
      const nativeLock = observer.records.find(
        ({ statement }) => statement.includes('access.resource_initialization') && statement.includes('FOR UPDATE'),
      );
      expect(nativeLock).toBeDefined();
      const before = await footprint(realm);
      observer.armFault({
        match: { statement: nativeLock!.statement },
        boundary: 'before',
        error: new AccessUnavailableError('overloaded'),
      });
      const failed = await call('DELETE', `/v1/realms/${realm.realmId}/membership`, fixture.owner);
      expect(failed.response.status, JSON.stringify(failed.value)).toBe(503);
      expect(failed.value.code).not.toBe('realm_last_owner');
      expect(await footprint(realm)).toEqual(before);

      const limited = await system.auth.issue({
        accountId: fixture.owner.id,
        clientId: system.auth.ordinaryClient.id,
        scopes: ['realm:read'],
      });
      const denied = await call('DELETE', `/v1/realms/${realm.realmId}/membership`, {
        id: fixture.owner.id,
        bearer: limited.bearer,
      });
      expect(denied.response.status, JSON.stringify(denied.value)).toBe(403);
      expect(denied.value.code).toBe('forbidden');
      expect(await footprint(realm)).toEqual(before);
    } finally {
      await observer.close();
      await system.auth.issue({
        accountId: fixture.owner.id,
        clientId: system.auth.ordinaryClient.id,
        scopes: system.auth.ordinaryScopes,
      });
    }
  },
);

test.serial(
  'acceptance replay reauthorizes without a new guard, while actual restored publication rechecks current owners',
  async () => {
    const realm = await createRealm();
    const interval = await join(realm);
    await ownerGrant(realm, fixture.member);
    await worker.stop();
    try {
      const accepted = await call('DELETE', `/v1/realms/${realm.realmId}/membership`, fixture.owner);
      expect(accepted.response.status).toBe(202);
      await ownerGrant(realm, fixture.member, '(,)', true);
      const before = await footprint(realm);
      const replay = await call('DELETE', `/v1/realms/${realm.realmId}/membership`, fixture.owner);
      expect(replay.response.status, JSON.stringify(replay.value)).toBe(202);
      expect(replay.value).toEqual(accepted.value);
      expect(await footprint(realm)).toEqual(before);

      const [stored] = await queryCommunityDatabase<{ authorization: string }>(
        `SELECT inputs::jsonb #>> '{json,0,authorization}' AS authorization
       FROM dbos.workflow_input WHERE workflow_uuid=$1`,
        [accepted.value.workflowId],
      );
      expect(stored?.authorization).toBeString();
      const { system } = communityFixtureRuntime();
      const consent = createCurrentConsentReader({ database: system.database.authPool });
      const membership = createRealmMembership({
        clock: () => new Date(),
        deadlineNow: () => Date.now(),
        pool: system.database.pool,
        access: system.access,
        referenceKeys: system.tokenKeys,
        restorer: createInitiatorRestorer({
          pool: system.database.pool,
          access: system.access,
          readOperation: readMembershipInitiator,
          readConsent: (input) => consent.readCurrentConsent(input),
        }),
      });
      const input = {
        kind: 'membership' as const,
        principal: { kind: 'realm' as const, id: realm.realmId },
        memberAccountId: fixture.owner.id,
        reservationId: interval.reservationId,
        role: null,
        authorization: stored!.authorization,
      };
      const reservation = {
        accountId: input.memberAccountId,
        principal: input.principal,
        reservationId: input.reservationId,
      };
      const publishKey = `owner-leave-${crypto.randomUUID()}`;
      await expect(
        membership.publish(await membership.authorize(input.authorization, input), input, reservation, publishKey),
      ).rejects.toBeInstanceOf(ResourceAccessWriteDeniedError);
      expect(await footprint(realm)).toEqual(before);

      // The authenticated legacy self-leave writer also fences the same real source.
      await expect(
        membership.publish(
          await membership.authorize(fixture.owner.bearer, { ...input, authorization: fixture.owner.bearer }),
          { ...input, authorization: fixture.owner.bearer },
          reservation,
          `legacy-${crypto.randomUUID()}`,
        ),
      ).rejects.toBeInstanceOf(ResourceAccessWriteDeniedError);
      expect(await footprint(realm)).toEqual(before);
    } finally {
      // Restore an eligible alternative before the original queued workflow resumes.
      await ownerGrant(realm, fixture.outsider);
      await restartWorker();
    }
    await driver.settle();
  },
);
