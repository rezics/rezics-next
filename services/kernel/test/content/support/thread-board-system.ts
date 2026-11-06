import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { createKernel } from '../../../src/http/kernel.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { createBoardEffect } from '../../../src/content/board-projection.ts';
import { refreshBoardRankBatch } from '../../../src/content/board-rank.ts';
import { createAuthorItemEffect } from '../../../src/content/author-item-index.ts';
import { createSubjectThreadEffect } from '../../../src/content/subject-thread-index.ts';
import { readBatch, type CloudEvent } from '../../../src/events/log.ts';
import { partitionOf, routeOf } from '../../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { testReceiptKeys } from '../../support/receipt-keys.ts';
import { TEST_REQUEST_DEADLINE_MS } from '../../support/test-kernel.ts';
import { seedGovernanceAuthority } from './disclosure-fixtures.ts';
import { governance, highRates, openUserCasesSystem } from './user-cases-fixtures.ts';

export type Reader = { id: string; bearer: string } | null;
export type Thread = { id: string; route: number; firstPost: Post };
export type Post = { id: string; threadId: string; revisionId: string; body: unknown; licence: string };
export type Board = { id: string; route: number; visibility: 'published' | 'protected' };
type Hold = { enter(): void; released: Promise<void> };

/** Native HTTP creation and projection for the Thread/Board contract, independent of Realm setup. */
export async function openThreadBoardSystem() {
  const system = await openUserCasesSystem();
  try {
    const moderator = await governance(system);
    const author = { id: system.actors.author.actor.accountId, bearer: system.actors.author.bearer };
    const member = { id: system.actors.other.actor.accountId, bearer: system.actors.other.bearer };
    const outsider = { id: system.actors.moderator.actor.accountId, bearer: system.actors.moderator.bearer };
    const pool = system.database.pool;
    const pointHolds = new Map<string, Hold>();
    const pageHolds = new Map<string, Hold>();
    const sources = new Set<number>();
    const consumer = `thread-board-${crypto.randomUUID()}`;
    const wait = async (holds: Map<string, Hold>, key: string) => {
      const hold = holds.get(key);
      if (!hold) return;
      holds.delete(key);
      hold.enter();
      await hold.released;
    };
    const app = createKernel({
      pool,
      routeKey: system.routeKey,
      tokens: system.tokenKeys,
      receiptKeys: testReceiptKeys(),
      access: () => system.access,
      requestDeadlineMs: TEST_REQUEST_DEADLINE_MS,
      content: {
        disclosureBarrier: (target) => wait(pointHolds, target.postId ?? target.threadId),
        pageDisclosureBarrier: (target) => wait(pageHolds, target.threadId ?? target.boardId),
      },
      writeRate: createWriteRateLimiter({ secret: crypto.randomUUID() + crypto.randomUUID(), overrides: highRates }),
      ratePeer: () => '127.0.0.1',
    });
    async function send(method: string, path: string, actor: Reader, body?: unknown, headers?: Record<string, string>) {
      return app.handle(
        new Request(`https://content.test${path}`, {
          method,
          headers: {
            ...(actor ? { authorization: `Bearer ${actor.bearer}` } : {}),
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    }
    async function command<T>(
      method: string,
      path: string,
      body?: unknown,
      actor: Reader = moderator,
      headers?: Record<string, string>,
    ): Promise<T> {
      const response = await send(method, path, actor, body, headers);
      if (!response.ok) throw new Error(`Thread/Board ${method} ${path}: ${response.status} ${await response.text()}`);
      return response.json() as Promise<T>;
    }
    const resource = (id: string) => ({ route: routeOf(id)!, id });
    async function grant(id: string, actor: Exclude<Reader, null>, actions: string[]) {
      await seedGovernanceAuthority(pool, routeOf(id)!, id, moderator.id, ['access:grant', ...actions]);
      const tuple = { resource: resource(id), subject: { kind: 'account', id: actor.id }, actions, valid: '(,)' };
      await command('POST', '/v1/grants', tuple);
      return tuple;
    }
    const { digest } = await command<{ digest: string }>('POST', '/v1/definitions/releases', {
      release: bundledRelease,
    });
    await command('POST', `/v1/definitions/releases/${digest}:activate`, { expected_head: null });
    const { subject } = await command<{ subject: { id: string } }>('POST', '/v1/subjects', {
      type: 'schema:Book',
      labels: { en: 'Controlled Thread/Board subject' },
    });
    const readGrants = new Map<string, Awaited<ReturnType<typeof grant>>>();
    async function board(visibility: Board['visibility'] = 'published') {
      const { subject: concept } = await command<{ subject: { id: string } }>('POST', '/v1/subjects', {
        type: 'skos:Concept',
        labels: { en: 'Controlled discussion concept' },
      });
      await seedGovernanceAuthority(pool, 0, GLOBAL_CONTEXT, moderator.id, ['board:create']);
      const { board } = await command<{ board: Board }>('POST', '/v1/boards', {
        conceptId: concept.id,
        title: 'Controlled discussion Board',
        purpose: 'discussion',
        visibility,
      });
      await grant(board.id, author, ['board:read', 'thread:create']);
      if (visibility === 'protected') readGrants.set(board.id, await grant(board.id, member, ['board:read']));
      await seedGovernanceAuthority(pool, board.route, board.id, moderator.id, ['moderation:takedown']);
      return board;
    }
    async function thread(board: Board, text = 'Controlled original opening') {
      const { thread } = await command<{ thread: Thread }>(
        'POST',
        '/v1/threads',
        {
          boardId: board.id,
          title: 'Controlled discussion title',
          kind: 'discussion',
          subjectIds: [subject.id],
          body: fromPlainText(text),
          licence: 'CC-BY-4.0',
          visibility: 'published',
        },
        author,
      );
      sources.add(partitionOf(thread.route));
      return thread;
    }
    async function reply(thread: Thread, parentId?: string) {
      return (
        await command<{ post: Post }>(
          'POST',
          `/v1/threads/${thread.id}/posts`,
          {
            body: fromPlainText('Controlled reply'),
            licence: 'MIT',
            ...(parentId ? { parentId } : {}),
          },
          author,
        )
      ).post;
    }
    async function revise(post: Post) {
      return (
        await command<{ post: Post }>(
          'POST',
          `/v1/posts/${post.id}/revisions`,
          {
            body: fromPlainText('Controlled edited writing'),
            licence: 'MIT',
          },
          author,
          { 'if-match': JSON.stringify(post.revisionId) },
        )
      ).post;
    }
    const effects = [createBoardEffect(pool), createSubjectThreadEffect(pool), createAuthorItemEffect(pool)];
    async function drain(board: Board) {
      for (const partition of sources) {
        for (;;) {
          const events: CloudEvent[] = [];
          const result = await readBatch(pool, {
            partition,
            consumer,
            apply: async (envelopes) => {
              events.push(...envelopes.flatMap((envelope) => envelope.events));
            },
          });
          if (result.status !== 'read') throw new Error(`Native Thread/Board relay ${result.status}`);
          if (!result.envelopes) break;
          for (const event of events)
            for (const effect of effects) if (effect.types.includes(event.type)) await effect.run(event);
        }
      }
      await refreshBoardRankBatch(pool, new Date(), [partitionOf(board.route)]);
    }
    async function hold(path: string, actor: Reader, key: string, page: boolean) {
      let enter!: () => void;
      const reached = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holds = page ? pageHolds : pointHolds;
      holds.set(key, { enter, released });
      const response = send('GET', path, actor);
      void response.catch(() => {});
      return {
        reached: Promise.race([
          reached,
          response.then(() => {
            throw new Error('Native read finished before disclosure barrier');
          }),
        ]),
        response,
        release() {
          holds.delete(key);
          release();
        },
      };
    }
    return {
      app,
      author,
      member,
      outsider,
      moderator,
      subjectId: subject.id,
      board,
      thread,
      reply,
      revise,
      drain,
      hold,
      get: (path: string, actor: Reader = null) => send('GET', path, actor),
      async revoke(board: Board) {
        await command('POST', '/v1/grants:revoke', readGrants.get(board.id)!);
      },
      async takedown(board: Board) {
        await command('POST', `/v1/boards/${board.id}:takeDown`, { reason: 'Controlled late Board takedown' });
      },
      close: () => system.close(),
    };
  } catch (error) {
    await system.close();
    throw error;
  }
}
