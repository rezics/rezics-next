import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { closeCommunityDrivers, createCommunityDriver, queryCommunityDatabase } from './community-driver.ts';
import type { Account, CommunityDriver } from '../../../../specs/community-driver.ts';

setDefaultTimeout(180_000);

type Realm = { realmId: string; spaceId: string; headRevisionId: string };
type Footprint = { operations: number; receipts: number; events: number; members: number; workflows: number };

let driver: CommunityDriver;
let fixture: Awaited<ReturnType<CommunityDriver['provision']>>;

const key = (value: string) => JSON.stringify(value);

async function request(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  actor: Account | null,
  options: { key?: string; body?: unknown; ifMatch?: string } = {},
) {
  const response = await driver.request({
    method,
    path,
    actor,
    ...(options.key === undefined ? {} : { key: options.key }),
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.ifMatch === undefined ? {} : { ifMatch: options.ifMatch }),
  });
  const value = (await response
    .clone()
    .json()
    .catch(() => ({}))) as Record<string, unknown>;
  return { response, value };
}

async function createSpaceAndRealm(visibility: 'public' | 'protected', name: string): Promise<Realm> {
  const spaceResult = await request('POST', '/v1/spaces', fixture.owner, {
    key: key(`${name}-space`),
    body: { title: `${name} Space` },
  });
  expect(spaceResult.response.status).toBe(201);
  const space = (spaceResult.value.space as { spaceId: string }).spaceId;
  const realmResult = await request('POST', '/v1/realms', fixture.owner, {
    key: key(`${name}-realm`),
    body: { spaceId: space, title: `${name} Realm`, visibility, contextId: fixture.contextId },
  });
  expect(realmResult.response.status).toBe(201);
  const realm = realmResult.value.realm as { realmId: string; headRevisionId: string };
  return { realmId: realm.realmId, spaceId: space, headRevisionId: realm.headRevisionId };
}

async function membershipWorkflows(realmId: string, accountId: string): Promise<string[]> {
  const rows = await queryCommunityDatabase<{ id: string }>(
    `SELECT ws.workflow_uuid AS id
       FROM dbos.workflow_status AS ws
       JOIN dbos.workflow_input AS wi USING (workflow_uuid)
      WHERE ws.name = 'accounts.membership'
        AND wi.inputs::jsonb #>> '{json,0,kind}' = 'membership'
        AND wi.inputs::jsonb #>> '{json,0,principal,kind}' = 'realm'
        AND wi.inputs::jsonb #>> '{json,0,principal,id}' = $1
        AND wi.inputs::jsonb #>> '{json,0,memberAccountId}' = $2
      ORDER BY ws.workflow_uuid`,
    [realmId, accountId],
  );
  return rows.map((row) => row.id);
}

async function footprint(realmId: string, accountId: string, actorAccountId: string): Promise<Footprint> {
  const rows = await queryCommunityDatabase<Footprint>(
    `SELECT
       (SELECT count(*)::int FROM community.realm_membership_operation
         WHERE realm_id = $1 AND member_account_id = $2) AS operations,
       (SELECT count(*)::int FROM core.receipt
         WHERE principal_kind = 'account' AND principal_id = $3 AND command_kind = 'community.realm.join') AS receipts,
       (SELECT count(*)::int FROM core.outbox
         WHERE subject = $1::text AND type LIKE 'com.rezics.community.realm.membership.%') AS events,
       (SELECT count(*)::int FROM community.realm_member
         WHERE realm_id = $1 AND account_id = $2) AS members,
       (SELECT count(*)::int FROM dbos.workflow_status AS ws
         JOIN dbos.workflow_input AS wi USING (workflow_uuid)
        WHERE ws.name = 'accounts.membership'
          AND wi.inputs::jsonb #>> '{json,0,principal,id}' = $1::text
          AND wi.inputs::jsonb #>> '{json,0,memberAccountId}' = $2::text) AS workflows`,
    [realmId, accountId, actorAccountId],
  );
  return rows[0]!;
}

async function createProtectedThread(realm: Realm) {
  const schemeResult = await request('POST', '/v1/subjects', fixture.owner, {
    key: key('protected-board-scheme'),
    body: { type: 'skos:ConceptScheme', labels: { en: 'Protected membership board' } },
  });
  expect(schemeResult.response.status).toBe(201);
  const schemeId = (schemeResult.value.subject as { id: string }).id;
  const assigned = await request('PUT', `/v1/realms/${realm.realmId}/boardScheme`, fixture.owner, {
    key: key('protected-board-scheme-assignment'),
    ifMatch: JSON.stringify(realm.headRevisionId),
    body: { schemeId },
  });
  expect(assigned.response.status).toBe(200);

  const conceptResult = await request('POST', '/v1/subjects', fixture.owner, {
    key: key('protected-board-concept'),
    body: {
      type: 'skos:Concept',
      labels: { en: 'Protected membership discussion' },
      statements: {
        'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: schemeId } }],
      },
    },
  });
  expect(conceptResult.response.status).toBe(201);
  const conceptId = (conceptResult.value.subject as { id: string }).id;
  const boardResult = await request('POST', `/v1/realms/${realm.realmId}/boards`, fixture.owner, {
    key: key('protected-board'),
    body: { conceptId, title: 'Protected membership board', visibility: 'published' },
  });
  expect(boardResult.response.status).toBe(201);
  const boardId = (boardResult.value.board as { id: string }).id;
  const threadResult = await request('POST', '/v1/threads', fixture.owner, {
    key: key('protected-thread'),
    body: {
      boardId,
      title: 'Protected membership thread',
      body: fromPlainText('Member access after the owner addition.'),
      licence: 'CC-BY-4.0',
      subjectIds: [],
      visibility: 'published',
    },
  });
  expect(threadResult.response.status).toBe(201);
  await driver.settle();
  return (threadResult.value.thread as { id: string }).id;
}

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  driver = await createCommunityDriver();
  fixture = await driver.provision();
});

