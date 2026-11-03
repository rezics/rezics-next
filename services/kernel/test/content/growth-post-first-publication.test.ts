import { expect, setDefaultTimeout, test } from 'bun:test';
import insertRevision from '../../src/content/insert-revision.sql';
import updateHead from '../../src/content/update-head.sql';
import publishOpeningThread from '../../src/content/publish-opening-thread.sql';
import fence from '../../src/command/fence.sql';
import { publicationType } from './support/post-publication-fixture.ts';
import { observeSql, type SqlExecution } from './support/sql-observer.ts';
import {
  assertGrowthAccessPaths, capture, checkGrowth, type GrowthReport,
} from '../support/growth.ts';
import {
  growthPostFirstPublicationFixture, publicationScales, publicationBody,
  type PublicationKind, type PublicationTarget,
} from './support/growth-post-first-publication-fixture.ts';

setDefaultTimeout(1_800_000);
type Fixture = Awaited<ReturnType<typeof growthPostFirstPublicationFixture>>;

function writes(records: readonly SqlExecution[]) {
  return records.filter(r => [insertRevision.sql, updateHead.sql, publishOpeningThread.sql, fence.sql].includes(r.statement));
}

/** Bind the measured writes to this exact source and native command envelope,
 * so a cheap HTTP response or event-only observation cannot satisfy growth. */
function publicationBindings(records: readonly SqlExecution[], target: PublicationTarget, revisionId: string,
  state: { security_revision: string; thread_security_revision: string }) {
  const one = (sql: string) => {
    const matches = records.filter(r => r.statement === sql);
    expect(matches).toHaveLength(1);
    return matches[0]!;
  };
  const revision = one(insertRevision.sql);
  expect(revision.parameters[insertRevision.params.indexOf('post_id')]).toBe(target.post.id);
  expect(revision.parameters[insertRevision.params.indexOf('revision_id')]).toBe(revisionId);
  const head = one(updateHead.sql);
  expect(head.parameters[updateHead.params.indexOf('previous_revision_id')]).toBe(target.post.revisionId);
  expect(head.parameters[updateHead.params.indexOf('revision_id')]).toBe(revisionId);
  expect(head.parameters[updateHead.params.indexOf('previous_visibility')]).toBe('draft');
  expect(head.parameters[updateHead.params.indexOf('visibility')]).toBe('published');
  expect(head.parameters[updateHead.params.indexOf('security_revision')]).toBe(state.security_revision);
  if (target.ancestry === 1) {
    const thread = one(publishOpeningThread.sql);
    expect(thread.parameters[publishOpeningThread.params.indexOf('thread_id')]).toBe(target.threadId);
    expect(thread.parameters[publishOpeningThread.params.indexOf('post_id')]).toBe(target.post.id);
    expect(thread.parameters[publishOpeningThread.params.indexOf('security_revision')]).toBe(state.thread_security_revision);
  } else expect(records.filter(r => r.statement === publishOpeningThread.sql)).toHaveLength(0);
  const commit = one(fence.sql);
  const json = (name: 'events' | 'basis' | 'receipt') => {
    const value = commit.parameters[fence.params.indexOf(name)];
    return typeof value === 'string' ? JSON.parse(value) : value;
  };
  expect(json('events')).toMatchObject([
    { type: 'com.rezics.content.revision.created.v1', subject: target.post.id, data: { revisionId } },
    { type: publicationType, subject: target.post.id, data: { revisionId } },
  ]);
  expect(json('events')).toHaveLength(2);
  expect(json('basis')).toMatchObject({ principal: { kind: 'account' }, clientId: expect.any(String) });
  expect(json('receipt')).toMatchObject({ kind: 'content.post.revise', response: {
    threadId: target.threadId, itemId: target.post.id, revisionId,
  } });
}

