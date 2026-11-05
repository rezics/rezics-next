import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createKernel } from '../../src/http/kernel.ts';
import { withConnection } from '../../src/database/pool.ts';
import { readAccount } from '../../src/access/account-data.ts';
import {
  createLifecycleCommands,
  createLifecycleInternals,
  HANDLE_REDIRECT_TTL_MS,
  LIFECYCLE_ACTIONS,
} from '../../src/access/lifecycle.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const accountRoute = 0x3651;
const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
let db: GrowthDatabase;
let instant = Date.now();
let internal: ReturnType<typeof createLifecycleInternals>;
let commands: ReturnType<typeof createLifecycleCommands>;
let kernel: ReturnType<typeof createKernel>;
const clock = () => new Date(instant);
const key = () => Bun.randomUUIDv7();
const hashRoute = (handle: string) => createHash('sha256').update(handle).digest().readUInt16BE(0);

type Fixture = { accountId: string; current: string; former: string[]; prefix: string };

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  internal = createLifecycleInternals({
    pool: db.pool,
    clock,
    routeKey: new Uint8Array(32).fill(41),
    provisioningEvidence: async () => null,
    recoveryEvidence: async () => null,
  });
  commands = createLifecycleCommands({ pool: db.pool, access, clock });
  kernel = createKernel({ pool: db.pool, routeKey: new Uint8Array(32).fill(42), clock });
});
afterAll(async () => db?.close());

async function seedAccount(
  database: GrowthDatabase,
  prefix: string,
  history: number,
  authorized = false,
): Promise<Fixture> {
  const accountId = newId(accountRoute);
  const current = `${prefix}_current`;
  const former = Array.from({ length: history }, (_, index) => `${prefix}_former_${index}`);
  const changeTimes = former.map((_, index) => new Date(Date.now() - (history - index) * 60_000).toISOString());
  const formerUntil = new Date(Date.now() + HANDLE_REDIRECT_TTL_MS).toISOString();
  await database.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,handle,handle_change_times,transaction_id)
     VALUES ($1,$2,'actor','active',$3,$4::timestamptz[],$2)`,
    [accountRoute, accountId, current, changeTimes],
  );
  await database.admin.query(
    `INSERT INTO access.handle_claim(route,normalized_handle,account_id,state,transaction_id,reservation_id)
     VALUES ($1,$2,$3,'active',$3,$4)`,
    [hashRoute(current), current, accountId, newId(hashRoute(current))],
  );
  if (former.length > 0) {
    const claimRoutes = former.map(hashRoute);
    const reservations = former.map((handle) => newId(hashRoute(handle)));
    await database.admin.query(
      `INSERT INTO access.handle_claim
        (route,normalized_handle,account_id,state,reserved_until,former_until,transaction_id,reservation_id)
       SELECT route,handle,$1,'reserved',$2::timestamptz,$2::timestamptz,$1,reservation
       FROM unnest($3::integer[],$4::text[],$5::uuid[]) AS seed(route,handle,reservation)`,
      [accountId, formerUntil, claimRoutes, former, reservations],
    );
  }
  if (authorized) {
    await database.admin.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
       SELECT $1,$2,$2,action,'(,)'::tstzrange,$2 FROM unnest($3::text[]) AS actions(action)`,
      [accountRoute, accountId, ['account:update', 'account:delete']],
    );
  }
  return { accountId, current, former, prefix };
}

async function growFormerHistory(database: GrowthDatabase, fixture: Fixture, count: number) {
  const additional = Array.from(
    { length: Math.max(0, count - fixture.former.length) },
    (_, offset) => `${fixture.prefix}_former_${fixture.former.length + offset}`,
  );
  if (additional.length > 0) {
    await database.admin.query(
      `INSERT INTO access.handle_claim
        (route,normalized_handle,account_id,state,reserved_until,former_until,transaction_id,reservation_id)
       SELECT route,handle,$1,'reserved',$2::timestamptz,$2::timestamptz,$1,reservation
       FROM unnest($3::integer[],$4::text[],$5::uuid[]) AS seed(route,handle,reservation)`,
      [
        fixture.accountId,
        new Date(Date.now() + HANDLE_REDIRECT_TTL_MS).toISOString(),
        additional.map(hashRoute),
        additional,
        additional.map((handle) => newId(hashRoute(handle))),
      ],
    );
    fixture.former.push(...additional);
  }
  const changeCount = Math.min(count, 4);
  const changeTimes = Array.from({ length: changeCount }, (_, index) =>
    new Date(Date.now() - (changeCount - index) * 60_000).toISOString(),
  );
  await database.admin.query(
    'UPDATE access.account SET handle_change_times=$1::timestamptz[] WHERE route=$2 AND account_id=$3',
    [changeTimes, accountRoute, fixture.accountId],
  );
}

