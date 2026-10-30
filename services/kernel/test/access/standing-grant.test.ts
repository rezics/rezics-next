import { setFixtureAccountState } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { ACTIVE_ACCOUNTS, parentCreationAuthorization, installStandingParentGrant } from '../../src/access/index.ts';
import { createGrantCommands, GrantDeniedError } from '../../src/access/grant-commands.ts';
import { createDelegationCommands } from '../../src/access/delegation-commands.ts';
import { accessCommandAuthorization, type Actor, type Access } from '../../src/request/access.ts';
import { runCommand } from '../../src/command/command.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { standingFixture } from './standing-fixture.ts';

let f: Awaited<ReturnType<typeof standingFixture>>;
beforeAll(async () => {
  f = await standingFixture();
}, 30000);
beforeEach(() => f.reset());
afterAll(() => f?.close());
const commands = () => createGrantCommands({ pool: f.pool, access: f.access, managementAction: 'access:grant' });
async function standing() {
  await f.grant(f.actor, 'subject:create');
  return commands().create(await f.context(), {
    resource: f.resource,
    subject: ACTIVE_ACCOUNTS,
    actions: ['subject:create'],
    valid: '(,)',
    key: Bun.randomUUIDv7(),
  });
}
async function create(actor?: Actor, access: Access = f.access, parentExists = true) {
  const context = await f.context(f.recipient);
  const caller = actor ?? context.actor;
  const child = { route: f.otherResource.route, id: newId(f.otherResource.route) };
  const parent = await f.parent();
  if (!parentExists) parent.resource = { route: f.resource.route, id: newId(f.resource.route) };
  const authorization = parentCreationAuthorization({
    access,
    actor: caller,
    action: 'subject:create',
    parent,
    context: { ...context, resource: child },
  });
  return runCommand(
    f.pool,
    {
      partition: partitionOf(child.route),
      deadline: context.deadline,
      ...(caller.kind === 'account'
        ? { basis: { actorAccountId: caller.accountId, clientId: caller.clientId, requestedBy: caller.requestedBy } }
        : {}),
      authorization,
    },
    async (tx) => {
      await tx.query('INSERT INTO public.standing_resource VALUES ($1,$2)', [child.route, child.id]);
      return { value: child, events: [{ type: 'com.rezics.fixture.created.v1', data: child }] };
    },
  );
}

test('ordinary people and automated actors create on a standing parent without authority on a fresh child', async () => {
  await standing();
  expect(Object.isFrozen(ACTIVE_ACCOUNTS)).toBe(true);
  const checked: string[] = [];
  const traced = {
    ...f.access,
    async authorize(...args: Parameters<Access['authorize']>) {
      checked.push(args[3].id);
      return f.access.authorize(...args);
    },
  };
  const before = await f.snapshot();
  const result = await create(undefined, traced);
  expect(checked).toEqual([f.resource.id]);
  expect(result.partition).toBe(partitionOf(f.otherResource.route));
  expect((await f.snapshot()).events).toBe(before.events);
  expect(
    (
      await f.reader.query('SELECT 1 FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [
        result.value.route,
        result.value.id,
      ])
    ).rowCount,
  ).toBe(0);
  await f.reader.query('UPDATE access.account SET operator_account_id=$3 WHERE route=$1 AND account_id=$2', [
    routeOf(f.recipient),
    f.recipient,
    f.actor,
  ]);
  expect((await create()).replayed).toBe(false);
});

test('grant, consent, actual parent, and active unfenced evidence each independently deny before child mutation', async () => {
  const before = await f.reader.query('SELECT count(*) FROM public.standing_resource');
  await expect(create()).rejects.toBeInstanceOf(GrantDeniedError);
  await standing();
  const limited = await f.context(f.recipient, ['subject:read']);
  await expect(create(limited.actor)).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(create({ kind: 'anonymous' })).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(create(undefined, f.access, false)).rejects.toBeInstanceOf(GrantDeniedError);
  for (const state of ['pending', 'suspended', 'deleted']) {
    await setFixtureAccountState(f.reader, f.recipient, state);
    await expect(create()).rejects.toThrow();
  }
  await f.reader.query("UPDATE access.account SET state='active',authn_fenced=true WHERE route=$1 AND account_id=$2", [
    routeOf(f.recipient),
    f.recipient,
  ]);
  await expect(create()).rejects.toThrow();
  expect((await f.reader.query('SELECT count(*) FROM public.standing_resource')).rows).toEqual(before.rows);
});

test('the principal operand is required independently and explicit bans still win', async () => {
  await f.grant(f.actor, 'subject:create');
  await commands().create(await f.context(), {
    resource: f.resource,
    subjectId: f.recipient,
    subjectRole: '',
    actions: ['subject:create'],
    valid: '(,)',
    key: Bun.randomUUIDv7(),
  });
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
  const context = await f.context(f.recipient, f.actions, `urn:rezics:request:${f.principal}:${request}`);
  await expect(create(context.actor)).rejects.toBeInstanceOf(GrantDeniedError);
  await standing();
  expect((await create(context.actor)).replayed).toBe(false);
  await f.reader.query(
    "INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id) VALUES ($1,$2,$3,'subject:create','realm_ban','(,)',$3)",
    [f.resource.route, f.resource.id, f.principal],
  );
  await expect(create(context.actor)).rejects.toBeInstanceOf(GrantDeniedError);
});

test('standing administration requires management and every delegated action and rejects malformed targets', async () => {
  const context = await f.context();
  const input = {
    resource: f.resource,
    subject: ACTIVE_ACCOUNTS,
    actions: ['subject:create'],
    valid: '(,)',
    key: Bun.randomUUIDv7(),
  };
  await expect(commands().create(context, input)).rejects.toBeInstanceOf(GrantDeniedError);
  await f.grant(f.actor, 'subject:create');
  await f.reader.query(
    "DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND action='access:grant'",
    [f.resource.route, f.resource.id],
  );
  await expect(commands().create(context, input)).rejects.toBeInstanceOf(GrantDeniedError);
  await f.grant(f.actor, 'access:grant');
  await expect(commands().create(context, { ...input, actions: ['unknown:action'] })).rejects.toBeInstanceOf(
    GrantDeniedError,
  );
  await expect(commands().create(context, { ...input, subject: { kind: 'everyone' } as never })).rejects.toBeInstanceOf(
    GrantDeniedError,
  );
  const result = await commands().create(context, input);
  expect(result.value.subject).toEqual(ACTIVE_ACCOUNTS);
  expect(JSON.stringify(result.value)).not.toContain('email');
  expect((await commands().create(context, input)).replayed).toBe(true);
});

test('one-time standing installation uses the actual parent, command authority and durable receipts', async () => {
  const context = await f.context();
  await f.grant(f.actor, 'subject:create');
  const authority = await accessCommandAuthorization(
    f.access,
    context.actor,
    'access:grant',
    f.resource,
    context,
    () => new GrantDeniedError(),
  );
  const input = { access: f.access, parent: await f.parent(), authority, context, actions: ['subject:create'] };
  const installed = await installStandingParentGrant(input);
  expect(installed.replayed).toBe(false);
  expect((await installStandingParentGrant(input)).replayed).toBe(true);
  expect((await create()).replayed).toBe(false);
  expect(
    (
      await f.reader.query(
        "SELECT count(*)::int AS count FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_kind='active_accounts'",
        [f.resource.route, f.resource.id],
      )
    ).rows,
  ).toEqual([{ count: 1 }]);
});