function growthEvidence(report: GrowthReport, kind: PublicationKind) {
  expect(report.samples.map(s => s.scale)).toEqual([...publicationScales]);
  const relations = new Set<string>();
  for (const sample of report.samples) {
    expect(sample.repetitions.length).toBeGreaterThan(0);
    expect(sample.statementRepetitions).toHaveLength(sample.repetitions.length);
    for (const [i, cost] of sample.repetitions.entries()) {
      expect(cost.rows).toBeGreaterThan(0);
      expect(cost.blocks).toBeGreaterThan(0);
      expect(cost.plans).toBeGreaterThan(0);
      expect(cost.blocks).toBe(cost.sharedHit + cost.sharedRead);
      Object.keys(cost.relations).forEach(r => relations.add(r));
      const statements = sample.statementRepetitions[i]!;
      const count = (pattern: RegExp) => statements.filter(s => pattern.test(s.statement)).reduce((n, s) => n + s.count, 0);
      // This is the new producer's write envelope, not the old published-edit
      // budget: one revision, one post CAS, one fence, plus the opening update.
      expect(count(/insert into content\.revision/i)).toBe(1);
      expect(count(/update content\.post\s+p/i)).toBe(1);
      expect(count(/update content\.thread\s+set visibility/i)).toBe(kind === 'opening' ? 1 : 0);
      expect(count(/insert into core\.outbox/i)).toBe(1);
      expect(count(/insert into core\.receipt/i)).toBe(1);
      expect(count(/insert into editorial\.write_basis/i)).toBe(1);
      expect(count(/access\./i)).toBeGreaterThan(0);
      expect(count(/from content\.post/i)).toBeGreaterThan(0);
      expect(count(/from content\.thread/i)).toBeGreaterThan(0);
    }
  }
  expect(relations.size).toBeGreaterThan(0);
  assertGrowthAccessPaths(report.name, report.samples, [...relations]);
}

for (const kind of ['opening', 'reply'] as const) {
  for (const axis of ['unrelated', 'revisions', 'history'] as const) {
    test(`native ${kind} first publication stays bounded under independent ${axis} growth`, async () => {
      const f = await growthPostFirstPublicationFixture();
      const observer = observeSql(f.db.pool);
      let target: PublicationTarget;
      let before: Awaited<ReturnType<Fixture['snapshot']>>;
      let completed: { target: PublicationTarget; before: typeof before; revisionId: string } | undefined;
      async function verifyCompleted() {
        if (completed) {
          await f.assertPublished(completed.target, completed.revisionId, completed.before);
          completed = undefined;
        }
      }
      async function prepare(scale: number) {
        await verifyCompleted();
        target = await f.draft(kind, axis === 'revisions' ? scale : 0);
        before = await f.snapshot(target);
      }
      async function publish() {
        const start = observer.records.length;
        const result = await f.revise(target.post);
        expect(result.status, JSON.stringify(result.value)).toBe(200);
        const revisionId = result.value.post.revisionId as string;
        expect(revisionId).not.toBe(target.post.revisionId);
        publicationBindings(observer.records.slice(start), target, revisionId, before.state);
        completed = { target, before, revisionId };
      }
      try {
        const report = await checkGrowth(f.db, {
          name: `native ${kind} first publication / ${axis}`,
          scales: publicationScales,
          bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
          rule: 'series',
          async grow(_db, scale, previous) {
            await verifyCompleted();
            await f.grow(axis, scale, previous);
            await prepare(scale); // Spare warmup draft is outside capture too.
          },
          warmup: publish,
          prepare: async (_db, scale) => prepare(scale),
          operation: publish,
        });
        await verifyCompleted();
        growthEvidence(report, kind);
      } finally {
        try { await observer.close(); } finally { await f.close(); }
      }
    });
  }
}