async function context(accountId: string) {
  const deadline = Date.now() + 30_000;
  const actor = await authenticateAccount(
    access,
    { pool: db.pool, deadline },
    {
      accountId,
      clientId: 'handle-retirement-growth',
      scopes: [...LIFECYCLE_ACTIONS.keys()],
      requestedBy: null,
      authnEpoch: 1,
    },
  );
  return {
    actor,
    account: await withConnection(db.pool, (client) => readAccount(client, routeOf(accountId)!, accountId)),
    deadline,
  };
}

async function rename(fixture: Fixture, next: string) {
  const reservation = (await internal.reserveHandle({ accountId: fixture.accountId, handle: next, key: key() })).value;
  const input = {
    accountId: fixture.accountId,
    handle: reservation.handle,
    reservationId: reservation.reservationId,
    expectedHandle: fixture.current,
    operationId: key(),
    key: key(),
  };
  await internal.holdHandle(input);
  await commands.transitionAccountHandle(await context(fixture.accountId), input);
  await internal.finalizeHandleTransition({ ...input, key: `${input.key}:claim` });
  await internal.redirectTransitionHandle({ ...input, key: `${input.key}:redirect` });
  await internal.completeHandleTransition({ ...input, key: `${input.key}:complete` });
}

async function addUnrelatedFormerAccounts(database: GrowthDatabase, count: number, prefix: string) {
  const ids = Array.from({ length: count }, () => newId(accountRoute));
  const former = ids.map((id) => `${prefix}_${id.replaceAll('-', '')}`);
  const current = ids.map((id) => `now_${id.replaceAll('-', '')}`);
  const formerRoutes = former.map(hashRoute);
  const currentRoutes = current.map(hashRoute);
  const reservedUntil = new Date(Date.now() + HANDLE_REDIRECT_TTL_MS).toISOString();
  await database.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,handle,transaction_id)
     SELECT $1,id,'actor','active',handle,id FROM unnest($2::uuid[],$3::text[]) AS seed(id,handle)`,
    [accountRoute, ids, current],
  );
  await database.admin.query(
    `INSERT INTO access.handle_claim(route,normalized_handle,account_id,state,transaction_id)
     SELECT route,handle,id,'active',id FROM unnest($1::integer[],$2::text[],$3::uuid[]) AS seed(route,handle,id)`,
    [currentRoutes, current, ids],
  );
  await database.admin.query(
    `INSERT INTO access.handle_claim(route,normalized_handle,account_id,state,reserved_until,former_until,transaction_id)
     SELECT route,handle,id,'reserved',$4::timestamptz,$4::timestamptz,id
     FROM unnest($1::integer[],$2::text[],$3::uuid[]) AS seed(route,handle,id)`,
    [formerRoutes, former, ids, reservedUntil],
  );
}

async function seedPermissionNoise(database: GrowthDatabase, count: number) {
  const resources = Array.from({ length: count }, () => newId(accountRoute));
  const subjects = Array.from({ length: count }, () => newId(accountRoute));
  await database.admin.query(
    `INSERT INTO access.resource_grant
      (route,resource_id,subject_id,subject_role,action,valid,transaction_id)
     SELECT $1,resource,subject,'','account:update','(,)',resource
     FROM unnest($2::uuid[],$3::uuid[]) AS seed(resource,subject)`,
    [accountRoute, resources, subjects],
  );
}

async function seedReceiptNoise(database: GrowthDatabase, count: number) {
  const ids = Array.from({ length: count }, () => newId(accountRoute));
  await database.admin.query(
    `INSERT INTO core.receipt
      (partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
     SELECT $1,'account',id,'access.handle-retirement-growth',id::text,decode(repeat('0',64),'hex'),1,1,id,'{}'
     FROM unnest($2::uuid[]) AS seed(id)`,
    [accountRoute >>> 4, ids],
  );
}

async function seedMutationNoise(database: GrowthDatabase, count: number) {
  const accounts = Array.from({ length: count }, () => newId(accountRoute));
  const reservations = Array.from({ length: count }, () => newId(accountRoute));
  await database.admin.query(
    `INSERT INTO access.lifecycle_handle_operation
      (route,account_id,operation_id,handle,reservation_id,expected_handle,old_reservation_id,state,transaction_id)
     SELECT $1,account_id,'growth_noise_' || account_id::text,'growth_noise_' || account_id::text,
            reservation,NULL,NULL,'completed',account_id
     FROM unnest($2::uuid[],$3::uuid[]) AS seed(account_id,reservation)`,
    [accountRoute, accounts, reservations],
  );

  const handles = accounts.map((account) => `growth_noise_${account.replaceAll('-', '')}`);
  const routes = handles.map(hashRoute);
  await database.admin.query(
    `INSERT INTO access.lifecycle_handle_effect
      (route,normalized_handle,account_id,reservation_id,operation_id,effect,transaction_id)
     SELECT route,handle,account_id,reservation,'growth_noise_' || account_id::text,'active',account_id
     FROM unnest($1::integer[],$2::text[],$3::uuid[],$4::uuid[]) AS seed(route,handle,account_id,reservation)`,
    [routes, handles, accounts, reservations],
  );
}

test.serial('former-handle lookup stays bounded across accounts and a full cap history', async () => {
  const target = await seedAccount(db, 'growth_lookup_target', 5);
  const oldHandle = 'growth_lookup_target_former_0';
  const report = await checkGrowth(db, {
    name: 'former-handle lookup',
    scales: [256, 1024, 4096],
    warmups: 1,
    repetitions: 3,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      await addUnrelatedFormerAccounts(database, scale - previous, `growth_lookup_${scale}`);
    },
    async operation() {
      const response = await kernel.handle(new Request(`https://kernel.test/v1/accounts?handle=${oldHandle}`));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        accounts: [{ id: target.accountId, handle: target.current, movedTo: target.current }],
        next: null,
      });
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  for (const sample of report.samples) {
    expect(sample.cost.statements).toBe(4);
    expect(sample.cost.relations?.['access.account']?.rows).toBe(1);
    expect(sample.cost.relations?.['access.handle_claim']?.rows).toBe(1);
  }
});

