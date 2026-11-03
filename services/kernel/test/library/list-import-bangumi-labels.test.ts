import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { createBangumiImport } from '../../src/library/list-import-bangumi.ts';
import { createPersonalLabelCommands } from '../../src/library/label-commands.ts';
import { createLabelAssignmentCommands } from '../../src/library/label-assignment-commands.ts';
import { bangumiTagEvidence, bangumiTag } from '../../src/library/list-import-bangumi-label-model.ts';
import { parseBangumiUpload } from '../../src/library/list-import-bangumi-model.ts';
import { testRouteKey } from '../support/test-kernel.ts';
import { routeOf } from '../../src/route/route.ts';
let f: NativeProfileFixture;
const base = '/v1/libraryImports/bangumi';
const wrapper = (collections: unknown[]) => JSON.stringify({ format: 'rezics.bangumi-collection.v1', collections });
const send = (path: string, body?: unknown, persona = 'owner') =>
  f.send(persona, body === undefined ? 'GET' : 'POST', base + path, body);
async function json(r: Response) {
  expect(r.status).toBe(200);
  return r.json();
}
const native = () => ({ pool: f.pool, access: f.access, tokens: f.tokens, routeKey: testRouteKey() });
const catalogue = () => createPersonalLabelCommands(native());
const assignments = () => createLabelAssignmentCommands(native());
async function label(name = randomUUID()) {
  return (await catalogue().createLabel(f.owner.actor, { name }, randomUUID())).value.label;
}
async function retained(tags: unknown, target?: string) {
  const subject = target ?? (await f.createSubject('game'));
  const p = await json(
    await send(':preview', {
      upload: wrapper([
        { tags, subject_type: 4, type: 1, private: false, comment: 'private source only', updated_at: '2001-01-01' },
      ]),
    }),
  );
  const r = await json(await send(`/${p.uploadId}:review`, { ordinal: 0, target: subject }));
  return { id: p.uploadId as string, revision: r.review.token as string, subject };
}
async function review(r: { id: string; revision: string }, mappings: unknown[]) {
  return (await json(await send(`/${r.id}:reviewLabels`, { ordinal: 0, rowRevision: r.revision, mappings }))).labels
    .review;
}
async function apply(id: string, token: string) {
  return json(await send(`/${id}:applyLabels`, { ordinal: 0, reviewToken: token }));
}
beforeAll(async () => {
  f = await createProfileEntryFixture();
}, 120000);
afterAll(async () => {
  await f?.close();
});