test('native first publication pins its revision across replay, silent edits, stale competition and ancestor refusal', async () => {
  const f = await growthPostFirstPublicationFixture();
  const observer = observeSql(f.db.pool);
  try {
    for (const kind of ['opening', 'reply'] as const) {
      const target = await f.draft(kind);
      const before = await f.snapshot(target);
      const key = crypto.randomUUID();
      const first = await capture(f.db, () => f.revise(target.post, { visibility: 'published' }, { key }));
      expect(first.value.status).toBe(200);
      const published = first.value.value.post;
      await f.assertPublished(target, published.revisionId, before);
      const publishedState = await f.snapshot(target);
      const start = observer.records.length;
      const replay = await capture(f.db, () => f.revise(target.post, { visibility: 'published' }, { key }));
      expect(replay.value.status).toBe(200);
      expect(replay.value.value.post.revisionId).toBe(published.revisionId);
      expect(writes(observer.records.slice(start))).toEqual([]);
      expect(await f.snapshot(target)).toEqual(publishedState);
      const later = await capture(f.db, () => f.revise(published, {}));
      expect(later.value.status).toBe(200);
      expect(later.value.value.post.revisionId).not.toBe(published.revisionId);
      expect(later.value.value.post.visibility).toBe('published');
      const afterLater = await f.snapshot(target);
      expect(afterLater.state.security_revision).toBe(publishedState.state.security_revision);
      expect(afterLater.state.thread_security_revision).toBe(publishedState.state.thread_security_revision);
      const replayAfterEdit = await capture(f.db, () => f.revise(target.post, { visibility: 'published' }, { key }));
      expect(replayAfterEdit.value.value.post.revisionId).toBe(published.revisionId);
      expect(await f.snapshot(target)).toEqual(afterLater);
      expect(await f.publications(target.post.id)).toHaveLength(1);
      const exact = await f.call('GET', `/v1/posts/${target.post.id}/revisions/${published.revisionId}`);
      expect(exact.value.post.body).toEqual(publicationBody);
      const stale = await capture(f.db, () => f.revise(target.post));
      expect(stale.value.status).toBe(412);
      expect(await f.snapshot(target)).toEqual(afterLater);

      const rival = await f.draft(kind);
      const competition = await capture(f.db, () => Promise.all([f.revise(rival.post), f.revise(rival.post)]));
      const winners = competition.value.filter(r => r.status === 200);
      expect(winners).toHaveLength(1);
      expect([404, 412]).toContain(competition.value.find(r => r.status !== 200)!.status);
      expect((await f.publications(rival.post.id))[0]!.data.revisionId).toBe(winners[0]!.value.post.revisionId);
      expect(await f.publications(rival.post.id)).toHaveLength(1);
    }
    // Real native ancestor loss, with an allowed sibling as the identity and
    // permission control. No Access result or selected visibility is injected.
    const denied = await f.draft('reply');
    const allowed = await f.draft('reply');
    const ancestor = await f.native.reply(denied.threadId, 'published');
    const child = await f.native.reply(denied.threadId, 'draft', ancestor.id);
    const selected = { ...denied, post: child, ancestry: 2 };
    await f.checked('POST', `/v1/posts/${ancestor.id}:takeDown`, { reason: 'Ancestor growth control' }, 200);
    const refusedBefore = await f.snapshot(selected);
    const start = observer.records.length;
    const refused = await capture(f.db, () => f.revise(child));
    expect(refused.value.status).toBe(404);
    expect(writes(observer.records.slice(start))).toEqual([]);
    expect(await f.snapshot(selected)).toEqual(refusedBefore);
    expect(await f.publications(child.id)).toEqual([]);
    const controlBefore = await f.snapshot(allowed);
    const control = await capture(f.db, () => f.revise(allowed.post));
    expect(control.value.status).toBe(200);
    await f.assertPublished(allowed, control.value.value.post.revisionId, controlBefore);
  } finally {
    try { await observer.close(); } finally { await f.close(); }
  }
});

test('a supported event-fence failure rolls back opening and thread security, revision, receipt, basis and outbox', async () => {
  const f = await growthPostFirstPublicationFixture();
  const observer = observeSql(f.db.pool);
  try {
    const target = await f.draft('opening');
    const before = await f.snapshot(target);
    const key = crypto.randomUUID();
    observer.armFault({ match: { statement: fence.sql }, boundary: 'after', error: new Error('publication event fence fault') });
    const start = observer.records.length;
    const failed = await capture(f.db, () => f.revise(target.post, { visibility: 'published' }, { key }));
    expect(failed.value.status).toBe(500);
    const records = observer.records.slice(start);
    expect(records.some(r => r.statement === insertRevision.sql)).toBe(true);
    expect(records.some(r => r.statement === updateHead.sql)).toBe(true);
    expect(records.some(r => r.statement === publishOpeningThread.sql)).toBe(true);
    expect(records.some(r => r.statement === fence.sql)).toBe(true);
    expect(records.some(r => /^ROLLBACK\s*;?$/i.test(r.statement))).toBe(true);
    expect(await f.snapshot(target)).toEqual(before);
    expect((await f.call('GET', `/v1/threads/${target.threadId}`, undefined, { anonymous: true })).status).toBe(404);
    const retried = await capture(f.db, () => f.revise(target.post, { visibility: 'published' }, { key }));
    expect(retried.value.status).toBe(200);
    await f.assertPublished(target, retried.value.value.post.revisionId, before);
    expect((await f.call('GET', `/v1/threads/${target.threadId}`, undefined, { anonymous: true })).status).toBe(200);
  } finally {
    try { await observer.close(); } finally { await f.close(); }
  }
});
