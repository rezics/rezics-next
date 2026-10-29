import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { createSessionCommands } from '../../src/library/sessions.ts';
import { routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { compileSessionProfile, sessionScopes } from './support/session-profile-fixture.ts';

let native: NativeProfileFixture;
let reader: pg.Pool;
let owner: Awaited<ReturnType<NativeProfileFixture['identity']>>;
let commands: ReturnType<typeof createSessionCommands>;
let wide: string;
let narrow: string;
let removed: string;
let absent: string;
const input = (subjectId: string, total = '9') => ({ subjectId, mode: 'scalar_amount', unit: 'minute', total });
const path = (id: string) => `/v1/progressSessions/${id}`;

beforeAll(async () => {
  native = await createProfileEntryFixture();
  reader = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    options: '-c default_transaction_read_only=on',
  });
  owner = await native.identity(sessionScopes);
  commands = createSessionCommands(native);
  wide = await native.publish(await compileSessionProfile());
  narrow = await native.publish(await compileSessionProfile('5', 1));
  removed = await native.publish(await compileSessionProfile('5', 1, 'removed'));
  absent = await native.publish(await compileSessionProfile('5', 1, 'absent'));
  expect((await native.send('steward', 'POST', '/v1/platform/exposure/reading_progress:open')).status).toBe(200);
}, 120_000);
afterAll(async () => {
  await reader?.end();
  await native?.close();
});

async function facts(id: string) {
  const client = await reader.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const session = (
      await client.query('SELECT to_jsonb(s) AS row FROM library.progress_session s WHERE route=$1 AND session_id=$2', [
        routeOf(id),
        id,
      ])
    ).rows;
    const changes = (
      await client.query(
        'SELECT to_jsonb(c) AS row FROM library.progress_change c WHERE route=$1 AND session_id=$2 ORDER BY change_no',
        [routeOf(id), id],
      )
    ).rows;
    await client.query('COMMIT');
    return { session, changes };
  } finally {
    client.release();
  }
}
async function send(url: string, body: unknown, key = entryKey()) {
  return native.send(owner.bearer, 'POST', url, body, key);
}
async function reject(id: string, amount: string, status: number, code: string) {
  const before = await facts(id);
  const effects = await native.inspect(owner.actor.accountId);
  const response = await send(`${path(id)}:record`, { revision: 1, amount });
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ code, effect_status: 'not_applied' });
  expect(await facts(id)).toEqual(before);
  expect(await native.inspect(owner.actor.accountId)).toEqual(effects);
}

test('creation independently anchors the optional version and replays after that source becomes hidden', async () => {
  await native.activate(wide);
  const subject = await native.createSubject('game');
  const versionSubjectId = await native.createSubject('unprofiled');
  const body = { ...input(subject), versionSubjectId };
  const key = entryKey();
  const response = await send('/v1/progressSessions', body, key);
  expect(response.status).toBe(201);
  const accepted = await response.json();
  expect(accepted.progressSession.versionSubjectId).toBe(versionSubjectId);
  expect(
    (
      await native.send('steward', 'POST', `/v1/subjects/${versionSubjectId}:hide`, {
        reason: 'Native version anchor test',
      })
    ).status,
  ).toBe(200);
  const before = await native.inspect(owner.actor.accountId);
  const replay = await send('/v1/progressSessions', body, key);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual(accepted);
  expect((await send('/v1/progressSessions', body)).status).toBe(404);
  expect(await native.inspect(owner.actor.accountId)).toEqual(before);
});

