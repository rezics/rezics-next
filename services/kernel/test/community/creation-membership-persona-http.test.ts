import { afterAll, beforeEach, expect, test } from 'bun:test';
import type { Account, CommunityDriver, Fixture, Method, Realm, Space } from '../../../../specs/community-driver.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { routeOf } from '../../src/route/route.ts';
import {
  closeCommunityDrivers,
  createCommunityDriver,
  queryCommunityDatabase as sql,
  restartWorker,
  worker,
} from './community-driver.ts';

let driver: CommunityDriver;
let fixture: Fixture;
beforeEach(async () => {
  driver = await createCommunityDriver();
  fixture = await driver.provision();
}, 120_000);
afterAll(closeCommunityDrivers);

function call(
  method: Method,
  path: string,
  actor: Account | null,
  body?: unknown,
  key = JSON.stringify(crypto.randomUUID()),
) {
  return driver.request({ method, path, actor, key, ...(body === undefined ? {} : { body }) });
}
async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json() as Promise<T>;
}
const resource = (id: string) => ({ route: routeOf(id)!, id });
const subject = (account: Account) => ({ kind: 'account', id: account.id });
async function grant(account: Account, id: string, actions: string[], enabled = true) {
  await json(
    await call('POST', enabled ? '/v1/grants' : '/v1/grants:revoke', fixture.subjectOwner, {
      resource: resource(id),
      subject: subject(account),
      actions,
      valid: '(,)',
    }),
    enabled ? 201 : 200,
  );
}
function roleInput(realm: Realm, account: Account, role = 'community.realm.moderator') {
  return { resource: resource(realm.realmId), subject: subject(account), role, valid: '(,)' };
}
async function space(actor = fixture.owner) {
  return (await json<{ space: Space }>(await call('POST', '/v1/spaces', actor, { title: 'Creation host' }), 201)).space;
}
async function realm(visibility: 'public' | 'protected', actor = fixture.owner) {
  const host = await space(actor);
  return (
    await json<{ realm: Realm }>(
      await call('POST', '/v1/realms', actor, {
        spaceId: host.spaceId,
        title: 'Membership Realm',
        visibility,
        contextId: fixture.contextId,
      }),
      201,
    )
  ).realm;
}
const membershipPath = (realm: Realm) => `/v1/realms/${realm.realmId}/membership`;
async function add(realm: Realm, account: Account, actor: Account | null = fixture.owner) {
  return call('POST', `/v1/realms/${realm.realmId}/members`, actor, { accountId: account.id });
}
async function currentMember(realm: Realm, account: Account) {
  return sql('SELECT role FROM community.realm_member WHERE realm_id=$1 AND account_id=$2 AND upper_inf(valid)', [
    realm.realmId,
    account.id,
  ]);
}

