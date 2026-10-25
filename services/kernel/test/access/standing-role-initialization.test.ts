import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { ACTIVE_ACCOUNTS, initializeResourceGrants, parentCreationAuthorization } from '../../src/access/index.ts';
import { createGrantCommands, GrantDeniedError } from '../../src/access/grant-commands.ts';
import { accessCheck, type Resource } from '../../src/request/access.ts';
import { runCommand, authoritativeTimeValue } from '../../src/command/command.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { standingFixture } from './standing-fixture.ts';

let f: Awaited<ReturnType<typeof standingFixture>>;
beforeAll(async () => {
  // reaction:set is a mounted standing action; the fixture catalogue must include it or the thread and post templates drop.
  f = await standingFixture(['reaction:set']);
}, 30000);
beforeEach(async () => {
  await f.reset();
  await f.grant(f.actor, 'subject:create');
  await createGrantCommands({ pool: f.pool, access: f.access, managementAction: 'access:grant' }).create(
    await f.context(),
    {
      resource: f.resource,
      subject: ACTIVE_ACCOUNTS,
      actions: ['subject:create'],
      valid: '(,)',
      key: Bun.randomUUIDv7(),
    },
  );
});
afterAll(() => f?.close());
async function create(
  type = 'content.board',
  options: {
    child?: Resource;
    creator?: string;
    wrongResource?: Resource;
    fail?: boolean;
    failGrant?: boolean;
    key?: string;
    wrongPartition?: boolean;
  } = {},
) {
  const context = await f.context(f.recipient);
  const child = options.child ?? { route: f.otherResource.route, id: newId(f.otherResource.route) };
  const authorization = parentCreationAuthorization({
    access: f.access,
    actor: context.actor,
    action: 'subject:create',
    parent: await f.parent(),
    context: { ...context, resource: child },
  });
  return runCommand(
    f.pool,
    {
      partition: partitionOf(options.wrongPartition ? f.resource.route : child.route),
      deadline: context.deadline,
      basis: {
        actorAccountId: context.actor.accountId,
        clientId: context.actor.clientId,
        requestedBy: context.actor.requestedBy,
      },
      authorization,
      receipt: {
        actorAccountId: context.actor.accountId,
        kind: 'fixture.create',
        key: options.key ?? Bun.randomUUIDv7(),
        digest: createHash('sha256')
          .update(JSON.stringify([child, type]))
          .digest(),
      },
    },
    async (tx, command) => {
      await tx.query('INSERT INTO public.standing_resource VALUES ($1,$2)', [child.route, child.id]);
      if (options.failGrant)
        await tx.query(
          `CREATE TEMP TABLE initializer_failure AS SELECT 1; CREATE FUNCTION pg_temp.fail_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'grant failure'; END $$; CREATE TRIGGER fixture_fail BEFORE INSERT ON access.resource_role_grant FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_grant()`,
        );
      await initializeResourceGrants(tx, {
        resource: options.wrongResource ?? child,
        type,
        creator: options.creator ?? context.actor.accountId,
      });
      if (options.fail) throw new Error('resource failure');
      return {
        value: { child, at: authoritativeTimeValue(command.time) },
        events: [{ type: 'com.rezics.fixture.created.v1', data: child }],
      };
    },
  );
}
async function roles(child: Resource) {
  return (
    await f.reader.query(
      'SELECT grant_role, subject_kind, subject_id::text, lower(valid)::text AS start FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2 ORDER BY grant_role',
      [child.route, child.id],
    )
  ).rows;
}
async function allowed(id: string, action: string, child: Resource) {
  const context = await f.context(id);
  return (await accessCheck(f.access, context.actor, action, child, context))(f.pool);
}

test('same-transaction initialization writes catalogue roles at T in the child partition and replay adds no rows', async () => {
  const child = { route: f.otherResource.route, id: newId(f.otherResource.route) };
  const key = Bun.randomUUIDv7();
  const result = await create('content.board', { child, key });
  const rows = await roles(child);
  expect(rows.map((r) => [r.grant_role, r.subject_kind])).toEqual([
    ['content.board.owner', 'identity'],
    ['content.board.standing', 'active_accounts'],
  ]);
  expect(rows[0]!.subject_id).toBe(f.recipient);
  expect(rows.every((r) => Date.parse(r.start) === Date.parse(result.value.at))).toBe(true);
  expect(await allowed(f.recipient, 'board:read', child)).toBe(true);
  expect(await allowed(f.principal, 'thread:create', child)).toBe(true);
  expect(await allowed(f.principal, 'report:create', child)).toBe(true);
  expect(await allowed(f.principal, 'board:read', child)).toBe(false);
  expect(await allowed(f.recipient, 'moderation:takedown', child)).toBe(false);
  expect((await create('content.board', { child, key })).replayed).toBe(true);
  expect(await roles(child)).toEqual(rows);
  expect(
    (
      await f.reader.query('SELECT 1 FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2', [
        f.resource.route,
        f.resource.id,
      ])
    ).rowCount,
  ).toBe(0);
});

