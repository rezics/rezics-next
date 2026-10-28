import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { createKernel } from '../../src/http/kernel.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { newId } from '../../src/route/route.ts';
import { encodeListCursor } from '../../src/tokens/list-cursor.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population, type Row } from '../support/growth.ts';

const routeKey = new Uint8Array(32).fill(7);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
const authorId = newId(0x9abc);
const createdAt = '2026-10-25T00:00:00.000Z';
const body = Buffer.from(serializeDocument(fromPlainText('Sitemap growth body')));
const bodySha256 = createHash('sha256').update(body).digest();
const pageSize = 4;
const populationSize = 200;
const scales = [1, 8, 64] as const;
const listedPartition = { boards: 0x100, threads: 0x200 };
const protectedPartition = { boards: 0x500, threads: 0x600 };

let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let app: ReturnType<typeof createKernel>;

beforeAll(async () => {
  db = await openGrowthDatabase();
  app = createKernel({ pool: db.pool, routeKey, tokens });
});
afterAll(() => db.close());

type Feed = 'boards' | 'threads';
async function page(feed: Feed, values: Record<string, string>) {
  const response = await app.handle(
    new Request(`http://kernel.test/v1/sitemap/${feed}?${new URLSearchParams(values)}`),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { items: { id: string }[]; next: string | null };
}

/** A cursor that starts a walk at the first board of a route, as an earlier page of the same feed would. */
async function cursorAtRoute(feed: Feed, route: number): Promise<string> {
  const id = `00000000-0000-7000-8000-${route.toString(16).padStart(4, '0')}00000000`;
  return encodeListCursor(
    tokens,
    { route: `GET /v1/sitemap/${feed}`, viewer: null, query: {} },
    { epoch: 1, after: [id, 0, '', ''] },
    new Date(createdAt),
  );
}

/** One published board with one listed thread, optionally in its own Realm. */
function content(route: number, realm: 'public' | 'protected' | null): Record<string, readonly Row[]> {
  const boardId = newId(route);
  const threadId = newId(route);
  const postId = newId(route);
  const revisionId = newId(route);
  const transactionId = randomUUID();
  const rows: Record<string, Row[]> = {};
  let realmId: string | null = null;
  if (realm) {
    const spaceId = newId(route);
    const spaceRevisionId = newId(route);
    const realmRevisionId = newId(route);
    realmId = newId(route);
    rows['community.space'] = [
      {
        route,
        space_id: spaceId,
        state: 'active',
        head_revision_id: spaceRevisionId,
        created_at: createdAt,
        creator: authorId,
      },
    ];
    rows['community.space_revision'] = [
      {
        route,
        space_id: spaceId,
        revision_id: spaceRevisionId,
        predecessor: null,
        title: 'Host',
        summary: '',
        created_at: createdAt,
        author: authorId,
      },
    ];
    rows['community.realm'] = [
      {
        route,
        realm_id: realmId,
        space_id: spaceId,
        state: 'active',
        visibility: realm,
        context_id: GLOBAL_CONTEXT,
        head_revision_id: realmRevisionId,
        created_at: createdAt,
        creator: authorId,
      },
    ];
    rows['community.realm_revision'] = [
      {
        route,
        realm_id: realmId,
        revision_id: realmRevisionId,
        predecessor: null,
        title: 'Realm',
        summary: '',
        visibility: realm,
        context_id: GLOBAL_CONTEXT,
        created_at: createdAt,
        author: authorId,
      },
    ];
  }
  rows['content.board'] = [
    {
      route,
      board_id: boardId,
      realm_id: realmId,
      subject_id: newId(route),
      title: 'Sitemap growth board',
      visibility: 'published',
      security_revision: 1,
      recorded_transaction_id: transactionId,
    },
  ];
  rows['content.thread'] = [
    {
      route,
      thread_id: threadId,
      author_account_id: authorId,
      board_id: boardId,
      title: 'Sitemap growth thread',
      visibility: 'published',
      security_revision: 1,
      recorded_transaction_id: transactionId,
      first_post_id: postId,
      availability: 'available',
      created_at: createdAt,
    },
  ];
  rows['content.post'] = [
    {
      route,
      thread_id: threadId,
      post_id: postId,
      reply_to_post_id: null,
      author_account_id: authorId,
      head_revision_id: revisionId,
      visibility: 'published',
      security_revision: 1,
      recorded_transaction_id: transactionId,
      created_at: createdAt,
      availability: 'available',
    },
  ];
  rows['content.revision'] = [
    {
      route,
      thread_id: threadId,
      post_id: postId,
      revision_id: revisionId,
      body,
      body_sha256: bodySha256,
      search_text: 'Sitemap growth body',
      licence: 'MIT',
      subject_ids: [],
      board_id: boardId,
      availability: 'available',
      recorded_transaction_id: transactionId,
      recorded_at: createdAt,
      media_ids: [],
    },
  ];
  rows['content.board_thread'] = [
    {
      route,
      board_id: boardId,
      thread_id: threadId,
      created_at: createdAt,
      last_activity_at: createdAt,
      source_epoch: 1,
      source_position: 1,
      source_revision_id: null,
    },
  ];
  return rows;
}

function population(name: string, partition: number, realm: 'public' | 'protected' | null): Population {
  return {
    name: `growth-sitemap-${name}-${randomUUID()}`,
    hotPartition: partition,
    hotShare: 1,
    rows: ({ route }) => content(route, realm),
  };
}

async function grow(listed: Population, scale: number, previous: number) {
  await seed({ pool: db.pool, admin: db.admin }, listed, {
    from: previous * populationSize,
    to: scale * populationSize,
  });
}

for (const feed of ['boards', 'threads'] as const) {
  test(`${feed} sitemap page stays within its bound as listed items grow`, async () => {
    const listed = population(`listed-${feed}`, listedPartition[feed], null);
    // Each test grows its own region and starts its walk there.
    const cursor = await cursorAtRoute(feed, listedPartition[feed] * 16);
    const report = await checkGrowth(db, {
      name: `Sitemap ${feed} page, listed items`,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow: (_database, scale, previous) => grow(listed, scale, previous),
      operation: async () => {
        const result = await page(feed, { limit: String(pageSize), cursor });
        expect(result.items).toHaveLength(pageSize);
        expect(result.next).toEqual(expect.any(String));
        return result;
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  }, 180_000);

  test(`${feed} sitemap page stays within its bound as protected Realm content grows`, async () => {
    const partition = protectedPartition[feed];
    const hidden = population(`protected-${feed}`, partition, 'protected');
    // The walk reaches the protected content first, so each page scans only that.
    const cursor = await cursorAtRoute(feed, partition * 16);
    const report = await checkGrowth(db, {
      name: `Sitemap ${feed} page, protected Realm content`,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow: (_database, scale, previous) => grow(hidden, scale, previous),
      operation: async () => {
        const result = await page(feed, { limit: String(pageSize), cursor });
        expect(result.items).toEqual([]);
        expect(result.next).toEqual(expect.any(String));
        return result;
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  }, 180_000);
}
