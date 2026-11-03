import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import { batchCommand } from '../../src/semantic/bulk.ts';
import { globalContextAnchor } from '../../src/semantic/context.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { partitionOf } from '../../src/route/route.ts';
import { testRouteKey } from '../support/test-kernel.ts';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture;
let matched: string;
const root = '/v1/libraryImports/bangumi';
const providerId = 815432;
const upload = (collections: unknown[]) => ({ upload: JSON.stringify({ format: 'rezics.bangumi-collection.v1', collections }) });
const record = (id = providerId) => ({ subject_id: id, subject_type: 2, type: 1, rate: 0, ep_status: 0,
  vol_status: 2, tags: ['personal'], comment: 'private note sentinel', private: true,
  updated_at: '2022-06-19T18:44:13.6140127+08:00', started_date: '2021-03', custom: { priority: 4 } });
async function ok(response: Response) { expect(response.status).toBe(200); return response.json(); }
async function preview(records: unknown[]) { return ok(await f.send('owner', 'POST', root + ':preview', upload(records))); }
async function review(id: string, ordinal: number, target?: string) {
  return (await ok(await f.send('owner', 'POST', `${root}/${id}:review`, { ordinal, ...(target ? { target } : {}) }))).review;
}
const choice = (ordinal: number, r: { token: string }, state = 'preserve', skip = false) => ({ ordinal, reviewToken: r.token, state, skip });
async function apply(id: string, rows: unknown[]) { return ok(await f.send('owner', 'POST', `${root}/${id}:apply`, { rows })); }
beforeAll(async () => {
  f = await createProfileEntryFixture();
  const importer = await f.identity(['subject:batch_write', 'subject:read']);
  await createGrantCommands({ pool: f.pool, access: f.access, managementAction: 'access:grant' }).create(
    { pool: f.pool, actor: f.steward.actor, deadline: Date.now() + 30000 }, {
      resource: { route: 0, id: GLOBAL_CONTEXT }, subject: { kind: 'account', id: importer.actor.accountId },
      actions: ['subject:batch_write'], valid: '(,)', key: randomUUID(),
    });
  const route = tupleRoute(testRouteKey(), 'bangumi', String(providerId));
  const result = await batchCommand(f.pool, {
    actor: importer.actor, route, routeKey: testRouteKey(), deadline: Date.now() + 30000, clock: () => new Date(),
    authorization: resourceAuthorization({ access: f.access, actor: importer.actor, action: 'subject:batch_write',
      anchor: globalContextAnchor, context: { pool: f.pool, deadline: Date.now() + 30000, partition: partitionOf(route) } }),
    release: { digest: f.originalDigest, release: f.original },
    command: { op: 'create', key: randomUUID(), subject: { type: 'ex:Child', labels: { en: 'Source title' } },
      source: { source: 'bangumi', external_id: String(providerId), record_revision: 'v0', digest: 'a'.repeat(64), converter_revision: 'fixture', field_group: 'facts' } },
  });
  if (!('id' in result.value)) throw new Error('Native provider subject was not created');
  matched = result.value.id;
}, 120000);
afterAll(async () => { await f?.close(); });

test('own native HTTP preview, identifier match, explicit unmatched target, skip and private losses', async () => {
  const before = await f.inspect();
  const { uploadId } = await preview([record(), { ...record(999999), subject_type: 1 }, { subject_type: 999, type: 88 }, { type: 2 }]);
  const page = await ok(await f.send('owner', 'GET', `${root}/${uploadId}`));
  expect(page.rows).toHaveLength(4);
  expect(page.next).toBeNull();
  expect(page.rows[0].evidence.source).toEqual(record());
  expect(page.rows[0].evidence.fields).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: 'rate', value: 0, reason: expect.stringContaining('unrated') }),
    expect.objectContaining({ field: 'ep_status', value: 0, reason: expect.stringContaining('episodes') }),
    expect.objectContaining({ field: 'custom', meaning: 'unknown' }),
  ]));
  expect(page.rows[2].evidence.fields.some((v: { field: string }) => v.field === 'rate')).toBe(false);
  expect(await f.inspect()).toEqual(before);
  const a = await review(uploadId, 0);
  expect(a).toMatchObject({ match: 'matched', candidates: [matched], target: matched, proposedState: 'planned' });
  const unmatched = await review(uploadId, 1);
  expect(unmatched.match).toBe('unmatched');
  const selected = await f.createSubject('game');
  const b = await review(uploadId, 1, selected), c = await review(uploadId, 2), d = await review(uploadId, 3);
  expect(b.match).toBe('chosen');
  const confirmed = [choice(0, a), choice(1, b), choice(2, c), choice(3, d, 'omit', true)];
  const result = await apply(uploadId, confirmed);
  expect(result.outcomes.map((o: { status: string }) => o.status)).toEqual(['applied', 'applied', 'unsupported', 'skipped']);
  expect(result.outcomes[0]).toMatchObject({ applied: ['type'], retained: expect.arrayContaining(['comment', 'rate', 'ep_status', 'custom']) });
  expect((await f.commands.readEntry(f.owner.actor, matched)).state).toBe('planned');
  const after = await f.inspect();
  expect(await apply(uploadId, confirmed)).toEqual(result);
  expect(await f.inspect()).toEqual(after);
  expect((await f.send('other', 'GET', `${root}/${uploadId}`)).status).toBe(404);
  expect((await f.send('other', 'POST', `${root}/${uploadId}:review`, { ordinal: 0, target: selected })).status).toBe(404);
  expect((await f.send('other', 'POST', `${root}/${uploadId}:apply`, { rows: confirmed })).status).toBe(404);
});

