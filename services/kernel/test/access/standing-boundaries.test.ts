import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import {
  ACTIVE_ACCOUNTS,
  AccessUnavailableError,
  initializeResourceGrants,
  parentCreationAuthorization,
  installStandingParentGrant,
} from '../../src/access/index.ts';
import { createGrantCommands, GrantDeniedError } from '../../src/access/grant-commands.ts';
import { createDelegationCommands } from '../../src/access/delegation-commands.ts';
import { accessCheck, accessCommandAuthorization, type Resource } from '../../src/request/access.ts';
import { resourceRoleCatalogue } from '../../src/access/resource-roles.ts';
import { runCommand, authoritativeTimeValue, type CommandAuthorization } from '../../src/command/command.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { standingFixture, type StandingFixtureLifecycle } from './standing-fixture.ts';
let f: Awaited<ReturnType<typeof standingFixture>>;
let fixtureLifecycle: StandingFixtureLifecycle | undefined;
beforeAll(async () => {
  f = await standingFixture(['reaction:set'], undefined, (lifecycle) => {
    fixtureLifecycle = lifecycle;
  });
  fixtureLifecycle!.ready();
}, 30000);
beforeEach(async () => {
  await fixtureLifecycle!.run('reset standing fixture rows', () => f.reset());
  await fixtureLifecycle!.run('grant fixture creator', () => f.grant(f.actor, 'subject:create'));
  await fixtureLifecycle!.run('install fixture standing grant', async () => {
    await commands().create(await f.context(), {
      resource: f.resource,
      subject: ACTIVE_ACCOUNTS,
      actions: ['subject:create'],
      valid: '(,)',
      key: Bun.randomUUIDv7(),
    });
  });
  fixtureLifecycle!.ready();
});
afterAll(async () => {
  const pendingOperation = fixtureLifecycle?.pendingOperation;
  await fixtureLifecycle?.close();
  if (pendingOperation && pendingOperation !== 'ready')
    throw new Error(`Standing fixture startup did not complete; pending operation: ${pendingOperation}`);
});
function commands() {
  return createGrantCommands({ pool: f.pool, access: f.access, managementAction: 'access:grant' });
}
async function creation(evidenceMs?: number) {
  const context = await f.context(f.recipient);
  const child = { route: f.otherResource.route, id: newId(f.otherResource.route) };
  const authorization = parentCreationAuthorization({
    access: f.access,
    actor: context.actor,
    action: 'subject:create',
    parent: await f.parent(),
    context: {
      ...context,
      ...(evidenceMs === undefined ? {} : { deadline: Date.now() + evidenceMs }),
      resource: child,
    },
  });
  const options = {
    partition: partitionOf(child.route),
    deadline: context.deadline,
    basis: {
      actorAccountId: context.actor.accountId,
      clientId: context.actor.clientId,
      requestedBy: context.actor.requestedBy,
    },
    authorization,
  };
  return { context, child, options, authorization };
}
async function insert(tx: Parameters<Parameters<typeof runCommand>[2]>[0], child: Resource, type = 'content.board') {
  await tx.query('INSERT INTO public.standing_resource VALUES ($1,$2)', [child.route, child.id]);
  await initializeResourceGrants(tx, { resource: child, type, creator: f.recipient });
  return { value: child, events: [{ type: 'com.rezics.fixture.created.v1', data: child }] };
}

