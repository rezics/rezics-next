import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { realmMembershipWorkflowId } from '../../src/community/work.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { closeCommunityDrivers, createCommunityDriver, queryCommunityDatabase } from './community-driver.ts';

setDefaultTimeout(180_000);

let driver: Awaited<ReturnType<typeof createCommunityDriver>>;
let fixture: Awaited<ReturnType<typeof driver.provision>>;
type Account = typeof fixture.member;
type Realm = { realmId: string; spaceId: string; headRevisionId: string; title: string };
let snapshotSql: string;

async function request(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  actor: Account | null,
  status: number,
  options: { body?: unknown; key?: string; ifMatch?: string } = {},
) {
  const response = await driver.request({
    method,
    path,
    actor,
    ...options,
    ...(method === 'GET' ? {} : { key: options.key ?? JSON.stringify(crypto.randomUUID()) }),
  });
  expect(response.status, `${method} ${path}`).toBe(status);
  const text = await response.text();
  return { response, text, value: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function realm(visibility: 'public' | 'protected', title: string): Promise<Realm> {
  const space = await request('POST', '/v1/spaces', fixture.owner, 201, { body: { title: `${title} Space` } });
  const spaceId = (space.value.space as { spaceId: string }).spaceId;
  const created = await request('POST', '/v1/realms', fixture.owner, 201, {
    body: { spaceId, title, visibility, contextId: fixture.contextId },
  });
  return created.value.realm as Realm;
}

async function addMember(target: Realm, member: Account) {
  const added = await request('POST', `/v1/realms/${target.realmId}/members`, fixture.owner, 202, {
    body: { accountId: member.id },
  });
  expect(added.value.workflowId).toEqual(expect.any(String));
  await driver.settle();
  const own = await request('GET', `/v1/realms/${target.realmId}/members/me`, member, 200);
  expect(own.value).toMatchObject({ state: 'member', since: expect.any(String) });
  expect(
    await queryCommunityDatabase(
      `SELECT role FROM community.realm_member WHERE realm_id = $1 AND account_id = $2 AND upper_inf(valid)`,
      [target.realmId, member.id],
    ),
  ).toEqual([{ role: 'member' }]);
}

async function followRows(member: Account, spaceId: string) {
  return queryCommunityDatabase('SELECT * FROM library.follow WHERE account_id = $1 AND target_id = $2', [
    member.id,
    spaceId,
  ]);
}

async function followEffects(member: Account, spaceId: string) {
  return queryCommunityDatabase(
    `SELECT
       (SELECT coalesce(jsonb_agg(r ORDER BY idempotency_key), '[]'::jsonb) FROM core.receipt r
         WHERE principal_kind = 'account' AND principal_id = $1 AND command_kind = 'library.follow.membership'
           AND response ->> 'targetId' = $2::text) AS receipts,
       (SELECT coalesce(jsonb_agg(e ORDER BY partition_no, position, event_seq), '[]'::jsonb) FROM core.outbox e
         WHERE type = 'com.rezics.library.follow.updated.v1' AND subject = $1::text
           AND data ->> 'targetId' = $2::text) AS events`,
    [member.id, spaceId],
  );
}

// Compare row values, including closed intervals and receipt digests, rather than just row counts.
// Periodic rank workflows are unrelated; include every community and Accounts membership workflow.
const snapshot = () => queryCommunityDatabase(snapshotSql);

async function refusal(
  method: 'GET' | 'POST',
  path: string,
  actor: Account | null,
  status: number,
  secrets: readonly string[],
) {
  const before = await snapshot();
  const result = await request(method, path, actor, status);
  expect(result.response.headers.get('content-type')).toBe('application/problem+json');
  const { request_id, ...problem } = result.value;
  expect(request_id).toEqual(expect.any(String));
  expect(problem).toMatchObject({ status, code: status === 404 ? 'not_found' : 'forbidden' });
  if (method === 'POST') expect(problem.effect_status).toBe('not_applied');
  expect(Object.keys(problem).sort()).toEqual(['code', 'effect_status', 'retryable', 'status', 'title', 'type']);
  for (const secret of secrets) expect(result.text).not.toContain(secret);
  for (const name of ['etag', 'digest', 'content-digest', 'repr-digest', 'location']) {
    expect(result.response.headers.get(name)).toBeNull();
  }
  expect(await snapshot()).toEqual(before);
  return problem;
}

async function protectedContent(target: Realm) {
  const scheme = await request('POST', '/v1/subjects', fixture.owner, 201, {
    body: { type: 'skos:ConceptScheme', labels: { en: `${target.title} boards` } },
  });
  const schemeId = (scheme.value.subject as { id: string }).id;
  await request('PUT', `/v1/realms/${target.realmId}/boardScheme`, fixture.owner, 200, {
    ifMatch: JSON.stringify(target.headRevisionId),
    body: { schemeId },
  });
  const concept = await request('POST', '/v1/subjects', fixture.owner, 201, {
    body: {
      type: 'skos:Concept',
      labels: { en: `${target.title} discussion` },
      statements: {
        'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: schemeId } }],
      },
    },
  });
  const board = await request('POST', `/v1/realms/${target.realmId}/boards`, fixture.owner, 201, {
    body: { conceptId: (concept.value.subject as { id: string }).id, title: target.title, visibility: 'published' },
  });
  const boardId = (board.value.board as { id: string }).id;
  const secret = `Confidential discussion in ${target.title}`;
  const created = await request('POST', '/v1/threads', fixture.owner, 201, {
    body: {
      boardId,
      title: target.title,
      body: fromPlainText(secret),
      licence: 'CC-BY-4.0',
      subjectIds: [],
      visibility: 'published',
    },
  });
  const thread = created.value.thread as { id: string; firstPost: { id: string; sha256: string } };
  return {
    paths: [
      [`/v1/boards/${boardId}`, `/v1/boards/${fixture.unknown.board}`],
      [`/v1/threads/${thread.id}`, `/v1/threads/${fixture.unknown.thread}`],
      [`/v1/posts/${thread.firstPost.id}`, `/v1/posts/${newId(routeOf(thread.id)!)}`],
    ],
    secrets: [secret, boardId, thread.id, thread.firstPost.id, thread.firstPost.sha256],
  };
}

async function assertRemovalOrder(workflowId: string, ban: boolean) {
  const parents = await queryCommunityDatabase<{ name: string; status: string }>(
    'SELECT name, status FROM dbos.workflow_status WHERE workflow_uuid = $1',
    [workflowId],
  );
  expect(parents).toEqual([{ name: ban ? 'accounts.membership' : 'community.leave', status: 'SUCCESS' }]);
  if (!ban) {
    expect(
      await queryCommunityDatabase(
        `SELECT function_name FROM dbos.operation_outputs
         WHERE workflow_uuid = $1 AND function_name = 'community.leave.membership' AND error IS NULL`,
        [workflowId],
      ),
    ).toEqual([{ function_name: 'community.leave.membership' }]);
  }
  const membershipId = ban ? workflowId : realmMembershipWorkflowId(workflowId, 'leave.membership');
  const steps = await queryCommunityDatabase<{ function_name: string; error: string | null }>(
    `SELECT function_name, error FROM dbos.operation_outputs WHERE workflow_uuid = $1 ORDER BY function_id`,
    [membershipId],
  );
  const names = steps.map((step) => step.function_name);
  const publish = names.indexOf('accounts.membership.publish');
  expect(publish).toBeGreaterThanOrEqual(0);
  expect(names.indexOf('accounts.membership.release')).toBeGreaterThan(publish);
  expect(steps.every((step) => step.error === null)).toBe(true);
}

beforeAll(async () => {
  driver = await createCommunityDriver();
  fixture = await driver.provision();
  const tables = await queryCommunityDatabase<{ name: string }>(
    `SELECT format('%I.%I', n.nspname, c.relname) AS name FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND (
       n.nspname IN ('community', 'content')
       OR (n.nspname = 'access' AND (c.relname LIKE 'resource_%' OR c.relname LIKE 'membership_inverse%'))
       OR (n.nspname = 'library' AND c.relname = 'follow')
       OR (n.nspname = 'core' AND c.relname IN ('receipt', 'outbox')))
     ORDER BY name`,
  );
  const fragments = tables.map(
    ({ name }) =>
      `SELECT '${name}' AS relation, coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) AS rows FROM ${name} r`,
  );
  for (const table of ['workflow_status', 'workflow_input', 'workflow_output', 'operation_outputs']) {
    fragments.push(
      `SELECT 'dbos.${table}' AS relation,
         coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) AS rows FROM dbos.${table} r
       WHERE workflow_uuid IN (SELECT workflow_uuid FROM dbos.workflow_status
         WHERE name LIKE 'community.%' OR name = 'accounts.membership')`,
    );
  }
  snapshotSql = `${fragments.join(' UNION ALL ')} ORDER BY relation`;
});

afterAll(async () => {
  await driver?.close();
  await closeCommunityDrivers();
});

test('leave and ban removal revoke protected access before the inverse release and leave follows unchanged', async () => {
  expect(
    await queryCommunityDatabase('SELECT kind, state FROM access.account WHERE account_id = $1', [fixture.outsider.id]),
  ).toEqual([{ kind: 'actor', state: 'active' }]);
  // Run the moderator departure last so the member and ban paths are independently exercised.
  for (const kind of ['member', 'ban', 'moderator'] as const) {
    const target = await realm('protected', `Protected ${kind} departure`);
    const content = await protectedContent(target);
    const member = kind === 'moderator' ? fixture.moderator : fixture.member;
    await addMember(target, member);
    expect(
      await queryCommunityDatabase(
        `SELECT
           (SELECT count(*)::int FROM community.realm_member WHERE realm_id = $1 AND account_id = $2) AS memberships,
           (SELECT count(*)::int FROM access.resource_grant WHERE resource_id = $1 AND subject_id = $2) AS grants,
           (SELECT count(*)::int FROM access.resource_role_grant WHERE resource_id = $1 AND subject_id = $2) AS roles`,
        [target.realmId, fixture.outsider.id],
      ),
    ).toEqual([{ memberships: 0, grants: 0, roles: 0 }]);
    if (kind === 'moderator') {
      expect((await driver.grantModerator(target.realmId, member)).status).toBe(201);
      expect(
        await queryCommunityDatabase(
          `SELECT grant_role FROM access.resource_role_grant
           WHERE resource_id = $1 AND subject_id = $2 AND grant_role = 'community.realm.moderator'
             AND valid @> clock_timestamp()`,
          [target.realmId, member.id],
        ),
      ).toEqual([{ grant_role: 'community.realm.moderator' }]);
    }
    const paths = [
      [`/v1/realms/${target.realmId}`, `/v1/realms/${fixture.unknown.realm}`],
      [`/v1/realms/${target.realmId}/members/me`, `/v1/realms/${fixture.unknown.realm}/members/me`],
      [`/v1/realms/${target.realmId}/boards`, `/v1/realms/${fixture.unknown.realm}/boards`],
      ...content.paths,
    ];
    const secrets = [target.realmId, target.title, ...content.secrets];
    await driver.settle();
    for (const [path, unknown] of paths) {
      await request('GET', path!, member, 200);
      const hidden = await refusal('GET', path!, fixture.outsider, 404, secrets);
      expect(hidden).toEqual(await refusal('GET', unknown!, fixture.outsider, 404, secrets));
    }
    const following = await followRows(member, target.spaceId);
    expect(following).toMatchObject([{ target_type: 'space', state: 'following', reason: 'membership' }]);
    const effects = await followEffects(member, target.spaceId);
    const interval = await queryCommunityDatabase<{ reservation_id: string }>(
      `SELECT reservation_id FROM community.realm_member WHERE realm_id = $1 AND account_id = $2 AND upper_inf(valid)`,
      [target.realmId, member.id],
    );
    expect(interval).toHaveLength(1);
    const removed =
      kind === 'ban'
        ? await request('PUT', `/v1/realms/${target.realmId}/bans/${member.id}`, fixture.owner, 200, {
            body: { reason: 'Protected access removal' },
          })
        : await request('DELETE', `/v1/realms/${target.realmId}/membership`, member, 202);
    const workflowId = (
      kind === 'ban' ? (removed.value.ban as { workflowId: string }).workflowId : removed.value.workflowId
    ) as string;
    expect(workflowId).toEqual(expect.any(String));
    await driver.settle();
    await assertRemovalOrder(workflowId, kind === 'ban');
    expect(
      await queryCommunityDatabase(
        `SELECT upper_inf(valid) AS open FROM community.realm_member
         WHERE realm_id = $1 AND account_id = $2 AND reservation_id = $3`,
        [target.realmId, member.id, interval[0]!.reservation_id],
      ),
    ).toEqual([{ open: false }]);
    expect(
      await queryCommunityDatabase(
        `SELECT reservation_id FROM access.membership_inverse WHERE account_id = $1 AND kind = 'realm' AND group_id = $2`,
        [member.id, target.realmId],
      ),
    ).toEqual([]);
    expect(await followRows(member, target.spaceId)).toEqual(following);
    expect(await followEffects(member, target.spaceId)).toEqual(effects);
    if (kind === 'moderator') {
      // Leaving membership preserves the moderator role's independent read grant.
      await request('GET', `/v1/realms/${target.realmId}`, member, 200);
      continue;
    }
    for (const [path, unknown] of paths) {
      const hidden = await refusal('GET', path!, member, 404, secrets);
      expect(hidden).toEqual(await refusal('GET', unknown!, member, 404, secrets));
    }
    const host = await request('GET', `/v1/spaces/${target.spaceId}`, member, 200);
    expect(host.value.space).toMatchObject({ realmId: null });
  }
});

test('an explicit Space unfollow survives join rejoin owner add and retries', async () => {
  const target = await realm('public', 'Unfollow precedence');
  const member = fixture.member;
  const membership = `/v1/realms/${target.realmId}/membership`;
  const unfollowed = await request('DELETE', `/v1/follows/${target.spaceId}`, member, 200);
  expect(unfollowed.value.follow).toMatchObject({ targetId: target.spaceId, state: 'unfollowed', reason: 'explicit' });
  await driver.settle();
  const stored = await followRows(member, target.spaceId);
  const effects = await followEffects(member, target.spaceId);
  expect(effects).toMatchObject([{ receipts: [], events: [expect.any(Object)] }]);
  const unchanged = async () => {
    await driver.settle();
    expect(await followRows(member, target.spaceId)).toEqual(stored);
    expect(await followEffects(member, target.spaceId)).toEqual(effects);
    const read = await request('GET', `/v1/follows/${target.spaceId}`, member, 200);
    expect(read.value.follow).toEqual(unfollowed.value.follow);
  };
  await request('POST', membership, member, 202);
  await unchanged();
  await request('DELETE', membership, member, 202);
  await unchanged();
  const retryKey = JSON.stringify(crypto.randomUUID());
  const joined = await request('POST', membership, member, 202, { key: retryKey });
  await unchanged();
  await addMember(target, member);
  await unchanged();
  const beforeRetry = await snapshot();
  const retried = await request('POST', membership, member, 202, { key: retryKey });
  expect(retried.value).toEqual(joined.value);
  await unchanged();
  expect(await snapshot()).toEqual(beforeRetry);

  const banned = fixture.outsider;
  const ban = await request('PUT', `/v1/realms/${target.realmId}/bans/${banned.id}`, fixture.owner, 200, {
    body: { reason: 'Refused join follow control' },
  });
  expect(ban.value.ban).toMatchObject({ accountId: banned.id, workflowId: null });
  await driver.settle();
  expect(
    await queryCommunityDatabase(
      'SELECT account_id FROM community.realm_ban WHERE realm_id = $1 AND account_id = $2 AND upper_inf(valid)',
      [target.realmId, banned.id],
    ),
  ).toEqual([{ account_id: banned.id }]);
  await refusal('POST', membership, banned, 403, [target.title]);
  expect(await followRows(banned, target.spaceId)).toEqual([]);
  expect(await followEffects(banned, target.spaceId)).toEqual([{ receipts: [], events: [] }]);

  const control = fixture.moderator;
  expect(await followRows(control, target.spaceId)).toEqual([]);
  expect(await followEffects(control, target.spaceId)).toEqual([{ receipts: [], events: [] }]);
  const controlKey = JSON.stringify(crypto.randomUUID());
  const controlJoin = await request('POST', membership, control, 202, { key: controlKey });
  await driver.settle();
  expect(await followRows(control, target.spaceId)).toMatchObject([
    { target_type: 'space', state: 'following', reason: 'membership' },
  ]);
  const implied = await followEffects(control, target.spaceId);
  expect(implied).toEqual([{ receipts: [expect.any(Object)], events: [expect.any(Object)] }]);
  const replay = await request('POST', membership, control, 202, { key: controlKey });
  expect(replay.value).toEqual(controlJoin.value);
  await driver.settle();
  expect(await followEffects(control, target.spaceId)).toEqual(implied);
});