// Full row images detect changes as well as inserts. Partition children are read through their parent once.
async function snapshot() {
  const tables = await sql<{ name: string }>(`SELECT format('%I.%I', n.nspname, c.relname) AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p') AND NOT c.relispartition AND
      (n.nspname IN ('community','content') OR
       (n.nspname='access' AND c.relname IN
         ('resource_grant','resource_role_grant','resource_initialization','resource_denial',
          'membership_inverse','membership_inverse_terminal')) OR
       (n.nspname='library' AND c.relname='follow') OR
       (n.nspname='core' AND c.relname IN ('receipt','outbox')))
    ORDER BY name`);
  const selections = tables.map(
    ({ name }) =>
      `SELECT '${name}' AS name, COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows FROM ${name} t`,
  );
  // Scheduled maintenance workflows are independent of these requests.
  selections.push(`SELECT 'dbos.workflow_status', COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.workflow_uuid), '[]'::jsonb)
    FROM dbos.workflow_status t WHERE name LIKE 'community.%' OR name='accounts.membership'`);
  return sql(`${selections.join(' UNION ALL ')} ORDER BY name`);
}
async function refused(request: () => Promise<Response>, status: number, effectStatus = 'not_applied') {
  const before = await snapshot();
  const response = await request();
  const value = await json<Record<string, unknown>>(response, status);
  expect(value).toMatchObject({
    status,
    effect_status: effectStatus,
    code: status === 401 ? 'authentication_required' : status === 404 ? 'not_found' : 'forbidden',
  });
  // The documented problem envelope contains no resource bodies, storage keys or digests.
  expect(
    Object.keys(value).every((key) =>
      ['type', 'title', 'status', 'code', 'retryable', 'effect_status', 'request_id', 'detail', 'errors'].includes(key),
    ),
  ).toBe(true);
  expect(JSON.stringify(value)).not.toMatch(
    /"(?:body|bytes|objectKey|object_key|digest|responseDigest|space|realm|grant|workflowId)"/i,
  );
  expect(response.headers.get('etag')).toBeNull();
  expect(await snapshot()).toEqual(before);
}
async function personas() {
  const protectedRealm = await realm('protected');
  await json(await add(protectedRealm, fixture.member), 202);
  await driver.settle();
  await json(await call('POST', '/v1/roleGrants', fixture.owner, roleInput(protectedRealm, fixture.moderator)), 201);
  // The owner of the protected fixture can be banned in another Realm without losing its other roles.
  const banRealm = await realm('public', fixture.member);
  await json(
    await call('PUT', `/v1/realms/${banRealm.realmId}/bans/${fixture.owner.id}`, fixture.member, {
      reason: 'Open ban for an independent creation persona',
    }),
  );
  await driver.settle();
  expect(await currentMember(protectedRealm, fixture.member)).toEqual([{ role: 'member' }]);
  expect(
    await sql('SELECT grant_role FROM access.resource_role_grant WHERE resource_id=$1 AND subject_id=$2', [
      protectedRealm.realmId,
      fixture.moderator.id,
    ]),
  ).toEqual([{ grant_role: 'community.realm.moderator' }]);
  expect(
    await sql('SELECT account_id FROM community.realm_ban WHERE realm_id=$1 AND upper_inf(valid)', [banRealm.realmId]),
  ).toEqual([{ account_id: fixture.owner.id }]);
  expect(await currentMember(protectedRealm, fixture.outsider)).toEqual([]);
  expect(
    await sql(
      `SELECT resource_id FROM access.resource_role_grant WHERE resource_id=$1 AND subject_id=$2
    UNION ALL SELECT resource_id FROM access.resource_grant WHERE resource_id=$1 AND subject_id=$2`,
      [protectedRealm.realmId, fixture.outsider.id],
    ),
  ).toEqual([]);
  expect((await call('GET', `/v1/realms/${protectedRealm.realmId}`, fixture.outsider)).status).toBe(404);
  return { protectedRealm, banRealm };
}
async function initialized(kind: 'space' | 'realm', value: Space | Realm, actor: Account) {
  const id = 'spaceId' in value && !('realmId' in value) ? value.spaceId : (value as Realm).realmId;
  expect(routeOf(id)).not.toBeNull();
  expect(routeOf(value.headRevisionId)).toBe(routeOf(id));
  expect(value.creator).toBe(actor.id);
  expect(
    await sql(
      `SELECT r.head_revision_id, v.revision_id FROM community.${kind} r
    JOIN community.${kind}_revision v ON v.route=r.route AND v.revision_id=r.head_revision_id
    WHERE r.${kind}_id=$1`,
      [id],
    ),
  ).toEqual([{ head_revision_id: value.headRevisionId, revision_id: value.headRevisionId }]);
  expect(await sql(`SELECT revision_id FROM community.${kind}_revision WHERE ${kind}_id=$1`, [id])).toEqual([
    { revision_id: value.headRevisionId },
  ]);
  expect(
    await sql('SELECT resource_type, creator_id FROM access.resource_initialization WHERE resource_id=$1', [id]),
  ).toEqual([{ resource_type: `community.${kind}`, creator_id: actor.id }]);
  const roles = await sql(
    'SELECT grant_role, subject_kind, subject_id FROM access.resource_role_grant WHERE resource_id=$1 ORDER BY grant_role',
    [id],
  );
  expect(roles).toHaveLength(2);
  expect(roles[0]).toEqual({ grant_role: `community.${kind}.owner`, subject_kind: 'identity', subject_id: actor.id });
  expect(roles[1]).toMatchObject({
    grant_role: `community.${kind}.standing`,
    subject_kind: 'active_accounts',
    subject_id: '00000000-0000-0000-0000-000000000000',
  });
}