test('serialization retry rechecks the parent at a fresh T and cannot use a removed standing grant', async () => {
  const c = await creation();
  const times: string[] = [];
  let bodies = 0;
  const authorization: CommandAuthorization = {
    ...c.authorization,
    async prepare(attempt) {
      times.push(authoritativeTimeValue(attempt.time));
      return c.authorization.prepare!(attempt);
    },
  };
  await expect(
    runCommand(f.pool, { ...c.options, authorization }, async (tx) => {
      bodies++;
      await insert(tx, c.child);
      await f.reader.query(
        "DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_kind='active_accounts'",
        [f.resource.route, f.resource.id],
      );
      await tx.query("DO $$ BEGIN RAISE EXCEPTION 'retry' USING ERRCODE='40001'; END $$");
      throw new Error('unreachable');
    }),
  ).rejects.toBeInstanceOf(GrantDeniedError);
  expect(times).toHaveLength(2);
  expect(times[0]).not.toBe(times[1]);
  expect(bodies).toBe(1);
  expect(
    (
      await f.reader.query('SELECT 1 FROM public.standing_resource WHERE route=$1 AND id=$2', [
        c.child.route,
        c.child.id,
      ])
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await f.reader.query('SELECT 1 FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2', [
        c.child.route,
        c.child.id,
      ])
    ).rowCount,
  ).toBe(0);
});

test('proofs reject JSON replacement, changed command basis and changed authorization anchors', async () => {
  for (const kind of ['json', 'client', 'principal', 'anchor', 'action']) {
    const c = await creation();
    const authorization =
      kind === 'json'
        ? { ...c.authorization, prepare: async () => ({ allowed: true }) }
        : kind === 'anchor'
          ? { ...c.authorization, resource: c.child }
          : kind === 'action'
            ? { ...c.authorization, action: 'board:manage' }
            : c.authorization;
    const basis = {
      ...c.options.basis,
      ...(kind === 'client' ? { clientId: 'other-client' } : {}),
      ...(kind === 'principal'
        ? { requestedBy: `urn:rezics:request:${f.principal}:${newId(routeOf(f.principal)!)}` }
        : {}),
    };
    await expect(
      runCommand(f.pool, { ...c.options, basis, authorization }, (tx) => insert(tx, c.child)),
    ).rejects.toBeInstanceOf(GrantDeniedError);
    expect(
      (
        await f.reader.query('SELECT 1 FROM public.standing_resource WHERE route=$1 AND id=$2', [
          c.child.route,
          c.child.id,
        ])
      ).rowCount,
    ).toBe(0);
  }
});

test('a parent proof cannot outlive its actual Access evidence deadline', async () => {
  const c = await creation(1000);
  const authorization: CommandAuthorization = {
    ...c.authorization,
    async prepare(attempt) {
      const proof = await c.authorization.prepare!(attempt);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      return proof;
    },
  };
  await expect(runCommand(f.pool, { ...c.options, authorization }, (tx) => insert(tx, c.child))).rejects.toBeInstanceOf(
    AccessUnavailableError,
  );
});

test('role grants retain independent principal, consent and denial operands and native nonoverlap', async () => {
  const c = await creation();
  await runCommand(f.pool, c.options, (tx) => insert(tx, c.child));
  const standing = await f.context(f.principal);
  expect(await (await accessCheck(f.access, standing.actor, 'report:create', c.child, standing))(f.pool)).toBe(true);
  const request = newId(routeOf(f.principal)!);
  await createDelegationCommands({ pool: f.pool, access: f.access, action: 'account:delegate' }).create(
    await f.context(f.principal),
    {
      principalId: f.principal,
      requestId: request,
      assignedActorId: f.recipient,
      valid: '(,)',
      key: Bun.randomUUIDv7(),
    },
  );
  const delegated = await f.context(f.recipient, f.actions, `urn:rezics:request:${f.principal}:${request}`);
  const check = await accessCheck(f.access, delegated.actor, 'board:read', c.child, delegated);
  expect(await check(f.pool)).toBe(false);
  const context = await f.context(f.recipient);
  await f.grant(f.recipient, 'access:grant', c.child);
  const role = {
    resource: c.child,
    subject: { kind: 'account', id: f.principal } as const,
    role: 'content.board.owner',
    valid: '(,)',
    key: Bun.randomUUIDv7(),
  };
  await commands().createRole(context, role);
  expect(await check(f.pool)).toBe(true);
  await expect(commands().createRole(context, { ...role, key: Bun.randomUUIDv7() })).rejects.toMatchObject({
    code: '23P01',
  });
  const limited = await f.context(f.recipient, ['subject:read']);
  expect(await (await accessCheck(f.access, limited.actor, 'board:read', c.child, limited))(f.pool)).toBe(false);
  await f.reader.query(
    "INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id) VALUES ($1,$2,$3,'board:read','resource','(,)',$3)",
    [c.child.route, c.child.id, f.principal],
  );
  expect(await check(f.pool)).toBe(false);
  await f.reader.query('DELETE FROM access.resource_denial WHERE route=$1 AND resource_id=$2', [
    c.child.route,
    c.child.id,
  ]);
  await commands().revokeRole(context, role);
  expect(await check(f.pool)).toBe(false);
});

