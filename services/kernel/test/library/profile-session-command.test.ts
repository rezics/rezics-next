import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import pg from 'pg';
import { compileCatalogue } from '@rezics/definitions/compile';
import {
  fixture,
  libraryLabels,
  libraryProfile,
  unitData,
} from '../../../../packages/definitions/test/support/library-profiles.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { LibraryNotFoundError } from '../../src/library/command-support.ts';
import changePage from '../../src/library/progress-store-change-page.sql';
import unitPage from '../../src/library/progress-store-unit-page.sql';
import { routeOf } from '../../src/route/route.ts';
import { accountToken } from '../support/admitted-access.ts';
import {
  createProfileEntryFixture,
  entryKey,
  entryTypes,
  type NativeProfileFixture,
} from './support/profile-entry-fixture.ts';

const scopes = [
  'subject:read',
  'progress_session:create',
  'progress_session:read',
  'progress_session:list',
  'progress_session:update',
];
const title =
  'native sessions admit declared mode unit data with exact bounds pin immutable creation meaning and preserve sparse identities';
let native: NativeProfileFixture;
let commands: ReturnType<typeof import('../../src/library/sessions.ts').createSessionCommands>;
let owner: Awaited<ReturnType<NativeProfileFixture['identity']>>;
let other: typeof owner;
let reader: pg.Pool;
let digest: string;
let replacement: string;
let removed: string;
const path = (id: string) => `/v1/progressSessions/${id}`;
const create = (subjectId: string, mode = 'scalar_amount', unit = 'page', extra = {}) => ({
  subjectId,
  mode,
  unit,
  ...extra,
});

// Extend source data here; no release, policy, subject or current-type surrogate.
async function compileSessions(changed: boolean, absent = false) {
  const profile = libraryProfile(changed ? 'fixture.sessions.next' : 'fixture.sessions');
  const scalar = [
    {
      ...unitData('seed-tray.v2'),
      minimum: '0.100001',
      maximum: '999999999999.999998',
      precision: 6,
      totalPolicy: 'required',
    },
    { ...unitData('precise'), minimum: '1.25', maximum: '9.75', precision: 2 },
    { ...unitData('no-total'), totalPolicy: 'forbidden' },
    unitData('percent'),
    { id: 'page', identity: { kind: 'none' }, structure: { kind: 'none' } },
  ];
  profile.progress.allowed = [
    { mode: 'scalar_amount', units: changed ? scalar.filter((u) => u.id !== 'seed-tray.v2') : scalar },
    {
      mode: 'cursor_position',
      units: [
        { ...unitData('percent', 'cursor_position'), maximum: '500', precision: 3 },
        { ...unitData('marker.v2', 'cursor_position'), maximum: '900' },
        { id: 'chapter', identity: { kind: 'none' }, structure: { kind: 'none' } },
      ],
    },
    {
      mode: 'completed_units',
      units: [unitData('plot-key.v2', 'completed_units'), unitData('episode', 'completed_units')],
    },
  ];
  const recipe = libraryProfile('fixture.scalar-only', 'percent');
  recipe.progress.allowed[0].units[0].maximum = '200';
  const record = libraryProfile('fixture.no-progress');
  delete record.progress;
  const input = fixture(profile);
  const schema = JSON.parse(input.schemas['fixture.yaml']!);
  schema.version = absent ? 'sessions-removed' : changed ? 'sessions-next' : 'sessions';
  if (absent) {
    delete schema.classes.Parent.annotations;
    delete schema.classes.Root.annotations;
  }
  schema.classes.Recipe = { class_uri: entryTypes.recipe, annotations: { library: recipe } };
  schema.classes.Record = { class_uri: entryTypes.record, ...(changed ? {} : { annotations: { library: record } }) };
  input.schemas['fixture.yaml'] = JSON.stringify(schema);
  for (const [key, text] of Object.entries(input.presentation)) {
    const labels = JSON.parse(text);
    if (absent) {
      delete labels.libraryProfiles[profile.id];
      delete labels.libraryProfiles['fixture.root'];
    }
    const locale = key.split('/')[1] as Parameters<typeof libraryLabels>[1];
    Object.assign(labels.types, { [entryTypes.recipe]: 'recipe', [entryTypes.record]: 'record' });
    for (const p of [recipe, ...(changed ? [] : [record])]) labels.libraryProfiles[p.id] = libraryLabels(p, locale);
    input.presentation[key] = JSON.stringify(labels);
  }
  return compileCatalogue(input);
}