test.serial(
  'Space and Realm creation follow the Global grant and Space management independently of Realm roles and bans',
  async () => {
    await personas();
    await worker.stop();
    try {
      for (const actor of [fixture.member, fixture.moderator, fixture.owner, fixture.outsider]) {
        // All four fixture accounts start with direct creation grants. Remove each operand independently.
        await grant(actor, PLATFORM_RESOURCE.id, ['space:create', 'realm:create'], false);
        for (const global of [false, true]) {
          if (global) await grant(actor, PLATFORM_RESOURCE.id, ['space:create', 'realm:create']);
          const spaceBody = { title: 'Independent Global creation grant' };
          const spaceKey = JSON.stringify(crypto.randomUUID());
          const createSpace = () => call('POST', '/v1/spaces', actor, spaceBody, spaceKey);
          if (!global) await refused(createSpace, 403);
          else {
            const created = (await json<{ space: Space }>(await createSpace(), 201)).space;
            const before = await snapshot();
            expect((await json<{ space: Space }>(await createSpace(), 201)).space).toEqual(created);
            expect(await snapshot()).toEqual(before);
            await initialized('space', created, actor);
          }
          for (const management of [false, true]) {
            const host = await space(fixture.subjectOwner);
            if (management) await grant(actor, host.spaceId, ['space:manage']);
            const body = {
              spaceId: host.spaceId,
              title: 'Independent Realm operands',
              visibility: 'public',
              contextId: fixture.contextId,
            };
            const key = JSON.stringify(crypto.randomUUID());
            const createRealm = () => call('POST', '/v1/realms', actor, body, key);
            if (!global || !management) await refused(createRealm, 403);
            else {
              const created = (await json<{ realm: Realm }>(await createRealm(), 201)).realm;
              expect(routeOf(created.realmId)).toBe(routeOf(host.spaceId));
              const before = await snapshot();
              expect((await json<{ realm: Realm }>(await createRealm(), 201)).realm).toEqual(created);
              expect(await snapshot()).toEqual(before);
              await initialized('realm', created, actor);
            }
          }
        }
      }
      await refused(() => call('POST', '/v1/spaces', null, { title: 'Anonymous creation' }), 401);
      const host = await space();
      await refused(
        () =>
          call('POST', '/v1/realms', null, {
            spaceId: host.spaceId,
            title: 'Anonymous Realm',
            visibility: 'public',
            contextId: fixture.contextId,
          }),
        401,
      );
    } finally {
      await restartWorker();
      await driver.settle();
    }
  },
  180_000,
);