test('post standing role resolves both restored actions and initializes on the post type', async () => {
  const template = resourceRoleCatalogue(f.access)?.types.get('content.post');
  expect(template).toEqual({ owner: 'content.post.owner', standing: ['content.post.standing'] });
  const c = await creation();
  await runCommand(f.pool, c.options, (tx) => insert(tx, c.child, 'content.post'));
  const standing = await f.context(f.principal);
  for (const action of ['reaction:set', 'report:create'])
    expect(await (await accessCheck(f.access, standing.actor, action, c.child, standing))(f.pool)).toBe(true);
  const roles = await f.reader.query<{ grant_role: string }>(
    'SELECT grant_role FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2 ORDER BY grant_role',
    [c.child.route, c.child.id],
  );
  expect(roles.rows.map((row) => row.grant_role)).toEqual(['content.post.owner', 'content.post.standing']);
});

test('one-time setup marker cannot resurrect a revoked standing grant under another actor receipt', async () => {
  await f.reader.query(
    "DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_kind='active_accounts'",
    [f.resource.route, f.resource.id],
  );
  const context = await f.context();
  const authority = await accessCommandAuthorization(
    f.access,
    context.actor,
    'access:grant',
    f.resource,
    context,
    () => new GrantDeniedError(),
  );
  await installStandingParentGrant({
    access: f.access,
    parent: await f.parent(),
    authority,
    context,
    actions: ['subject:create'],
  });
  await f.reader.query(
    "DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_kind='active_accounts'",
    [f.resource.route, f.resource.id],
  );
  expect(
    (
      await installStandingParentGrant({
        access: f.access,
        parent: await f.parent(),
        authority,
        context,
        actions: ['subject:create'],
      })
    ).replayed,
  ).toBe(true);
  await f.grant(f.principal, 'subject:create');
  await f.grant(f.principal, 'access:grant');
  const other = await f.context(f.principal);
  const otherAuthority = await accessCommandAuthorization(
    f.access,
    other.actor,
    'access:grant',
    f.resource,
    other,
    () => new GrantDeniedError(),
  );
  await expect(
    installStandingParentGrant({
      access: f.access,
      parent: await f.parent(),
      authority: otherAuthority,
      context: other,
      actions: ['subject:create'],
    }),
  ).rejects.toMatchObject({ code: '23505' });
  const c = await creation();
  await expect(runCommand(f.pool, c.options, (tx) => insert(tx, c.child))).rejects.toBeInstanceOf(GrantDeniedError);
});

test('initializer requires the actual new resource row from the current transaction', async () => {
  for (const existing of [false, true]) {
    const c = await creation();
    if (existing)
      await f.reader.query('INSERT INTO public.standing_resource VALUES ($1,$2)', [c.child.route, c.child.id]);
    await expect(
      runCommand(f.pool, c.options, async (tx) => {
        if (existing)
          await tx.query('UPDATE public.standing_resource SET id=id WHERE route=$1 AND id=$2', [
            c.child.route,
            c.child.id,
          ]);
        await initializeResourceGrants(tx, { resource: c.child, type: 'content.board', creator: f.recipient });
        return { value: null, events: [{ type: 'com.rezics.fixture.created.v1', data: null }] };
      }),
    ).rejects.toBeInstanceOf(GrantDeniedError);
    expect(
      (
        await f.reader.query('SELECT 1 FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2', [
          c.child.route,
          c.child.id,
        ])
      ).rowCount,
    ).toBe(0);
  }
});
