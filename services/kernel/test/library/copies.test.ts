import { suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { compileCatalogue } from '@rezics/definitions/compile';
import { fixture } from '../../../../packages/definitions/test/support/library-profiles.ts';
import { Value } from 'typebox/value';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { IdempotencyConflictError } from '../../src/command/command.ts';
import { EVENT_TYPES, readBatch } from '../../src/events/log.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { LibraryNotFoundError } from '../../src/library/command-support.ts';
import { CopyConflictError, CopyInvalidError, createCopyCommands } from '../../src/library/copies.ts';
import type { Copy } from '../../src/library/entry-model.ts';
import type { AccountActor, Actor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { authenticateAccount } from '../support/admitted-access.ts';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import {
  assertGrowth,
  measure,
  openGrowthDatabase,
  type GrowthDatabase,
  type GrowthSample,
} from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const route = 0x22c0;
const updatedEvent = 'com.rezics.library.copy.updated.v1';
const deletedEvent = 'com.rezics.library.copy.deleted.v1';
const scopes = ['subject:read', 'copy:create', 'copy:update', 'copy:delete', 'copy:read', 'copy:list'];
const persona = (accountId: string, permissions = scopes): AccountActor => ({
  kind: 'account',
  accountId,
  scopes: permissions,
  clientId: 'copies-test',
  requestedBy: null,
  authnEpoch: 1,
});
let owner = persona(newId(route));
let other = persona(newId(route));
const suspended = persona(newId(route));
let noScope = persona(owner.accountId, ['subject:read']);
const anonymous: Actor = { kind: 'anonymous' };
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(61)]]) };
let native: NativeProfileFixture;
let database: GrowthDatabase;
let commands: ReturnType<typeof createCopyCommands>;
let edition: string;
let now = Date.parse('2026-10-26T12:00:00.000Z');
const clock = () => new Date(now);
const tick = () => {
  now += 1000;
};
const key = () => randomUUID();

type Counts = { copies: number; updated: number; deleted: number };

async function subject(label: string): Promise<string> {
  return native.createSubject('game', label);
}

async function snapshot(): Promise<Counts> {
  const result = await database.admin.query<Counts>(
    `SELECT
       (SELECT count(*)::int FROM library.copy) AS copies,
       (SELECT count(*)::int FROM core.outbox WHERE type = $1) AS updated,
       (SELECT count(*)::int FROM core.outbox WHERE type = $2) AS deleted`,
    [updatedEvent, deletedEvent],
  );
  return result.rows[0]!;
}

async function refusal(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('expected a refusal');
}

async function denyRead(subjectId: string): Promise<void> {
  const subjectRoute = routeOf(subjectId);
  if (subjectRoute === null) throw new Error('Test subject must have a route');
  await database.admin.query(
    `INSERT INTO access.resource_denial
       (route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
     VALUES ($1, $2, $3, '', 'subject:read', 'resource', '(,)'::tstzrange, $4)`,
    [subjectRoute, subjectId, owner.accountId, randomUUID()],
  );
}

beforeAll(async () => {
  database = await openGrowthDatabase(databaseUrl);
  native = await createProfileEntryFixture({ pool: database.pool, clock });
  const release = await compileCatalogue(
    fixture({
      id: 'fixture.baseline-holdings',
      copies: {
        kinds: [{ id: 'physical', statuses: [{ id: 'ordered' }, { id: 'owned' }, { id: 'lent' }, { id: 'disposed' }] }],
      },
    }),
  );
  await native.activate(await native.publish(release));
  for (const actor of [owner, other, suspended]) {
    await database.admin.query(
      `INSERT INTO access.account
         (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch)
       VALUES ($1, $2, 'actor', $3, $4, false, 1)`,
      [route, actor.accountId, 'active', newId(route)],
    );
    if (actor === suspended) await suspendAccount(database.admin, actor.accountId);
  }
  const access = native.access;
  const context = { pool: database.pool, deadline: deadlineFor(30_000) };
  owner = await authenticateAccount(access, context, owner);
  other = await authenticateAccount(access, context, other);
  noScope = await authenticateAccount(access, context, noScope);
  commands = createCopyCommands({ pool: database.pool, access, tokens, clock });
  edition = await subject('Owned edition');
});

afterAll(async () => {
  if (native) await native.close();
  if (database) await database.close();
});

