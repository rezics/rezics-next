import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import pg from 'pg';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

// Generic native ordering proof using the compiled accepted fixture profile. This is not the
// bundled first-public journey, canonical winner/conflicts, cursor or epoch publication proof.
// Those need Semantic's native mapping/participants and the common members implementation.
let f: NativeProfileFixture;
let kernelT = Date.now();
const clock = () => new Date(kernelT);
const windowMs = 720 * 60 * 60 * 1000;
const reader = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  options: '-c default_transaction_read_only=on',
});
beforeAll(async () => {
  f = await createProfileEntryFixture({ clock });
}, 120_000);
beforeEach(async () => {
  kernelT = Date.now();
  await f.activate(f.originalDigest);
});
afterAll(async () => {
  await f?.close();
  await reader.end();
});

type Row = Record<string, unknown>;
type Entry = Row & { subjectId: string; state: string; revision: number; incarnationId?: string };
type Descriptor = { deletionId: string; revision: number };
const path = (subjectId: string) => `/v1/libraryEntries/${subjectId}`;
const ownerId = () => f.owner.actor.accountId;
function privateFree(value: unknown) {
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    expect(['owner_write_seq', 'ownerWriteSeq', 'seq', 'library_profile_pin', 'libraryProfilePin']).not.toContain(key);
    privateFree(child);
  }
}
async function body(response: Response, status: number): Promise<Row> {
  const json = await response.json();
  expect({ status: response.status, body: json }).toEqual({ status, body: expect.any(Object) });
  privateFree(json);
  return json;
}
async function problem(response: Response, status: number, code: string) {
  expect(await body(response, status)).toMatchObject({ code, effect_status: 'not_applied' });
}
async function put(subjectId: string, input: Row, key = entryKey(), persona = 'owner', status = 201) {
  const response = await f.send(persona, 'PUT', path(subjectId), input, key);
  const json = await body(response, status);
  const entry = json.libraryEntry as Entry;
  expect(entry).toMatchObject({ subjectId, state: input.state });
  return { entry, json, key };
}
function cas(entry: Entry) {
  // Omission is allowed only for an old receipt. Do not manufacture an incarnation.
  return {
    revision: entry.revision,
    ...(entry.incarnationId === undefined ? {} : { incarnationId: entry.incarnationId }),
  };
}
async function create(persona = 'owner', state = 'planned') {
  const subjectId = await f.createSubject('game');
  return { subjectId, ...(await put(subjectId, { state }, entryKey(), persona)) };
}
async function clear(entry: Entry, key = entryKey(), persona = 'owner') {
  const query = new URLSearchParams(Object.entries(cas(entry)).map(([k, v]) => [k, String(v)]));
  const response = await f.send(persona, 'DELETE', `${path(entry.subjectId)}?${query}`, undefined, key);
  expect(response.status).toBe(204);
  expect(await response.text()).toBe('');
  const deletionId = response.headers.get('Library-Entry-Deletion-Id');
  const revision = response.headers.get('Library-Entry-Deletion-Revision');
  expect(deletionId, '204 must return the original native deletion locator').toMatch(/^[0-9a-f-]{36}$/);
  expect(revision).toBe(String(entry.revision + 1));
  return { d: { deletionId: deletionId!, revision: Number(revision) }, key };
}
async function undo(subjectId: string, d: Descriptor, key = entryKey(), persona = 'owner') {
  return f.send(persona, 'POST', `${path(subjectId)}:restore`, d, key);
}
async function live(subjectId: string, accountId = ownerId()): Promise<Row[]> {
  // Explicit cast before JSON decoding preserves the complete native bigint, with no zero fallback.
  return (
    await reader.query<{ row: Row }>(
      `SELECT to_jsonb(e) || jsonb_build_object('owner_write_seq', e.owner_write_seq::text,
        'type_source_position', e.type_source_position::text) AS row
       FROM library.entry e WHERE route=$1 AND account_id=$2 AND subject_id=$3`,
      [routeOf(accountId), accountId, subjectId],
    )
  ).rows.map(({ row }) => row);
}
async function archive(d: Descriptor, accountId = ownerId()): Promise<Row[]> {
  return (
    await reader.query<{ row: Row }>(
      `SELECT to_jsonb(e) || jsonb_build_object('owner_write_seq', e.owner_write_seq::text,
        'type_source_position', e.type_source_position::text) AS row
       FROM library.entry_deleted e WHERE route=$1 AND account_id=$2 AND deletion_id=$3`,
      [routeOf(accountId), accountId, d.deletionId],
    )
  ).rows.map(({ row }) => row);
}
async function one(subjectId: string, accountId = ownerId()) {
  const rows = await live(subjectId, accountId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}
function sequence(row: Row) {
  expect(row.owner_write_seq).toEqual(expect.any(String));
  expect(row.owner_write_seq as string).toMatch(/^[1-9][0-9]*$/);
  return BigInt(row.owner_write_seq as string);
}
async function counterTable() {
  // The adopted rule fixes seq/owner keys, not the relation's spelling. Discover the actual
  // migrated table, requiring one authority; never depend on an unlanded allocator module.
  const found = await reader.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns WHERE table_schema='library'
     GROUP BY table_name HAVING bool_or(column_name='seq' AND udt_name='int8' AND is_nullable='NO')
       AND bool_or(column_name='route') AND bool_or(column_name='account_id')`,
  );
  expect(found.rows, 'one actual native bigint owner counter table must exist').toHaveLength(1);
  return pg.escapeIdentifier(found.rows[0]!.table_name);
}
async function counter(accountId = ownerId()) {
  const table = await counterTable();
  const result = await reader.query<{ seq: string }>(
    `SELECT seq::text AS seq FROM library.${table} WHERE route=$1 AND account_id=$2`,
    [routeOf(accountId), accountId],
  );
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]!.seq).toMatch(/^[1-9][0-9]*$/);
  return BigInt(result.rows[0]!.seq);
}
async function observed(subjectId: string, ds: Descriptor[] = [], accountId = ownerId()) {
  return {
    counter: await counter(accountId),
    live: await live(subjectId, accountId),
    archives: await Promise.all(ds.map((d) => archive(d, accountId))),
    native: await f.inspect(accountId),
  };
}
async function committed(key: string, subjectId: string, eventType: string, accountId = ownerId()) {
  const partition = partitionOf(routeOf(accountId)!);
  const receipts = await reader.query<{ row: Row; position: string }>(
    `SELECT to_jsonb(r) AS row, position::text AS position FROM core.receipt r
     WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2 AND idempotency_key=$3`,
    [partition, accountId, key],
  );
  expect(receipts.rows).toHaveLength(1);
  const receipt = receipts.rows[0]!;
  const events = await reader.query<{ row: Row }>(
    `SELECT to_jsonb(e) AS row FROM core.outbox e WHERE partition_no=$1 AND position=$2 ORDER BY event_seq`,
    [partition, receipt.position],
  );
  expect(events.rows.map(({ row }) => ({ type: row.type, subject: row.subject, data: row.data }))).toEqual([
    { type: eventType, subject: accountId, data: { subjectId } },
  ]);
  privateFree(events.rows.map(({ row }) => row.data));
  return receipt.row;
}
const updated = 'com.rezics.library.entry.updated.v1';
const deleted = 'com.rezics.library.entry.deleted.v1';

// Inspect the database actually migrated by the native check. A missing column is a real red
// requirement; there is no substitute driver, test allocator, source INSERT or fabricated grant.
test('native owner ordering schema stores private bigint sequences on live and retained entries', async () => {
  const result = await reader.query(
    `SELECT table_name, udt_name FROM information_schema.columns
     WHERE table_schema='library' AND table_name IN ('entry','entry_deleted') AND column_name='owner_write_seq'
     ORDER BY table_name`,
  );
  expect(result.rows).toEqual([
    { table_name: 'entry', udt_name: 'int8' },
    { table_name: 'entry_deleted', udt_name: 'int8' },
  ]);
  await counterTable();
});

test('native equal-kernelT state sets on different own subjects allocate increasing positive bigint owner order', async () => {
  const a = await create();
  const b = await create();
  expect(a.entry.revision).toBe(1);
  expect(b.entry.revision).toBe(1);
  expect(a.entry.updatedAt).toBe(clock().toISOString());
  expect(b.entry.updatedAt).toBe(a.entry.updatedAt);
  const ra = await committed(a.key, a.subjectId, updated);
  const rb = await committed(b.key, b.subjectId, updated);
  expect(ra.transaction_id).not.toBe(rb.transaction_id);
  const sa = sequence(await one(a.subjectId));
  const sb = sequence(await one(b.subjectId));
  expect(sb).toBe(sa + 1n);
  expect(await counter()).toBe(sb);
  // Equal state and equal domain time still represent separate successful writes.
  const changed = await put(a.subjectId, { state: 'planned', ...cas(a.entry) }, entryKey(), 'owner', 200);
  const changedRow = await one(a.subjectId);
  expect(sequence(changedRow)).toBe(sb + 1n);
  expect(await counter()).toBe(sb + 1n);
  expect(changedRow.updated_at).toEqual((await one(b.subjectId)).updated_at);
  await committed(changed.key, a.subjectId, updated);
});

test('native separate owners have independent counters at identical kernelT', async () => {
  const a = await create();
  const beforeOwner = await counter();
  const beforeOther = await reader.query(
    `SELECT seq::text FROM library.${await counterTable()} WHERE route=$1 AND account_id=$2`,
    [routeOf(f.other.actor.accountId), f.other.actor.accountId],
  );
  expect(beforeOther.rows).toEqual([]);
  // GET must not initialize an absent owner's counter.
  await problem(await f.send('other', 'GET', path(a.subjectId)), 404, 'not_found');
  expect(
    (
      await reader.query(`SELECT seq::text FROM library.${await counterTable()} WHERE route=$1 AND account_id=$2`, [
        routeOf(f.other.actor.accountId),
        f.other.actor.accountId,
      ])
    ).rows,
  ).toEqual([]);
  const b = await put(a.subjectId, { state: 'planned' }, entryKey(), 'other');
  expect(sequence(await one(a.subjectId, f.other.actor.accountId))).toBe(1n);
  expect(await counter(f.other.actor.accountId)).toBe(1n);
  expect(await counter()).toBe(beforeOwner);
  await committed(b.key, a.subjectId, updated, f.other.actor.accountId);
});

test('native authorized identical receipt replay skips the state body and counter while changed input conflicts', async () => {
  const a = await create();
  const first = await committed(a.key, a.subjectId, updated);
  const changed = await put(a.subjectId, { state: 'completed', ...cas(a.entry) }, entryKey(), 'owner', 200);
  const before = await observed(a.subjectId);
  // A body rerun would collide with the occupied slot or overwrite this later value.
  const replay = await put(a.subjectId, { state: 'planned' }, a.key);
  expect(replay.json).toEqual(a.json);
  expect(await committed(a.key, a.subjectId, updated)).toEqual(first);
  expect(await observed(a.subjectId)).toEqual(before);
  expect((await one(a.subjectId)).state).toBe(changed.entry.state);
  await problem(
    await f.send('owner', 'PUT', path(a.subjectId), { state: 'paused' }, a.key),
    422,
    'idempotency_conflict',
  );
  expect(await observed(a.subjectId)).toEqual(before);
});

test('native physical clear advances the owner counter and archives original sequence without a live tombstone', async () => {
  const a = await create();
  const source = await one(a.subjectId);
  const beforeClear = await counter();
  const deletion = await clear(a.entry);
  const receipt = await committed(deletion.key, a.subjectId, deleted);
  expect(receipt.transaction_id).toBe(deletion.d.deletionId);
  const rows = await archive(deletion.d);
  expect(rows).toHaveLength(1);
  const saved = rows[0]!;
  for (const key of Object.keys(source)) expect(saved[key], key).toEqual(source[key]);
  expect(sequence(saved)).toBe(sequence(source));
  expect(saved.subject_id).toBe(a.subjectId);
  expect(saved.revision).toBe(a.entry.revision);
  expect(saved.deleted_revision).toBe(deletion.d.revision);
  expect(Date.parse(String(saved.deleted_at))).toBe(kernelT);
  expect(Date.parse(String(saved.restore_until)) - kernelT).toBe(windowMs);
  expect(await counter()).toBe(beforeClear + 1n);
  expect(await live(a.subjectId)).toEqual([]);
  await problem(await f.send('owner', 'GET', path(a.subjectId)), 404, 'not_found');
  const before = await observed(a.subjectId, [deletion.d]);
  expect(await clear(a.entry, deletion.key)).toEqual(deletion);
  expect(await observed(a.subjectId, [deletion.d])).toEqual(before);
});

test('native exact restore Undo preserves accepted pin dates subject and incarnation but obtains a higher new sequence', async () => {
  const a = await create();
  const source = await one(a.subjectId);
  expect(source.library_profile_pin).toEqual({
    provenance: 'profile',
    releaseDigest: f.originalDigest,
    acceptingType: 'ex:Child',
    profileId: 'fixture.game',
  });
  expect(source.incarnation_id).toEqual(expect.any(String));
  const deletion = await clear(a.entry);
  const saved = (await archive(deletion.d))[0]!;
  for (const key of Object.keys(source)) expect(saved[key], key).toEqual(source[key]);
  const clearedOrder = await counter();
  await f.activate(f.replacementDigest);
  const restoreKey = entryKey();
  const restored = await body(await undo(a.subjectId, deletion.d, restoreKey), 200);
  const receipt = await committed(restoreKey, a.subjectId, updated);
  const current = await one(a.subjectId);
  for (const key of Object.keys(source).filter(
    (key) => !['owner_write_seq', 'revision', 'transaction_id'].includes(key),
  )) {
    expect(current[key], key).toEqual(source[key]);
  }
  expect(current.revision).toBe(a.entry.revision + 2);
  expect(current.transaction_id).toBe(receipt.transaction_id);
  expect(current.transaction_id).not.toBe(source.transaction_id);
  expect(sequence(current)).toBe(clearedOrder + 1n);
  expect(sequence(current)).toBeGreaterThan(sequence(source));
  expect(await counter()).toBe(sequence(current));
  expect(await archive(deletion.d)).toEqual([]);
  const before = await observed(a.subjectId, [deletion.d]);
  expect(await body(await undo(a.subjectId, deletion.d, restoreKey), 200)).toEqual(restored);
  expect(await clear(a.entry, deletion.key)).toEqual(deletion);
  expect(await observed(a.subjectId, [deletion.d])).toEqual(before);
});

test('native failed stale state CAS cannot advance committed owner order receipt or state', async () => {
  const a = await create();
  await put(a.subjectId, { state: 'completed', ...cas(a.entry) }, entryKey(), 'owner', 200);
  const before = await observed(a.subjectId);
  await problem(await f.send('owner', 'PUT', path(a.subjectId), { state: 'paused', ...cas(a.entry) }), 409, 'conflict');
  expect(await observed(a.subjectId)).toEqual(before);
});

test('native denied fresh state and exact state receipt replay cannot advance committed owner order', async () => {
  const writer = await f.identity(['subject:read', 'library_entry:read', 'library_entry:update']);
  const a = await create(writer.bearer);
  await f.revokeIdentity(writer.actor.accountId);
  const before = await observed(a.subjectId, [], writer.actor.accountId);
  for (const key of [entryKey(), a.key]) {
    await problem(await f.send(writer.bearer, 'PUT', path(a.subjectId), { state: 'planned' }, key), 403, 'forbidden');
    expect(await observed(a.subjectId, [], writer.actor.accountId)).toEqual(before);
  }
});

test('native current account fence denies exact state clear and Undo receipts without advancing committed owner order', async () => {
  const writer = await f.identity([
    'subject:read',
    'library_entry:read',
    'library_entry:update',
    'library_entry:delete',
  ]);
  const a = await create(writer.bearer);
  const deletion = await clear(a.entry, entryKey(), writer.bearer);
  const restoreKey = entryKey();
  await body(await undo(a.subjectId, deletion.d, restoreKey, writer.bearer), 200);
  await f.revokeIdentity(writer.actor.accountId);
  const before = await observed(a.subjectId, [deletion.d], writer.actor.accountId);
  // All use the original wall-valid bearer, never refreshed to bypass current admission.
  await problem(await f.send(writer.bearer, 'PUT', path(a.subjectId), { state: 'planned' }, a.key), 403, 'forbidden');
  const query = new URLSearchParams(Object.entries(cas(a.entry)).map(([k, v]) => [k, String(v)]));
  await problem(
    await f.send(writer.bearer, 'DELETE', `${path(a.subjectId)}?${query}`, undefined, deletion.key),
    403,
    'forbidden',
  );
  await problem(await undo(a.subjectId, deletion.d, restoreKey, writer.bearer), 403, 'forbidden');
  expect(await observed(a.subjectId, [deletion.d], writer.actor.accountId)).toEqual(before);
});

test('native stale exact restore preserves archive counter receipts and empty state', async () => {
  const a = await create();
  const deletion = await clear(a.entry);
  const empty = await observed(a.subjectId, [deletion.d]);
  await problem(await undo(a.subjectId, { ...deletion.d, revision: deletion.d.revision + 1 }), 409, 'conflict');
  expect(await observed(a.subjectId, [deletion.d])).toEqual(empty);
});

test('native occupied exact restore preserves archive counter receipts and replacement state', async () => {
  const a = await create();
  const deletion = await clear(a.entry);
  const retained = await archive(deletion.d);
  const replacement = await put(a.subjectId, { state: 'completed' });
  const before = await observed(a.subjectId, [deletion.d]);
  await problem(await undo(a.subjectId, deletion.d), 409, 'conflict');
  expect(await observed(a.subjectId, [deletion.d])).toEqual(before);
  expect((await one(a.subjectId)).state).toBe(replacement.entry.state);
  expect(before.archives).toEqual([retained]);
});

test('native strict original 720h restore boundary with unchanged wall-valid actor never reorders expired state', async () => {
  const a = await create();
  const b = await create();
  const deletedAt = kernelT;
  const da = await clear(a.entry);
  const db = await clear(b.entry);
  const original = await archive(db.d);
  const afterClears = await counter();
  kernelT = deletedAt + windowMs - 1;
  const key = entryKey();
  const restored = await body(await undo(a.subjectId, da.d, key), 200);
  expect(sequence(await one(a.subjectId))).toBe(afterClears + 1n);
  kernelT = deletedAt + windowMs;
  expect(await archive(db.d)).toEqual(original);
  expect(Date.parse(String(original[0]!.restore_until))).toBe(kernelT);
  const before = await observed(b.subjectId, [db.d]);
  await problem(await undo(b.subjectId, db.d), 409, 'conflict');
  expect(await observed(b.subjectId, [db.d])).toEqual(before);
  const replayBefore = await observed(a.subjectId, [da.d]);
  expect(await body(await undo(a.subjectId, da.d, key), 200)).toEqual(restored);
  expect(await observed(a.subjectId, [da.d])).toEqual(replayBefore);
});

// Explicitly unproved native boundaries, not synthetic passing/skip/todo tests:
// - createEntryCommands/personalLibraryRoutes expose no fault injection after a native state
//   writer and before receipt/outbox commit. Forced rollback still needs that production seam.
// - entry-due-store exports storage CAS only; no authorized durable-work producer registers
//   retained-entry due purge in the worker. Calling its SQL from this test would invent that work.
// - There is no native owner state derived-order repair producer. Canonical epoch repair must
//   arrive with Semantic's mapping/participants/common members, never a test-side winner engine.
// These later producers must prove they allocate nothing, including no-op paths: branded
// noEffect does not excuse a committed counter mutation. Native operation cost counters and
// full 64/512/4096 canonical/filter growth proof remain separate from these indexed row checks.