test('conflict preservation, guarded replacement, stale review refresh and original command retry', async () => {
  const { uploadId } = await preview([{ ...record(), type: 2 }]);
  const initial = await review(uploadId, 0);
  expect(initial).toMatchObject({ match: 'already_matched', conflict: true, current: { state: 'planned' }, proposedState: 'completed' });
  expect((await apply(uploadId, [choice(0, initial)])).outcomes[0].status).toBe('skipped');
  const { uploadId: replace } = await preview([{ ...record(), type: 2 }]);
  const stale = await review(replace, 0);
  const current = await f.commands.readEntry(f.owner.actor, matched);
  await f.commands.putEntry(f.owner.actor, matched, { state: 'paused', revision: current.revision, incarnationId: current.incarnationId }, randomUUID());
  expect((await apply(replace, [choice(0, stale, 'replace')])).outcomes[0].status).toBe('stale');
  const refreshed = await review(replace, 0);
  const confirmed = [choice(0, refreshed, 'replace')];
  const result = await apply(replace, confirmed);
  expect(result.outcomes[0].status).toBe('applied');
  const applied = await f.commands.readEntry(f.owner.actor, matched);
  expect(applied.state).toBe('completed');
  await f.commands.putEntry(f.owner.actor, matched, { state: 'planned', revision: applied.revision, incarnationId: applied.incarnationId }, randomUUID());
  expect(await apply(replace, confirmed)).toEqual(result);
  expect((await f.commands.readEntry(f.owner.actor, matched)).state).toBe('planned');
  const { uploadId: release } = await preview([record()]);
  const old = await review(release, 0);
  await f.activate(f.replacementDigest);
  expect((await apply(release, [choice(0, old, 'replace')])).outcomes[0].status).toBe('stale');
  await f.activate(f.originalDigest);
});

test('bounds, invalid values, cancellation, deletion and terminal authority denial', async () => {
  for (const body of [{ upload: '{' }, upload([]), upload(Array(101).fill({})), { upload: 'x'.repeat(262145) },
    upload([{ comment: 'x'.repeat(8193) }]), upload([{ api_token: 'private note sentinel' }])]) {
    const response = await f.send('owner', 'POST', root + ':preview', body);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('private note sentinel');
  }
  expect((await f.send('anonymous', 'POST', root + ':preview', upload([record()]))).status).toBe(401);
  const { uploadId } = await preview([{ type: 123, subject_type: 999, rate: -1, ep_status: null }, record()]);
  const view = await ok(await f.send('owner', 'GET', `${root}/${uploadId}`));
  expect(view.rows[0].evidence.fields.map((v: { meaning: string }) => v.meaning)).toEqual(['unknown', 'unknown', 'invalid', 'invalid']);
  const r = await review(uploadId, 1);
  expect((await f.send('owner', 'POST', `${root}/${uploadId}:apply`, { rows: Array(6).fill(choice(1, r)) })).status).toBe(400);
  await ok(await f.send('owner', 'POST', `${root}/${uploadId}:cancel`));
  expect((await f.send('owner', 'POST', `${root}/${uploadId}:apply`, { rows: [choice(1, r)] })).status).toBe(409);
  await ok(await f.send('owner', 'DELETE', `${root}/${uploadId}`));
  expect((await f.send('owner', 'GET', `${root}/${uploadId}`)).status).toBe(404);
  const terminal = await preview([record()]);
  const t = await review(terminal.uploadId, 0);
  await f.revokeIdentity(f.owner.actor.accountId);
  for (const [method, path, body] of [['GET', `${root}/${terminal.uploadId}`, undefined],
    ['POST', `${root}/${terminal.uploadId}:apply`, { rows: [choice(0, t, 'replace')] }],
    ['POST', root + ':preview', upload([record()])]] as const) {
    expect([401, 403]).toContain((await f.send('owner', method, path, body)).status);
  }
});
