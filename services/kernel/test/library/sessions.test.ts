import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { Value } from 'typebox/value';
import { readAccount, type Account } from '../../src/access/account-data.ts';
import { createAccess } from '../../src/access/permission.ts';
import { EVENT_TYPES, readBatch } from '../../src/events/log.ts';
import { LibraryNotFoundError } from '../../src/library/command-support.ts';
import { createSessionCommands } from '../../src/library/sessions.ts';
import type { ProgressMode, ProgressUnit } from '../../src/library/progress.ts';
import type { AccountActor, Actor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { measure, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { suspendAccount } from '../support/native-suspension-driver.ts';

const route = 0x21b0;
const eventType = 'com.rezics.library.progress_session.updated.v1';
const scopes = [
  'subject:read',
  'progress_session:create',
  'progress_session:update',
  'progress_session:read',
  'progress_session:list',
];
const persona = (accountId: string, permissions = scopes): AccountActor => ({
  kind: 'account',
  accountId,
  scopes: permissions,
  clientId: 'sessions-test',
  requestedBy: null,
  authnEpoch: 1,
});
const owner = persona(newId(route));
const other = persona(newId(route));
const suspended = persona(newId(route));
const anonymous: Actor = { kind: 'anonymous' };
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(59)]]) };
let database: GrowthDatabase;
let commands: ReturnType<typeof createSessionCommands>;
let subjectId: string;
let versionSubjectId: string;
let now = Date.parse('2026-10-26T12:00:00.000Z');
const clock = () => new Date(now);
const key = () => randomUUID();

