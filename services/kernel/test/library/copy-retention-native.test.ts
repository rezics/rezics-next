import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { compileCatalogue } from '@rezics/definitions/compile';
import { fixture, libraryLabels } from '../../../../packages/definitions/test/support/library-profiles.ts';
import { createLifecycleCommands } from '../../src/access/lifecycle.ts';
import { createCopyCommands } from '../../src/library/copies.ts';
import { purgeAccountFactsPage } from '../../src/library/account-fact-purge.ts';
import type { DueCopy } from '../../src/library/copy-retention.ts';
import { authenticateAccount } from '../support/admitted-access.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { copyRetentionRuntime } from './support/copy-retention-runtime.ts';

const scopes = [
  'subject:read',
  'copy:create',
  'copy:update',
  'copy:delete',
  'copy:read',
  'copy:list',
  'account:delete',
];
let now = Date.now();
let f: NativeProfileFixture;
let reader: pg.Pool;
let originalDigest: string;
let owner: Awaited<ReturnType<NativeProfileFixture['identity']>>;
let commands: ReturnType<typeof createCopyCommands>;
let runtime: Awaited<ReturnType<typeof copyRetentionRuntime>> | undefined;
const clock = () => new Date(now);

beforeAll(async () => {
  f = await createProfileEntryFixture({ clock });
  owner = await f.identity(scopes, 4095);
  commands = createCopyCommands({ pool: f.pool, access: f.access, tokens: f.tokens, clock });
  reader = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    options: '-c default_transaction_read_only=on',
  });
  const profile = {
    id: 'fixture.copy-retention-native',
    copies: { kinds: [{ id: 'installation', statuses: [{ id: 'licensed' }] }] },
  };
  const input = fixture(profile);
  const schema = JSON.parse(input.schemas['fixture.yaml']!);
  schema.classes.Record = { class_uri: 'ex:Record', annotations: { library: profile } };
  input.schemas['fixture.yaml'] = JSON.stringify(schema);
  for (const [key, text] of Object.entries(input.presentation)) {
    const labels = JSON.parse(text);
    labels.types['ex:Record'] = 'record';
    labels.libraryProfiles[profile.id] = libraryLabels(
      profile,
      key.split('/')[1] as Parameters<typeof libraryLabels>[1],
    );
    input.presentation[key] = JSON.stringify(labels);
  }
  originalDigest = await f.publish(await compileCatalogue(input));
  await f.activate(originalDigest);
  const rollback = await made();
  const beforeRollback = await f.inspect(owner.actor.accountId);
  await f.pool.query(`CREATE FUNCTION library.reject_copy_retention_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fixture copy retention rollback'; END $$;
    CREATE TRIGGER reject_copy_retention_fixture BEFORE UPDATE ON library.copy FOR EACH ROW
    WHEN (NEW.copy_id='${rollback.value.id}'::uuid) EXECUTE FUNCTION library.reject_copy_retention_fixture()`);
  try {
    await expect(clear(rollback)).rejects.toThrow('fixture copy retention rollback');
    expect(await f.inspect(owner.actor.accountId)).toEqual(beforeRollback);
  } finally {
    await f.pool.query(
      'DROP TRIGGER reject_copy_retention_fixture ON library.copy; DROP FUNCTION library.reject_copy_retention_fixture()',
    );
  }
}, 120_000);
afterAll(async () => {
  await runtime?.close();
  await reader?.end();
  await f?.close();
});

