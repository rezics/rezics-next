import { createHash, randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'bun:test';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { newId, partitionOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';
import { testKernel } from '../support/test-kernel.ts';

const db = await openGrowthDatabase();
afterAll(() => db.close());
const app = testKernel({ pool: db.pool });
const boardRoute = 0x4321;
const threadRoute = 0x1234;
const authorId = newId(threadRoute);
const pageSize = 3;
const candidateLimit = 200;
const scales = [256, 1024, 4096] as const;
const text = 'A fixed board page growth body';
const document = fromPlainText(text);
const body = Buffer.from(serializeDocument(document));
const bodyHash = createHash('sha256').update(body).digest();
const title =
  'board pages under new active and hot, with their disclosure passes, stay within the written bound as threads, boards and hidden candidates grow';

test(
  title,
  async () => {
    // HTTP calls use the production "newest" spelling for the contract's "new" sort.
    for (const [sort, index] of [
      ['newest', 'board_thread_page_idx'],
      ['active', 'board_thread_active_page_idx'],
      ['hot', 'board_thread_hot_page_idx'],
    ] as const) {
      await db.admin.query(
        'TRUNCATE content.board, content.board_thread, content.thread, content.post, content.revision CASCADE',
      );
      const boardId = newId(boardRoute);
      await db.admin.query(
        `INSERT INTO content.board
        (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
       VALUES ($1, $2, $3, 'Probe board', 'published', 1, $4)`,
        [boardRoute, boardId, newId(boardRoute), randomUUID()],
      );
      const visible: string[] = [];
      // Seed the same thread/post/head-revision and ranked candidate shapes as content writes and projection.
      // The first Q candidates stay fixed: 196 hidden, followed by s+1 visible threads. Every page must
      // exhaust Q through multiple disclosure batches, then disclose all s+1 kept entries a second time.
      // Later ordinals grow both this board and other boards, with half hidden, in the anchor partitions.
      const population: Population = {
        name: `board-sorts-${sort}-${randomUUID()}`,
        hotPartition: partitionOf(threadRoute),
        hotShare: 1,
        rows: ({ ordinal, route }) => {
          const onBoard = ordinal < candidateLimit || ordinal % 2 === 0;
          const otherBoard = newId(boardRoute);
          const targetBoard = onBoard ? boardId : otherBoard;
          const threadId = newId(route);
          const postId = newId(route);
          const revisionId = newId(route);
          const transactionId = randomUUID();
          const at = new Date(Date.UTC(2099, 0, 1) - ordinal * 1000).toISOString();
          const hidden = ordinal < candidateLimit - pageSize - 1 || (ordinal >= candidateLimit && ordinal % 4 < 2);
          const visibility = hidden ? (ordinal % 2 === 0 ? 'protected' : 'taken_down') : 'published';
          if (ordinal >= candidateLimit - pageSize - 1 && ordinal < candidateLimit) visible.push(threadId);
          return {
            'content.board': [
              {
                route: boardRoute,
                board_id: otherBoard,
                subject_id: newId(boardRoute),
                title: 'Other board',
                visibility: 'published',
                security_revision: 1,
                recorded_transaction_id: transactionId,
              },
            ],
            'content.thread': [
              {
                route,
                thread_id: threadId,
                author_account_id: authorId,
                board_id: targetBoard,
                title: 'Growth thread',
                visibility,
                security_revision: 1,
                recorded_transaction_id: transactionId,
                first_post_id: postId,
                created_at: at,
              },
            ],
            'content.post': [
              {
                route,
                thread_id: threadId,
                post_id: postId,
                author_account_id: authorId,
                head_revision_id: revisionId,
                visibility: 'published',
                security_revision: 1,
                recorded_transaction_id: transactionId,
                created_at: at,
              },
            ],
            'content.revision': [
              {
                route,
                thread_id: threadId,
                post_id: postId,
                revision_id: revisionId,
                body,
                body_sha256: bodyHash,
                search_text: text,
                licence: 'MIT',
                subject_ids: [],
                board_id: targetBoard,
                availability: 'available',
                recorded_transaction_id: transactionId,
                recorded_at: at,
                media_ids: [],
              },
            ],
            'content.board_thread': [
              {
                route: boardRoute,
                board_id: targetBoard,
                thread_id: threadId,
                created_at: at,
                last_activity_at: at,
                active_rank: 8192 - ordinal,
                hot_rank: 8192 - ordinal,
                rank_refreshed_at: at,
                source_epoch: 1,
                source_position: ordinal + 1,
                source_revision_id: revisionId,
              },
            ],
          };
        },
      };
      const report = await checkGrowth(db, {
        name: `Board page ${sort}, including candidate and final disclosure`,
        scales,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        repetitions: 1,
        grow: async (growthDb, scale, previous) => {
          await seed({ pool: growthDb.pool, admin: growthDb.admin }, population, { from: previous, to: scale });
        },
        operation: async () => {
          const response = await app.handle(
            new Request(`http://kernel.test/v1/boards/${boardId}/threads?sort=${sort}&limit=${pageSize}`),
          );
          const page = (await response.json()) as {
            threads: { id: string; boardId: string; visibility: string; firstPost: { body: unknown } }[];
            next: string | null;
            rankRefreshedAt: string | null;
          };
          expect(response.status).toBe(200);
          expect(page.threads.map(({ id }) => id)).toEqual(visible.slice(0, pageSize));
          for (const thread of page.threads) {
            expect(thread.boardId).toBe(boardId);
            expect(thread.visibility).toBe('published');
            expect(thread.firstPost.body).toEqual(document);
          }
          expect(page.next).toEqual(expect.any(String));
          if (sort === 'newest') expect(page.rankRefreshedAt).toBeNull();
          else expect(Number.isFinite(Date.parse(page.rankRefreshedAt!))).toBe(true);
          return page;
        },
      });
      expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
      for (const { cost } of report.samples) {
        expect(cost.rows).toBeGreaterThan(0);
        expect(cost.blocks).toBeGreaterThan(0);
        expect(cost.statements).toBeGreaterThan(0);
        expect(cost.relations['content.board_thread']?.rows).toBe(candidateLimit);
        expect(cost.relations[`index:${index}`]?.blocks).toBeGreaterThan(0);
        for (const relation of Object.values(cost.relations)) expect(relation.sequentialScans).toBe(0);
      }
    }
  },
  600_000,
);