test('resource and grant failures roll back resource, role grants, outbox and receipt together', async () => {
  for (const failure of [{ fail: true }, { failGrant: true }]) {
    const child = { route: f.otherResource.route, id: newId(f.otherResource.route) };
    const before = await f.snapshot(child.route);
    await expect(create('content.board', { child, ...failure })).rejects.toThrow();
    expect(await roles(child)).toEqual([]);
    expect(
      (await f.reader.query('SELECT 1 FROM public.standing_resource WHERE route=$1 AND id=$2', [child.route, child.id]))
        .rowCount,
    ).toBe(0);
    expect(await f.snapshot(child.route)).toEqual(before);
  }
});

test('type data limits standing reads, owner erasure and moderation, with no role for reports or communal subjects', async () => {
  const thread = (await create('content.thread')).value.child;
  expect(await allowed(f.principal, 'post:create', thread)).toBe(true);
  expect(await allowed(f.principal, 'reaction:set', thread)).toBe(true);
  expect(await allowed(f.principal, 'report:create', thread)).toBe(true);
  expect(await allowed(f.principal, 'thread:read', thread)).toBe(false);
  const post = (await create('content.post')).value.child;
  expect((await roles(post)).map((r) => r.grant_role)).toEqual(['content.post.owner', 'content.post.standing']);
  expect(await allowed(f.recipient, 'post:erase', post)).toBe(true);
  expect(await allowed(f.principal, 'post:erase', post)).toBe(false);
  expect(await allowed(f.principal, 'reaction:set', post)).toBe(true);
  expect(await allowed(f.principal, 'report:create', post)).toBe(true);
  expect(await allowed(f.principal, 'post:read', post)).toBe(false);
  const media = (await create('content.media')).value.child;
  expect((await roles(media)).map((r) => r.grant_role)).toEqual(['content.media.owner']);
  expect(await allowed(f.recipient, 'media:read_reservation', media)).toBe(true);
  expect(await allowed(f.principal, 'media:read', media)).toBe(false);
  expect(await roles((await create('content.report')).value.child)).toEqual([]);
  expect(await roles((await create('semantic.communal')).value.child)).toEqual([]);
});

test('unknown template, forged creator, wrong resource or partition, and outside-command initialization deny', async () => {
  await expect(create('unknown.type')).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(create('fixture.unmounted')).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(create('fixture.missing')).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(create('content.board', { creator: f.principal })).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(create('content.board', { wrongResource: f.resource })).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(create('content.board', { wrongPartition: true })).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(
    initializeResourceGrants(f.reader, { resource: f.otherResource, type: 'content.board', creator: f.recipient }),
  ).rejects.toThrow();
});

test('trusted role-data extension uses the same formula and management checks all resolved actions', async () => {
  const child = (await create('fixture.owned')).value.child;
  expect((await roles(child)).map((r) => r.grant_role)).toEqual(['fixture.owner']);
  expect(await allowed(f.recipient, 'fixture:own', child)).toBe(true);
  expect(await allowed(f.principal, 'fixture:own', child)).toBe(false);
  const commands = createGrantCommands({ pool: f.pool, access: f.access, managementAction: 'access:grant' });
  const input = {
    resource: child,
    subject: ACTIVE_ACCOUNTS,
    role: 'fixture.owner',
    valid: '(,)',
    key: Bun.randomUUIDv7(),
  };
  await expect(commands.createRole(await f.context(f.recipient), input)).rejects.toBeInstanceOf(GrantDeniedError);
  await f.grant(f.recipient, 'access:grant', child);
  await commands.createRole(await f.context(f.recipient), input);
  expect(await allowed(f.principal, 'fixture:own', child)).toBe(true);
  await expect(
    commands.createRole(await f.context(f.recipient), { ...input, role: 'unknown.role', key: Bun.randomUUIDv7() }),
  ).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(
    commands.createRole(await f.context(f.recipient), {
      ...input,
      role: 'content.post.owner',
      key: Bun.randomUUIDv7(),
    }),
  ).rejects.toBeInstanceOf(GrantDeniedError);
  await f.reader.query(
    "INSERT INTO access.resource_role_grant(route,resource_id,subject_kind,subject_id,grant_role,valid,transaction_id) VALUES ($1,$2,'identity',$3,'unknown.role','(,)',$3)",
    [child.route, child.id, f.principal],
  );
  expect(await allowed(f.principal, 'subject:update', child)).toBe(false);
});