async function made(person = owner, vertical: 'game' | 'record' = 'game') {
  person.actor = await authenticateAccount(f.access, { pool: f.pool, deadline: deadlineFor(30_000) }, person.actor);
  const subjectId = await f.createSubject(vertical);
  return commands.createCopy(
    person.actor,
    {
      subjectId,
      kind: 'installation',
      status: 'licensed',
      note: 'private original',
      source: 'original shop',
      acquiredOn: '2020-02-29',
      location: 'original shelf',
    },
    entryKey(),
  );
}
async function row(id: string) {
  return (
    await reader.query('SELECT to_jsonb(c) AS value FROM library.copy c WHERE route=$1 AND copy_id=$2', [
      routeOf(id),
      id,
    ])
  ).rows[0]?.value;
}
async function head() {
  return (
    await reader.query('SELECT generation::text FROM library.fact_source_head WHERE route=$1 AND account_id=$2', [
      routeOf(owner.actor.accountId),
      owner.actor.accountId,
    ])
  ).rows[0]?.generation;
}
async function due(id: string): Promise<DueCopy> {
  const result = await reader.query(
    `SELECT route,copy_id AS "copyId",account_id AS "accountId",deletion_id AS "deletionId",revision,
    restore_until::text AS "restoreUntil" FROM library.copy WHERE route=$1 AND copy_id=$2`,
    [routeOf(id), id],
  );
  return result.rows[0];
}
async function clear(copy: Awaited<ReturnType<typeof made>>, key = entryKey()) {
  owner.actor = await authenticateAccount(f.access, { pool: f.pool, deadline: deadlineFor(30_000) }, owner.actor);
  const deleted = await commands.deleteCopy(owner.actor, copy.value.id, copy.value.revision, key);
  return { deleted, body: { deletionId: deleted.transactionId, revision: copy.value.revision + 1 }, key };
}
async function restore(id: string, body: { deletionId: string; revision: number }, key = entryKey()) {
  owner.actor = await authenticateAccount(f.access, { pool: f.pool, deadline: deadlineFor(30_000) }, owner.actor);
  return commands.restoreCopy(owner.actor, id, body, key);
}

