import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { createResourcePublicEligibility } from '../../src/access/index.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { authoritativeTimeValue, runCommand } from '../../src/command/command.ts';
import { withConnection } from '../../src/database/pool.ts';
import {
  accessCheck,
  accessCommandAuthorization,
  type Access,
  type AccessClient,
  type AccountActor,
  type Resource,
} from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
const action = 'content:read';
const own = { route: 0x6789, id: newId(0x6789) };
const parent = { route: 0x789a, id: newId(0x789a) };
let actor: AccountActor = {
  kind: 'account',
  accountId: newId(0x1234),
  clientId: 'fixture',
  scopes: [],
  requestedBy: null,
  authnEpoch: 1,
};
let permissions: Access;
const observedTimes: string[] = [];
type Row = { revision: number; published: boolean; current: boolean };
async function read(client: AccessClient, resource: Resource, at?: string) {
  const { rows } = await client.query<Row>(
    `SELECT revision,published,valid @> COALESCE($3::timestamptz,clock_timestamp()) AS current
    FROM public_boundary_fixture WHERE route=$1 AND id=$2 AND slot=0`,
    [resource.route, resource.id, at ?? null],
  );
  if (!rows[0]) throw new Error('Required publication evidence unavailable');
  return rows[0];
}
function target() {
  return {
    ...own,
    eligibility: createResourcePublicEligibility({
      resource: own,
      action,
      async prepare({ pool }) {
        const resource = await read(pool, own);
        const container = await read(pool, parent);
        return { resource, container };
      },
      async verify(context) {
        expect('pool' in context).toBe(false);
        observedTimes.push(context.at);
        const resource = await read(context.client, own, context.at);
        const container = await read(context.client, parent, context.at);
        return (
          resource.published &&
          container.published &&
          resource.current &&
          container.current &&
          resource.revision === context.evidence.resource.revision &&
          container.revision === context.evidence.container.revision
        );
      },
    }),
  };
}
async function context() {
  return {
    pool: db.pool,
    deadline: Date.now() + 5000,
    account: await readAccount(db.pool, routeOf(actor.accountId)!, actor.accountId),
  };
}
beforeAll(async () => {
  db = await openGrowthDatabase();
  await db.admin.query(`CREATE TABLE public_boundary_fixture
    (route integer, id uuid, slot integer, revision integer, published boolean, valid tstzrange,
    PRIMARY KEY(route,id,slot))`);
  for (const resource of [own, parent])
    await db.admin.query("INSERT INTO public_boundary_fixture VALUES ($1,$2,0,1,true,'(,)')", [
      resource.route,
      resource.id,
    ]);
  await db.admin.query(
    `INSERT INTO access.account (route,account_id,kind,state,transaction_id)
    VALUES ($1,$2,'actor','active',$2)`,
    [routeOf(actor.accountId), actor.accountId],
  );
  permissions = admittedAccess({ actions: new Map([[action, { anonymous: true }]]) });
  actor = await authenticateAccount(permissions, { pool: db.pool, deadline: Date.now() + 10_000 }, actor);
});
beforeEach(async () => {
  observedTimes.length = 0;
  await db.admin.query("UPDATE public_boundary_fixture SET revision=1,published=true,valid='(,)' WHERE slot=0");
});
afterAll(async () => {
  await db?.close();
});

test('canonical eligibility and the command formula share the actual attempt T at an exact publication boundary', async () => {
  const at = new Date(Date.now() + 200).toISOString();
  await db.admin.query(
    `UPDATE public_boundary_fixture SET valid=tstzrange($1::timestamptz,
    $1::timestamptz+interval '1 millisecond','[)') WHERE slot=0`,
    [at],
  );
  const ctx = await context();
  const authorization = await accessCommandAuthorization(
    permissions,
    actor,
    action,
    target(),
    ctx,
    () => new Error('denied'),
  );
  const result = await runCommand(
    db.pool,
    {
      partition: partitionOf(own.route),
      deadline: ctx.deadline,
      authorization,
      clock: () => new Date(at),
      basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: null },
    },
    async (_tx, command) => ({
      value: authoritativeTimeValue(command.time),
      events: [{ type: 'com.rezics.public-floor.checked.v1', data: {} }],
    }),
  );
  expect(Date.parse(result.value)).toBe(Date.parse(at));
  expect(observedTimes.map(Date.parse)).toEqual([Date.parse(at)]);
});

test('canonical capabilities cannot be swapped or serialized after preparation', async () => {
  const resource = target();
  const check = await accessCheck(permissions, actor, action, resource, await context());
  expect(await withConnection(db.pool, check)).toBe(true);
  resource.eligibility = target().eligibility;
  expect(await withConnection(db.pool, check)).toBe(false);
  resource.eligibility = JSON.parse(JSON.stringify(resource.eligibility));
  expect(await withConnection(db.pool, check)).toBe(false);
});

test('publication and container callback reads are included in the constant-row/logarithmic-buffer bound', async () => {
  const report = await checkGrowth(db, {
    name: 'public floor with bounded domain evidence',
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    async grow(db, scale, previous) {
      for (const resource of [own, parent]) {
        // Unrelated rows on the same anchor route AND old resource revisions.
        await db.admin.query(
          `INSERT INTO public_boundary_fixture
          SELECT $1,$2,n,1,false,'[1900-01-01,1901-01-01)' FROM generate_series($3::integer,$4::integer) n`,
          [resource.route, resource.id, previous * 128 + 1, scale * 128],
        );
        const ids = Array.from({ length: (scale - previous) * 128 }, () => newId(resource.route));
        await db.admin.query(
          `INSERT INTO public_boundary_fixture
          SELECT $1,id,0,1,true,'(,)' FROM unnest($2::uuid[]) id`,
          [resource.route, ids],
        );
      }
      await db.admin.query('VACUUM ANALYZE public_boundary_fixture');
    },
    async operation() {
      const check = await accessCheck(permissions, actor, action, target(), await context());
      expect(await withConnection(db.pool, check)).toBe(true);
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
  for (const sample of report.samples) {
    expect(sample.cost.relations?.['public.public_boundary_fixture']?.rows).toBe(4);
    expect(sample.cost.relations?.['public.public_boundary_fixture']?.sequentialScans).toBe(0);
  }
}, 60000);
