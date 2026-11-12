import { createHash, randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'bun:test';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { newId, partitionOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  assertGrowthAccessPaths,
  capture,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  seed,
  type Population,
  type Row,
} from '../support/growth.ts';
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
const baseline = { from: 1_000_000, to: 1_004_096 };
const text = 'A fixed board page growth body';
const document = fromPlainText(text);
const body = Buffer.from(serializeDocument(document));
const bodyHash = createHash('sha256').update(body).digest();
// seed() spreads the threads across all sixteen routes in their anchor partition. Access also
// reads the board route and the fixed Global Context, so populate every one of those routes.
const accessRoutes = [
  0,
  boardRoute,
  ...Array.from({ length: 16 }, (_, index) => partitionOf(threadRoute) * 16 + index),
];
type AccessResource = {
  readonly route: number;
  readonly resource_id: string;
  readonly subject_id: string;
  readonly valid: string;
  readonly transaction_id: string;
};

const accessRowsByOrdinal = new Map<number, readonly AccessResource[]>();

function accessResourcesFor(ordinal: number): readonly AccessResource[] {
  let resources = accessRowsByOrdinal.get(ordinal);
  if (!resources) {
    resources = accessRoutes.map((route) => ({
      route,
      resource_id: newId(route),
      subject_id: newId(threadRoute),
      valid: '(,)',
      transaction_id: randomUUID(),
    }));
    accessRowsByOrdinal.set(ordinal, resources);
  }
  return resources;
}

const accessPopulations: readonly Population[] = [
  {
    name: 'board-sorts-unrelated-access-grants',
    hotPartition: partitionOf(threadRoute),
    hotShare: 1,
    rows: ({ ordinal }) => ({
      'access.resource_grant': accessResourcesFor(ordinal).map((resource) => ({ ...resource, action: 'thread:read' })),
    }),
  },
  {
    name: 'board-sorts-unrelated-access-roles',
    hotPartition: partitionOf(threadRoute),
    hotShare: 1,
    rows: ({ ordinal }) => ({
      'access.resource_role_grant': accessResourcesFor(ordinal).map((resource) => ({
        ...resource,
        grant_role: 'content.thread.owner',
      })),
    }),
  },
  {
    name: 'board-sorts-unrelated-access-denials',
    hotPartition: partitionOf(threadRoute),
    hotShare: 1,
    rows: ({ ordinal }) => ({
      'access.resource_denial': accessResourcesFor(ordinal).map((resource) => ({
        ...resource,
        action: 'thread:read',
        reason: 'resource',
      })),
    }),
  },
];

async function seedBoardSortRange(
  target: Parameters<typeof seed>[0],
  population: Population,
  range: { readonly from: number; readonly to: number },
): Promise<void> {
  try {
    await seed(target, population, range, { maintenance: false });
    for (const accessPopulation of accessPopulations)
      await seed(target, accessPopulation, range, { maintenance: false });
  } finally {
    accessRowsByOrdinal.clear();
  }
}

test('board pages under newest, oldest, active and hot, with their disclosure passes, stay within the written bound as threads, boards and hidden candidates grow', async () => {
  // HTTP calls use the production "newest" spelling for the contract's "new" sort.
  for (const sort of ['newest', 'oldest', 'active', 'hot'] as const) {
    await db.admin.query(
      `TRUNCATE content.board, content.board_thread, content.thread, content.post, content.revision,
          access.resource_grant, access.resource_role_grant, access.resource_denial CASCADE`,
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
      rows: ({ ordinal, route: seededRoute }) => {
        // Baseline threads share the probe's route but never its board or candidate window.
        const route = ordinal >= baseline.from ? threadRoute : seededRoute;
        const onBoard = ordinal < baseline.from && (ordinal < candidateLimit || ordinal % 2 === 0);
        const otherBoard = newId(boardRoute);
        const targetBoard = onBoard ? boardId : otherBoard;
        const threadId = newId(route);
        const postId = newId(route);
        const revisionId = newId(route);
        const transactionId = randomUUID();
        // For oldest, keep later distractors newer than the fixed first 200 candidate window.
        const at = new Date(
          sort === 'oldest' && ordinal >= candidateLimit && ordinal < baseline.from
            ? Date.UTC(2099, 0, 1) + ordinal * 1000
            : Date.UTC(2099, 0, 1) - ordinal * 1000,
        ).toISOString();
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
              active_rank: Math.max(0, 8192 - ordinal),
              hot_rank: Math.max(0, 8192 - ordinal),
              rank_refreshed_at: at,
              source_epoch: 1,
              source_position: ordinal + 1,
              source_revision_id: revisionId,
            },
          ],
        };
      },
    };
    // Give every content relation 4096 unrelated rows before the measured scales, and every Access
    // relation 4096 per measured route. core.partition already has all 4096 anchors from migration.
    // Keep the Content and three Access relations in separate bounded producers so each 500-row
    // batch contains one relation. checkGrowth analyzes all four after growth.
    await seedBoardSortRange(db, population, baseline);
    const report = await checkGrowth(db, {
      name: `Board page ${sort}, including candidate and final disclosure`,
      scales,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      repetitions: 1,
      grow: async (growthDb, scale, previous) => {
        await seedBoardSortRange(growthDb, population, { from: previous, to: scale });
        // checkGrowth runs VACUUM (ANALYZE) after grow, covering all three Access tables too.
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
        expect(page.threads.map(({ id }) => id)).toEqual(
          sort === 'oldest' ? visible.slice(-pageSize).reverse() : visible.slice(0, pageSize),
        );
        for (const thread of page.threads) {
          expect(thread.boardId).toBe(boardId);
          expect(thread.visibility).toBe('published');
          expect(thread.firstPost.body).toEqual(document);
        }
        expect(page.next).toEqual(expect.any(String));
        if (sort === 'newest' || sort === 'oldest') expect(page.rankRefreshedAt).toBeNull();
        else expect(Number.isFinite(Date.parse(page.rankRefreshedAt!))).toBe(true);
        return page;
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
    const statementCounts = report.samples.map(({ cost }) => cost.statements);
    expect(statementCounts.every((count) => count <= 43)).toBe(true);
    expect(new Set(statementCounts).size).toBe(1);
    expect(new Set(report.samples.map(({ cost }) => cost.controlStatements)).size).toBe(1);
    expect(new Set(report.samples.map(({ cost }) => cost.catalogStatements)).size).toBe(1);
    const assertedRelations = [
      ...new Set(
        report.samples.flatMap(({ cost }) => Object.keys(cost.relations).filter((name) => !name.startsWith('index:'))),
      ),
    ];
    for (const { scale, cost } of report.samples) {
      for (const relation of assertedRelations) {
        expect(cost.relations[relation]?.sequentialScans, `${sort} scale ${scale} ${relation}`).toEqual(
          expect.any(Number),
        );
      }
    }
    assertGrowthAccessPaths(`Board page ${sort}`, report.samples, assertedRelations);
    for (const { scale, cost } of report.samples) {
      expect(cost.rows).toBeGreaterThan(0);
      expect(cost.blocks).toBeGreaterThan(0);
      expect(cost.statements).toBeGreaterThan(0);
      expect(cost.controlStatements).toBeGreaterThan(0);
      expect(cost.requestBytes).toBeGreaterThan(0);
      expect(cost.responseBytes).toBeGreaterThan(0);
      const candidates = cost.relations['content.board_thread']!;
      const measurement = JSON.stringify({ sort, scale, ...candidates });
      // A small board can use a bitmap heap scan and sort; larger boards seek the ordered index.
      // Both must examine at most 2Q rows, even when the former reads more than the LIMIT.
      expect(candidates.rows, measurement).toBeGreaterThan(0);
      expect(candidates.rows, measurement).toBeLessThanOrEqual(2 * candidateLimit);
      // Charge bitmap index blocks too: the candidate row budget plus two conservative
      // binary-tree descents over the complete seeded candidate relation.
      const candidateBlocks =
        candidates.blocks +
        Object.entries(cost.relations)
          .filter(([name]) => name.startsWith('index:board_thread_'))
          .reduce((blocks, [, relation]) => blocks + relation.blocks, 0);
      const candidateBlockBound =
        2 * candidateLimit + 2 * Math.ceil(Math.log2(2 + baseline.to - baseline.from + scale));
      expect(candidateBlocks, measurement).toBeLessThanOrEqual(candidateBlockBound);
    }
  }

  await db.admin.query(
    `TRUNCATE content.board, content.board_thread, content.thread, content.post, content.revision,
        access.resource_grant, access.resource_role_grant, access.resource_denial CASCADE`,
  );
  const boardId = newId(boardRoute);
  await db.admin.query(
    `INSERT INTO content.board
       (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
       VALUES ($1, $2, $3, 'Large board', 'published', 1, $4)`,
    [boardRoute, boardId, newId(boardRoute), randomUUID()],
  );
  const visible: string[] = [];
  const rowsByOrdinal = new Map<number, Record<string, readonly Row[]>>();
  const largePage: Population = {
    name: `board-sorts-limit-100-${randomUUID()}`,
    hotPartition: partitionOf(threadRoute),
    hotShare: 1,
    rows: ({ ordinal, route: seededRoute }) => {
      const cached = rowsByOrdinal.get(ordinal);
      if (cached) return cached;
      const route = ordinal >= baseline.from ? threadRoute : seededRoute;
      const inWindow = ordinal < candidateLimit;
      const targetBoard = inWindow ? boardId : newId(boardRoute);
      const threadId = newId(route);
      const postId = newId(route);
      const revisionId = newId(route);
      const transactionId = randomUUID();
      const at = new Date(Date.UTC(2099, 0, 1) - ordinal * 1000).toISOString();
      const hidden = ordinal < candidateLimit && ordinal < 99;
      const visibility = hidden ? (ordinal % 2 === 0 ? 'protected' : 'taken_down') : 'published';
      if (ordinal >= 99 && ordinal < candidateLimit) visible.push(threadId);
      const rows: Record<string, readonly Row[]> = {
        'content.board': inWindow
          ? []
          : [
              {
                route: boardRoute,
                board_id: targetBoard,
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
            active_rank: Math.max(0, 8192 - ordinal),
            hot_rank: Math.max(0, 8192 - ordinal),
            rank_refreshed_at: at,
            source_epoch: 1,
            source_position: ordinal + 1,
            source_revision_id: revisionId,
          },
        ],
      };
      rowsByOrdinal.set(ordinal, rows);
      return rows;
    },
  };
  await seedBoardSortRange(db, largePage, baseline);
  const queryReport = await checkGrowth(db, {
    name: 'Board page s=100 with text query and 101 visible survivors',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    grow: async (growthDb, scale, previous) => {
      await seedBoardSortRange(growthDb, largePage, { from: previous, to: scale });
    },
    operation: async () => {
      const response = await app.handle(
        new Request(`http://kernel.test/v1/boards/${boardId}/threads?sort=newest&limit=100&query=fixed`),
      );
      const page = (await response.json()) as {
        threads: { id: string; firstPost: { body: unknown } }[];
        next: string | null;
      };
      expect(response.status).toBe(200);
      expect(page.threads.map(({ id }) => id)).toEqual(visible.slice(0, 100));
      expect(page.threads).toHaveLength(100);
      for (const thread of page.threads) expect(thread.firstPost.body).toEqual(document);
      expect(page.next).toEqual(expect.any(String));
      return page;
    },
  });
  expect(queryReport.samples.map(({ scale }) => scale)).toEqual([...scales]);
  const queryCounts = queryReport.samples.map(({ cost }) => cost.statements);
  expect(queryCounts.every((count) => count <= 43)).toBe(true);
  expect(new Set(queryCounts).size).toBe(1);
  const queryRelations = [
    ...new Set(
      queryReport.samples.flatMap(({ cost }) =>
        Object.keys(cost.relations).filter((name) => !name.startsWith('index:')),
      ),
    ),
  ];
  for (const { scale, cost } of queryReport.samples) {
    for (const relation of queryRelations) {
      expect(cost.relations[relation]?.sequentialScans, `query scale ${scale} ${relation}`).toEqual(expect.any(Number));
    }
    expect(cost.relations['content.board_thread']?.rows).toBeGreaterThan(0);
    expect(cost.relations['content.board_thread']?.rows).toBeLessThanOrEqual(2 * candidateLimit);
  }
  assertGrowthAccessPaths('Board page s=100 with text query', queryReport.samples, queryRelations);

  await db.admin.query(
    `TRUNCATE content.board, content.board_thread, content.thread, content.post, content.revision,
        community.space, community.space_revision, community.realm, community.realm_revision,
        community.realm_ban, access.account, access.resource_grant, access.resource_role_grant,
        access.resource_denial CASCADE`,
  );
  const signing = await generateKeyPair('ES256', { extractable: true });
  const issuer = 'https://board-sorts.auth.test';
  const audience = 'https://board-sorts.api.test';
  const kid = 'board-sorts';
  const jwk = { ...(await exportJWK(signing.publicKey)), kid, alg: 'ES256' };
  const realmApp = testKernel({
    pool: db.pool,
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/jwks`,
      fetch: async () => Response.json({ keys: [jwk] }),
    },
  });
  const grantedReader = newId(0x3456);
  const bannedReader = newId(0x3456);
  const author = newId(threadRoute);
  const realmId = newId(boardRoute);
  const protectedBoardId = newId(boardRoute);
  const threadId = newId(threadRoute);
  const postId = newId(threadRoute);
  const revisionId = newId(threadRoute);
  const at = '2026-10-01T00:00:00.000Z';
  const transactionId = randomUUID();
  const spaceId = newId(boardRoute);
  const spaceRevisionId = newId(boardRoute);
  const realmRevisionId = newId(boardRoute);
  await db.admin.query(
    `INSERT INTO access.account(route, account_id, kind, state, membership_inverse_complete, transaction_id)
       VALUES ($1, $2, 'actor', 'active', true, $2), ($1, $3, 'actor', 'active', true, $3)`,
    [0x3456, grantedReader, bannedReader],
  );
  const realmRoute = [boardRoute, spaceId, spaceRevisionId, at, author, realmId, GLOBAL_CONTEXT, realmRevisionId];
  const fixture = await db.admin.connect();
  try {
    await fixture.query('BEGIN');
    await fixture.query(
      `INSERT INTO community.space(route, space_id, state, head_revision_id, created_at, creator)
         VALUES ($1, $2, 'active', $3, $4, $5)`,
      realmRoute.slice(0, 5),
    );
    await fixture.query(
      `INSERT INTO community.space_revision(route, space_id, revision_id, title, summary, created_at, author)
         VALUES ($1, $2, $3, 'Protected host', '', $4, $5)`,
      realmRoute.slice(0, 5),
    );
    await fixture.query(
      `INSERT INTO community.realm(route, realm_id, space_id, state, visibility, context_id, head_revision_id, created_at, creator)
         VALUES ($1, $6, $2, 'active', 'protected', $7, $8, $4, $5)`,
      realmRoute,
    );
    await fixture.query(
      `INSERT INTO community.realm_revision(route, realm_id, revision_id, predecessor, title, summary, visibility, context_id, created_at, author)
         VALUES ($1, $6, $8, NULL, 'Protected realm', '', 'protected', $7, $4, $5)`,
      realmRoute,
    );
    await fixture.query('COMMIT');
  } catch (error) {
    await fixture.query('ROLLBACK');
    throw error;
  } finally {
    fixture.release();
  }
  const contentRoute = [
    boardRoute,
    protectedBoardId,
    realmId,
    newId(boardRoute),
    transactionId,
    threadRoute,
    threadId,
    author,
    postId,
    at,
    revisionId,
    body,
    bodyHash,
    text,
  ];
  await db.admin.query(
    `INSERT INTO content.board(route, board_id, realm_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
       VALUES ($1, $2, $3, $4, 'Protected board', 'protected', 1, $5)`,
    contentRoute.slice(0, 5),
  );
  await db.admin.query(
    `INSERT INTO content.thread(route, thread_id, author_account_id, board_id, title, visibility, security_revision, recorded_transaction_id, first_post_id, availability, created_at)
       VALUES ($6, $7, $8, $2, 'Granted thread', 'published', 1, $5, $9, 'available', $10)`,
    contentRoute,
  );
  await db.admin.query(
    `INSERT INTO content.post(route, thread_id, post_id, author_account_id, head_revision_id, visibility, security_revision, recorded_transaction_id, created_at, availability)
       VALUES ($6, $7, $9, $8, $11, 'published', 1, $5, $10, 'available')`,
    contentRoute,
  );
  await db.admin.query(
    `INSERT INTO content.revision(route, thread_id, post_id, revision_id, body, body_sha256, search_text, licence, subject_ids, board_id, availability, recorded_transaction_id, recorded_at, media_ids)
       VALUES ($6, $7, $9, $11, $12, $13, $14, 'MIT', '{}', $2, 'available', $5, $10, '{}')`,
    contentRoute,
  );
  await db.admin.query(
    `INSERT INTO content.board_thread(route, board_id, thread_id, created_at, last_activity_at, source_epoch, source_position, source_revision_id)
       VALUES ($1, $2, $7, $10, $10, 1, 1, $11)`,
    contentRoute,
  );
  for (const reader of [grantedReader, bannedReader]) {
    for (const [resourceId, action] of [
      [protectedBoardId, 'board:read'],
      [realmId, 'realm:read'],
      [threadId, 'thread:read'],
      [postId, 'post:read'],
    ] as const) {
      await db.admin.query(
        `INSERT INTO access.resource_grant(route, resource_id, subject_id, subject_role, action, valid, transaction_id)
           VALUES ($1, $2, $3, '', $4, '(,)', $5)`,
        [Number.parseInt(resourceId.slice(24, 28), 16), resourceId, reader, action, randomUUID()],
      );
    }
  }
  await db.admin.query(
    `INSERT INTO community.realm_ban(route, realm_id, account_id, valid, reason, actor, transaction_id)
       VALUES ($1, $2, $3, tstzrange(clock_timestamp(), NULL, '[)'), 'Growth fixture ban', $4, $4)`,
    [boardRoute, realmId, bannedReader, grantedReader],
  );
  const tokenFor = async (subject: string) =>
    new SignJWT({
      client_id: 'web',
      scope: 'board:read realm:read thread:read post:read',
      authn_epoch: 1,
      auth_time: Math.floor(Date.now() / 1000),
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', kid, typ: 'at+jwt' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime('3m')
      .sign(signing.privateKey);
  const grantedToken = await tokenFor(grantedReader);
  const bannedToken = await tokenFor(bannedReader);
  const path = `http://kernel.test/v1/boards/${protectedBoardId}/threads?sort=newest&limit=1`;
  const bannedResponse = await realmApp.handle(
    new Request(path, { headers: { authorization: `Bearer ${bannedToken}` } }),
  );
  expect(bannedResponse.status).toBe(404);
  const measured = await capture(db, async () =>
    realmApp.handle(new Request(path, { headers: { authorization: `Bearer ${grantedToken}` } })),
  );
  expect(measured.value.status).toBe(200);
  const grantedPage = (await measured.value.json()) as {
    threads: { id: string; firstPost: { body: unknown } }[];
  };
  expect(grantedPage.threads.map(({ id }) => id)).toEqual([threadId]);
  expect(grantedPage.threads[0]!.firstPost.body).toEqual(document);
  expect(costOf(measured.capture).statements).toBeLessThanOrEqual(38);
}, 600_000);