test.serial('rename and deletion retirement stay bounded as former handles grow', async () => {
  const fixtures: { rename: Fixture; deletion: Fixture }[] = [];
  for (const scale of [256, 1024, 4096]) {
    for (let index = 0; index < 6; index++) {
      const renameFixture = await seedAccount(db, `growth_rename_${scale}_${index}`, 1, true);
      const deleteFixture = await seedAccount(db, `growth_delete_${scale}_${index}`, 1, true);
      fixtures.push({ rename: renameFixture, deletion: deleteFixture });
    }
  }
  const reports = await checkGrowth(db, {
    name: 'rename and deletion handle retirement',
    scales: [256, 1024, 4096],
    warmups: 1,
    repetitions: 5,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      if (previous === 0) {
        await seedPermissionNoise(database, 4096);
        await seedReceiptNoise(database, 4096);
        await seedMutationNoise(database, 4096);
      }
      await addUnrelatedFormerAccounts(database, scale - previous, `growth_mutation_${scale}`);
      const history = scale === 256 ? 1 : scale === 1024 ? 3 : 5;
      const offset = scale === 256 ? 0 : scale === 1024 ? 6 : 12;
      for (const fixture of fixtures.slice(offset, offset + 6)) {
        await growFormerHistory(database, fixture.rename, history);
        await growFormerHistory(database, fixture.deletion, history);
      }
    },
    async operation(_database, _scale, repetition) {
      const fixture = fixtures[repetition];
      if (!fixture) throw new Error(`Missing prepared mutation fixture ${repetition}`);
      const next = `growth_renamed_${repetition}`;
      await rename(fixture.rename, next);
      await commands.tombstone(await context(fixture.deletion.accountId), {
        accountId: fixture.deletion.accountId,
        key: key(),
      });
      await internal.redirectHandle({
        accountId: fixture.deletion.accountId,
        handle: fixture.deletion.current,
        key: key(),
      });
    },
  });
  expect(reports.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
});
