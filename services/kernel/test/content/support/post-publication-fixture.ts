import { expect } from 'bun:test';
import { fromPlainText, normalizeDocument } from '@rezics/document';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { createNativeContentSystemWithWriteRateOverrides } from './native-system.ts';

export type PublicationPost = { id: string; revisionId: string; visibility: string };
export const publicationType = 'com.rezics.content.post.published.v1';
export const mentionDocument = (accountId: string) => normalizeDocument({
  version: 'rezics-document-v1', profile: 'text',
  doc: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'publication' },
    content: [{ type: 'mention', attrs: { accountId } }] }] },
});

/** All authoring and container setup use native authenticated routes. SQL only
 * observes committed evidence and installs the isolated rollback fault. */
export async function postPublicationFixture() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
  const system = await createNativeContentSystemWithWriteRateOverrides(
    { databaseUrl: process.env.DATABASE_URL },
    JSON.stringify({ 'new-account': { write: { maximum: 100_000, seconds: 86_400 } } }),
  );
  const pool = system.database.pool;
  const author = system.actors.author;
  async function call(method: string, path: string, body?: unknown,
    options: { other?: boolean; anonymous?: boolean; key?: string; head?: string } = {}) {
    const response = await system.kernel.handle(new Request(`https://content.test${path}`, {
      method,
      headers: {
        ...(options.anonymous ? {} : { authorization: `Bearer ${(options.other ? system.actors.other : author).bearer}` }),
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(options.key ?? crypto.randomUUID()) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.head === undefined ? {} : { 'if-match': JSON.stringify(options.head) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    return { status: response.status, value: await response.json() as Record<string, any> };
  }
  async function command(path: string, body: unknown, status = 201, method = 'POST', head?: string) {
    const result = await call(method, path, body, { head });
    expect(result.status, JSON.stringify(result.value)).toBe(status);
    return result.value;
  }
  try {
    await bootstrapRelease(pool, bundledRelease);
    const { subject: scheme } = await command('/v1/subjects', {
      type: 'skos:ConceptScheme', labels: { en: 'Publication' },
    });
    const { subject: concept } = await command('/v1/subjects', {
      type: 'skos:Concept', labels: { en: 'Publication board' },
      statements: { 'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }] },
    });
    const { space } = await command('/v1/spaces', { title: 'Publication' });
    const { realm } = await command('/v1/realms', {
      spaceId: space.spaceId, title: 'Publication', visibility: 'public', contextId: GLOBAL_CONTEXT,
    });
    await command(`/v1/realms/${realm.realmId}/boardScheme`, { schemeId: scheme.id }, 200, 'PUT', realm.headRevisionId);
    const { board } = await command(`/v1/realms/${realm.realmId}/boards`, {
      conceptId: concept.id, title: 'Publication', visibility: 'published',
    });
    async function thread(visibility: 'draft' | 'published' = 'published') {
      const { thread } = await command('/v1/threads', {
        title: 'Publication', body: fromPlainText('Opening'), licence: 'MIT', subjectIds: [], boardId: board.id, visibility,
      });
      return thread as { id: string; firstPost: PublicationPost };
    }
    async function reply(threadId: string, visibility?: 'draft' | 'published', parentId?: string) {
      const { post } = await command(`/v1/threads/${threadId}/posts`, {
        body: mentionDocument(system.actors.other.actor.accountId), licence: 'MIT',
        ...(visibility === undefined ? {} : { visibility }), ...(parentId === undefined ? {} : { parentId }),
      });
      return post as PublicationPost;
    }
    const revise = (post: PublicationPost, body: Record<string, unknown>, options: Parameters<typeof call>[3] = {}) =>
      call('POST', `/v1/posts/${post.id}/revisions`, { body: fromPlainText('Revised'), ...body }, { head: post.revisionId, ...options });
    async function evidence(id: string) {
      return (await pool.query(
        `SELECT type,data FROM core.outbox WHERE data->>'itemId'=$1 ORDER BY position,event_seq`, [id],
      )).rows as { type: string; data: Record<string, unknown> }[];
    }
    async function state(id: string) {
      return (await pool.query(
        `SELECT p.head_revision_id,p.visibility,p.security_revision::text,
                t.visibility AS thread_visibility,t.security_revision::text AS thread_security_revision,
                (SELECT count(*)::integer FROM content.revision r WHERE r.route=p.route AND r.post_id=p.post_id) AS revisions
         FROM content.post p JOIN content.thread t USING(route,thread_id) WHERE p.post_id=$1`, [id],
      )).rows[0]!;
    }
    return { system, pool, author, board, realm, call, command, thread, reply, revise, evidence, state,
      close: () => system.close() };
  } catch (error) {
    await system.close();
    throw error;
  }
}