afterAll(async () => {
  await driver?.close();
  await closeCommunityDrivers();
});

test('each Realm membership transition gets its own workflow and settled owner additions grant protected access', async () => {
  const realm = await createSpaceAndRealm('public', 'membership-transitions');
  const actor = fixture.member;
  const membershipPath = `/v1/realms/${realm.realmId}/membership`;

  const firstJoinKey = key('transition-first-join');
  const firstJoin = await request('POST', membershipPath, actor, { key: firstJoinKey });
  expect(firstJoin.response.status).toBe(202);
  const firstJoinWorkflowId = firstJoin.value.workflowId as string;
  await driver.settle();
  const firstJoinRows = await membershipWorkflows(realm.realmId, actor.id);
  expect(firstJoinRows).toHaveLength(1);
  const beforeReplay = await footprint(realm.realmId, actor.id, actor.id);

  const replay = await request('POST', membershipPath, actor, { key: firstJoinKey });
  expect(replay.response.status).toBe(202);
  expect(replay.value.workflowId).toBe(firstJoinWorkflowId);
  await driver.settle();
  expect(await footprint(realm.realmId, actor.id, actor.id)).toEqual(beforeReplay);

  const leave = await request('DELETE', membershipPath, actor, { key: key('transition-leave') });
  expect(leave.response.status).toBe(202);
  expect(leave.value.workflowId).not.toBe(firstJoinWorkflowId);
  await driver.settle();
  const afterLeave = await membershipWorkflows(realm.realmId, actor.id);
  expect(afterLeave).toHaveLength(2);
  expect(new Set(afterLeave).size).toBe(2);
  const leaveChildId = afterLeave.find((id) => id !== firstJoinRows[0]!)!;

  const secondJoin = await request('POST', membershipPath, actor, { key: key('transition-second-join') });
  expect(secondJoin.response.status).toBe(202);
  expect(secondJoin.value.workflowId).not.toBe(firstJoinWorkflowId);
  await driver.settle();
  const afterSecondJoin = await membershipWorkflows(realm.realmId, actor.id);
  expect(afterSecondJoin).toHaveLength(3);
  expect(new Set(afterSecondJoin).size).toBe(3);
  const secondJoinChildId = afterSecondJoin.find((id) => id !== firstJoinRows[0] && id !== leaveChildId)!;

  const moderatorGrant = await driver.grantModerator(realm.realmId, fixture.moderator);
  expect(moderatorGrant.status).toBe(201);
  const ban = await request('PUT', `/v1/realms/${realm.realmId}/bans/${actor.id}`, fixture.moderator, {
    key: key('transition-ban'),
    body: { reason: 'Membership transition regression' },
  });
  expect(ban.response.status).toBe(200);
  const banWorkflowId = (ban.value.ban as { workflowId: string }).workflowId;
  await driver.settle();
  const allTransitions = await membershipWorkflows(realm.realmId, actor.id);
  expect(allTransitions).toHaveLength(4);
  expect(new Set(allTransitions).size).toBe(4);
  expect(new Set([firstJoinRows[0]!, leaveChildId, secondJoinChildId, banWorkflowId]).size).toBe(4);
  expect(allTransitions).toContain(banWorkflowId);

  const protectedRealm = await createSpaceAndRealm('protected', 'protected-owner-addition');
  const threadId = await createProtectedThread(protectedRealm);
  expect((await request('GET', `/v1/threads/${threadId}`, actor)).response.status).toBe(404);
  expect((await request('GET', `/v1/realms/${protectedRealm.realmId}/participation`, actor)).response.status).toBe(404);
  const added = await request('POST', `/v1/realms/${protectedRealm.realmId}/members`, fixture.owner, {
    key: key('protected-owner-addition'),
    body: { accountId: actor.id },
  });
  expect(added.response.status).toBe(202);
  await driver.settle();
  expect(await membershipWorkflows(protectedRealm.realmId, actor.id)).toHaveLength(1);
  const protectedFacts = await queryCommunityDatabase<{
    memberships: number;
    groupGrants: number;
    inverseMemberships: number;
    accountState: string;
  }>(
    `SELECT
       (SELECT count(*)::int FROM community.realm_member
         WHERE realm_id = $1 AND account_id = $2 AND upper_inf(valid)) AS memberships,
       (SELECT count(*)::int FROM access.resource_role_grant
         WHERE resource_id = $1 AND subject_id = $1 AND subject_role = 'member'
           AND grant_role = 'community.realm.member' AND upper_inf(valid)) AS "groupGrants",
       (SELECT count(*)::int FROM access.membership_inverse
         WHERE account_id = $2 AND kind = 'realm' AND group_id = $1) AS "inverseMemberships",
       (SELECT state FROM access.account WHERE account_id = $2) AS "accountState"`,
    [protectedRealm.realmId, actor.id],
  );
  expect(protectedFacts[0]).toEqual({ memberships: 1, groupGrants: 1, inverseMemberships: 1, accountState: 'active' });
  expect((await request('GET', `/v1/threads/${threadId}`, actor)).response.status).toBe(200);
  expect((await request('GET', `/v1/realms/${protectedRealm.realmId}/participation`, actor)).response.status).toBe(204);
  const post = await request('POST', `/v1/threads/${threadId}/posts`, actor, {
    key: key('protected-member-post'),
    body: { body: fromPlainText('The added member can post.'), licence: 'CC-BY-4.0', subjectIds: [] },
  });
  expect(post.response.status).toBe(201);
});
