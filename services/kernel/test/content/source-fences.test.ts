import { suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { Value } from 'typebox/value';
import { readAccount } from '../../src/access/account-data.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { authoritativeTimeValue, IdempotencyConflictError } from '../../src/command/command.ts';
import { CONTENT_EVENTS } from '../../src/content/events.ts';
import { tupleRoute, type ImportedFieldGroup } from '../../src/content/imported-contract.ts';
import fenceRead from '../../src/content/read-source-fences.sql';
import { takedownSourceFence } from '../../src/content/source-fence-command.ts';
import { readFences, type SourceFence, type SourceFenceTuple } from '../../src/content/source-fences.ts';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { readPartition } from '../../src/partition/partition.ts';
import type { Access, Actor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { actorFixture } from '../access/actor-side-fixture.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import { observeSql } from './support/sql-observer.ts';

const signature: (
  client: Pick<PoolClient, 'query'>,
  tuples: readonly SourceFenceTuple[],
) => Promise<readonly SourceFence[]> = readFences;

function untouchedClient(): Pick<PoolClient, 'query'> {
  return new Proxy({} as Pick<PoolClient, 'query'>, {
    get() {
      throw new Error('Invalid or empty batches must not access the database');
    },
  });
}

function tuple(route: number): SourceFenceTuple {
  return { route, source: 'catalogue', external_id: 'record-1', field_group: 'summary' };
}

test('the exact low-level signature returns an empty batch without database access', async () => {
  expect(await signature(untouchedClient(), [])).toEqual([]);
});

test('fence reads reject more than one hundred exact tuple keys before database access', async () => {
  await expect(
    readFences(
      untouchedClient(),
      Array.from({ length: 101 }, () => tuple(0)),
    ),
  ).rejects.toBeInstanceOf(RangeError);
});

test('fence reads reject mixed tuple partitions before database access', async () => {
  const otherRoute = Array.from({ length: 65536 }, (_, route) => route).find(
    (route) => partitionOf(route) !== partitionOf(0),
  )!;
  await expect(readFences(untouchedClient(), [tuple(0), tuple(otherRoute)])).rejects.toBeInstanceOf(RangeError);
});

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
pool.options.max = 1;
const admin = createPool(url);
const observer = observeSql(pool);
afterAll(async () => {
  await observer.close();
  await pool.end();
  await admin.end();
});
const routeKey = new Uint8Array(32).fill(7);
const action = 'source_fence:takedown';
const platform = { route: 0, id: '00000000-0000-8000-8000-000000000000' };
const eventType = 'com.rezics.content.source_fence.taken_down.v1';
const context = (idempotencyKey = Bun.randomUUIDv7()) => ({
  idempotencyKey,
  requestId: Bun.randomUUIDv7(),
  deadline: Date.now() + 10_000,
});
const input = (external_id = Bun.randomUUIDv7(), field_group: ImportedFieldGroup = 'summary') => ({
  source: 'catalogue',
  external_id,
  field_group,
  reason: 'private governance evidence',
});
const home = (body: ReturnType<typeof input>) => ({
  route: tupleRoute(routeKey, body.source, body.external_id),
  source: body.source,
  external_id: body.external_id,
  field_group: body.field_group,
});

async function fixture(database = { pool, admin }) {
  const f = await actorFixture(database.pool, database.admin);
  const actor = { ...f.actor, scopes: [action] };
  async function grant(subject = actor.accountId, target = platform, valid = '(,)') {
    await database.admin.query(
      `INSERT INTO access.resource_grant
      (route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [target.route, target.id, subject, action, valid, f.transactionId],
    );
  }
  await grant();
  async function dependencies(identity: Actor = actor) {
    // The native request pipeline supplies the authoritative account observation.
    const account =
      identity.kind === 'account'
        ? await readAccount(database.admin, routeOf(identity.accountId)!, identity.accountId)
        : null;
    return {
      pool: database.pool,
      routeKey,
      access: f.permissions({
        actions: new Map([[action, { anonymous: false }]]),
        accountEvidence: () => account,
        resourceRoles: { roles: { 'content.governance': [action] }, types: {} },
      }),
    };
  }
  const execute = async (body = input(), request = context(), identity: Actor = actor) =>
    takedownSourceFence(await dependencies(identity), identity, body, request);
  const revoke = () =>
    database.admin.query(
      'DELETE FROM access.resource_grant WHERE route=0 AND resource_id=$1 AND subject_id=$2 AND action=$3',
      [platform.id, actor.accountId, action],
    );
  return { ...f, actor, dependencies, execute, grant, revoke };
}

async function facts(body: ReturnType<typeof input>, database = { pool }) {
  return withConnection(database.pool, async (client) => {
    await readPartition(client, partitionOf(home(body).route));
    return readFences(client, [home(body)]);
  });
}

async function storedTakedownPair(body: ReturnType<typeof input>) {
  return (
    await admin.query<{ takenDownAt: string; takedownId: string }>(
      `SELECT taken_down_at::text AS "takenDownAt", takedown_id AS "takedownId"
      FROM content.source_fences WHERE route=$1 AND source=$2 AND external_id=$3 AND field_group=$4`,
      Object.values(home(body)),
    )
  ).rows[0]!;
}

test('readFences returns the original takedown time and id for a taken-down fence, in one statement per partition, and omits both for a legacy or standing fence', async () => {
  const f = await fixture();
  const body = input();
  const target = home(body);
  const partition = partitionOf(target.route);
  const deps = await f.dependencies();
  const firstTime = new Date();
  const first = await takedownSourceFence({ ...deps, clock: () => firstTime }, f.actor, body, context());
  const repeated = await takedownSourceFence(
    { ...deps, clock: () => new Date(firstTime.getTime() + 1000) },
    f.actor,
    body,
    context(),
  );
  const original = (
    await admin.query('SELECT data FROM core.outbox WHERE partition_no=$1 AND position=$2', [
      first.partition,
      first.position,
    ])
  ).rows[0].data;
  expect(new Date(original.takenDownAt).toISOString()).toBe(firstTime.toISOString());
  expect(routeOf(original.takedownId)).toBe(target.route);
  const legacy = { ...target, field_group: 'facts' as const };
  const standing = { ...target, field_group: 'cover' as const };
  for (const [row, takenDown] of [
    [legacy, true],
    [standing, false],
  ] as const)
    await admin.query(
      `INSERT INTO content.source_fences
      (route,source,external_id,field_group,taken_down,security_revision,taken_down_at,takedown_id)
      VALUES ($1,$2,$3,$4,$5,1,NULL,NULL)`,
      [...Object.values(row), takenDown],
    );
  let missing: SourceFenceTuple;
  do {
    missing = home(input());
  } while (partitionOf(missing.route) !== partition);
  const tuples = [target, legacy, standing, missing];
  const rows = await withConnection(pool, async (client) => {
    await readPartition(client, partition);
    const start = observer.records.length;
    const result = await readFences(client, tuples);
    expect(observer.records.slice(start).map(({ statement, parameters }) => ({ statement, parameters }))).toEqual([
      { statement: fenceRead.sql, parameters: [partition, JSON.stringify(tuples)] },
    ]);
    return result;
  });
  const expected = [
    {
      ...target,
      takenDown: true,
      securityRevision: repeated.value.securityRevision,
      takenDownAt: original.takenDownAt,
      takedownId: original.takedownId,
    },
    { ...legacy, takenDown: true, securityRevision: '1' },
    { ...standing, takenDown: false, securityRevision: '1' },
    { ...missing, takenDown: false, securityRevision: null },
  ];
  expect(rows).toEqual(expected);
});

test('the first takedown records its command time and a takedown id, and later takedowns and every event keep both', async () => {
  const f = await fixture();
  const body = input();
  const target = home(body);
  const deps = await f.dependencies();
  const firstTime = new Date();
  const first = await takedownSourceFence({ ...deps, clock: () => firstTime }, f.actor, body, context());
  const readRow = async () =>
    (
      await admin.query(
        `SELECT taken_down_at::text AS "takenDownAt", takedown_id AS "takedownId"
        FROM content.source_fences WHERE route=$1 AND source=$2 AND external_id=$3 AND field_group=$4`,
        Object.values(target),
      )
    ).rows[0];
  const original = await readRow();
  expect(new Date(original.takenDownAt).toISOString()).toBe(firstTime.toISOString());
  expect(routeOf(original.takedownId)).toBe(target.route);
  const second = await takedownSourceFence(
    { ...deps, clock: () => new Date(firstTime.getTime() + 1000) },
    f.actor,
    body,
    context(),
  );
  expect(BigInt(second.value.securityRevision)).toBeGreaterThan(BigInt(first.value.securityRevision));
  expect(await readRow()).toEqual(original);
  for (const outcome of [first, second]) {
    const event = (
      await admin.query('SELECT data FROM core.outbox WHERE partition_no=$1 AND position=$2', [
        outcome.partition,
        outcome.position,
      ])
    ).rows[0];
    expect(event.data).toEqual({ ...target, securityRevision: outcome.value.securityRevision, ...original });
    expect(Value.Check(CONTENT_EVENTS[eventType], event.data)).toBe(true);
  }
});

test('a fence taken down before the takedown fields existed reports neither, and nothing derives them', async () => {
  const f = await fixture();
  const body = input();
  const row = home(body);
  await admin.query(
    `INSERT INTO content.source_fences
    (route,source,external_id,field_group,taken_down,security_revision,taken_down_at,takedown_id)
    VALUES ($1,$2,$3,$4,true,9007199254740993,NULL,NULL)`,
    Object.values(row),
  );
  const outcome = await f.execute(body);
  expect(outcome.value.securityRevision).toBe('9007199254740994');
  expect(
    (
      await admin.query(
        `SELECT taken_down_at,takedown_id FROM content.source_fences
        WHERE route=$1 AND source=$2 AND external_id=$3 AND field_group=$4`,
        Object.values(row),
      )
    ).rows,
  ).toEqual([{ taken_down_at: null, takedown_id: null }]);
  const events = (
    await admin.query('SELECT data FROM core.outbox WHERE partition_no=$1 AND position=$2', [
      outcome.partition,
      outcome.position,
    ])
  ).rows;
  expect(events).toEqual([{ data: { ...row, securityRevision: outcome.value.securityRevision } }]);
});

test('source fence provenance is paired, immutable and recorded when an open fence transitions', async () => {
  const f = await fixture();
  const body = input();
  const target = home(body);
  await admin.query(
    `INSERT INTO content.source_fences
    (route,source,external_id,field_group,taken_down,security_revision) VALUES ($1,$2,$3,$4,false,1)`,
    Object.values(target),
  );
  const outcome = await f.execute(body);
  expect(outcome.value.securityRevision).toBe('2');
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const where = ' WHERE route=$1 AND source=$2 AND external_id=$3 AND field_group=$4';
    for (const change of [
      'taken_down_at=NULL',
      'takedown_id=NULL',
      'taken_down_at=NULL,takedown_id=NULL',
      "taken_down_at=taken_down_at + interval '1 second'",
      `takedown_id='${newId(target.route)}'`,
      'taken_down=false,security_revision=security_revision+1',
    ]) {
      await client.query('SAVEPOINT invalid');
      const error = await client
        .query(`UPDATE content.source_fences SET ${change}${where}`, Object.values(target))
        .catch((caught: unknown) => caught);
      await client.query('ROLLBACK TO SAVEPOINT invalid');
      expect(error).toMatchObject({ code: '23514' });
    }
    for (const values of [
      [new Date(), null],
      [null, newId(target.route)],
    ]) {
      await client.query('SAVEPOINT invalid');
      const error = await client
        .query(
          `INSERT INTO content.source_fences
          (route,source,external_id,field_group,taken_down,security_revision,taken_down_at,takedown_id)
          VALUES ($1,$2,$3,$4,true,1,$5,$6)`,
          [...Object.values(home(input())), ...values],
        )
        .catch((caught: unknown) => caught);
      await client.query('ROLLBACK TO SAVEPOINT invalid');
      expect(error).toMatchObject({ code: '23514' });
    }
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('native takedown authorizes the sole independently anchored Global root at attempt T before tuple checkout', async () => {
  const f = await fixture();
  const body = input();
  const target = home(body);
  expect(partitionOf(target.route)).not.toBe(0);
  const deps = await f.dependencies();
  const original = deps.access;
  const checks: { resource: unknown; action: string; at: string; allowed: boolean }[] = [];
  const access: Access = {
    ...original,
    async authorize(client, actor, verb, resource, evidence, time) {
      const allowed = await original.authorize(client, actor, verb, resource, evidence, time);
      checks.push({ resource, action: verb, at: authoritativeTimeValue(time!), allowed });
      return allowed;
    },
  };
  const request = context();
  const before = await readPartition(admin, partitionOf(target.route));
  const rootBefore = await readPartition(admin, 0);
  const commandAt = new Date();
  const start = observer.records.length;
  const outcome = await takedownSourceFence({ ...deps, access, clock: () => commandAt }, f.actor, body, request);
  const trace = observer.records.slice(start);
  expect(checks.map((check) => ({ ...check, at: new Date(check.at).toISOString() }))).toEqual([
    { resource: platform, action, at: commandAt.toISOString(), allowed: true },
  ]);
  expect(outcome).toMatchObject({ partition: partitionOf(target.route), epoch: before!.epoch, replayed: false });
  expect(outcome.position).toBe(before!.position + 1n);
  expect(outcome.transactionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(outcome.value.securityRevision).toMatch(/^[1-9][0-9]*$/);
  expect(await readPartition(admin, 0)).toEqual(rootBefore);
  const begin = trace.findIndex((r) => /^BEGIN ISOLATION LEVEL SERIALIZABLE/.test(r.statement));
  const anchor = trace.findIndex((r) => /FROM semantic.context/.test(r.statement));
  expect(anchor).toBeGreaterThanOrEqual(0);
  expect(anchor).toBeLessThan(begin);
  expect(trace[anchor]!.parameters).toEqual([0, platform.id]);
  expect(trace.slice(0, anchor).some((r) => /FROM core.partition/.test(r.statement) && r.parameters[0] === 0)).toBe(
    true,
  );
  expect(trace.slice(begin).some((r) => /(?:FROM|JOIN) (?:access\.|semantic\.)/.test(r.statement))).toBe(false);
  const writes = trace.filter((r) => /INSERT INTO content.source_fences/.test(r.statement));
  expect(writes).toHaveLength(1);
  const storedProvenance = (
    await admin.query(
      `SELECT taken_down_at::text AS "takenDownAt", takedown_id AS "takedownId"
      FROM content.source_fences WHERE route=$1 AND source=$2 AND external_id=$3 AND field_group=$4`,
      Object.values(target),
    )
  ).rows[0];
  expect(writes[0]!.parameters).toEqual([
    ...Object.values(target),
    storedProvenance.takenDownAt,
    storedProvenance.takedownId,
  ]);
  expect(trace.some((r) => /resource_initialization|resource_role_grant.*INSERT|creation_xid/.test(r.statement))).toBe(
    false,
  );
  expect(await facts(body)).toEqual([
    { ...target, takenDown: true, securityRevision: outcome.value.securityRevision, ...storedProvenance },
  ]);
  const events = (
    await admin.query('SELECT * FROM core.outbox WHERE partition_no=$1 AND position=$2', [
      outcome.partition,
      outcome.position,
    ])
  ).rows;
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: eventType,
    event_seq: 0,
    event_count: 1,
    data: { ...target, securityRevision: outcome.value.securityRevision },
  });
  const schema = CONTENT_EVENTS[eventType];
  expect(Value.Check(schema, events[0]!.data)).toBe(true);
  for (const key of ['reason', 'body', 'title', 'snippet', 'subjectId', 'actor', 'unexpected'])
    expect(Value.Check(schema, { ...events[0]!.data, [key]: 'authored or private bytes' })).toBe(false);
  expect(JSON.stringify(events)).not.toContain(body.reason);
});

test('real governance role grants work; missing grant, scope, suspended account and anonymous callers deny without effects', async () => {
  for (const mode of [
    'role',
    'no-grant',
    'no-scope',
    'suspended',
    'anonymous',
    'wrong-root',
    'missing-root',
  ] as const) {
    const f = await fixture();
    const body = input();
    let actor: Actor = f.actor;
    if (['role', 'no-grant', 'wrong-root'].includes(mode)) await f.revoke();
    if (mode === 'role')
      await admin.query(
        `INSERT INTO access.resource_role_grant
      (route,resource_id,subject_id,subject_role,grant_role,valid,transaction_id)
      VALUES (0,$1,$2,'owner','content.governance','(,)',$3)`,
        [platform.id, f.organizationId, f.transactionId],
      );
    if (mode === 'wrong-root') await f.grant(f.actorId, f.resource);
    if (mode === 'no-scope') actor = { ...f.actor, scopes: [] };
    if (mode === 'suspended') await suspendAccount(admin, f.actorId);
    if (mode === 'anonymous') actor = { kind: 'anonymous' };
    if (mode === 'missing-root')
      await admin.query('DELETE FROM semantic.context WHERE route=0 AND context_id=$1', [platform.id]);
    try {
      const before = await readPartition(admin, partitionOf(home(body).route));
      const start = observer.records.length;
      if (mode === 'role') expect((await f.execute(body, context(), actor)).replayed).toBe(false);
      else {
        await expect(f.execute(body, context(), actor)).rejects.toBeInstanceOf(GrantDeniedError);
        expect(
          observer.records.slice(start).some((r) => /core.receipt|INSERT INTO content.source_fences/.test(r.statement)),
        ).toBe(false);
        expect(await readPartition(admin, partitionOf(home(body).route))).toEqual(before);
        expect(await facts(body)).toEqual([{ ...home(body), takenDown: false, securityRevision: null }]);
      }
    } finally {
      if (mode === 'missing-root')
        await admin.query(
          `INSERT INTO semantic.context(route,context_id,kind,labels)
        VALUES (0,$1,'global','{"en":"Global"}')`,
          [platform.id],
        );
    }
  }
});

test('the shared formula applies delegated principal requirements and every named denial', async () => {
  const f = await fixture();
  const delegated = { ...f.delegated, scopes: [action] };
  await expect(f.execute(input(), context(), delegated)).rejects.toBeInstanceOf(GrantDeniedError);
  await f.grant(f.principalId);
  expect((await f.execute(input(), context(), delegated)).replayed).toBe(false);
  for (const reason of ['resource', 'suspension', 'realm_ban']) {
    await admin.query(
      `INSERT INTO access.resource_denial
      (route,resource_id,subject_id,action,reason,valid,transaction_id) VALUES (0,$1,$2,$3,$4,'(,)',$5)`,
      [platform.id, f.principalId, action, reason, f.transactionId],
    );
    await expect(f.execute(input(), context(), delegated)).rejects.toBeInstanceOf(GrantDeniedError);
    await admin.query(
      'DELETE FROM access.resource_denial WHERE route=0 AND resource_id=$1 AND subject_id=$2 AND action=$3',
      [platform.id, f.principalId, action],
    );
  }
});

test('authorized replay has one effect, conflict denies, and revoked replay cannot disclose its stored native response', async () => {
  const f = await fixture();
  const body = input();
  const request = context();
  const first = await f.execute(body, request);
  expect(await f.execute(body, { ...request, deadline: Date.now() + 10_000 })).toEqual({ ...first, replayed: true });
  await expect(
    f.execute({ ...body, reason: 'changed reason' }, context(request.idempotencyKey)),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);
  await f.revoke();
  const start = observer.records.length;
  await expect(f.execute(body, context(request.idempotencyKey))).rejects.toBeInstanceOf(GrantDeniedError);
  expect(
    observer.records.slice(start).some((r) => /core.receipt|^BEGIN ISOLATION LEVEL SERIALIZABLE/.test(r.statement)),
  ).toBe(false);
  expect(await facts(body)).toEqual([
    {
      ...home(body),
      takenDown: true,
      securityRevision: first.value.securityRevision,
      ...(await storedTakedownPair(body)),
    },
  ]);
  expect(
    (
      await admin.query('SELECT 1 FROM core.outbox WHERE partition_no=$1 AND position=$2', [
        first.partition,
        first.position,
      ])
    ).rowCount,
  ).toBe(1);
  expect(
    (
      await admin.query(
        'SELECT response FROM core.receipt WHERE partition_no=$1 AND actor_account_id=$2 AND idempotency_key=$3',
        [first.partition, f.actorId, request.idempotencyKey],
      )
    ).rows,
  ).toEqual([{ response: first.value }]);
});

test('all field groups share the tuple home independently of subject merge history and revisions stay lossless', async () => {
  const f = await fixture();
  const external = Bun.randomUUIDv7();
  const bodies = (['facts', 'summary', 'cover'] as const).map((group) => input(external, group));
  const outcomes = [];
  for (const body of bodies) outcomes.push(await f.execute(body));
  expect(new Set(outcomes.map((row) => row.partition)).size).toBe(1);
  expect(new Set(bodies.map((row) => home(row).route)).size).toBe(1);
  // Native semantic history can change subjects in other partitions; fences carry no subject key.
  const subjectId = newId(0x6789);
  await admin.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id)
    VALUES ($1,$2,'schema:Book',$3)`,
    [routeOf(subjectId), subjectId, f.transactionId],
  );
  await admin.query(
    `INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id)
    VALUES ($1,$2,1,'merge',$3,$4)`,
    [routeOf(subjectId), subjectId, `sha256:${'a'.repeat(64)}`, f.transactionId],
  );
  for (const [index, body] of bodies.entries())
    expect(await facts(body)).toEqual([
      {
        ...home(body),
        takenDown: true,
        securityRevision: outcomes[index]!.value.securityRevision,
        ...(await storedTakedownPair(body)),
      },
    ]);
  const body = bodies[0]!;
  const target = home(body);
  await admin.query(
    `UPDATE content.source_fences SET security_revision=9007199254740993
    WHERE route=$1 AND source=$2 AND external_id=$3 AND field_group=$4`,
    Object.values(target),
  );
  const next = await f.execute(body);
  expect(BigInt(next.value.securityRevision)).toBeGreaterThan(9007199254740993n);
  expect(await facts(body)).toEqual([
    {
      ...target,
      takenDown: true,
      securityRevision: next.value.securityRevision,
      ...(await storedTakedownPair(body)),
    },
  ]);
  expect(await facts({ ...body, external_id: `${external}-other` })).toEqual([
    { ...home({ ...body, external_id: `${external}-other` }), takenDown: false, securityRevision: null },
  ]);
});

test('bounded invalid tuple and reason inputs fail before any pool access', async () => {
  const f = await fixture();
  const body = input();
  const deps = await f.dependencies();
  const start = observer.records.length;
  for (const patch of [
    ...['', 'Upper', 'bad\nsource', 'source\n', 'x'.repeat(33)].map((source) => ({ source })),
    ...['', 'a\nb', '\ud800', 'x'.repeat(1025), 'é'.repeat(513)].map((external_id) => ({ external_id })),
    { field_group: 'unknown' },
    ...['', 'x'.repeat(1025), '\ud800'].map((reason) => ({ reason })),
  ])
    await expect(
      takedownSourceFence(deps, f.actor, { ...body, ...patch } as typeof body, context()),
    ).rejects.toBeInstanceOf(RangeError);
  expect(observer.records.length).toBe(start);
});

test('a failed native outbox fence rolls back the tuple, log and receipt atomically', async () => {
  const f = await fixture();
  const body = input();
  const request = context();
  // Observe the actual executor statement, then fail its next native boundary.
  await f.execute(input());
  const statement = observer.records.find((r) => /INSERT INTO core.outbox/.test(r.statement))!.statement;
  observer.armFault({ match: { statement }, boundary: 'before', error: new Error('outbox unavailable') });
  const before = await readPartition(admin, partitionOf(home(body).route));
  await expect(f.execute(body, request)).rejects.toThrow('outbox unavailable');
  expect(await readPartition(admin, partitionOf(home(body).route))).toEqual(before);
  expect(await facts(body)).toEqual([{ ...home(body), takenDown: false, securityRevision: null }]);
  expect(
    (
      await admin.query(
        'SELECT 1 FROM core.receipt WHERE partition_no=$1 AND actor_account_id=$2 AND idempotency_key=$3',
        [partitionOf(home(body).route), f.actorId, request.idempotencyKey],
      )
    ).rowCount,
  ).toBe(0);
});

test('checkGrowth measures the real command pool with constant rows/statements and logarithmic buffers', async () => {
  const db: GrowthDatabase = await openGrowthDatabase(url);
  db.pool.options.max = 1;
  try {
    const f = await fixture(db);
    const body = input('growth-target');
    const deps = await f.dependencies();
    const target = home(body);
    const partition = partitionOf(target.route);
    let ordinal = 0;
    const hot = () => {
      for (;;) {
        const row = home(input(`command-distractor-${ordinal++}`));
        if (partitionOf(row.route) === partition) return row;
      }
    };
    const population: Population = {
      name: 'source-fence-command',
      hotPartition: partition,
      hotShare: 1,
      rows: () => ({
        'content.source_fences': [hot()].map((row) => ({ ...row, taken_down: true, security_revision: '1' })),
      }),
    };
    const report = await checkGrowth(db, {
      name: 'authorized exact tuple takedown',
      scales: [32, 256, 2048],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow: async (_db, scale, previous) => {
        await seed(db, population, { from: previous, to: scale });
      },
      operation: async () => {
        const result = await takedownSourceFence(deps, f.actor, body, context());
        expect(result.partition).toBe(partition);
        expect(result.replayed).toBe(false);
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([32, 256, 2048]);
    expect(new Set(report.samples.map((sample) => sample.cost.statements)).size).toBe(1);
    expect(report.samples.every((sample) => sample.cost.rows > 0 && sample.cost.blocks > 0)).toBe(true);
    expect(report.samples.every((sample) => Object.hasOwn(sample.cost.relations ?? {}, 'content.source_fences'))).toBe(
      true,
    );
    expect(report.samples.every((sample) => Object.hasOwn(sample.cost.relations ?? {}, 'access.resource_grant'))).toBe(
      true,
    );
  } finally {
    await db.close();
  }
}, 90_000);