test('a missing stored session cannot invalidate its authorized exact record receipt', async () => {
  await native.activate(wide);
  const subject = await native.createSubject('game');
  const started = await send('/v1/progressSessions', input(subject));
  expect(started.status).toBe(201);
  const id = (await started.json()).progressSession.id as string;
  const key = entryKey();
  const body = { revision: 1, amount: '4' };
  const recorded = await send(`${path(id)}:record`, body, key);
  expect(recorded.status).toBe(200);
  const receipt = await recorded.json();
  // Named persistence fault at the post-receipt session-read boundary; no positive rows are forged.
  const fault = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await fault.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM library.progress_change WHERE route=$1 AND session_id=$2', [routeOf(id), id]);
    await client.query('DELETE FROM library.progress_session WHERE route=$1 AND session_id=$2', [routeOf(id), id]);
    await client.query('COMMIT');
  } finally {
    client.release();
    await fault.end();
  }
  const before = await native.inspect(owner.actor.accountId);
  const replay = await send(`${path(id)}:record`, body, key);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(receipt);
  const conflict = await send(`${path(id)}:record`, { revision: 1, amount: '5' }, key);
  expect(conflict.status).toBe(422);
  expect(await conflict.json()).toMatchObject({ code: 'idempotency_conflict' });
  expect((await send(`${path(id)}:record`, body)).status).toBe(404);
  expect(await native.inspect(owner.actor.accountId)).toEqual(before);
});

test('fresh progress validates both immutable session meaning and current capability while exact receipts remain unchanged', async () => {
  await native.activate(wide);
  const subject = await native.createSubject('game');
  const createKey = entryKey();
  const body = input(subject);
  const started = await send('/v1/progressSessions', body, createKey);
  expect(started.status).toBe(201);
  const original = await started.json();
  const id = original.progressSession.id as string;
  const created = await facts(id);
  const pin = created.session[0]!.row.library_profile_pin;
  expect(pin.releaseDigest).toBe(wide);
  await native.activate(narrow);
  expect(await facts(id)).toEqual(created);
  await reject(id, '8', 422, 'unsupported_library_profile');
  await reject(id, '4.25', 422, 'unsupported_library_profile');
  const recordKey = entryKey();
  const value = { revision: 1, amount: '4' };
  const recorded = await send(`${path(id)}:record`, value, recordKey);
  expect(recorded.status).toBe(200);
  const receipt = await recorded.json();
  const stored = await facts(id);
  expect(stored.session[0]!.row).toMatchObject({ library_profile_pin: pin, total: 9, revision: 2 });
  expect(stored.changes[0]!.row.intent).toEqual({ amount: '4' });
  for (const digest of [removed, absent, wide, narrow]) {
    await native.activate(digest);
    if (digest === removed || digest === absent) {
      const response = await send(`${path(id)}:record`, { revision: 2, amount: '4' });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: 'unsupported_library_profile' });
    }
    const beforeReplay = await native.inspect(owner.actor.accountId);
    expect(await (await send('/v1/progressSessions', body, createKey)).json()).toEqual(original);
    expect(await (await send(`${path(id)}:record`, value, recordKey)).json()).toEqual(receipt);
    for (const [url, changed, key] of [
      ['/v1/progressSessions', { ...body, total: '8' }, createKey],
      [`${path(id)}:record`, { ...value, amount: '8' }, recordKey],
    ] as const) {
      const response = await send(url, changed, key);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: 'idempotency_conflict' });
    }
    expect(await native.inspect(owner.actor.accountId)).toEqual(beforeReplay);
    expect(await facts(id)).toEqual(stored);
  }
  await native.activate(absent);
  expect((await commands.completeSession(owner.actor, id, { revision: 2 }, entryKey())).value.state).toBe('completed');
  expect((await facts(id)).session[0]!.row.library_profile_pin).toEqual(pin);

  await native.activate(narrow);
  const narrowSession = await commands.startSession(owner.actor, input(subject, '5'), entryKey());
  const abandon = await commands.startSession(owner.actor, input(subject, '5'), entryKey());
  await native.activate(wide);
  await reject(narrowSession.value.id, '8', 400, 'invalid_request');
  await native.activate(absent);
  expect((await commands.abandonSession(owner.actor, abandon.value.id, { revision: 1 }, entryKey())).value.state).toBe(
    'abandoned',
  );
  await native.revokeIdentity(owner.actor.accountId);
  for (const [url, value, key] of [
    ['/v1/progressSessions', body, createKey],
    [`${path(id)}:record`, { revision: 1, amount: '4' }, recordKey],
  ] as const)
    expect([401, 403, 404]).toContain((await send(url, value, key)).status);
}, 120_000);
