import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import type pg from 'pg';
import { Value } from 'typebox/value';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { IdempotencyConflictError } from '../../src/command/command.ts';
import { EVENT_TYPES, readBatch } from '../../src/events/log.ts';
import { LibraryNotFoundError } from '../../src/library/command-support.ts';
import { createPublishedLogCommands } from '../../src/library/published-logs.ts';
import type { ProgressSession } from '../../src/library/progress-model.ts';
import * as progress from '../../src/library/progress-store.ts';
import type { AccountActor, Actor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { encodeCursor } from '../../src/tokens/cursor.ts';
import { measure, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let route: number;
const scopes = ['subject:read', 'published_log:create', 'published_log:read', 'published_log:delete'];
const updatedEvent = 'com.rezics.library.published_log.updated.v1';
const deletedEvent = 'com.rezics.library.published_log.deleted.v1';
let owner: AccountActor;
let other: AccountActor;
let suspended: AccountActor;
let unscoped: AccountActor;
const anonymous: Actor = { kind: 'anonymous' };
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(61)]]) };
const startedAt = '2026-10-26T08:00:00.000Z';
const completedAt = '2026-10-26T18:00:00.000Z';
let database: GrowthDatabase;
let nativeFixture: NativeProfileFixture;
let commands: ReturnType<typeof createPublishedLogCommands>;
let subjectId: string;
let subjectRoute: number;
let now = Date.parse('2026-10-26T12:00:00.000Z');
const clock = () => new Date(now);
const key = () => randomUUID();

async function subject(): Promise<string> {
  const id = await nativeFixture.createSubject('game', 'Published log book');
  const idRoute = routeOf(id);
  if (idRoute === null || partitionOf(idRoute) === partitionOf(route))
    throw new Error('Subject partition matched the owner');
  return id;
}