test('an account records two private copies of one edition and changes each by revision', async () => {
  tick();
  const firstAt = clock().toISOString();
  const first = await commands.createCopy(
    owner,
    {
      subjectId: edition,
      kind: 'physical',
      status: 'owned',
      location: 'Study',
      source: 'Bookshop',
      acquiredOn: '2030-01-01',
      note: 'First copy',
    },
    key(),
  );
  tick();
  const secondAt = clock().toISOString();
  const second = await commands.createCopy(owner, { subjectId: edition, kind: 'physical', status: 'ordered' }, key());
  expect(second.value.id).not.toBe(first.value.id);
  expect(first.replayed).toBe(false);
  expect(first.partition).toBe(partitionOf(route));
  expect(routeOf(first.value.id)).toBe(route);
  expect(first.value).toMatchObject({
    accountId: owner.accountId,
    subjectId: edition,
    kind: 'physical',
    status: 'owned',
    location: 'Study',
    source: 'Bookshop',
    acquiredOn: '2030-01-01',
    disposedOn: null,
    note: 'First copy',
    revision: 1,
    createdAt: firstAt,
    updatedAt: firstAt,
  });
  expect(second.value).toMatchObject({
    accountId: owner.accountId,
    subjectId: edition,
    kind: 'physical',
    status: 'ordered',
    location: null,
    source: null,
    acquiredOn: null,
    disposedOn: null,
    note: null,
    revision: 1,
    createdAt: secondAt,
    updatedAt: secondAt,
  });
  expect(await commands.readCopy(owner, first.value.id)).toEqual(first.value);
  const stored = await database.admin.query<{ route: number; account_id: string; subject_id: string }>(
    'SELECT route, account_id, subject_id FROM library.copy WHERE copy_id = $1',
    [first.value.id],
  );
  expect(stored.rows).toEqual([{ route, account_id: owner.accountId, subject_id: edition }]);

  tick();
  const changed = await commands.updateCopy(
    owner,
    first.value.id,
    { revision: 1, status: 'lent', location: 'Friend', note: 'Loan' },
    key(),
  );
  expect(changed.value).toMatchObject({
    id: first.value.id,
    subjectId: edition,
    kind: 'physical',
    status: 'lent',
    location: 'Friend',
    source: 'Bookshop',
    acquiredOn: '2030-01-01',
    disposedOn: null,
    note: 'Loan',
    revision: 2,
    createdAt: first.value.createdAt,
    updatedAt: clock().toISOString(),
  });
  expect(await commands.readCopy(owner, second.value.id)).toEqual(second.value);
  const before = await snapshot();
  await expect(
    commands.updateCopy(owner, first.value.id, { revision: 1, status: 'disposed' }, key()),
  ).rejects.toBeInstanceOf(CopyConflictError);
  expect(await snapshot()).toEqual(before);
  expect(await commands.readCopy(owner, first.value.id)).toEqual(changed.value);

  const removed = await commands.deleteCopy(owner, first.value.id, changed.value.revision, key());
  expect(removed.value).toEqual(changed.value);
  expect(removed.replayed).toBe(false);
  await expect(commands.readCopy(owner, first.value.id)).rejects.toBeInstanceOf(LibraryNotFoundError);
  expect(await commands.readCopy(owner, second.value.id)).toEqual(second.value);
  const page = await commands.listCopies(owner, { limit: 100 });
  expect(page.copies.some((copy) => copy.id === first.value.id)).toBe(false);
  expect(page.copies.some((copy) => copy.id === second.value.id)).toBe(true);
});