test('native exact copies retain original pins/times, suppress live facts, and replay only under current authorization', async () => {
  const copy = await made();
  const sibling = await commands.createCopy(
    owner.actor,
    { subjectId: copy.value.subjectId, kind: 'installation', status: 'licensed' },
    entryKey(),
  );
  const before = await row(copy.value.id),
    liveSibling = await row(sibling.value.id),
    generation = BigInt(await head());
  const d1 = await clear(copy);
  expect(BigInt(await head())).toBe(generation + 1n);
  expect(await row(copy.value.id)).toMatchObject({
    subject_id: before.subject_id,
    library_profile_pin: before.library_profile_pin,
    revision: before.revision + 1,
    deletion_id: d1.body.deletionId,
    note: before.note,
  });
  expect(await row(sibling.value.id)).toEqual(liveSibling);
  await expect(commands.readCopy(owner.actor, copy.value.id)).rejects.toMatchObject({ name: 'LibraryNotFoundError' });
  expect(
    (await commands.listCopies(owner.actor, { subjectId: copy.value.subjectId })).copies.map((copy) => copy.id),
  ).toEqual([sibling.value.id]);
  expect((await f.send(owner.bearer, 'GET', `/v1/copies/${copy.value.id}`)).status).toBe(404);
  const path = `/v1/copies/${copy.value.id}:restore`;
  const other = await f.identity(scopes);
  const unscoped = await f.identity(['subject:read']);
  for (const [bearer, status] of [
    [other.bearer, 404],
    [unscoped.bearer, 403],
    ['', 401],
  ] as const) {
    const response = await f.send(bearer, 'POST', path, d1.body);
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain('private original');
  }
  for (const body of [{ ...d1.body, note: 'smuggle' }, { revision: d1.body.revision }, { ...d1.body, revision: '2' }])
    expect((await f.send(owner.bearer, 'POST', path, body)).status).toBe(422);
  await expect(restore(copy.value.id, { ...d1.body, deletionId: entryKey() })).rejects.toMatchObject({
    code: 'copy_restore_stale',
  });
  // The active profile retires the accepted kind; clear and Undo still use the immutable original pin.
  await f.activate(f.replacementDigest);
  const undoKey = entryKey();
  const undo = await restore(copy.value.id, d1.body, undoKey);
  expect(undo.value).toMatchObject({
    ...copy.value,
    revision: d1.body.revision + 1,
    transactionId: undo.transactionId,
  });
  expect(await row(copy.value.id)).toMatchObject({
    library_profile_pin: before.library_profile_pin,
    created_at: before.created_at,
    updated_at: before.updated_at,
    deletion_id: null,
  });
  await expect(restore(copy.value.id, d1.body)).rejects.toMatchObject({ code: 'copy_restore_occupied' });
  const d3 = await clear(undo);
  const hidden = await f.send('steward', 'POST', `/v1/subjects/${copy.value.subjectId}:hide`, {
    reason: 'retention source controls',
  });
  expect(hidden.status).toBe(200);
  const snapshot = await f.inspect(owner.actor.accountId);
  await expect(restore(copy.value.id, d3.body)).rejects.toMatchObject({ name: 'LibraryNotFoundError' });
  expect(await commands.deleteCopy(owner.actor, copy.value.id, copy.value.revision, d1.key)).toEqual({
    ...d1.deleted,
    replayed: true,
  });
  expect(await restore(copy.value.id, d1.body, undoKey)).toEqual({ ...undo, replayed: true });
  expect(await f.inspect(owner.actor.accountId)).toEqual(snapshot);
  // Old bearers and retained native Actors lose replay authority on real revocation/suspension.
  const revoked = await f.identity(scopes),
    suspended = await f.identity(scopes);
  await f.activate(originalDigest);
  for (const person of [revoked, suspended]) {
    const item = await made(person);
    const key = entryKey();
    await commands.deleteCopy(person.actor, item.value.id, item.value.revision, key);
    if (person === revoked) await f.revokeIdentity(person.actor.accountId);
    else await f.suspend(person.actor.accountId);
    await expect(commands.deleteCopy(person.actor, item.value.id, item.value.revision, key)).rejects.toBeInstanceOf(
      Error,
    );
    expect(
      (await f.send(person.bearer, 'DELETE', `/v1/copies/${item.value.id}?revision=1`, undefined, key)).status,
    ).toBe(401);
  }
  const absent = await made(owner, 'record');
  await f.activate(f.replacementDigest); // Record now has no Library profile at all.
  const absentDelete = await clear(absent);
  expect((await restore(absent.value.id, absentDelete.body)).value.id).toBe(absent.value.id);
  expect((await f.send(owner.bearer, 'DELETE', `/v1/copies/${absent.value.id}`)).status).toBe(409);
  await f.activate(originalDigest);
  const rollback = await made();
  const beforeRollback = await f.inspect(owner.actor.accountId);
  await f.pool.query(`CREATE FUNCTION library.reject_copy_retention_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fixture copy retention rollback'; END $$;
    CREATE TRIGGER reject_copy_retention_fixture BEFORE UPDATE ON library.copy FOR EACH ROW
    WHEN (NEW.copy_id='${rollback.value.id}'::uuid) EXECUTE FUNCTION library.reject_copy_retention_fixture()`);
  try {
    await expect(clear(rollback)).rejects.toThrow('fixture copy retention rollback');
    expect(await f.inspect(owner.actor.accountId)).toEqual(beforeRollback);
  } finally {
    await f.pool.query(
      'DROP TRIGGER reject_copy_retention_fixture ON library.copy; DROP FUNCTION library.reject_copy_retention_fixture()',
    );
  }
}, 120_000);

