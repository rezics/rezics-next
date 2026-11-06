import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import pg from 'pg';
import { readAccount } from '../../src/access/account-data.ts';
import { parentCreationAuthorization } from '../../src/access/index.ts';
import { createAccess } from '../../src/access/permission.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { runCommand } from '../../src/command/command.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { configureTestReceiptKeys } from '../support/receipt-keys.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: url, max: 2 });
configureTestReceiptKeys(pool);
afterAll(() => pool.end());

const GLOBAL = { route: 0, id: '00000000-0000-8000-8000-000000000000' };
const actorId = '00000000-0000-7000-8000-123400000001';
const transactionId = '00000000-0000-7000-8000-123400000007';
const action = 'post:create';
// The seeded Global Context declares its own type, as the platform root anchor does.
const globalParent = { resource: GLOBAL, resourceType: 'semantic.context', validate: async () => true };
// post:create declares one resource type: the case where the child type used to select the parent's profile.
// The actor's account row, read once after its fixture insert; the evidence callback returns it for every check.
let account: Awaited<ReturnType<typeof readAccount>>;
const access = createAccess({
  actions: new Map([[action, { anonymous: false, 'x-resource-types': ['content.post'] }]]),
  resourceRoles: {
    roles: { 'fixture.post.owner': [action] },
    types: { 'content.post': { owner: 'fixture.post.owner', standing: [] } },
  },
  accountEvidence: () => account,
});

beforeAll(async () => {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS public.typed_parent_child (route integer, id uuid, PRIMARY KEY (route,id))',
  );
  await pool.query(
    "INSERT INTO access.account (route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$3) ON CONFLICT DO NOTHING",
    [routeOf(actorId), actorId, transactionId],
  );
  account = await readAccount(pool, routeOf(actorId)!, actorId);
});
beforeEach(() => pool.query('DELETE FROM access.resource_grant WHERE route=0 AND action=$1', [action]));

async function createUnderGlobal(granted: boolean) {
  if (granted)
    await pool.query(
      `INSERT INTO access.resource_grant (route,resource_id,subject_id,subject_role,action,valid,transaction_id)
       VALUES (0,$1,$2,'',$3,'(,)'::tstzrange,$4)`,
      [GLOBAL.id, actorId, action, transactionId],
    );
  const actor: AccountActor = {
    kind: 'account',
    accountId: actorId,
    clientId: 'web',
    scopes: [action],
    authnEpoch: 1,
    requestedBy: null,
  };
  const child = { route: 0x789a, id: newId(0x789a) };
  const deadline = Date.now() + 10_000;
  const inserted = new WeakSet<object>();
  const authorization = parentCreationAuthorization({
    access,
    actor,
    action,
    parent: globalParent,
    context: {
      pool,
      deadline,
      resource: child,
      creation: {
        async validate(tx) {
          return inserted.has(tx);
        },
      },
    },
  });
  const result = await runCommand(
    pool,
    {
      partition: partitionOf(child.route),
      deadline,
      basis: { actorAccountId: actorId, clientId: actor.clientId, requestedBy: null },
      authorization,
    },
    async (tx) => {
      inserted.add(tx);
      await tx.query('INSERT INTO public.typed_parent_child VALUES ($1,$2)', [child.route, child.id]);
      return { value: child, events: [{ type: 'com.rezics.fixture.created.v1', data: child }] };
    },
  );
  return { result, child };
}

test('a direct Global grant for the child action permits creation under the typed Global parent', async () => {
  const { result, child } = await createUnderGlobal(true);
  expect(result.value).toEqual(child);
});

test('the typed Global parent refuses the same creation without the direct Global grant', async () => {
  await expect(createUnderGlobal(false)).rejects.toBeInstanceOf(GrantDeniedError);
});