test('invalid fields, unknown subjects and unreadable subjects change nothing', async () => {
  const denied = await subject('Unreadable edition');
  await denyRead(denied);
  const valid = {
    subjectId: edition,
    kind: 'physical',
    status: 'owned' as const,
    location: 'L'.repeat(200),
    source: 'S'.repeat(200),
    acquiredOn: '2024-02-29',
    disposedOn: '2024-03-01',
    note: 'n'.repeat(1000),
  };
  tick();
  const created = await commands.createCopy(owner, valid, key());
  expect(created.value).toMatchObject({
    status: 'owned',
    location: valid.location,
    source: valid.source,
    acquiredOn: '2024-02-29',
    disposedOn: '2024-03-01',
    note: valid.note,
    revision: 1,
  });
  const before = await snapshot();
  const rejected: unknown[] = [
    null,
    { status: 'owned' },
    { ...valid, status: 'Owned' },
    { ...valid, location: 'x'.repeat(201) },
    { ...valid, source: 's'.repeat(201) },
    { ...valid, note: 'n'.repeat(1001) },
    { ...valid, acquiredOn: '2030-02-29' },
    { ...valid, acquiredOn: '2030-01-01T00:00:00.000Z' },
    { ...valid, disposedOn: '2030-13-01' },
    { ...valid, disposedOn: '2030-04-31' },
    { ...valid, subjectId: 'not-a-subject' },
    { ...valid, location: 4 },
    { ...valid, extra: true },
  ];
  for (const input of rejected) {
    await expect(commands.createCopy(owner, input, key())).rejects.toBeInstanceOf(CopyInvalidError);
  }
  const beforeUnsupported = await native.inspect(owner.accountId);
  const unsupported = await refusal(() => commands.createCopy(owner, { ...valid, status: 'borrowed' }, key()));
  expect(unsupported).toBeInstanceOf(ProblemError);
  expect(unsupported).toMatchObject({ code: 'unsupported_library_profile' });
  expect(await native.inspect(owner.accountId)).toEqual(beforeUnsupported);
  await expect(
    commands.createCopy(owner, { subjectId: newId(route), kind: 'physical', status: 'owned' }, key()),
  ).rejects.toBeInstanceOf(LibraryNotFoundError);
  await expect(
    commands.createCopy(owner, { subjectId: denied, kind: 'physical', status: 'owned' }, key()),
  ).rejects.toBeInstanceOf(LibraryNotFoundError);
  await expect(
    commands.updateCopy(owner, created.value.id, { revision: 1, location: 'x'.repeat(201) }, key()),
  ).rejects.toMatchObject({ name: 'CopyInvalidError', field: 'location' });
  await expect(
    commands.updateCopy(owner, created.value.id, { revision: 0, status: 'lent' }, key()),
  ).rejects.toMatchObject({ name: 'CopyInvalidError', field: 'revision' });
  await expect(
    commands.updateCopy(owner, created.value.id, { revision: 1, subjectId: edition }, key()),
  ).rejects.toBeInstanceOf(CopyInvalidError);
  await expect(commands.deleteCopy(owner, created.value.id, 1.5, key())).rejects.toMatchObject({
    name: 'CopyInvalidError',
    field: 'revision',
  });
  expect(await snapshot()).toEqual(before);
  expect(await commands.readCopy(owner, created.value.id)).toEqual(created.value);
});

test('replays return the original copy and a reused key with a different body conflicts', async () => {
  const request = key();
  const input = { subjectId: edition, kind: 'physical', status: 'lent' as const, note: 'Shelf' };
  tick();
  const created = await commands.createCopy(owner, input, request);
  const before = await snapshot();
  expect(
    await commands.createCopy(owner, { note: 'Shelf', kind: 'physical', status: 'lent', subjectId: edition }, request),
  ).toMatchObject({
    value: created.value,
    replayed: true,
  });
  expect(await snapshot()).toEqual(before);
  await expect(commands.createCopy(owner, { ...input, note: 'Other' }, request)).rejects.toBeInstanceOf(
    IdempotencyConflictError,
  );
  expect(await commands.readCopy(owner, created.value.id)).toEqual(created.value);

  const updateKey = key();
  tick();
  const updated = await commands.updateCopy(owner, created.value.id, { revision: 1, status: 'owned' }, updateKey);
  const afterUpdate = await snapshot();
  expect(await commands.updateCopy(owner, created.value.id, { status: 'owned', revision: 1 }, updateKey)).toMatchObject(
    { value: updated.value, replayed: true },
  );
  expect(await snapshot()).toEqual(afterUpdate);
  await expect(
    commands.updateCopy(owner, created.value.id, { revision: 1, status: 'disposed' }, updateKey),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);
  expect((await commands.readCopy(owner, created.value.id)).revision).toBe(2);

  const deleteKey = key();
  const removed = await commands.deleteCopy(owner, created.value.id, 2, deleteKey);
  const afterDelete = await snapshot();
  expect(await commands.deleteCopy(owner, created.value.id, 2, deleteKey)).toMatchObject({
    value: removed.value,
    replayed: true,
  });
  expect(await snapshot()).toEqual(afterDelete);
  await expect(commands.readCopy(owner, created.value.id)).rejects.toBeInstanceOf(LibraryNotFoundError);
});