test.serial(
  'join leave and add-member answer each persona and a member cannot promote itself to owner',
  async () => {
    const { protectedRealm, banRealm } = await personas();
    const publicRealm = await realm('public');
    for (const actor of [fixture.member, fixture.moderator, fixture.outsider]) {
      await json(await call('POST', membershipPath(publicRealm), actor), 202);
      await driver.settle();
      expect(await currentMember(publicRealm, actor)).toEqual([{ role: 'member' }]);
      expect(
        await sql('SELECT state, reason FROM library.follow WHERE account_id=$1 AND target_id=$2', [
          actor.id,
          publicRealm.spaceId,
        ]),
      ).toEqual([{ state: 'following', reason: 'membership' }]);
      await json(await call('DELETE', membershipPath(publicRealm), actor), 202);
      await driver.settle();
      expect(await currentMember(publicRealm, actor)).toEqual([]);
      expect(
        await sql('SELECT state FROM library.follow WHERE account_id=$1 AND target_id=$2', [
          actor.id,
          publicRealm.spaceId,
        ]),
      ).toEqual([{ state: 'following' }]);
    }
    await worker.stop();
    try {
      for (const [actor, status] of [
        [fixture.member, 403],
        [fixture.moderator, 403],
        [fixture.outsider, 404],
        [null, 401],
      ] as const)
        await refused(() => call('POST', membershipPath(protectedRealm), actor), status);
      await refused(() => call('POST', membershipPath(banRealm), fixture.owner), 403);
      for (const actor of [fixture.moderator, fixture.outsider])
        await refused(() => call('DELETE', membershipPath(protectedRealm), actor), 404);
      await refused(() => call('DELETE', membershipPath(banRealm), fixture.owner), 404);
      await refused(() => call('DELETE', membershipPath(protectedRealm), null), 401);
      for (const [actor, status] of [
        [fixture.moderator, 403],
        [fixture.member, 403],
        [fixture.outsider, 404],
        [null, 401],
      ] as const)
        await refused(() => add(protectedRealm, fixture.outsider, actor), status);
      await refused(() => add(banRealm, fixture.outsider, fixture.owner), 403);
      await refused(() => add(banRealm, fixture.owner, fixture.member), 403);
      for (const role of ['community.realm.owner', 'community.realm.moderator'])
        await refused(
          () => call('POST', '/v1/roleGrants', fixture.member, roleInput(protectedRealm, fixture.member, role)),
          403,
        );
    } finally {
      await restartWorker();
    }
    await json(await add(protectedRealm, fixture.outsider), 202);
    await driver.settle();
    expect(await currentMember(protectedRealm, fixture.outsider)).toEqual([{ role: 'member' }]);
    expect((await call('GET', `/v1/realms/${protectedRealm.realmId}`, fixture.outsider)).status).toBe(200);
    await worker.stop();
    try {
      await json(await call('POST', '/v1/roleGrants', fixture.owner, roleInput(protectedRealm, fixture.member)), 201);
      expect((await call('GET', `/v1/realms/${protectedRealm.realmId}/bans`, fixture.member)).status).toBe(200);
      await json(await call('POST', '/v1/roleGrants:revoke', fixture.owner, roleInput(protectedRealm, fixture.member)));
      // The very next request observes revocation without a worker tick or clock advancement.
      await refused(
        () => call('GET', `/v1/realms/${protectedRealm.realmId}/bans`, fixture.member),
        403,
        'not_applicable',
      );
    } finally {
      await restartWorker();
    }
    await json(await call('DELETE', membershipPath(protectedRealm), fixture.member), 202);
    await driver.settle();
    expect(await currentMember(protectedRealm, fixture.member)).toEqual([]);
  },
  180_000,
);

test.serial(
  'an accepted membership workflow stops when its initiator loses the action before a step',
  async () => {
    const protectedRealm = await realm('protected');
    await json(await call('POST', '/v1/roleGrants', fixture.owner, roleInput(protectedRealm, fixture.moderator)), 201);
    await grant(fixture.moderator, protectedRealm.realmId, ['realm:manage']);
    await driver.settle();
    await worker.stop();
    let workflowId: string;
    let before: Awaited<ReturnType<typeof snapshot>>;
    try {
      ({ workflowId } = await json<{ workflowId: string }>(
        await add(protectedRealm, fixture.outsider, fixture.moderator),
        202,
      ));
      expect(await currentMember(protectedRealm, fixture.outsider)).toEqual([]);
      expect(
        await sql('SELECT initiator_account_id FROM community.realm_membership_operation WHERE realm_id=$1', [
          protectedRealm.realmId,
        ]),
      ).toEqual([{ initiator_account_id: fixture.moderator.id }]);
      await grant(fixture.moderator, protectedRealm.realmId, ['realm:manage'], false);
      before = await snapshot();
    } finally {
      await restartWorker();
    }
    await expect(driver.settle()).rejects.toThrow('Membership workflow step failed: publish');
    expect(await sql('SELECT status FROM dbos.workflow_status WHERE workflow_uuid=$1', [workflowId!])).toEqual([
      { status: 'ERROR' },
    ]);
    expect(await currentMember(protectedRealm, fixture.outsider)).toEqual([]);
    expect(
      await sql('SELECT group_id FROM access.membership_inverse WHERE account_id=$1 AND group_id=$2', [
        fixture.outsider.id,
        protectedRealm.realmId,
      ]),
    ).toEqual([]);
    expect(
      await sql('SELECT target_id FROM library.follow WHERE account_id=$1 AND target_id=$2', [
        fixture.outsider.id,
        protectedRealm.spaceId,
      ]),
    ).toEqual([]);
    const unchanged = new Set([
      'access.resource_grant',
      'access.resource_role_grant',
      'access.resource_initialization',
      'community.realm_member',
      'library.follow',
      'content.board',
      'content.thread',
      'content.post',
    ]);
    expect((await snapshot()).filter((row) => unchanged.has(row.name))).toEqual(
      before!.filter((row) => unchanged.has(row.name)),
    );
  },
  120_000,
);
