import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { createGrantCommands, GrantDeniedError } from '../../src/access/grant-commands.ts';
import { readResourceGrants } from '../../src/access/grant-read.ts';
import { resourceRoleCatalogue } from '../../src/access/resource-roles.ts';
import { grantFixture } from './grant-fixture.ts';

const actions = [
  'realm:read',
  'realm:manage',
  'realm:restore',
  'realm:ban',
  'realm:publish',
  'board:create',
  'moderation:takedown',
  'realm:participate',
  'realm:join',
];
let f: Awaited<ReturnType<typeof grantFixture>>;
let commands: ReturnType<typeof createGrantCommands>;
beforeAll(async () => {
  f = await grantFixture(actions);
  commands = createGrantCommands({ pool: f.pool, access: f.access, managementAction: 'access:grant' });
}, 30_000);
beforeEach(async () => {
  await f.reset();
  await f.reader.query('DELETE FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2', [
    f.resource.route,
    f.resource.id,
  ]);
  await f.reader.query(
    `INSERT INTO access.resource_initialization
    (route,resource_id,resource_type,creator_id,initialized_at)
    VALUES ($1,$2,'community.realm',$3,clock_timestamp()) ON CONFLICT DO NOTHING`,
    [f.resource.route, f.resource.id, f.actor],
  );
  for (const action of actions) await f.grant(f.actor, action);
  await f.reader.query(
    `INSERT INTO access.resource_role_grant
    (route,resource_id,subject_kind,subject_id,subject_role,grant_role,valid,transaction_id)
    VALUES ($1,$2,'identity',$3,'','community.realm.owner','(,)',$3)`,
    [f.resource.route, f.resource.id, f.actor],
  );
});
afterAll(() => f?.close());
async function read(port: typeof commands | null = commands, account = f.actor) {
  const context = await f.context(account);
  return readResourceGrants(
    {
      pool: f.pool,
      access: f.access,
      clock: () => new Date(),
      tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(1)]]) },
      // Fixture-owned existence read, with production Access and actual native grant writer.
      resources: new Map([
        ['community.realm', { readAction: 'realm:read', read: async () => ({ [f.resource.id]: false }) }],
      ]),
      ...(port ? { commands: port } : {}),
    },
    context.actor,
    { resourceId: f.resource.id },
    context.deadline,
  );
}

test('genuine native Realm management exposes exact delegable actions and keeps the sole owner guarded', async () => {
  const page = await read();
  expect(page.mutationState).toBe('ready');
  expect(page.actions.sort()).toEqual([...new Set([...actions, 'access:grant'])].sort());
  expect(page.roles.find((role) => role.id === 'community.realm.owner')?.delegable).toBe(true);
  const source = page.grants.find((grant) => grant.role === 'community.realm.owner')!;
  expect(source.manageable).toBe(true);
  expect(source.subject).toEqual({ kind: 'account', id: f.actor });
  await expect(
    commands.revokeRole(await f.context(), {
      resource: page.resource,
      subject: { kind: 'account', id: f.actor },
      role: source.role!,
      valid: source.valid,
      key: Bun.randomUUIDv7(),
    }),
  ).rejects.toBeInstanceOf(GrantDeniedError);
});

test('missing or copied mutation composition remains unavailable despite native role data', async () => {
  for (const port of [null, { ...commands }]) {
    const page = await read(port);
    expect(page.mutationState).toBe('realm_guard_unavailable');
    expect(page.actions).toEqual([]);
    expect(page.roles.every((role) => !role.delegable)).toBe(true);
    expect(page.grants.every((grant) => !grant.manageable)).toBe(true);
  }
});
test('management read uses every current owner action and refuses a foreign account before disclosure', async () => {
  const ownerActions = resourceRoleCatalogue(f.access)!.roles.get('community.realm.owner')!;
  const withheld = ownerActions.find((action) => action !== 'realm:read' && action !== 'access:grant')!;
  await f.reader.query(
    'DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action=$4',
    [f.resource.route, f.resource.id, f.actor, withheld],
  );
  const page = await read();
  expect(page.roles.find((role) => role.id === 'community.realm.owner')?.delegable).toBe(false);
  expect(page.grants.find((grant) => grant.role === 'community.realm.owner')?.manageable).toBe(false);
  await expect(read(commands, f.recipient)).rejects.toMatchObject({ code: 'not_found' });
});
