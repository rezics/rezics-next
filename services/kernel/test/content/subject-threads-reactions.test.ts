import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { readSubjectThread } from '../../src/content/reads.ts';
import { projectSubjectThreadReactions } from '../../src/content/subject-threads-reactions.ts';
import viewerReactions from '../../src/content/reaction-viewer.sql';
import reactionCounts from '../../src/content/reaction-count-page.sql';
import { routeOf } from '../../src/route/route.ts';
import { createReactionRelayBase } from './reaction-relay-convergence-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

test('Subject threads retain native reaction totals, viewer isolation and final source authority', async () => {
  const world = await createReactionRelayBase();
  let effects: Awaited<ReturnType<typeof world.startEffects>> | undefined;
  let trace: ReturnType<typeof observeSql> | undefined;
  try {
    effects = await world.startEffects();
    const created = await world.command<{ thread: { id: string } }>('POST', '/v1/threads', {
      title: 'A Subject discussion',
      body: fromPlainText('Original opening'),
      licence: 'CC0-1.0',
      subjectIds: [world.conceptId],
      boardId: world.mainBoardId,
      visibility: 'published',
    });
    const threadId = created.thread.id;
    const path = `/v1/subjects/${world.conceptId}/threads?place=${world.mainTarget.realmId}&kind=discussion`;
    const reactionPath = `/v1/threads/${threadId}/reaction`;
    const page = async (bearer?: string) => {
      const result = await world.call('GET', path, { bearer });
      expect(result.response.status, result.text).toBe(200);
      expect(result.value?.threads.map((entry: { id: string }) => entry.id)).toEqual([threadId]);
      return result;
    };
    for (const kind of ['love', 'like'] as const) {
      const capture = await effects.captureBeforeWrite(world.other.accountId);
      await world.command('PUT', reactionPath, { kind }, { bearer: world.other.bearer });
      const written = await capture.read();
      await effects.waitForEffect(written.envelope, written.eventSeq);
      const current = await page(world.other.bearer);
      expect(current.value?.threads[0]).toMatchObject({ reactions: { [kind]: 1 }, viewerReaction: kind });
      expect(Object.keys(current.value?.threads[0].reactions)).toEqual([kind]);
      expect(current.value?.reactionsAsOf).toMatchObject({ epoch: expect.any(Number), position: expect.any(String) });
      expect(current.response.headers.get('cache-control')).toBe('private, no-store');
    }
    expect((await page(world.author.bearer)).value?.threads[0].viewerReaction).toBeNull();
    expect((await page()).value?.threads[0]).not.toHaveProperty('viewerReaction');
    const capture = await effects.captureBeforeWrite(world.other.accountId);
    await world.command('DELETE', reactionPath, undefined, { bearer: world.other.bearer });
    const cleared = await capture.read();
    await effects.waitForEffect(cleared.envelope, cleared.eventSeq);
    expect((await page(world.other.bearer)).value?.threads[0]).toMatchObject({ reactions: {}, viewerReaction: null });

    const pool = world.system.database.pool;
    const deps = { pool, access: world.system.access, tokens: world.system.tokenKeys };
    const context = { actor: { kind: 'anonymous' as const }, deadline: Date.now() + 60_000 };
    const selected = await readSubjectThread(deps, threadId, world.conceptId, world.mainTarget.realmId, context);
    expect(selected.value).not.toBeNull();
    await pool.query('UPDATE content.thread SET title=$3 WHERE route=$1 AND thread_id=$2', [
      routeOf(threadId),
      threadId,
      'Changed opening',
    ]);
    await expect(
      projectSubjectThreadReactions(deps, world.conceptId, world.mainTarget.realmId, [selected.value!], context),
    ).rejects.toMatchObject({ code: 'dependency_unavailable' });
    expect((await page()).value?.threads[0].title).toBe('Changed opening');

    trace = observeSql(pool);
    trace.armFault({
      match: { statement: reactionCounts.sql },
      boundary: 'before',
      error: new Error('Subject reaction source failed'),
    });
    await expect(
      projectSubjectThreadReactions(deps, world.conceptId, world.mainTarget.realmId, [selected.value!], context),
    ).rejects.toThrow('Subject reaction source failed');
    const barrier = trace.hold({ statement: viewerReactions.sql }, 'after');
    const pending = world.call('GET', path, { bearer: world.other.bearer });
    await barrier.entered;
    try {
      await pool.query(
        "UPDATE content.board SET visibility='taken_down',security_revision=security_revision+1 WHERE route=$1 AND board_id=$2",
        [routeOf(world.mainBoardId), world.mainBoardId],
      );
    } finally {
      barrier.release();
    }
    const withheld = await pending;
    expect(withheld.response.status, withheld.text).toBe(200);
    expect(withheld.value?.threads).toEqual([]);
    expect(withheld.value?.next).toBeNull();
  } finally {
    await trace?.close();
    await effects?.stop();
    await world.system.close();
  }
});
