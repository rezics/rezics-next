import { expect, test } from 'bun:test';
import { fromPlainText, normalizeDocument } from '@rezics/document';
import { listAuthorPosts } from '../../src/content/author-item-reads.ts';
import { prepareAuthorItemContext } from '../../src/content/author-item-context.ts';
import { readPost, readThread } from '../../src/content/reads.ts';
import { routeOf } from '../../src/route/route.ts';
import views from '../../src/access/account-views-read.sql';
import { observeSql } from './support/sql-observer.ts';
import { createReviewLifecycleFixture } from './review-native-lifecycle-fixture.ts';

test('author replies carry only their immediate public parent and retire changed parent context', async () => {
  const f = await createReviewLifecycleFixture();
  try {
    const dependencies = { pool: f.system.database.pool, access: f.system.access, tokens: f.system.tokenKeys };
    const context = { actor: { kind: 'anonymous' as const }, deadline: Date.now() + 120_000 };
    const created = await f.call('POST', '/v1/threads', {
      bearer: f.author.bearer,
      body: { kind: 'review', title: 'Parent context', body: fromPlainText('Opening'), licence: 'CC0-1.0',
        boardId: f.boardId, subjectIds: [f.subjectId], visibility: 'published' },
    });
    expect(created.response.status, created.text).toBe(201);
    const threadId = created.value.thread.id as string;
    async function reply(text: string, parentId?: string) {
      const body = normalizeDocument({ ...fromPlainText(text), doc: { type: 'doc', content: [
        { type: 'paragraph', attrs: { id: 'parent-text', lang: 'ja' }, content: [
          { type: 'text', text, marks: [{ type: 'spoiler' }] },
          { type: 'ruby', attrs: { rt: 'Invisible annotation' }, content: [{ type: 'text', text: 'visible' }] },
        ] },
      ] } });
      const result = await f.call('POST', `/v1/threads/${threadId}/posts`, {
        bearer: f.author.bearer,
        body: { body, licence: 'CC0-1.0', subjectIds: [], ...(parentId ? { parentId } : {}) },
      });
      expect(result.response.status, result.text).toBe(201);
      return result.value.post.id as string;
    }
    const parentId = await reply('Immediate parent '.repeat(80));
    const childId = await reply('Child', parentId);
    const thread = (await readThread(dependencies, threadId, context)).value!;
    const post = (await readPost(dependencies, threadId, childId, context)).value!;
    const reference = { thread, post };
    const prepared = await prepareAuthorItemContext(dependencies, [reference], context);
    const result = (await prepared.finish()).get(childId)!;
    expect(result.parentContext).toMatchObject({ kind: 'reply', parent: {
      state: 'available', id: parentId, author: null, spoiler: true, language: 'ja',
    } });
    if (result.parentContext?.kind !== 'reply' || result.parentContext.parent.state !== 'available')
      throw new Error('Expected disclosed parent');
    expect(result.parentContext.parent.excerpt!.length).toBeLessThanOrEqual(160);
    const parent = (await readPost(dependencies, threadId, parentId, context)).value!;
    if (parent.availability !== 'available') throw new Error('Expected available exact parent');
    expect(result.parentContext.parent.revisionId).toBe(parent.revisionId);
    expect(JSON.stringify(result)).not.toContain('Opening');
    expect(JSON.stringify(result)).not.toContain('Invisible annotation');
    const changing = await prepareAuthorItemContext(dependencies, [reference], context);
    const removed = await f.call('DELETE', `/v1/posts/${parentId}`, { bearer: f.author.bearer });
    expect(removed.response.status, removed.text).toBe(204);
    expect((await changing.finish()).get(childId)?.parentContext).toEqual({
      kind: 'reply', parent: { state: 'withheld' },
    });
    await expect(changing.finish()).rejects.toThrow('finish only once');
  } finally {
    await f.close();
  }
}, 240_000);

test('author page refuses publication revoked after selection without returning a replacement page', async () => {
  const f = await createReviewLifecycleFixture();
  const observer = observeSql(f.system.database.pool);
  try {
    const created = await f.call('POST', '/v1/threads', {
      bearer: f.author.bearer,
      body: { kind: 'review', title: 'Publication fence', body: fromPlainText('Opening'), licence: 'CC0-1.0',
        boardId: f.boardId, subjectIds: [f.subjectId], visibility: 'published' },
    });
    expect(created.response.status, created.text).toBe(201);
    const reply = await f.call('POST', `/v1/threads/${created.value.thread.id}/posts`, {
      bearer: f.author.bearer,
      body: { body: fromPlainText('Published reply'), licence: 'CC0-1.0', subjectIds: [] },
    });
    expect(reply.response.status, reply.text).toBe(201);
    const gate = observer.hold({ statement: views.sql }, 'after');
    const pending = listAuthorPosts(
      { pool: f.system.database.pool, access: f.system.access, tokens: f.system.tokenKeys },
      f.author.accountId,
      { actor: { kind: 'anonymous' }, deadline: Date.now() + 120_000 },
    );
    // Attach rejection before releasing the real asynchronous boundary.
    const outcome = expect(pending).rejects.toMatchObject({ code: 'dependency_unavailable' });
    try {
      await gate.entered;
      await f.admin.query('UPDATE access.account SET public_views=$3::jsonb WHERE route=$1 AND account_id=$2',
        [routeOf(f.author.accountId), f.author.accountId, JSON.stringify({ posts: false, reviews: true })]);
    } finally {
      gate.release();
    }
    await outcome;
  } finally {
    await observer.close();
    await f.close();
  }
}, 240_000);