beforeAll(async () => {
  native = await createProfileEntryFixture();
  reader = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    options: '-c default_transaction_read_only=on',
  });
  const { createSessionCommands } = await import('../../src/library/sessions.ts');
  commands = createSessionCommands(native);
  owner = await native.identity(scopes);
  other = await native.identity(scopes);
  await json(await native.send('steward', 'POST', '/v1/platform/exposure/reading_progress:open'), 200);
  digest = await native.publish(await compileSessions(false));
  replacement = await native.publish(await compileSessions(true));
  removed = await native.publish(await compileSessions(true, true));
}, 120_000);
beforeEach(async () => {
  await native.activate(digest);
});
afterAll(async () => {
  await Promise.all([native?.close(), reader?.end()]);
});

async function json(response: Response, status: number) {
  const body = await response.json();
  expect({ status: response.status, body }).toEqual({ status, body: expect.any(Object) });
  privateFree(body);
  return body;
}
function privateFree(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    expect([
      'pin',
      'library_profile_pin',
      'libraryProfilePin',
      'provenance',
      'releaseDigest',
      'acceptingType',
      'profileId',
      'typeId',
      'typeSourceId',
      'sourcePartition',
      'sourceEpoch',
      'sourcePosition',
    ]).not.toContain(key);
    privateFree(child);
  }
}
async function problem(response: Response, status: number, code: string) {
  const body = await json(response, status);
  expect(body.code).toBe(code);
  expect(body.effect_status).toBe('not_applied');
  expect(JSON.stringify(body)).not.toContain('ex:');
  expect(JSON.stringify(body)).not.toContain('fixture.sessions');
  return body;
}
const send = (method: string, url: string, body?: unknown, key = entryKey(), bearer = owner.bearer) =>
  native.send(bearer, method, url, body, key);