test('installed evidence keeps missing, empty, invalid, unknown and native-name failures separate', () => {
  const evidence = parseBangumiUpload(
    wrapper([{}, { tags: [] }, { tags: ['valid', 7] }, { tags: ['', 'x'.repeat(101), ' e\u0301  label ', '\u0001'] }]),
  );
  expect(evidence.map(bangumiTagEvidence)).toEqual(['missing', 'empty', 'invalid', 'known']);
  expect(bangumiTag(evidence[2]!, 0)?.status).toBe('invalid');
  expect([0, 1, 2, 3].map((i) => bangumiTag(evidence[3]!, i)?.proposedName)).toEqual([null, null, 'é label', null]);
  const unknown = {
    ...evidence[2]!,
    fields: [{ field: 'tags', value: ['future'], meaning: 'unknown' as const, reason: 'future' }],
  };
  expect(bangumiTagEvidence(unknown)).toBe('unknown');
  expect(bangumiTag(unknown, 0)?.status).toBe('unknown');
});
test('owner adopts existing/new labels, reopens assignments, preserves state and retries original native identities', async () => {
  const existing = await label(),
    r = await retained(['one', ' new  private ', 'one', '', 'same target']);
  const stateChoice = { ordinal: 0, reviewToken: r.revision, state: 'preserve', skip: false };
  const stateResult = await json(await send(`/${r.id}:apply`, { rows: [stateChoice] }));
  expect(stateResult.outcomes[0].status).toBe('applied');
  const accepted = await f.commands.readEntry(f.owner.actor, r.subject);
  await f.commands.putEntry(
    f.owner.actor,
    r.subject,
    { state: 'paused', revision: accepted.revision, incarnationId: accepted.incarnationId },
    randomUUID(),
  );
  const state = await f.commands.readEntry(f.owner.actor, r.subject);
  const before = await f.inspect();
  const v = await review(r, [
    { index: 0, target: { labelId: existing.id } },
    { index: 1, target: { name: ' new  private ' } },
    { index: 2, target: { name: 'must not create' } },
    { index: 3, target: { labelId: existing.id } },
    { index: 4, target: { labelId: existing.id } },
  ]);
  expect(v.items.map((i: { status: string }) => i.status)).toEqual([
    'ready',
    'ready',
    'duplicate',
    'invalid',
    'duplicate',
  ]);
  const result = await apply(r.id, v.token);
  expect(result.outcomes.map((i: { status: string }) => i.status)).toEqual([
    'assigned',
    'assigned',
    'duplicate',
    'invalid',
    'duplicate',
  ]);
  expect(result.remaining).toEqual([]);
  const opened = await assignments().listAssignments(f.owner.actor, { subjectId: r.subject });
  expect(opened.assignments.map((i) => i.labelId).sort()).toEqual([existing.id, result.outcomes[1].label.id].sort());
  expect(await catalogue().readLabel(f.owner.actor, result.outcomes[1].label.id)).toMatchObject({
    name: 'new private',
  });
  expect(await json(await send(`/${r.id}:apply`, { rows: [stateChoice] }))).toEqual(stateResult);
  expect(await f.commands.readEntry(f.owner.actor, r.subject)).toEqual(state);
  const after = await f.inspect();
  for (const field of ['sessions', 'copies', 'follows', 'entitlements'] as const)
    expect(after[field]).toEqual(before[field]);
  expect(await apply(r.id, v.token)).toEqual(result);
  // Lose only the producer acknowledgement; native create/assign receipts are the retry authority.
  await f.pool.query(
    `UPDATE library.bangumi_upload_row SET labels=jsonb_set(labels,'{outcomes}','[]')
    WHERE route=$1 AND account_id=$2 AND upload_id=$3`,
    [routeOf(f.owner.actor.accountId), f.owner.actor.accountId, r.id],
  );
  expect(await apply(r.id, v.token)).toEqual(result);
  expect((await assignments().listAssignments(f.owner.actor, { subjectId: r.subject })).assignments).toEqual(
    opened.assignments,
  );
  const next = await review(r, [{ index: 0, target: { labelId: existing.id } }]);
  expect((await apply(r.id, next.token)).outcomes[0].status).toBe('unchanged');
  expect((await send(`/${r.id}:applyLabels`, { ordinal: 0, reviewToken: v.token })).status).toBe(409);
  expect((await send(`/${r.id}/rows/0/tags`, undefined, 'other')).status).toBe(404);
  expect((await send(`/${r.id}:applyLabels`, { ordinal: 0, reviewToken: next.token }, 'other')).status).toBe(404);
  expect((await send(`/${r.id}/rows/0/tags`)).headers.get('cache-control')).toBe('private, no-store');
  const unprofiled = await retained(['independent'], await f.createSubject('unprofiled'));
  const independent = await review(unprofiled, [{ index: 0, target: { labelId: existing.id } }]);
  expect(independent.subject.releaseDigest).toBeNull();
  expect((await apply(unprofiled.id, independent.token)).outcomes[0].status).toBe('assigned');
  await expect(f.commands.readEntry(f.owner.actor, unprofiled.subject)).rejects.toThrow();
}, 120000);
test('changed row/review, deleted/recreated targets and current profile loss require new confirmation', async () => {
  const name = randomUUID(),
    target = await label(name),
    r = await retained(['tag']);
  const v = await review(r, [{ index: 0, target: { labelId: target.id } }]);
  await catalogue().deleteLabel(f.owner.actor, target.id, target.revision, randomUUID());
  const recreated = await label(name);
  expect((await apply(r.id, v.token)).outcomes[0].status).toBe('stale');
  const fresh = await review(r, [{ index: 0, target: { labelId: recreated.id } }]);
  const changed = await json(await send(`/${r.id}:review`, { ordinal: 0, target: r.subject }));
  expect((await send(`/${r.id}:applyLabels`, { ordinal: 0, reviewToken: fresh.token })).status).toBe(409);
  r.revision = changed.review.token;
  const current = await review(r, [{ index: 0, target: { labelId: recreated.id } }]);
  await f.activate(f.replacementDigest);
  expect((await apply(r.id, current.token)).outcomes[0].status).toBe('stale');
  await f.activate(f.originalDigest);
  expect((await assignments().listAssignments(f.owner.actor, { subjectId: r.subject })).assignments).toEqual([]);
}, 120000);
test('native 32-slot capacity preserves unchanged outcomes and reclaims only a deleted parent reservation', async () => {
  const r = await retained(['already', 'overflow']),
    ids: string[] = [];
  for (let i = 0; i < 32; i++) {
    const l = await label();
    ids.push(l.id);
    await assignments().assignLabel(f.owner.actor, l.id, { subjectId: r.subject }, randomUUID());
  }
  const overflow = await label();
  const v = await review(r, [
    { index: 0, target: { labelId: ids[0]! } },
    { index: 1, target: { labelId: overflow.id } },
  ]);
  expect((await apply(r.id, v.token)).outcomes.map((o: { status: string }) => o.status)).toEqual([
    'unchanged',
    'capacity',
  ]);
  await catalogue().deleteLabel(f.owner.actor, ids[1]!, 1, randomUUID());
  const fresh = await review(r, [{ index: 1, target: { labelId: overflow.id } }]);
  expect((await apply(r.id, fresh.token)).outcomes[0].status).toBe('assigned');
  expect(
    (await assignments().listAssignments(f.owner.actor, { subjectId: r.subject, limit: 100 })).assignments,
  ).toHaveLength(32);
}, 180000);
test('tag pages preserve maximum admitted text, reject negative targets and bound lifetime effects', async () => {
  const r = await retained(Array.from({ length: 65 }, (_, i) => `tag ${i}`));
  for (const [after, count, next] of [
    [-1, 32, 31],
    [31, 32, 63],
    [63, 1, null],
  ]) {
    const page = await json(await send(`/${r.id}/rows/0/tags?after=${after}`));
    expect(page.tags).toHaveLength(count as number);
    expect(page.next).toBe(next);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(65536);
  }
  const missing = await json(
    await send(':preview', { upload: wrapper([{}, { tags: [] }, { tags: ['x', 3] }, { tags: ['x'.repeat(8000)] }]) }),
  );
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await json(await send(`/${missing.uploadId}/rows/${i}/tags`))).evidence);
  expect(statuses).toEqual(['missing', 'empty', 'invalid', 'known']);
  const max = await json(await send(`/${missing.uploadId}/rows/3/tags`));
  expect(max.tags[0]).toMatchObject({ value: 'x'.repeat(8000), status: 'invalid', proposedName: null });
  const foreign = (
    await createPersonalLabelCommands(native()).createLabel(f.other.actor, { name: randomUUID() }, randomUUID())
  ).value.label;
  expect(
    (
      await send(`/${r.id}:reviewLabels`, {
        ordinal: 0,
        rowRevision: r.revision,
        mappings: [{ index: 0, target: { labelId: foreign.id } }],
      })
    ).status,
  ).toBe(404);
  const v = await review(
    r,
    Array.from({ length: 16 }, (_, index) => ({ index, target: { name: randomUUID() } })),
  );
  const accepted = await apply(r.id, v.token);
  expect(accepted.outcomes.every((o: { status: string }) => o.status === 'assigned')).toBe(true);
  const limit = await review(r, [{ index: 16, target: { name: randomUUID() } }]);
  expect((await apply(r.id, limit.token)).outcomes[0].status).toBe('limit');
  const unchanged = await review(r, [{ index: 0, target: { labelId: accepted.outcomes[0].label.id } }]);
  expect((await apply(r.id, unchanged.token)).outcomes[0].status).toBe('unchanged');
}, 180000);
test('partial interruption, cancel and source removal retain accepted native facts and remove new review evidence', async () => {
  const r = await retained(['first', 'second']);
  const v = await review(r, [
    { index: 0, target: { name: randomUUID() } },
    { index: 1, target: { name: randomUUID() } },
  ]);
  let probes = 0;
  const interrupted = {
    get aborted() {
      return probes++ > 0;
    },
  } as AbortSignal;
  const result = await createBangumiImport(native()).applyLabels(
    f.owner.actor,
    r.id,
    0,
    v.token,
    interrupted,
    Date.now() + 120000,
  );
  expect(result.outcomes.map((o) => o.status)).toEqual(['assigned']);
  expect(result.remaining).toEqual([1]);
  await json(await send(`/${r.id}:cancel`, {}));
  expect((await send(`/${r.id}:applyLabels`, { ordinal: 0, reviewToken: v.token })).status).toBe(409);
  expect(
    (await f.pool.query('SELECT labels FROM library.bangumi_upload_row WHERE upload_id=$1', [r.id])).rows[0].labels,
  ).toBeNull();
  expect((await assignments().listAssignments(f.owner.actor, { subjectId: r.subject })).assignments).toHaveLength(1);
  expect((await f.send('owner', 'DELETE', `${base}/${r.id}`)).status).toBe(200);
  expect((await send(`/${r.id}/rows/0/tags`)).status).toBe(404);
  expect((await assignments().listAssignments(f.owner.actor, { subjectId: r.subject })).assignments).toHaveLength(1);
  const terminal = await retained(['private']);
  const t = await review(terminal, [{ index: 0, target: { name: randomUUID() } }]);
  await f.revokeIdentity(f.owner.actor.accountId);
  expect([401, 403]).toContain(
    (await send(`/${terminal.id}:applyLabels`, { ordinal: 0, reviewToken: t.token })).status,
  );
}, 120000);