async function subject(): Promise<string> {
  const request = key();
  const result = await createSubject(database.pool, {
    actor: owner,
    target: subjectTarget(new Uint8Array(32).fill(73), owner.accountId, request),
    idempotencyKey: request,
    digest: createHash('sha256').update(request).digest(),
    item: { type: 'schema:Book', labels: { en: 'Progress book' } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  return result.subject.id;
}

async function start(mode: ProgressMode, unit: ProgressUnit = 'page') {
  return (await commands.startSession(owner, { subjectId, mode, unit }, key())).value;
}

async function snapshot() {
  return (
    await database.admin.query(
      `SELECT
    (SELECT count(*)::int FROM library.progress_session) AS sessions,
    (SELECT count(*)::int FROM library.progress_unit) AS units,
    (SELECT count(*)::int FROM library.progress_change) AS changes,
    (SELECT count(*)::int FROM core.outbox WHERE type = $1) AS events`,
      [eventType],
    )
  ).rows[0];
}

beforeAll(async () => {
  database = await openGrowthDatabase();
  await bootstrapRelease(database.pool, bundledRelease);
  const accounts = new Map<string, Account>();
  for (const actor of [owner, other, suspended]) {
    await database.admin.query(
      `INSERT INTO access.account
      (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch)
      VALUES ($1, $2, 'actor', $3, $4, false, 1)`,
      [route, actor.accountId, 'active', newId(route)],
    );
    if (actor === suspended) await suspendAccount(database.admin, actor.accountId);
    accounts.set(actor.accountId, (await readAccount(database.admin, route, actor.accountId))!);
  }
  const access = createAccess({
    actions: new Map([['subject:read', { anonymous: true }]]),
    accountEvidence: (actor) => accounts.get(actor.accountId) ?? null,
  });
  commands = createSessionCommands({ pool: database.pool, access, tokens, clock });
  subjectId = await subject();
  versionSubjectId = await subject();
});

afterAll(async () => {
  if (database) await database.close();
});

test('each mode starts in the account partition, records by CAS and reads its own value', async () => {
  for (const [mode, record, expected] of [
    ['scalar_amount', { amount: '23' }, { amount: '23', position: null, locator: null, completedUnitCount: 0 }],
    [
      'cursor_position',
      { locator: 'chapter:4', position: '9' },
      { amount: null, locator: 'chapter:4', position: '9', completedUnitCount: 0 },
    ],
    [
      'completed_units',
      { add: ['1', '3', '7'] },
      { amount: null, locator: null, position: null, completedUnitCount: 3 },
    ],
  ] as const) {
    const created = await commands.startSession(owner, { subjectId, versionSubjectId, mode, unit: 'page' }, key());
    expect(created.partition).toBe(partitionOf(route));
    expect(routeOf(created.value.id)).toBe(route);
    expect(created.value).toMatchObject({
      accountId: owner.accountId,
      subjectId,
      versionSubjectId,
      mode,
      state: 'active',
      revision: 1,
      startedAt: clock().toISOString(),
      completedAt: null,
    });
    const changed = await commands.recordProgress(owner, created.value.id, { revision: 1, ...record }, key());
    expect(changed.value).toMatchObject({ ...expected, revision: 2, state: 'active' });
    expect(await commands.readSession(owner, created.value.id)).toEqual(changed.value);
    const history = await commands.listChanges(owner, created.value.id);
    expect(history.changes).toEqual([
      {
        sessionId: created.value.id,
        changeNo: 2,
        intent: record,
        recordedAt: clock().toISOString(),
        transactionId: changed.value.transactionId,
      },
    ]);
    const before = await snapshot();
    const wrong = mode === 'scalar_amount' ? { locator: 'x', position: '2' } : { amount: '2' };
    await expect(
      commands.recordProgress(owner, created.value.id, { revision: 2, ...wrong }, key()),
    ).rejects.toMatchObject({ name: 'ProgressInvalidError' });
    expect(await snapshot()).toEqual(before);
    expect(await commands.readSession(owner, created.value.id)).toEqual(changed.value);
  }
});

test('completed units stay sparse and history preserves the exact sorted intent', async () => {
  const session = await start('completed_units');
  const first = await commands.recordProgress(owner, session.id, { revision: 1, add: ['7', '1', '3'] }, key());
  now += 1000;
  const second = await commands.recordProgress(owner, session.id, { revision: 2, remove: ['3'] }, key());
  expect(second.value.completedUnitCount).toBe(2);
  expect((await commands.listUnits(owner, session.id)).units.map((row) => row.unitId)).toEqual(['1', '7']);
  expect((await commands.listChanges(owner, session.id)).changes).toEqual([
    {
      sessionId: session.id,
      changeNo: 2,
      intent: { add: ['1', '3', '7'] },
      recordedAt: first.value.startedAt,
      transactionId: first.value.transactionId,
    },
    {
      sessionId: session.id,
      changeNo: 3,
      intent: { remove: ['3'] },
      recordedAt: clock().toISOString(),
      transactionId: second.value.transactionId,
    },
  ]);
  const duplicate = await commands.recordProgress(
    owner,
    session.id,
    { revision: 3, add: ['1'], remove: ['missing'] },
    key(),
  );
  expect(duplicate.value.completedUnitCount).toBe(2);
  expect((await commands.listChanges(owner, session.id)).changes.at(-1)?.intent).toEqual({
    add: ['1'],
    remove: ['missing'],
  });
});

test('percent is bounded, minutes never auto-complete and a cursor can move back', async () => {
  const percent = await start('scalar_amount', 'percent');
  const before = await snapshot();
  await expect(
    commands.recordProgress(owner, percent.id, { revision: 1, amount: '100.000001' }, key()),
  ).rejects.toMatchObject({ name: 'ProgressInvalidError', field: 'amount' });
  expect(await snapshot()).toEqual(before);
  expect((await commands.recordProgress(owner, percent.id, { revision: 1, amount: '100' }, key())).value.state).toBe(
    'active',
  );
  const minutes = (
    await commands.startSession(owner, { subjectId, mode: 'scalar_amount', unit: 'minute', total: '10' }, key())
  ).value;
  expect((await commands.recordProgress(owner, minutes.id, { revision: 1, amount: '500' }, key())).value).toMatchObject(
    { state: 'active', completedAt: null },
  );
  const cursor = await start('cursor_position');
  await commands.recordProgress(owner, cursor.id, { revision: 1, locator: 'chapter:9', position: '99' }, key());
  expect(
    (await commands.recordProgress(owner, cursor.id, { revision: 2, locator: 'chapter:2', position: '1' }, key()))
      .value,
  ).toMatchObject({ locator: 'chapter:2', position: '1' });
});

test('completion and abandonment are explicit CAS transitions; rereads preserve earlier completion', async () => {
  const session = await start('scalar_amount');
  now += 1000;
  const completed = await commands.completeSession(owner, session.id, { revision: 1 }, key());
  expect(completed.value).toMatchObject({ state: 'completed', revision: 2, completedAt: clock().toISOString() });
  now += 1000;
  const reread = await start('scalar_amount');
  expect(reread.id).not.toBe(session.id);
  expect(reread.completedAt).toBeNull();
  expect(await commands.readSession(owner, session.id)).toEqual(completed.value);
  const before = await snapshot();
  await expect(commands.recordProgress(owner, session.id, { revision: 2, amount: '1' }, key())).rejects.toMatchObject({
    name: 'ProgressInvalidError',
    field: 'state',
  });
  await expect(commands.abandonSession(owner, session.id, { revision: 2 }, key())).rejects.toMatchObject({
    name: 'ProgressInvalidError',
    field: 'state',
  });
  expect(await snapshot()).toEqual(before);
  const abandoned = await commands.abandonSession(owner, reread.id, { revision: 1 }, key());
  expect(abandoned.value).toMatchObject({ state: 'abandoned', completedAt: null, revision: 2 });
  await expect(commands.completeSession(owner, reread.id, { revision: 2 }, key())).rejects.toMatchObject({
    name: 'ProgressInvalidError',
  });
});

test('stale and concurrent revisions cannot append history or mutate the sparse set', async () => {
  const session = await start('completed_units');
  const results = await Promise.allSettled([
    commands.recordProgress(owner, session.id, { revision: 1, add: ['1'] }, key()),
    commands.recordProgress(owner, session.id, { revision: 1, add: ['7'] }, key()),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((result) => result.status === 'rejected')).toMatchObject({
    reason: { name: 'ProgressConflictError' },
  });
  const before = await snapshot();
  for (const revision of [0, -1, 1.5, '2', undefined]) {
    await expect(commands.recordProgress(owner, session.id, { revision, add: ['bad'] }, key())).rejects.toMatchObject({
      name: 'ProgressInvalidError',
    });
  }
  await expect(commands.completeSession(owner, session.id, { revision: 1 }, key())).rejects.toMatchObject({
    name: 'ProgressConflictError',
  });
  expect(await snapshot()).toEqual(before);
  expect((await commands.listUnits(owner, session.id)).units).toHaveLength(1);
  expect((await commands.listChanges(owner, session.id)).changes).toHaveLength(1);
});

test('20,000 units is a hard limit and a rejected addition rolls back every row', async () => {
  const session = await start('completed_units');
  let revision = 1;
  for (let offset = 0; offset < 20_000; offset += 100) {
    await commands.recordProgress(
      owner,
      session.id,
      { revision, add: Array.from({ length: 100 }, (_, n) => `u${offset + n}`) },
      key(),
    );
    revision += 1;
  }
  expect((await commands.readSession(owner, session.id)).completedUnitCount).toBe(20_000);
  const before = await snapshot();
  await expect(
    commands.recordProgress(owner, session.id, { revision, add: ['overflow'] }, key()),
  ).rejects.toMatchObject({ name: 'ProgressInvalidError', field: 'completedUnitCount' });
  expect(await snapshot()).toEqual(before);
  const swapped = await commands.recordProgress(
    owner,
    session.id,
    { revision, remove: ['u0'], add: ['replacement'] },
    key(),
  );
  expect(swapped.value.completedUnitCount).toBe(20_000);
});

test('replays return the original result without repeated rows or events', async () => {
  const request = key();
  const input = { subjectId, mode: 'completed_units', unit: 'episode' };
  const created = await commands.startSession(owner, input, request);
  expect(await commands.startSession(owner, input, request)).toMatchObject({ value: created.value, replayed: true });
  const recordKey = key();
  const record = { revision: 1, add: ['7'] };
  const recorded = await commands.recordProgress(owner, created.value.id, record, recordKey);
  const before = await snapshot();
  expect(await commands.recordProgress(owner, created.value.id, record, recordKey)).toMatchObject({
    value: recorded.value,
    replayed: true,
  });
  expect(await snapshot()).toEqual(before);
  await expect(
    commands.recordProgress(owner, created.value.id, { revision: 1, add: ['8'] }, recordKey),
  ).rejects.toThrow();
  const completeKey = key();
  const completed = await commands.completeSession(owner, created.value.id, { revision: 2 }, completeKey);
  expect(await commands.completeSession(owner, created.value.id, { revision: 2 }, completeKey)).toMatchObject({
    value: completed.value,
    replayed: true,
  });
});

test('unknown subjects and versions are not found; invalid creation changes nothing', async () => {
  const before = await snapshot();
  for (const input of [
    { subjectId: newId(route), mode: 'scalar_amount', unit: 'page' },
    { subjectId, versionSubjectId: newId(route), mode: 'scalar_amount', unit: 'page' },
  ])
    await expect(commands.startSession(owner, input, key())).rejects.toBeInstanceOf(LibraryNotFoundError);
  await expect(commands.startSession(owner, { subjectId, mode: 'unknown', unit: 'page' }, key())).rejects.toMatchObject(
    { name: 'ProgressInvalidError' },
  );
  expect(await snapshot()).toEqual(before);
});

test('foreign, anonymous, suspended and unscoped personas never read or change a session', async () => {
  const session = await start('completed_units');
  const before = await snapshot();
  for (const candidate of [other, anonymous, suspended, persona(owner.accountId, [])]) {
    for (const read of [
      () => commands.readSession(candidate, session.id),
      () => commands.listUnits(candidate, session.id),
      () => commands.listChanges(candidate, session.id),
    ])
      await expect(read()).rejects.toThrow();
    for (const write of [
      () => commands.recordProgress(candidate, session.id, { revision: 1, add: ['leak'] }, key()),
      () => commands.completeSession(candidate, session.id, { revision: 1 }, key()),
      () => commands.abandonSession(candidate, session.id, { revision: 1 }, key()),
    ])
      await expect(write()).rejects.toThrow();
  }
  for (const candidate of [anonymous, suspended, persona(owner.accountId, [])]) {
    await expect(commands.listSessions(candidate, subjectId)).rejects.toThrow();
    await expect(
      commands.startSession(candidate, { subjectId, mode: 'scalar_amount', unit: 'page' }, key()),
    ).rejects.toThrow();
  }
  expect((await commands.listSessions(other, subjectId)).sessions).toEqual([]);
  for (const id of ['malformed', newId(route), newId(0x3000)]) {
    await expect(commands.readSession(owner, id)).rejects.toBeInstanceOf(LibraryNotFoundError);
  }
  await expect(commands.readSession(other, session.id)).rejects.toBeInstanceOf(LibraryNotFoundError);
  expect(await snapshot()).toEqual(before);
  expect((await commands.readSession(owner, session.id)).revision).toBe(1);
});

test('signed keyset cursors bind the operation, account and session or subject', async () => {
  const target = await start('completed_units');
  await commands.recordProgress(owner, target.id, { revision: 1, add: ['1', '3', '7'] }, key());
  await commands.recordProgress(owner, target.id, { revision: 2, remove: ['3'] }, key());
  const first = await commands.listUnits(owner, target.id, { limit: 1 });
  expect(first.units.map((row) => row.unitId)).toEqual(['1']);
  expect(first.next).toBeString();
  expect(
    (await commands.listUnits(owner, target.id, { limit: 1, cursor: first.next! })).units.map((row) => row.unitId),
  ).toEqual(['7']);
  const history = await commands.listChanges(owner, target.id, { limit: 1 });
  expect(
    (await commands.listChanges(owner, target.id, { cursor: history.next! })).changes.map((row) => row.changeNo),
  ).toEqual([3]);
  const another = await start('completed_units');
  for (const read of [
    () => commands.listUnits(owner, another.id, { cursor: first.next! }),
    () => commands.listChanges(owner, target.id, { cursor: first.next! }),
    () => commands.listUnits(owner, target.id, { cursor: `${first.next!}x` }),
  ])
    await expect(read()).rejects.toMatchObject({ code: 'invalid_cursor' });
  const page = await commands.listSessions(owner, subjectId, { limit: 1 });
  expect(page.next).toBeString();
  const next = await commands.listSessions(owner, subjectId, { cursor: page.next! });
  expect(next.sessions.every((row) => row.id !== page.sessions[0]!.id)).toBe(true);
  await expect(commands.listSessions(other, subjectId, { cursor: page.next! })).rejects.toMatchObject({
    code: 'invalid_cursor',
  });
  await expect(commands.listSessions(owner, versionSubjectId, { cursor: page.next! })).rejects.toMatchObject({
    code: 'invalid_cursor',
  });
  await expect(commands.listUnits(owner, target.id, { limit: 101 })).rejects.toMatchObject({
    name: 'ProgressInvalidError',
  });
});

test('events are closed, ID-only, and use the account as their subject in its partition', async () => {
  const schema = EVENT_TYPES[eventType];
  expect(Value.Check(schema, { sessionId: newId(route) })).toBe(true);
  expect(Value.Check(schema, { sessionId: newId(route), subjectId })).toBe(false);
  const rows = await database.admin.query('SELECT partition_no, subject, data FROM core.outbox WHERE type = $1', [
    eventType,
  ]);
  expect(rows.rows.length).toBeGreaterThan(0);
  for (const row of rows.rows) {
    expect(row.partition_no).toBe(partitionOf(route));
    expect(row.subject).toBe(owner.accountId);
    expect(Object.keys(row.data)).toEqual(['sessionId']);
  }
  const batch = await readBatch(database.pool, {
    consumer: 'session_test',
    partition: partitionOf(route),
    apply: async () => {},
  });
  expect(batch.status).toBe('read');
});

test('statement counts stay equal at three scales of unrelated sessions and units', async () => {
  const scalar = await start('scalar_amount');
  const cursor = await start('cursor_position');
  const units = await start('completed_units');
  await commands.recordProgress(owner, units.id, { revision: 1, add: ['1', '7'] }, key());
  const samples: number[][] = [];
  let previous = 0;
  let revision = 1;
  for (const scale of [1, 8, 64]) {
    await database.admin.query(
      `INSERT INTO library.progress_session
      (route, session_id, account_id, subject_id, mode, unit, state, revision, started_at, transaction_id, completed_unit_count)
      SELECT $1, session_id, $2, $3, 'completed_units', 'page', 'active', 1, now(), $2, 0
      FROM unnest($4::uuid[]) AS session_id`,
      [route, other.accountId, subjectId, Array.from({ length: scale - previous }, () => newId(route))],
    );
    await database.admin.query(
      `INSERT INTO library.progress_unit(route, session_id, unit_id, added_at)
      SELECT route, session_id, 'unrelated', now() FROM library.progress_session
      WHERE account_id = $1 ON CONFLICT DO NOTHING`,
      [other.accountId],
    );
    const operations: (() => Promise<unknown>)[] = [
      () => commands.recordProgress(owner, scalar.id, { revision, amount: '2' }, key()),
      () => commands.recordProgress(owner, cursor.id, { revision, locator: 'x', position: '2' }, key()),
      () => commands.recordProgress(owner, units.id, { revision: revision + 1, add: ['1'] }, key()),
      () => commands.listUnits(owner, units.id, { limit: 1 }),
      () => commands.listChanges(owner, units.id, { limit: 1 }),
    ];
    const counts = [];
    for (const operation of operations) counts.push((await measure(database, operation)).cost.statements);
    samples.push(counts);
    previous = scale;
    revision += 1;
  }
  expect(samples[1]).toEqual(samples[0]);
  expect(samples[2]).toEqual(samples[0]);
});