async function start(subjectId: string, mode = 'scalar_amount', unit = 'page', extra = {}, key = entryKey()) {
  const response = await send('POST', '/v1/progressSessions', create(subjectId, mode, unit, extra), key);
  return (await json(response, 201)).progressSession;
}
async function fact(id: string) {
  const rows = (await native.inspect(owner.actor.accountId)).sessions.filter(({ row }) => row.session_id === id);
  expect(rows).toHaveLength(1);
  return rows[0]!.row;
}
const pin = () => ({
  provenance: 'profile',
  releaseDigest: digest,
  acceptingType: entryTypes.game,
  profileId: 'fixture.sessions',
});
async function contents(id: string) {
  const client = await reader.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const args = { route: routeOf(owner.actor.accountId)!, session_id: id, has_cursor: false, limit: 101 };
    const units = await unitPage.run(client, { ...args, after_unit_id: '' });
    const changes = await changePage.run(client, { ...args, after_change_no: 0 });
    await client.query('COMMIT');
    return { units, changes };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function noEffects(body: () => Promise<unknown>, accountId = owner.actor.accountId, id?: string) {
  const before = await native.inspect(accountId);
  const history = id ? await contents(id) : null;
  const own = accountId === owner.actor.accountId ? null : await native.inspect(owner.actor.accountId);
  await body();
  expect(await native.inspect(accountId)).toEqual(before);
  if (id && history) expect(await contents(id)).toEqual(history);
  if (own) expect(await native.inspect(owner.actor.accountId)).toEqual(own);
}
async function rejectCreate(input: unknown, status = 400, code = 'invalid_request') {
  await noEffects(async () => {
    await problem(await send('POST', '/v1/progressSessions', input), status, code);
  });
}
async function rejectRecord(id: string, revision: number, value: object) {
  await noEffects(
    async () => {
      await problem(await send('POST', `${path(id)}:record`, { revision, ...value }), 400, 'invalid_request');
    },
    owner.actor.accountId,
    id,
  );
}
async function record(id: string, revision: number, value: object, key = entryKey()) {
  return (await json(await send('POST', `${path(id)}:record`, { revision, ...value }, key), 200)).progressSession;
}
function independentFacts(before: Awaited<ReturnType<NativeProfileFixture['inspect']>>, after: typeof before) {
  for (const key of ['entries', 'copies', 'entitlements', 'follows'] as const) expect(after[key]).toEqual(before[key]);
}

test('native controls use provisioned identities real Access semantic sources and unchanged session algorithms', async () => {
  const subject = await native.createSubject('game');
  expect((await native.send(owner.bearer, 'GET', `/v1/subjects/${subject}`)).status).toBe(200);
  const s = await start(subject);
  expect(s).toMatchObject({ mode: 'scalar_amount', unit: 'page', state: 'active', revision: 1 });
  const r = await commands.recordProgress(owner.actor, s.id, { revision: 1, amount: '12.000001' }, entryKey());
  expect(r.value.amount).toBe('12.000001');
  expect((await contents(s.id)).changes.map((c) => c.intent)).toEqual([{ amount: '12.000001' }]);
  await expect(commands.readSession(other.actor, s.id)).rejects.toBeInstanceOf(LibraryNotFoundError);
  await rejectRecord(s.id, 2, { amount: '01' });
});

test(title, async () => {
  const subject = await native.createSubject('game');
  const before = await native.inspect(owner.actor.accountId);
  const input = create(subject, 'scalar_amount', 'seed-tray.v2', { total: '999999999999.999998' });
  const first = await commands.startSession(owner.actor, input, entryKey());
  expect(first.replayed).toBe(false);
  expect(String(first.value.unit)).toBe('seed-tray.v2');
  expect((await fact(first.value.id)).library_profile_pin).toEqual(pin());
  const reread = await start(subject, 'scalar_amount', 'seed-tray.v2', { total: '999999999999.999998' });
  expect(reread.id).not.toBe(first.value.id);
  expect(reread).toMatchObject({
    subjectId: subject,
    mode: 'scalar_amount',
    unit: 'seed-tray.v2',
    amount: null,
    state: 'active',
  });
  expect((await fact(reread.id)).library_profile_pin).toEqual(pin());
  expect((await commands.listSessions(owner.actor, subject)).sessions.map((s) => s.id).sort()).toEqual(
    [first.value.id, reread.id].sort(),
  );
  const amount = '999999999999.999997';
  const updated = await commands.recordProgress(owner.actor, first.value.id, { revision: 1, amount }, entryKey());
  expect(updated.value.amount).toBe(amount);
  expect((await contents(first.value.id)).changes.map((c) => c.intent)).toEqual([{ amount }]);
  expect((await commands.readSession(owner.actor, reread.id)).amount).toBeNull();
  independentFacts(before, await native.inspect(owner.actor.accountId));
});

test('native creation stores the accepting primary type and exact private profile pin', async () => {
  const subject = await native.createSubject('game');
  const s = await start(subject);
  expect((await fact(s.id)).library_profile_pin).toEqual(pin());
});

test('fresh active profile admission rejects missing capabilities and pairs without legacy fallback', async () => {
  const game = await native.createSubject('game');
  const recipe = await native.createSubject('recipe');
  const recordSubject = await native.createSubject('record');
  const unprofiled = await native.createSubject('unprofiled');
  expect((await native.send(owner.bearer, 'GET', `/v1/subjects/${unprofiled}`)).status).toBe(200);
  for (const input of [
    create(game, 'scalar_amount', 'unknown-unit'),
    create(game, 'cursor_position', 'precise'),
    create(recipe, 'cursor_position', 'percent'),
    create(recordSubject),
    create(unprofiled),
  ])
    await rejectCreate(input, 422, 'unsupported_library_profile');
  await native.activate(replacement);
  await rejectCreate(create(game, 'scalar_amount', 'seed-tray.v2', { total: '9' }), 422, 'unsupported_library_profile');
});

test('malformed shapes caller pins and totals on other modes are invalid requests without effects', async () => {
  const subject = await native.createSubject('game');
  for (const input of [
    null,
    [],
    { ...create(subject), unit: 7 },
    { ...create(subject), pin: pin() },
    { ...create(subject), profileId: 'fixture.sessions' },
    { ...create(subject), releaseDigest: digest },
    { ...create(subject), acceptingType: entryTypes.game },
    create(subject, 'cursor_position', 'percent', { total: '1' }),
    create(subject, 'completed_units', 'episode', { total: '1' }),
  ])
    await rejectCreate(input);
});

test('scalar metadata checks total separately from amount using exact decimal bounds and precision', async () => {
  const subject = await native.createSubject('game');
  // Adjacent values here collapse if compared through Number.
  for (const total of ['0.100000', '999999999999.999999', '1000000000000', '1.0000001'])
    await rejectCreate(create(subject, 'scalar_amount', 'seed-tray.v2', { total }));
  for (const unit of ['seed-tray.v2', 'no-total']) {
    const extra = unit === 'no-total' ? { total: '1' } : {};
    await rejectCreate(create(subject, 'scalar_amount', unit, extra));
  }
  await rejectCreate(create(subject, 'scalar_amount', 'seed-tray.v2', { total: null }));
  const bounded = await start(subject, 'scalar_amount', 'precise', { total: '9.75' });
  for (const amount of ['1.24', '9.76', '1.251', '0', '-1', '1e1', '01.25'])
    await rejectRecord(bounded.id, 1, { amount });
  for (const total of ['1.24', '9.76', '1.251'])
    await rejectCreate(create(subject, 'scalar_amount', 'precise', { total }));
  expect((await record(bounded.id, 1, { amount: '1.25' })).amount).toBe('1.25');
  expect((await record(bounded.id, 2, { amount: '9.75' })).amount).toBe('9.75');
  const optional = await start(subject, 'scalar_amount', 'precise');
  expect(optional.total).toBeNull();
  expect((await start(subject, 'scalar_amount', 'no-total')).total).toBeNull();
  const exact = await start(subject, 'scalar_amount', 'seed-tray.v2', { total: '999999999999.999998' });
  expect((await record(exact.id, 1, { amount: '0.100001' })).amount).toBe('0.100001');
  expect((await record(exact.id, 2, { amount: '999999999999.999998' })).amount).toBe('999999999999.999998');
});

test('absent precision and total policy keep parser bounds while percent bounds belong to pair metadata', async () => {
  const subject = await native.createSubject('game');
  const defaults = await start(subject, 'scalar_amount', 'page', { total: '999999999999.999999' });
  expect((await record(defaults.id, 1, { amount: '999999999999.999999' })).amount).toBe('999999999999.999999');
  expect((await start(subject)).total).toBeNull();
  for (const amount of ['1000000000000', '0.0000001']) await rejectRecord(defaults.id, 2, { amount });
  const percent = await start(subject, 'scalar_amount', 'percent', { total: '100' });
  expect((await record(percent.id, 1, { amount: '100' })).amount).toBe('100');
  await rejectRecord(percent.id, 2, { amount: '100.000001' });
  await rejectCreate(create(subject, 'scalar_amount', 'percent', { total: '100.000001' }));
  const recipe = await native.createSubject('recipe');
  const extended = await start(recipe, 'scalar_amount', 'percent', { total: '200' });
  expect((await record(extended.id, 1, { amount: '101' })).amount).toBe('101');
  const cursor = await start(subject, 'cursor_position', 'percent');
  expect((await record(cursor.id, 1, { locator: 'opaque:bookmark', position: '101.001' })).position).toBe('101.001');
  for (const value of [
    { locator: 'x', position: '500.001' },
    { locator: 'x', position: '101.0001' },
    { locator: 'x'.repeat(257), position: '1' },
  ])
    await rejectRecord(cursor.id, 2, { ...value });
  const marker = await start(subject, 'cursor_position', 'marker.v2');
  const direct = await commands.recordProgress(
    owner.actor,
    marker.id,
    { revision: 1, locator: 'opaque', position: '899.000001' },
    entryKey(),
  );
  expect(direct.value.position).toBe('899.000001');
  expect((await contents(marker.id)).changes.map((c) => c.intent)).toEqual([
    { locator: 'opaque', position: '899.000001' },
  ]);
  await rejectCreate(create(subject, 'cursor_position', 'chapter', { total: '1' }));
});

test('same profile sparse records retain exact opaque identities duplicate noops removals and truthful history', async () => {
  const subject = await native.createSubject('game');
  const before = await native.inspect(owner.actor.accountId);
  const s = await start(subject, 'completed_units', 'plot-key.v2');
  const opaque = 'A_opaque:~plot.v2-0007';
  const first = await commands.recordProgress(
    owner.actor,
    s.id,
    { revision: 1, add: ['7', '1', '3', opaque] },
    entryKey(),
  );
  expect(first.value.completedUnitCount).toBe(4);
  const initial = await contents(s.id);
  expect(initial.units.map((u) => u.unitId)).toEqual(['1', '3', '7', opaque]);
  expect(initial.changes.map((c) => c.intent)).toEqual([{ add: ['1', '3', '7', opaque] }]);
  expect((await record(s.id, 2, { add: ['3', opaque] })).completedUnitCount).toBe(4);
  expect((await record(s.id, 3, { remove: ['2', opaque] })).completedUnitCount).toBe(3);
  expect((await record(s.id, 4, { remove: ['2'] })).completedUnitCount).toBe(3);
  const stored = await contents(s.id);
  expect(stored.units.map((u) => u.unitId)).toEqual(['1', '3', '7']);
  expect(stored.units).toEqual(initial.units.filter((u) => u.unitId !== opaque));
  expect(stored.changes.map((c) => c.intent)).toEqual([
    { add: ['1', '3', '7', opaque] },
    { add: ['3', opaque] },
    { remove: ['2', opaque] },
    { remove: ['2'] },
  ]);
  expect((await commands.listUnits(owner.actor, s.id)).units.map((u) => u.unitId)).toEqual(['1', '3', '7']);
  expect((await commands.listChanges(owner.actor, s.id)).changes.map((c) => c.intent)).toEqual(
    stored.changes.map((c) => c.intent),
  );
  expect((await json(await send('GET', `${path(s.id)}/completedUnits`), 200)).completedUnits).toEqual(['1', '3', '7']);
  privateFree(await json(await send('GET', `${path(s.id)}/changes`), 200));
  for (const value of [
    { add: ['x', 'x'] },
    { add: ['x'], remove: ['x'] },
    { add: ['bad/key'] },
    { add: ['x'.repeat(129)] },
    { add: Array.from({ length: 101 }, (_, i) => `key${i}`) },
    { add: ['x'], structureRevision: 'invented' },
  ])
    await rejectRecord(s.id, 5, { ...value });
  const maxKey = 'x'.repeat(128);
  expect((await record(s.id, 5, { add: [maxKey] })).completedUnitCount).toBe(4);
  const reread = await start(subject, 'completed_units', 'plot-key.v2');
  expect(reread.id).not.toBe(s.id);
  expect((await contents(reread.id)).units).toEqual([]);
  independentFacts(before, await native.inspect(owner.actor.accountId));
});

test('native sparse cardinality stays capped at twenty thousand across bounded records', async () => {
  const subject = await native.createSubject('game');
  const s = await start(subject, 'completed_units', 'episode');
  for (let batch = 0; batch < 200; batch++) {
    const add = Array.from({ length: 100 }, (_, i) => `key-${batch * 100 + i}`);
    const result = await commands.recordProgress(owner.actor, s.id, { revision: batch + 1, add }, entryKey());
    expect(result.value.completedUnitCount).toBe((batch + 1) * 100);
  }
  await rejectRecord(s.id, 201, { add: ['overflow'] });
  expect((await record(s.id, 201, { add: ['key-0'] })).completedUnitCount).toBe(20000);
}, 120_000);

test('authorized receipts survive profile replacement removal hide and rollback without changing creation meaning', async () => {
  const subject = await native.createSubject('game');
  const startKey = entryKey();
  const input = create(subject, 'scalar_amount', 'page', { total: '9' });
  const original = await json(await send('POST', '/v1/progressSessions', input, startKey), 201);
  const s = original.progressSession;
  const recordKey = entryKey();
  const intent = { revision: 1, amount: '1.123456' };
  const recorded = await json(await send('POST', `${path(s.id)}:record`, intent, recordKey), 200);
  const stored = await fact(s.id);
  const history = await contents(s.id);
  for (const head of [replacement, removed, digest, replacement]) {
    await native.activate(head);
    await noEffects(
      async () => {
        expect(await json(await send('POST', '/v1/progressSessions', input, startKey), 201)).toEqual(original);
        expect(await json(await send('POST', `${path(s.id)}:record`, intent, recordKey), 200)).toEqual(recorded);
        await problem(
          await send('POST', '/v1/progressSessions', { ...input, total: '8' }, startKey),
          422,
          'idempotency_conflict',
        );
        await problem(
          await send('POST', `${path(s.id)}:record`, { ...intent, amount: '1.123457' }, recordKey),
          422,
          'idempotency_conflict',
        );
      },
      owner.actor.accountId,
      s.id,
    );
    expect(await fact(s.id)).toEqual(stored);
    expect(await contents(s.id)).toEqual(history);
    expect((await json(await send('GET', path(s.id)), 200)).progressSession).toEqual(recorded.progressSession);
  }
  await json(
    await native.send('steward', 'POST', `/v1/subjects/${subject}:hide`, { reason: 'Native receipt concealment' }),
    200,
  );
  await noEffects(
    async () => {
      expect(await json(await send('POST', '/v1/progressSessions', input, startKey), 201)).toEqual(original);
      expect(await json(await send('POST', `${path(s.id)}:record`, intent, recordKey), 200)).toEqual(recorded);
      await problem(await send('POST', '/v1/progressSessions', input), 404, 'not_found');
      expect((await commands.readSession(owner.actor, s.id)).amount).toBe('1.123456');
    },
    owner.actor.accountId,
    s.id,
  );
});

test('native guards conceal sessions and source failures and fence old receipts before replay', async () => {
  const subject = await native.createSubject('game');
  const hidden = await native.createSubject('game');
  await json(
    await native.send('steward', 'POST', `/v1/subjects/${hidden}:hide`, { reason: 'Native source concealment' }),
    200,
  );
  const s = await start(subject);
  for (const source of [hidden, native.unknownSubject()])
    await noEffects(async () => {
      await problem(await send('POST', '/v1/progressSessions', create(source)), 404, 'not_found');
    });
  for (const suffix of ['', '/completedUnits', '/changes']) {
    await noEffects(async () => {
      await problem(await send('GET', path(s.id) + suffix, undefined, entryKey(), other.bearer), 404, 'not_found');
    }, other.actor.accountId);
    const anonymous = await native.send('anonymous', 'GET', path(s.id) + suffix);
    expect([401, 404]).toContain(anonymous.status);
    privateFree(await anonymous.json());
  }
  await noEffects(async () => {
    await problem(
      await send('POST', `${path(s.id)}:record`, { revision: 1, amount: '1' }, entryKey(), other.bearer),
      404,
      'not_found',
    );
  }, other.actor.accountId);
  await expect(commands.listUnits(other.actor, s.id)).rejects.toBeInstanceOf(LibraryNotFoundError);
  for (const fence of ['scope', 'suspension', 'authn'] as const) {
    const actor = await native.identity(scopes);
    const key = entryKey();
    const input = create(subject);
    const response = await json(await send('POST', '/v1/progressSessions', input, key, actor.bearer), 201);
    const id = response.progressSession.id;
    const recordKey = entryKey();
    const value = { revision: 1, amount: '1' };
    await json(await send('POST', `${path(id)}:record`, value, recordKey, actor.bearer), 200);
    let bearer = actor.bearer;
    if (fence === 'scope')
      bearer = await accountToken({
        accountId: actor.actor.accountId,
        clientId: actor.actor.clientId,
        scopes: ['subject:read', 'progress_session:read'],
      });
    if (fence === 'suspension') await native.suspend(actor.actor.accountId);
    if (fence === 'authn') await native.revokeIdentity(actor.actor.accountId);
    await noEffects(async () => {
      for (const [url, body, receipt] of [
        ['/v1/progressSessions', input, key],
        [`${path(id)}:record`, value, recordKey],
      ] as const) {
        const denied = await send('POST', url, body, receipt, bearer);
        expect([401, 403, 404]).toContain(denied.status);
        const bodyDenied = await denied.json();
        privateFree(bodyDenied);
        expect(bodyDenied).not.toHaveProperty('progressSession');
      }
    }, actor.actor.accountId);
    if (fence === 'suspension')
      await expect(commands.readSession(actor.actor, id)).rejects.toBeInstanceOf(GrantDeniedError);
  }
  const limited = await native.identity(['progress_session:create']);
  await noEffects(async () => {
    const denied = await send('POST', '/v1/progressSessions', create(subject), entryKey(), limited.bearer);
    expect([403, 404]).toContain(denied.status);
    privateFree(await denied.json());
    await expect(commands.startSession(limited.actor, create(subject), entryKey())).rejects.toBeDefined();
  }, limited.actor.accountId);
});