test('strict original expiry and native exact due purge survive parked stale episodes crash replay and terminal account fences', async () => {
  const copy = await made(),
    sibling = await commands.createCopy(
      owner.actor,
      { subjectId: copy.value.subjectId, kind: 'installation', status: 'licensed', note: 'living sibling' },
      entryKey(),
    );
  const siblingRow = await row(sibling.value.id);
  const d1 = await clear(copy),
    key1 = await due(copy.value.id);
  runtime = await copyRetentionRuntime(now);
  // An exact work locator is durable before it is due. Native cutoff still rejects early cleanup.
  expect(await runtime.call('purge', { key: key1, workflowId: entryKey() })).toBeUndefined();
  expect(await row(copy.value.id)).toHaveProperty('note', 'private original');
  await runtime.call('park', { copyId: copy.value.id, phase: 'before' });
  const parked = runtime.call('purge', { key: key1, workflowId: entryKey() });
  await runtime.until('parked');
  now += 1000;
  const undo = await restore(copy.value.id, d1.body);
  const d3 = await clear(undo),
    key3 = await due(copy.value.id);
  now = Date.parse(key1.restoreUntil);
  await runtime.call('time', { time: now });
  await runtime.call('release');
  await parked;
  expect(await row(copy.value.id)).toMatchObject({ deletion_id: d3.body.deletionId, note: 'private original' });
  // One millisecond before the original D3 boundary is restorable; at the boundary it is expired.
  now = Date.parse(key3.restoreUntil) - 1;
  const justBefore = await restore(copy.value.id, d3.body);
  const d5 = await clear(justBefore),
    key5 = await due(copy.value.id);
  now = Date.parse(key5.restoreUntil);
  await runtime.call('time', { time: now });
  await runtime.call('park', { copyId: copy.value.id, phase: 'before' });
  const boundary = runtime.call('purge', { key: key5, workflowId: entryKey() });
  await runtime.until('parked');
  await expect(restore(copy.value.id, d5.body)).rejects.toMatchObject({ code: 'copy_restore_expired' });
  expect(Date.parse((await row(copy.value.id)).restore_until)).toBe(now);
  const generation = await head();
  await runtime.call('release');
  await boundary;
  expect(await row(copy.value.id)).toBeUndefined();
  expect(await head()).toBe(generation);
  expect(await row(sibling.value.id)).toEqual(siblingRow);
  // Commit succeeds, but the process dies before the SDK can persist that step result.
  const crashCopy = await made(),
    crashDelete = await clear(crashCopy),
    crashKey = await due(crashCopy.value.id);
  now = Date.parse(crashKey.restoreUntil);
  await runtime.call('time', { time: now });
  await runtime.call('park', { copyId: crashCopy.value.id, phase: 'committed' });
  const workflowId = entryKey(),
    executor = runtime.executor;
  const crashed = runtime.call('purge', { key: crashKey, workflowId }).catch(() => undefined);
  await runtime.until('committed');
  expect(await row(crashCopy.value.id)).toBeUndefined();
  const afterCommit = await f.inspect(owner.actor.accountId);
  await runtime.crash();
  runtime = undefined;
  await crashed;
  runtime = await copyRetentionRuntime(now, executor);
  await runtime.call('purge', { key: crashKey, workflowId });
  expect(await f.inspect(owner.actor.accountId)).toEqual(afterCommit);
  await expect(restore(crashCopy.value.id, crashDelete.body)).rejects.toMatchObject({ name: 'LibraryNotFoundError' });
  // Current terminal owner fence beats both live and retained states, independently of 720h.
  const terminal = await f.identity(scopes);
  const held = await made(terminal),
    living = await made(terminal);
  const heldDelete = await commands.deleteCopy(terminal.actor, held.value.id, 1, entryKey());
  await createLifecycleCommands({ pool: f.pool, access: f.access, clock }).tombstone(
    { actor: terminal.actor, deadline: Date.now() + 30_000 },
    { accountId: terminal.actor.accountId, key: entryKey() },
  );
  await expect(
    commands.restoreCopy(
      terminal.actor,
      held.value.id,
      { deletionId: heldDelete.transactionId, revision: 2 },
      entryKey(),
    ),
  ).rejects.toBeInstanceOf(Error);
  const erased = await purgeAccountFactsPage(
    { pool: f.pool, clock },
    { accountId: terminal.actor.accountId, kind: 'copy', after: null, limit: 100, stepKey: entryKey() },
  );
  expect(erased.value.removed).toBe(2);
  expect(await row(held.value.id)).toBeUndefined();
  expect(await row(living.value.id)).toBeUndefined();
  // The installed real scheduler dispatches the same ordinary default module/queue.
  const scheduledOwner = await f.identity(scopes, 0);
  const scheduled = await made(scheduledOwner);
  await commands.deleteCopy(scheduledOwner.actor, scheduled.value.id, 1, entryKey());
  now += 720 * 60 * 60 * 1000;
  await runtime.call('time', { time: now });
  await runtime.call('schedule');
  const deadline = Date.now() + 60_000;
  while (await row(scheduled.value.id)) {
    if (Date.now() >= deadline) throw new Error('Default scheduled copy purge did not finish');
    await Bun.sleep(20);
  }
  await runtime.close();
  runtime = undefined;
}, 240_000);
