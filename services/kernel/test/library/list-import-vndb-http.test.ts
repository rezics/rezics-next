import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { parseVndb, VNDB_LIMITS } from '../../src/library/list-import-vndb-parser.ts';
import { OWNED_PHASES } from '../../src/library/erasure-owned-graph.ts';
let f: NativeProfileFixture, matched: string;
const vnId = `v${Date.now()}${Math.floor(Math.random() * 100000)}`;
const base = '/v1/libraryImports/vndb';
const xml = (rows: string, extra = '') =>
  `<vndb-export version="1.0" uid="u1"><vns>${rows}</vns>${extra}</vndb-export>`;
const vn = (id: string, fields = '') => `<vn id="${id}"><title>Display only</title>${fields}</vn>`;
async function json(method: string, path: string, body?: unknown, persona = 'owner', key = entryKey()) {
  const response = await f.send(persona, method, path, body, key);
  expect(response.status).toBe(200);
  return response.json();
}
const upload = (source: string) => json('POST', base + ':preview', { xml: source });
const review = (id: string, body: unknown) => json('POST', `${base}/${id}:review`, body);
const apply = (id: string, rows: { ordinal: number; reviewId: string }[]) =>
  json('POST', `${base}/${id}:apply`, { rows });
beforeAll(async () => {
  f = await createProfileEntryFixture();
  const producer = await f.identity(['subject:batch_write', 'subject:create', 'subject:read']);
  await createGrantCommands({ pool: f.pool, access: f.access, managementAction: 'access:grant' }).create(
    { pool: f.pool, actor: f.steward.actor, deadline: deadlineFor(30000) },
    {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: producer.actor.accountId },
      actions: ['subject:batch_write'],
      valid: '(,)',
      key: entryKey(),
    },
  );
  const created = await json(
    'POST',
    '/v1/subjects:batchWrite',
    {
      commands: [
        {
          op: 'create',
          key: entryKey(),
          source: {
            source: 'vndb',
            external_id: vnId,
            record_revision: '1',
            digest: 'a'.repeat(64),
            converter_revision: 'vndb@1',
            field_group: 'facts',
          },
          subject: { type: 'ex:Child', labels: { en: 'Display only' } },
        },
      ],
    },
    producer.bearer,
  );
  expect(created.results[0]).toMatchObject({ status: 201 });
  matched = created.results[0].value.id;
}, 120000);
afterAll(() => f?.close());
test('own HTTP upload, admitted VN identifier, explicit unmatched resolution and bounded confirmed outcomes retain private losses', async () => {
  const target = await f.createSubject('game');
  const before = await f.inspect();
  const source = xml(
    vn(
      vnId,
      '<label label="Playing" private="1"/><vote>8.5</vote><started>2020-05-00</started><finished>2021-02-03</finished><notes>private note</notes><progress unit="minute">0</progress><unknown>keep</unknown>',
    ) +
      vn('v999999999999') +
      vn('v999999999998'),
    '<reviews><review id="1"><text>not a public review</text></review></reviews><releases><release id="r42"><vn id="v42"/></release></releases>',
  );
  const made = await upload(source),
    id = made.uploadId;
  const page = await json('GET', `${base}/${id}`);
  expect(page.rows[0].match).toEqual({ status: 'matched', candidates: [matched] });
  expect(page.rows[1].match.status).toBe('unmatched');
  expect(page.rows[0].fields).toMatchObject({
    score: { value: 8.5, scale: { min: 1, max: 10, step: 0.1 } },
    started: { value: '2020-05', precision: 'month' },
    finished: { precision: 'day' },
    notes: { value: 'private note' },
    progress: { value: '0' },
    progressMeasure: { value: 'minute' },
  });
  expect(page.rows[4].identifier).toBeNull();
  expect((await f.inspect()).entries).toEqual(before.entries);
  expect((await f.send('other', 'GET', `${base}/${id}`)).status).toBe(404);
  expect((await f.send('other', 'GET', `${base}/${id}/source`)).status).toBe(404);
  const a = await review(id, { ordinal: 0, action: 'state', state: 'playing' });
  const b = await review(id, { ordinal: 1, action: 'state', state: 'planned', targetId: target });
  const c = await review(id, { ordinal: 2, action: 'skip' });
  const d = await review(id, { ordinal: 3, action: 'retain' });
  const selection = [a, b, c, d].map((r, ordinal) => ({ ordinal, reviewId: r.reviewId }));
  const result = await apply(id, selection);
  expect(result.outcomes.map((r: { status: string }) => r.status)).toEqual([
    'applied',
    'applied',
    'skipped',
    'unsupported',
  ]);
  const effects = await f.inspect();
  expect((await apply(id, selection)).outcomes).toEqual(result.outcomes);
  expect(await f.inspect()).toEqual(effects);
  expect((await f.commands.readEntry(f.owner.actor, matched)).state).toBe('playing');
  expect((await f.commands.readEntry(f.owner.actor, target)).state).toBe('planned');
  expect(effects.sessions).toEqual(before.sessions);
  expect(effects.copies).toEqual(before.copies);
  expect(effects.entitlements).toEqual(before.entitlements);
  expect(await json('GET', `${base}/${id}/source`)).toEqual({ xml: source });
  expect((await f.send('other', 'POST', `${base}/${id}:apply`, { rows: selection })).status).toBe(404);
  await json('DELETE', `${base}/${id}`);
}, 120000);
test('reviewed conflicts preserve facts, revision and release guards reject stale choices, cancellation stops remaining rows', async () => {
  const target = await f.createSubject('game');
  await f.commands.putEntry(f.owner.actor, target, { state: 'planned' }, entryKey());
  const { uploadId: id } = await upload(xml(vn('v999999999997') + vn('v999999999996')));
  const choice = { ordinal: 0, action: 'state', state: 'playing', targetId: target };
  const kept = await review(id, choice);
  expect((await apply(id, [{ ordinal: 0, reviewId: kept.reviewId }])).outcomes[0].status).toBe('skipped');
  const replaced = await review(id, { ...choice, replace: true });
  const local = await f.commands.readEntry(f.owner.actor, target);
  await f.commands.putEntry(
    f.owner.actor,
    target,
    { state: 'playing', revision: local.revision, incarnationId: local.incarnationId },
    entryKey(),
  );
  expect((await apply(id, [{ ordinal: 0, reviewId: replaced.reviewId }])).outcomes[0].status).toBe('stale');
  const refreshed = await review(id, { ...choice, state: 'planned', replace: true });
  const original = [{ ordinal: 0, reviewId: refreshed.reviewId }];
  // Native receipt replay retains the original command operands.
  const started = await apply(id, original);
  expect(started.outcomes[0].status).toBe('applied');
  const stored = await f.pool.query('SELECT decisions FROM library.vndb_import WHERE account_id=$1 AND upload_id=$2', [
    f.owner.actor.accountId,
    id,
  ]);
  const decision = stored.rows[0].decisions['0'];
  const receipt = await f.commands.putEntry(
    f.owner.actor,
    target,
    { state: decision.state, revision: decision.baseline.revision, incarnationId: decision.baseline.incarnationId },
    decision.commandKey,
    decision.guard,
  );
  expect(receipt.replayed).toBe(true);
  const pending = await review(id, {
    ordinal: 1,
    action: 'state',
    state: 'planned',
    targetId: await f.createSubject('game'),
  });
  await json('POST', `${base}/${id}:cancel`);
  expect(await apply(id, [{ ordinal: 1, reviewId: pending.reviewId }])).toMatchObject({
    outcomes: [],
    stopped: 'cancelled',
  });
  await json('DELETE', `${base}/${id}`);
  const next = await upload(xml(vn('v999999999995')));
  const stale = await review(next.uploadId, {
    ordinal: 0,
    action: 'state',
    state: 'playing',
    targetId: target,
    replace: true,
  });
  await f.activate(f.replacementDigest);
  expect((await apply(next.uploadId, [{ ordinal: 0, reviewId: stale.reviewId }])).outcomes[0].status).toBe('stale');
  await json('DELETE', `${base}/${next.uploadId}`);
  await f.activate(f.originalDigest);
}, 120000);
test('XML bounds, exact identifier kinds, missing/zero/invalid evidence and native terminal denial', async () => {
  const zero = parseVndb(xml(vn('v1', '<vote>0</vote><started>bad</started><finished>0000-00-00</finished>')))[0]!;
  for (const name of ['score', 'started']) expect(zero.fields[name]?.kind).toBe('invalid');
  expect(zero.fields.finished?.kind).toBe('unknown');
  expect(zero.fields.notes?.kind).toBe('missing');
  for (const bad of [
    '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>' + xml(vn('v1')),
    xml(vn('r1')),
    xml('<a>'.repeat(33) + '</a>'.repeat(33)),
    xml(vn('v1')).slice(0, -2),
    'x'.repeat(VNDB_LIMITS.bytes + 1),
    xml(vn('v1').repeat(VNDB_LIMITS.rows)),
  ]) {
    expect((await f.send('owner', 'POST', base + ':preview', { xml: bad })).status).toBe(400);
  }
  expect(
    (await f.send('owner', 'POST', base + ':preview', { xml: 'x'.repeat(VNDB_LIMITS.wireBytes + 1) })).status,
  ).toBe(413);
  const made = await upload(xml(vn('v1')));
  expect(OWNED_PHASES).toContain('vndb_import');
  await f.revokeIdentity(f.owner.actor.accountId);
  for (const [method, path, body] of [
    ['GET', `${base}/${made.uploadId}`, undefined],
    ['POST', `${base}/${made.uploadId}:apply`, { rows: [{ ordinal: 0, reviewId: entryKey() }] }],
  ] as const)
    expect([401, 403]).toContain((await f.send('owner', method, path, body)).status);
}, 120000);