async function withAdmin<T>(body: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await database.admin.connect();
  try {
    await client.query('BEGIN');
    const value = await body(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function writeSession(): Promise<ProgressSession> {
  return withAdmin((client) =>
    progress.insertSession(
      client,
      route,
      {
        id: newId(route),
        accountId: owner.accountId,
        subjectId,
        versionSubjectId: null,
        mode: 'scalar_amount',
        unit: 'page',
        total: null,
      },
      { transactionId: newId(route), time: startedAt },
    ),
  );
}

async function completeSession(session: ProgressSession): Promise<ProgressSession> {
  const completed = await withAdmin((client) =>
    progress.updateSession(
      client,
      route,
      session.id,
      session.revision,
      {
        amount: session.amount,
        locator: session.locator,
        position: session.position,
        completedUnitCount: session.completedUnitCount,
        state: 'completed',
        completedAt,
      },
      { transactionId: newId(route), time: completedAt },
    ),
  );
  if (!completed) throw new Error('Session completion did not write');
  return completed;
}

async function counts() {
  const row = (
    await database.admin.query(
      `SELECT
         (SELECT count(*)::int FROM library.published_log) AS logs,
         (SELECT count(*)::int FROM library.progress_session) AS sessions,
         (SELECT count(*)::int FROM library.subject_listing WHERE subject_id = $1) AS listings,
         (SELECT count(*)::int FROM library.subject_collection WHERE subject_id = $1) AS collections,
         (SELECT count(*)::int FROM core.outbox WHERE type LIKE 'com.rezics.library.published_log.%') AS events`,
      [subjectId],
    )
  ).rows[0];
  return row;
}

async function storedLog(logId: string) {
  const row = (
    await database.admin.query(
      `SELECT route, log_id, account_id, session_id, subject_id, session_state, started_at, completed_at, note,
              published_at, transaction_id, revision, deleted, deletion_id, deleted_at, restore_until
       FROM library.published_log WHERE log_id = $1`,
      [logId],
    )
  ).rows[0];
  return row ?? null;
}

async function rowsNaming(logId: string): Promise<number> {
  const tables = await database.admin.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'library' AND column_name = 'route'
     GROUP BY table_name ORDER BY table_name`,
  );
  let count = 0;
  for (const table of tables.rows) {
    if (!/^[a-z_]+$/.test(table.table_name)) continue;
    const found = await database.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM library.${table.table_name} AS row
       WHERE row.route = $1 AND to_jsonb(row)::text LIKE $2`,
      [subjectRoute, `%${logId}%`],
    );
    count += found.rows[0]!.n;
  }
  const events = await database.admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM core.outbox
     WHERE partition_no = $1 AND (data::text LIKE $2 OR COALESCE(subject, '') LIKE $2)`,
    [partitionOf(subjectRoute), `%${logId}%`],
  );
  return count + events.rows[0]!.n;
}

beforeAll(async () => {
  database = await openGrowthDatabase();
  await bootstrapRelease(database.pool, bundledRelease);
  nativeFixture = await createProfileEntryFixture({ pool: database.pool });
  owner = (await nativeFixture.identity(scopes)).actor;
  other = (await nativeFixture.identity(scopes)).actor;
  suspended = (await nativeFixture.identity(scopes)).actor;
  unscoped = (await nativeFixture.identity(['subject:read'])).actor;
  route = routeOf(owner.accountId)!;
  await nativeFixture.suspend(suspended.accountId);
  commands = createPublishedLogCommands({ pool: database.pool, access: nativeFixture.access, tokens, clock });
  subjectId = await subject();
  subjectRoute = routeOf(subjectId)!;
});

afterAll(async () => {
  await nativeFixture?.close();
  if (database) await database.close();
});

test('an owner publishes an immutable snapshot that anyone, including anonymous, can read', async () => {
  const session = await writeSession();
  const published = await commands.publishLog(
    owner,
    { sessionId: session.id, note: 'A public reading milestone' },
    key(),
  );
  expect(published.partition).toBe(partitionOf(route));
  expect(published.replayed).toBe(false);
  expect(routeOf(published.value.id)).toBe(route);
  expect(published.value).toEqual({
    id: published.value.id,
    accountId: owner.accountId,
    subjectId,
    sessionState: 'active',
    startedAt: session.startedAt,
    completedAt: null,
    note: 'A public reading milestone',
    publishedAt: clock().toISOString(),
  });
  const row = await storedLog(published.value.id);
  expect(row).toMatchObject({
    route,
    log_id: published.value.id,
    account_id: owner.accountId,
    session_id: session.id,
    subject_id: subjectId,
    session_state: 'active',
    note: 'A public reading milestone',
  });
  expect(new Date(row.started_at).toISOString()).toBe(session.startedAt);
  expect(new Date(row.published_at).toISOString()).toBe(published.value.publishedAt);
  expect(row.completed_at).toBeNull();
  for (const viewer of [anonymous, other, suspended, owner]) {
    expect(await commands.readPublishedLog(viewer, published.value.id)).toEqual(published.value);
  }

  const completed = await completeSession(session);
  expect(completed).toMatchObject({ state: 'completed', completedAt, revision: session.revision + 1 });
  expect(await commands.readPublishedLog(anonymous, published.value.id)).toEqual(published.value);
  expect((await storedLog(published.value.id)).session_state).toBe('active');

  now += 1000;
  const again = await commands.publishLog(owner, { sessionId: session.id }, key());
  expect(again.value.id).not.toBe(published.value.id);
  expect(again.value).toEqual({
    id: again.value.id,
    accountId: owner.accountId,
    subjectId,
    sessionState: 'completed',
    startedAt: session.startedAt,
    completedAt,
    note: null,
    publishedAt: clock().toISOString(),
  });
  expect(await commands.readPublishedLog(anonymous, published.value.id)).toEqual(published.value);

  const page = await commands.listPublishedLogs(anonymous, { accountId: owner.accountId });
  const firstIndex = page.publishedLogs.findIndex((log) => log.id === published.value.id);
  const secondIndex = page.publishedLogs.findIndex((log) => log.id === again.value.id);
  expect(secondIndex).toBeGreaterThanOrEqual(0);
  expect(firstIndex).toBeGreaterThan(secondIndex);
  expect(page.publishedLogs[secondIndex]).toEqual(again.value);
  expect(page.publishedLogs[firstIndex]).toEqual(published.value);
  expect(await commands.listPublishedLogs(other, { accountId: other.accountId })).toEqual({
    publishedLogs: [],
    next: null,
  });

  const updated = EVENT_TYPES[updatedEvent];
  const deleted = EVENT_TYPES[deletedEvent];
  expect(Value.Check(updated, { logId: published.value.id })).toBe(true);
  expect(Value.Check(updated, { logId: published.value.id, subjectId })).toBe(false);
  expect(Value.Check(deleted, { logId: published.value.id, sessionId: session.id })).toBe(false);
  const events = await database.admin.query<{ partition_no: number; subject: string; data: { logId: string } }>(
    'SELECT partition_no, subject, data FROM core.outbox WHERE type = $1',
    [updatedEvent],
  );
  expect(events.rows.length).toBeGreaterThan(0);
  for (const event of events.rows) {
    expect(event.partition_no).toBe(partitionOf(route));
    expect(event.subject).toBe(owner.accountId);
    expect(Object.keys(event.data)).toEqual(['logId']);
  }
  const seen: string[] = [];
  const batch = await readBatch(database.pool, {
    consumer: 'published_log_test',
    partition: partitionOf(route),
    apply: async (envelopes) => {
      for (const envelope of envelopes) for (const event of envelope.events) seen.push(event.type);
    },
  });
  expect(batch.status).toBe('read');
  expect(seen).toContain(updatedEvent);
  expect(await rowsNaming(published.value.id)).toBe(0);
  expect(await rowsNaming(again.value.id)).toBe(0);
});

test('only the owner retracts a log, and a retracted log reads as a safe structural tombstone', async () => {
  const session = await writeSession();
  const published = (await commands.publishLog(owner, { sessionId: session.id, note: 'Retract me' }, key())).value;
  expect(
    (await commands.listPublishedLogs(anonymous, { accountId: owner.accountId, limit: 100 })).publishedLogs,
  ).toContainEqual(published);
  const original = await commands.readWithRevision(owner, published.id);
  if (original.revision === undefined) throw new Error('Owner read did not return the published log revision');
  const removed = await commands.retractLog(owner, published.id, key(), original.revision);
  expect(removed.replayed).toBe(false);
  expect(removed.value).toEqual(published);
  expect(removed.partition).toBe(partitionOf(route));
  expect(await commands.readPublishedLog(anonymous, published.id)).toEqual({ id: published.id, deleted: true });
  await expect(commands.readPublishedLog(owner, newId(route))).rejects.toBeInstanceOf(LibraryNotFoundError);
  await expect(commands.readPublishedLog(owner, 'not-a-log')).rejects.toBeInstanceOf(LibraryNotFoundError);
  const page = await commands.listPublishedLogs(anonymous, { accountId: owner.accountId, limit: 100 });
  expect(page.publishedLogs.map((log) => log.id)).not.toContain(published.id);
  expect(await storedLog(published.id)).toMatchObject({
    log_id: published.id,
    account_id: owner.accountId,
    session_id: session.id,
    subject_id: subjectId,
    session_state: published.sessionState,
    note: published.note,
    revision: original.revision + 1,
    deleted: true,
    deletion_id: removed.deletionId,
    deleted_at: new Date(now),
    restore_until: new Date(now + 720 * 60 * 60 * 1000),
  });
  expect(new Date((await storedLog(published.id))!.started_at).toISOString()).toBe(published.startedAt);
  expect(new Date((await storedLog(published.id))!.published_at).toISOString()).toBe(published.publishedAt);
  const events = await database.admin.query<{ partition_no: number; subject: string; data: { logId: string } }>(
    "SELECT partition_no, subject, data FROM core.outbox WHERE type = $1 AND data->>'logId' = $2",
    [deletedEvent, published.id],
  );
  expect(events.rows).toEqual([
    { partition_no: partitionOf(route), subject: owner.accountId, data: { logId: published.id } },
  ]);
  expect(await rowsNaming(published.id)).toBe(0);
});

test("another account's session cannot be published and its log cannot be retracted", async () => {
  const session = await writeSession();
  const before = await counts();
  const foreign = await commands.publishLog(other, { sessionId: session.id }, key()).then(
    () => null,
    (error: unknown) => error,
  );
  const unknown = await commands.publishLog(owner, { sessionId: newId(route) }, key()).then(
    () => null,
    (error: unknown) => error,
  );
  const malformed = await commands.publishLog(owner, { sessionId: 'not-a-session' }, key()).then(
    () => null,
    (error: unknown) => error,
  );
  expect(foreign).toBeInstanceOf(LibraryNotFoundError);
  expect(unknown).toBeInstanceOf(LibraryNotFoundError);
  expect(malformed).toBeInstanceOf(LibraryNotFoundError);
  expect((foreign as Error).message).toBe((unknown as Error).message);
  expect((malformed as Error).message).toBe((unknown as Error).message);
  expect(await counts()).toEqual(before);

  const published = (await commands.publishLog(owner, { sessionId: session.id }, key())).value;
  const held = await counts();
  await expect(commands.retractLog(other, published.id, key())).rejects.toBeInstanceOf(LibraryNotFoundError);
  await expect(commands.retractLog(other, newId(0x3000), key())).rejects.toBeInstanceOf(LibraryNotFoundError);
  expect(await counts()).toEqual(held);
  expect(await commands.readPublishedLog(anonymous, published.id)).toEqual(published);
  expect(await storedLog(published.id)).not.toBeNull();
});

test('suspended, anonymous and unscoped writes change nothing', async () => {
  const session = await writeSession();
  const published = (await commands.publishLog(owner, { sessionId: session.id, note: 'Stay' }, key())).value;
  const before = await counts();
  const sessionBefore = await withAdmin((client) => progress.readSession(client, route, session.id));
  for (const actor of [suspended, anonymous, unscoped]) {
    await expect(commands.publishLog(actor, { sessionId: session.id, note: 'Denied' }, key())).rejects.toBeInstanceOf(
      GrantDeniedError,
    );
    await expect(commands.retractLog(actor, published.id, key())).rejects.toBeInstanceOf(GrantDeniedError);
  }
  expect(await counts()).toEqual(before);
  expect(await commands.readPublishedLog(anonymous, published.id)).toEqual(published);
  expect(await withAdmin((client) => progress.readSession(client, route, session.id))).toEqual(sessionBefore);
});

test('replays return the original result and a reused key with a different body conflicts', async () => {
  const session = await writeSession();
  const request = key();
  const input = { sessionId: session.id, note: 'Replay' };
  const created = await commands.publishLog(owner, input, request);
  const before = await counts();
  expect(await commands.publishLog(owner, input, request)).toMatchObject({ value: created.value, replayed: true });
  expect(await counts()).toEqual(before);
  await expect(
    commands.publishLog(owner, { sessionId: session.id, note: 'Different' }, request),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);
  expect(await counts()).toEqual(before);
  expect(await commands.readPublishedLog(anonymous, created.value.id)).toEqual(created.value);

  const secondOutcome = await commands.publishLog(owner, { sessionId: session.id, note: 'Other' }, key());
  const second = secondOutcome.value;
  const retractKey = key();
  const removed = await commands.retractLog(owner, created.value.id, retractKey, created.revision);
  const afterRetract = await counts();
  expect(await commands.retractLog(owner, created.value.id, retractKey, created.revision)).toMatchObject({
    value: removed.value,
    replayed: true,
  });
  expect(await counts()).toEqual(afterRetract);
  await expect(commands.retractLog(owner, second.id, retractKey, secondOutcome.revision)).rejects.toBeInstanceOf(
    IdempotencyConflictError,
  );
  expect(await commands.readPublishedLog(anonymous, second.id)).toEqual(second);
  expect(await commands.readPublishedLog(anonymous, created.value.id)).toEqual({ id: created.value.id, deleted: true });
});

test('signed cursors are bound to the account page and tampered cursors are refused', async () => {
  const session = await writeSession();
  const ids: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    now += 1000;
    ids.push((await commands.publishLog(owner, { sessionId: session.id, note: `page-${index}` }, key())).value.id);
  }
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < 3; index += 1) {
    const page = await commands.listPublishedLogs(anonymous, {
      accountId: owner.accountId,
      limit: 1,
      ...(cursor === undefined ? {} : { cursor }),
    });
    expect(page.publishedLogs).toHaveLength(1);
    seen.push(page.publishedLogs[0]!.id);
    expect(page.next).toBeString();
    cursor = page.next!;
  }
  expect(seen).toEqual([ids[2]!, ids[1]!, ids[0]!]);

  const binding = { operation: 'published_log.list', parameters: { accountId: owner.accountId } };
  const sample = (await commands.listPublishedLogs(owner, { accountId: owner.accountId, limit: 1 })).publishedLogs[0]!;
  const wrongOperation = encodeCursor(
    tokens,
    { operation: 'published_log.read', parameters: { accountId: owner.accountId } },
    { epoch: 1, after: [sample.publishedAt, sample.id] },
  );
  const foreignId = encodeCursor(tokens, binding, { epoch: 1, after: [sample.publishedAt, newId(0x3000)] });
  for (const candidate of [`${cursor}x`, wrongOperation, foreignId, 'not-a-cursor']) {
    await expect(
      commands.listPublishedLogs(anonymous, { accountId: owner.accountId, cursor: candidate }),
    ).rejects.toMatchObject({ code: 'invalid_cursor' });
  }
  await expect(commands.listPublishedLogs(anonymous, { accountId: other.accountId, cursor })).rejects.toMatchObject({
    code: 'invalid_cursor',
  });
  await expect(commands.listPublishedLogs(anonymous, { accountId: owner.accountId, limit: 0 })).rejects.toMatchObject({
    code: 'invalid_request',
  });
  await expect(commands.listPublishedLogs(anonymous, { accountId: owner.accountId, limit: 101 })).rejects.toMatchObject(
    {
      code: 'invalid_request',
    },
  );
  await expect(commands.listPublishedLogs(anonymous, { accountId: 'not-an-account' })).rejects.toBeInstanceOf(
    LibraryNotFoundError,
  );
});

test('statements per publish, retract, read and page stay equal at three scales of unrelated logs', async () => {
  const session = await writeSession();
  const samples: number[][] = [];
  let previous = 0;
  for (const scale of [1, 8, 64]) {
    now += 1000;
    await database.admin.query(
      `INSERT INTO library.published_log
         (route, log_id, account_id, session_id, subject_id, session_state, started_at, completed_at, note,
          published_at, transaction_id)
       SELECT $1, log_id, $2, log_id, $3, 'active', timestamptz '2026-10-01T00:00:00Z', NULL, NULL,
              timestamptz '2026-10-01T00:00:00Z' - (ordinal::text || ' seconds')::interval, $2
       FROM unnest($4::uuid[]) WITH ORDINALITY AS seed(log_id, ordinal)`,
      [route, owner.accountId, subjectId, Array.from({ length: scale - previous }, () => newId(route))],
    );
    const published = await measure(database, () =>
      commands.publishLog(owner, { sessionId: session.id, note: `scale-${scale}` }, key()),
    );
    const read = await measure(database, () => commands.readPublishedLog(anonymous, published.value.value.id));
    const page = await measure(database, () =>
      commands.listPublishedLogs(anonymous, { accountId: owner.accountId, limit: 1 }),
    );
    const retracted = await measure(database, () =>
      commands.retractLog(owner, published.value.value.id, key(), published.value.revision),
    );
    const countsForScale = [published, read, page, retracted].map((sample) => sample.cost.statements);
    expect(countsForScale.every((count) => Number.isInteger(count) && count > 0)).toBe(true);
    expect(read.value).toEqual(published.value.value);
    expect(page.value.publishedLogs[0]?.id).toBe(published.value.value.id);
    expect(retracted.value.value.id).toBe(published.value.value.id);
    samples.push(countsForScale);
    previous = scale;
  }
  expect(samples[1]).toEqual(samples[0]);
  expect(samples[2]).toEqual(samples[0]);
});