test('a stale or concurrent revision does not change the copy', async () => {
  tick();
  const created = await commands.createCopy(
    owner,
    { subjectId: edition, kind: 'physical', status: 'owned', note: 'Race' },
    key(),
  );
  const results = await Promise.allSettled([
    commands.updateCopy(owner, created.value.id, { revision: 1, note: 'A' }, key()),
    commands.updateCopy(owner, created.value.id, { revision: 1, note: 'B' }, key()),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((result) => result.status === 'rejected')).toMatchObject({
    reason: { name: 'CopyConflictError' },
  });
  const current = await commands.readCopy(owner, created.value.id);
  expect(current.revision).toBe(2);
  expect(current.note === 'A' || current.note === 'B').toBe(true);
  const before = await snapshot();
  await expect(commands.updateCopy(owner, created.value.id, { revision: 1, note: 'C' }, key())).rejects.toBeInstanceOf(
    CopyConflictError,
  );
  await expect(commands.deleteCopy(owner, created.value.id, 1, key())).rejects.toBeInstanceOf(CopyConflictError);
  expect(await snapshot()).toEqual(before);
  expect(await commands.readCopy(owner, created.value.id)).toEqual(current);

  tick();
  const touched = await commands.updateCopy(owner, created.value.id, { revision: 2 }, key());
  expect(touched.value).toMatchObject({
    note: current.note,
    status: 'owned',
    revision: 3,
    updatedAt: clock().toISOString(),
  });
  const cleared = await commands.updateCopy(
    owner,
    created.value.id,
    { revision: 3, location: null, note: null },
    key(),
  );
  expect(cleared.value.location).toBeNull();
  expect(cleared.value.note).toBeNull();
});

test('another account, anonymous and suspended personas never read or change a copy', async () => {
  tick();
  const owned = await commands.createCopy(
    owner,
    { subjectId: edition, kind: 'physical', status: 'owned', note: 'Private' },
    key(),
  );
  const before = await snapshot();
  const people: Actor[] = [anonymous, suspended, noScope];
  const errors: Error[] = [];
  for (const person of people) {
    errors.push(
      await refusal(() =>
        commands.createCopy(person, { subjectId: edition, kind: 'physical', status: 'owned' }, key()),
      ),
    );
    errors.push(await refusal(() => commands.readCopy(person, owned.value.id)));
    errors.push(await refusal(() => commands.listCopies(person)));
    errors.push(
      await refusal(() => commands.updateCopy(person, owned.value.id, { revision: 1, status: 'disposed' }, key())),
    );
    errors.push(await refusal(() => commands.deleteCopy(person, owned.value.id, 1, key())));
    errors.push(await refusal(() => commands.readCopy(person, 'malformed')));
    errors.push(await refusal(() => commands.readCopy(person, newId(route))));
  }
  expect(errors.every((error) => error instanceof GrantDeniedError)).toBe(true);
  expect(new Set(errors.map((error) => error.message)).size).toBe(1);
  expect(await snapshot()).toEqual(before);
  expect(await commands.readCopy(owner, owned.value.id)).toEqual(owned.value);

  const missing = await refusal(() => commands.readCopy(other, newId(route)));
  const foreign = await refusal(() => commands.readCopy(other, owned.value.id));
  const malformed = await refusal(() => commands.readCopy(owner, 'not-a-copy'));
  const foreignRoute = await refusal(() => commands.readCopy(owner, newId(0x3000)));
  for (const error of [missing, foreign, malformed, foreignRoute]) {
    expect(error).toBeInstanceOf(LibraryNotFoundError);
    expect(error.message).toBe(missing.message);
  }
  await expect(
    commands.updateCopy(other, owned.value.id, { revision: 1, note: 'Stolen' }, key()),
  ).rejects.toBeInstanceOf(LibraryNotFoundError);
  await expect(commands.deleteCopy(other, owned.value.id, 1, key())).rejects.toBeInstanceOf(LibraryNotFoundError);
  expect(await snapshot()).toEqual(before);

  tick();
  const theirs = await commands.createCopy(
    other,
    { subjectId: edition, kind: 'physical', status: 'lent', note: 'Other' },
    key(),
  );
  expect(theirs.value.id).not.toBe(owned.value.id);
  expect(theirs.value.accountId).toBe(other.accountId);
  expect(await commands.readCopy(other, theirs.value.id)).toEqual(theirs.value);
  await expect(commands.readCopy(owner, theirs.value.id)).rejects.toBeInstanceOf(LibraryNotFoundError);
  await expect(
    commands.updateCopy(owner, theirs.value.id, { revision: 1, note: 'Stolen' }, key()),
  ).rejects.toBeInstanceOf(LibraryNotFoundError);
  const ownerPage = await commands.listCopies(owner, { limit: 100 });
  const otherPage = await commands.listCopies(other, { limit: 100 });
  expect(ownerPage.copies.every((copy) => copy.accountId === owner.accountId)).toBe(true);
  expect(ownerPage.copies.some((copy) => copy.id === theirs.value.id)).toBe(false);
  expect(otherPage.copies.map((copy) => copy.id)).toEqual([theirs.value.id]);
  expect(await commands.readCopy(other, theirs.value.id)).toEqual(theirs.value);
});

test('signed cursors page one account and stay bound to that account', async () => {
  const trio: Copy[] = [];
  for (const note of ['Cursor A', 'Cursor B', 'Cursor C']) {
    tick();
    trio.push(
      (await commands.createCopy(owner, { subjectId: edition, kind: 'physical', status: 'owned', note }, key())).value,
    );
  }
  tick();
  const hidden = (
    await commands.createCopy(other, { subjectId: edition, kind: 'physical', status: 'owned', note: 'Hidden' }, key())
  ).value;
  const seen: string[] = [];
  let cursor: string | null = null;
  let finished = false;
  for (let pageNumber = 0; pageNumber < 200; pageNumber += 1) {
    const page = await commands.listCopies(owner, cursor === null ? { limit: 1 } : { limit: 1, cursor });
    expect(page.copies).toHaveLength(1);
    expect(page.copies[0]!.accountId).toBe(owner.accountId);
    seen.push(page.copies[0]!.id);
    if (page.next === null) {
      finished = true;
      break;
    }
    cursor = page.next;
  }
  expect(finished).toBe(true);
  expect(new Set(seen).size).toBe(seen.length);
  expect(seen.filter((id) => trio.some((copy) => copy.id === id))).toEqual(trio.map((copy) => copy.id));
  expect(seen.includes(hidden.id)).toBe(false);

  const first = await commands.listCopies(owner, { limit: 1 });
  expect(first.next).toBeString();
  const rest = await commands.listCopies(owner, { limit: 100, cursor: first.next! });
  expect(rest.copies.some((copy) => copy.id === first.copies[0]!.id)).toBe(false);
  expect(rest.copies.length + 1).toBe(seen.length);
  await expect(commands.listCopies(other, { cursor: first.next! })).rejects.toMatchObject({ code: 'invalid_cursor' });
  await expect(commands.listCopies(owner, { cursor: `${first.next!}x` })).rejects.toMatchObject({
    code: 'invalid_cursor',
  });
  for (const limit of [0, 101, -1, 1.5]) {
    await expect(commands.listCopies(owner, { limit })).rejects.toMatchObject({
      name: 'CopyInvalidError',
      field: 'limit',
    });
  }
  const wide = await commands.listCopies(owner, { limit: 100 });
  expect(wide.copies.length).toBeLessThanOrEqual(100);
  expect(wide.copies.length).toBe(seen.length);
});

test("a subject filter lists only the account's copies of that subject in creation order and keeps its cursor bound to the filter", async () => {
  const target = await subject('Filtered copy edition');
  const unrelated = await subject('Other filtered copy edition');

  tick();
  const first = (
    await commands.createCopy(owner, { subjectId: target, kind: 'physical', status: 'owned', note: 'First' }, key())
  ).value;
  tick();
  await commands.createCopy(
    owner,
    { subjectId: unrelated, kind: 'physical', status: 'owned', note: 'Unrelated' },
    key(),
  );
  tick();
  const second = (
    await commands.createCopy(owner, { subjectId: target, kind: 'physical', status: 'ordered', note: 'Second' }, key())
  ).value;
  tick();
  const otherAccount = (
    await commands.createCopy(other, { subjectId: target, kind: 'physical', status: 'owned' }, key())
  ).value;

  const firstPage = await commands.listCopies(owner, { subjectId: target, limit: 1 });
  expect(firstPage.copies.map((copy) => copy.id)).toEqual([first.id]);
  expect(firstPage.next).toBeString();
  const secondPage = await commands.listCopies(owner, { subjectId: target, limit: 1, cursor: firstPage.next! });
  expect(secondPage.copies.map((copy) => copy.id)).toEqual([second.id]);
  expect(secondPage.next).toBeNull();
  expect(secondPage.copies[0]!.createdAt > firstPage.copies[0]!.createdAt).toBe(true);
  expect(firstPage.copies.some((copy) => copy.id === otherAccount.id)).toBe(false);
  await expect(commands.listCopies(owner, { limit: 1, cursor: firstPage.next! })).rejects.toMatchObject({
    code: 'invalid_cursor',
  });
  await expect(
    commands.listCopies(owner, { subjectId: unrelated, limit: 1, cursor: firstPage.next! }),
  ).rejects.toMatchObject({
    code: 'invalid_cursor',
  });
  expect((await commands.listCopies(owner, { subjectId: newId(route), limit: 1 })).copies).toEqual([]);
});

test('events are closed, ID-only, and use the account as their subject in its partition', async () => {
  const updated = EVENT_TYPES[updatedEvent];
  const deleted = EVENT_TYPES[deletedEvent];
  expect(Value.Check(updated, { copyId: newId(route) })).toBe(true);
  expect(Value.Check(deleted, { copyId: newId(route) })).toBe(true);
  expect(Value.Check(updated, { copyId: newId(route), note: 'Shelf' })).toBe(false);
  expect(Value.Check(deleted, { copyId: newId(route), subjectId: edition })).toBe(false);
  expect(Value.Check(updated, { subjectId: edition })).toBe(false);

  tick();
  const created = await commands.createCopy(
    owner,
    { subjectId: edition, kind: 'physical', status: 'disposed', note: 'Secret' },
    key(),
  );
  tick();
  await commands.updateCopy(owner, created.value.id, { revision: 1, disposedOn: '2030-02-02' }, key());
  await commands.deleteCopy(owner, created.value.id, 2, key());
  const rows = await database.admin.query<{
    partition_no: number;
    type: string;
    subject: string;
    data: Record<string, unknown>;
  }>(
    `SELECT partition_no, type, subject, data
     FROM core.outbox
     WHERE data->>'copyId' = $1
     ORDER BY position, event_seq`,
    [created.value.id],
  );
  expect(rows.rows.map((row) => row.type)).toEqual([updatedEvent, updatedEvent, deletedEvent]);
  for (const row of rows.rows) {
    expect(row.partition_no).toBe(partitionOf(route));
    expect(row.subject).toBe(owner.accountId);
    expect(Object.keys(row.data)).toEqual(['copyId']);
    expect(JSON.stringify(row.data)).not.toContain('Secret');
  }
  const batch = await readBatch(database.pool, {
    consumer: 'copy_commands',
    partition: partitionOf(route),
    apply: async () => {},
  });
  expect(batch.status).toBe('read');
});

test('statement counts stay equal at three scales of unrelated copies', async () => {
  tick();
  const stable = (
    await commands.createCopy(owner, { subjectId: edition, kind: 'physical', status: 'owned', note: 'Stable' }, key())
  ).value;
  const scales = [1, 8, 64] as const;
  const createSamples: GrowthSample[] = [];
  const updateSamples: GrowthSample[] = [];
  const pageSamples: GrowthSample[] = [];
  let previous = 0;
  let revision = stable.revision;
  for (const scale of scales) {
    await database.admin.query(
      `INSERT INTO library.copy
         (route, copy_id, account_id, subject_id, status, location, source, acquired_on, disposed_on, note, revision,
          created_at, updated_at, transaction_id)
       SELECT $1, copy_id, $2, $3, 'owned', NULL, NULL, NULL, NULL, NULL, 1, $4, $4, $5
       FROM unnest($6::uuid[]) AS copy_id`,
      [
        route,
        other.accountId,
        edition,
        '2020-01-01T00:00:00.000Z',
        newId(route),
        Array.from({ length: scale - previous }, () => newId(route)),
      ],
    );
    const created = await measure(database, () =>
      commands.createCopy(owner, { subjectId: edition, kind: 'physical', status: 'ordered' }, key()),
    );
    const updated = await measure(database, () =>
      commands.updateCopy(owner, stable.id, { revision, note: `Scale ${scale}` }, key()),
    );
    const page = await measure(database, () => commands.listCopies(owner, { limit: 1 }));
    expect(created.value.value.accountId).toBe(owner.accountId);
    expect(created.value.replayed).toBe(false);
    expect(updated.value.value.revision).toBe(revision + 1);
    expect(page.value.copies).toHaveLength(1);
    expect(page.value.copies[0]!.accountId).toBe(owner.accountId);
    for (const sample of [created, updated, page]) {
      expect(sample.cost.statements).toBeGreaterThan(0);
      expect(sample.cost.relations?.['library.copy']?.sequentialScans ?? 0).toBe(0);
    }
    createSamples.push({ scale, cost: created.cost });
    updateSamples.push({ scale, cost: updated.cost });
    pageSamples.push({ scale, cost: page.cost });
    previous = scale;
    revision = updated.value.value.revision;
  }
  expect(createSamples.map((sample) => sample.cost.statements)).toEqual([
    createSamples[0]!.cost.statements,
    createSamples[0]!.cost.statements,
    createSamples[0]!.cost.statements,
  ]);
  expect(updateSamples.map((sample) => sample.cost.statements)).toEqual([
    updateSamples[0]!.cost.statements,
    updateSamples[0]!.cost.statements,
    updateSamples[0]!.cost.statements,
  ]);
  expect(pageSamples.map((sample) => sample.cost.statements)).toEqual([
    pageSamples[0]!.cost.statements,
    pageSamples[0]!.cost.statements,
    pageSamples[0]!.cost.statements,
  ]);
  for (const samples of [createSamples, updateSamples, pageSamples]) {
    assertGrowth(samples, { statements: 'constant', rows: 'constant', blocks: 'logarithmic' });
  }
}, 120_000);

test('subject-filtered copy page keeps statement counts equal at three scales of unrelated copies', async () => {
  const target = await subject('Copy page growth target');
  const stable = (await commands.createCopy(owner, { subjectId: target, kind: 'physical', status: 'owned' }, key()))
    .value;
  const scales = [1, 8, 64] as const;
  const samples: GrowthSample[] = [];
  let previous = 0;
  for (const scale of scales) {
    const added = scale - previous;
    await database.admin.query(
      `WITH noise AS (
         SELECT copy_id, $2::uuid AS account_id, subject_id
         FROM unnest($7::uuid[], $8::uuid[]) AS own(copy_id, subject_id)
         UNION ALL
         SELECT copy_id, $3::uuid AS account_id, $4::uuid AS subject_id
         FROM unnest($9::uuid[]) AS others(copy_id)
       )
       INSERT INTO library.copy
         (route, copy_id, account_id, subject_id, status, location, source, acquired_on, disposed_on, note, revision,
          created_at, updated_at, transaction_id)
       SELECT $1, copy_id, account_id, subject_id, 'owned', NULL, NULL, NULL, NULL, NULL, 1, $5, $5, $6
       FROM noise`,
      [
        route,
        owner.accountId,
        other.accountId,
        target,
        '2020-01-01T00:00:00.000Z',
        newId(route),
        Array.from({ length: added }, () => newId(route)),
        Array.from({ length: added }, () => newId(route)),
        Array.from({ length: added }, () => newId(route)),
      ],
    );
    const page = await measure(database, () => commands.listCopies(owner, { subjectId: target, limit: 1 }));
    expect(page.value.copies).toHaveLength(1);
    expect(page.value.copies[0]!.id).toBe(stable.id);
    expect(page.cost.statements).toBeGreaterThan(0);
    expect(page.cost.relations?.['library.copy']?.sequentialScans ?? 0).toBe(0);
    samples.push({ scale, cost: page.cost });
    previous = scale;
  }
  expect(samples.map((sample) => sample.cost.statements)).toEqual([
    samples[0]!.cost.statements,
    samples[0]!.cost.statements,
    samples[0]!.cost.statements,
  ]);
  assertGrowth(samples, { statements: 'constant', rows: 'constant', blocks: 'logarithmic' });
}, 120_000);
