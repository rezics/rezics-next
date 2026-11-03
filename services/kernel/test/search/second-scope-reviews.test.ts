import { afterAll, describe, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createThread, revisePost } from '../../src/content/commands.ts';
import { erasePost } from '../../src/content/moderation.ts';
import { restorePost } from '../../src/content/restore-post.ts';
import {
  createNativeReviewDiscoveryAdapter,
  createReviewDiscoveryAdapter,
  REVIEW_DISCOVERY_PAGE_SIZE,
  type ReviewDiscoveryDocument,
  type ReviewDiscoveryFrontier,
} from '../../src/search/review-discovery.ts';
import type { DiscoveryReadContext } from '../../src/search/discovery.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { standingFixture } from '../access/standing-fixture.ts';

const fixture = await standingFixture();
afterAll(() => fixture.close());

const routeKey = new Uint8Array(32).fill(73);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
const request = () => ({
  idempotencyKey: Bun.randomUUIDv7(),
  deadline: Date.now() + 30_000,
  requestId: Bun.randomUUIDv7(),
});
type PublishedReview = { id: string; postId: string; subjectId: string; title: string; text: string };

describe('public review discovery adapter', () => {
  test('uses Content pages and current hydration for sparse progress, publication and lifecycle', async () => {
    const unavailable = createReviewDiscoveryAdapter();
    expect(await unavailable.readiness()).toBe('unavailable');
    expect(await unavailable.count(0)).toEqual({ status: 'unavailable' });

    const author = (await fixture.context()).actor;
    const dependencies = { pool: fixture.pool, access: fixture.access, tokens };
    const board = (
      await fixture.reader.query<{ route: number; board_id: string }>(
        "SELECT route, board_id FROM content.board WHERE realm_id IS NULL AND purpose='reviews' AND visibility='published'",
      )
    ).rows[0]!;
    await fixture.grant(author.accountId, 'thread:create', { route: board.route, id: board.board_id });

    async function subject(ordinal: number): Promise<string> {
      const id = newId(0x6b30 + ordinal);
      await fixture.reader.query(
        `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,visibility,security_revision)
         VALUES ($1,$2,'schema:Book',$2,'visible',1)`,
        [routeOf(id), id],
      );
      return id;
    }

    async function publish(target: string, ordinal: number): Promise<PublishedReview> {
      const result = await createThread(
        { pool: fixture.pool, access: fixture.access, routeKey },
        author,
        {
          kind: 'review',
          title: `Native review ${ordinal}`,
          body: fromPlainText(`Public review opening ${ordinal}.`),
          licence: 'MIT',
          subjectIds: [target],
          boardId: board.board_id,
          visibility: 'published',
        },
        request(),
      );
      return {
        id: result.value.threadId,
        postId: result.value.itemId,
        subjectId: target,
        title: `Native review ${ordinal}`,
        text: `Public review opening ${ordinal}.`,
      };
    }

    const initial: PublishedReview[] = [];
    for (let ordinal = 0; ordinal < 5; ordinal += 1) initial.push(await publish(await subject(ordinal), ordinal));
    initial.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const route = routeOf(author.accountId)!;
    const partition = partitionOf(route);
    for (const row of initial.slice(0, 4)) {
      await fixture.reader.query(
        "UPDATE semantic.subject SET visibility='hidden',security_revision=security_revision+1 WHERE route=$1 AND subject_id=$2",
        [routeOf(row.subjectId), row.subjectId],
      );
    }

    const adapter = createNativeReviewDiscoveryAdapter(dependencies, () => ({
      actor: { kind: 'anonymous' },
      deadline: Date.now() + 30_000,
    }));
    const context: DiscoveryReadContext = { access: fixture.access, actor: author, deadline: Date.now() + 30_000 };
    expect(await adapter.readiness()).toBe('ready');
    const count = await adapter.count(partition);
    expect(count).toMatchObject({ status: 'ready', value: { partition, unavailable: true } });
    if (count.status !== 'ready') return;
    expect(count.value).not.toHaveProperty('count');

    const sparse = await adapter.page(partition, null, 1);
    expect(sparse.status).toBe('ready');
    if (sparse.status !== 'ready') return;
    expect(sparse.value.documents).toEqual([]);
    expect(sparse.value.next).toEqual({ route, id: initial[3]!.id });
    expect((await adapter.readCurrent([initial[0]!.id], context)).size).toBe(0);

    const lateReviews: PublishedReview[] = [];
    let late: PublishedReview | undefined;
    for (let ordinal = 9; ordinal < 73; ordinal += 1) {
      const review = await publish(await subject(ordinal), ordinal);
      lateReviews.push(review);
      if (review.id > initial[3]!.id) {
        late = review;
        break;
      }
    }
    if (!late) throw new Error('Could not publish a review after the retained native frontier');

    let cursor = sparse.value.next;
    let fifthDocument: ReviewDiscoveryDocument | undefined;
    let lateDocument: ReviewDiscoveryDocument | undefined;
    let latePosition = 0n;
    for (let pageNumber = 0; pageNumber <= lateReviews.length; pageNumber += 1) {
      const page = await adapter.page(partition, cursor, 1);
      expect(page.status).toBe('ready');
      if (page.status !== 'ready') return;
      const row = page.value.documents[0];
      if (row?.id === initial[4]!.id) fifthDocument = row;
      if (row?.id === late.id) {
        lateDocument = row;
        latePosition = page.value.position;
      }
      if (page.value.next === null) break;
      cursor = page.value.next;
    }
    expect(fifthDocument).toMatchObject({
      identity: `content:review:${initial[4]!.id}`,
      owner: 'content',
      kind: 'review',
      route,
      id: initial[4]!.id,
      source_position: expect.any(String),
      version: expect.any(String),
      opening_revision_id: expect.any(String),
      text: initial[4]!.text,
    });
    if (!fifthDocument || !lateDocument) throw new Error('Content continuation lost an eligible review');
    expect(fifthDocument).not.toHaveProperty('authorId');
    expect(fifthDocument).not.toHaveProperty('voteCitation');
    expect(latePosition).toBeGreaterThan(sparse.value.position);
    const lateCard = await adapter.currentSummaries([lateDocument], context);
    expect(lateCard).toMatchObject({ status: 'ready' });
    if (lateCard.status === 'ready') {
      expect(lateCard.value.get(`content:review:${late.id}`)).toEqual({
        kind: 'review',
        id: late.id,
        route,
        openingRevisionId: lateDocument.opening_revision_id,
        title: late.title,
        text: late.text,
      });
      expect(lateCard.value.get(`content:review:${late.id}`)).not.toHaveProperty('authorId');
    }

    const firstCard = await adapter.currentSummaries([fifthDocument], context);
    expect(firstCard.status).toBe('ready');
    if (firstCard.status !== 'ready') return;
    expect(firstCard.value.get(fifthDocument.identity)?.text).toBe(initial[4]!.text);
    const authorSummary = await adapter.readCurrent([initial[4]!.id], context);
    expect(authorSummary.get(initial[4]!.id)).toEqual({
      id: initial[4]!.id,
      title: initial[4]!.title,
      summary: initial[4]!.text,
    });

    await revisePost(
      { pool: fixture.pool, access: fixture.access, routeKey },
      author,
      { threadId: initial[4]!.id, itemId: initial[4]!.postId, body: fromPlainText('Revised public opening.') } as never,
      request(),
    );
    const withdrawn = await adapter.currentSummaries([fifthDocument], context);
    expect(withdrawn).toEqual({ status: 'ready', value: new Map() });

    async function currentDocument(id: string): Promise<ReviewDiscoveryDocument | undefined> {
      let after: ReviewDiscoveryFrontier | null = null;
      const maxPages = Math.ceil((initial.length + lateReviews.length) / REVIEW_DISCOVERY_PAGE_SIZE) + 1;
      for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
        const page = await adapter.page(partition, after, REVIEW_DISCOVERY_PAGE_SIZE);
        expect(page.status).toBe('ready');
        if (page.status !== 'ready') return undefined;
        const found = page.value.documents.find((row) => row.id === id);
        if (found) return found;
        if (page.value.next === null) return undefined;
        after = page.value.next;
      }
      return undefined;
    }

    const revisedDocument = (await currentDocument(initial[4]!.id))!;
    expect(revisedDocument.id).toBe(initial[4]!.id);
    expect(revisedDocument.opening_revision_id).not.toBe(fifthDocument.opening_revision_id);
    expect((await adapter.currentSummaries([revisedDocument], context)).status).toBe('ready');

    await fixture.grant(author.accountId, 'post:erase', {
      route: routeOf(initial[4]!.postId)!,
      id: initial[4]!.postId,
    });
    await erasePost(
      { pool: fixture.pool, access: fixture.access, routeKey },
      author,
      { postId: initial[4]!.postId, reason: 'Author withdrew the review opening' },
      request(),
    );
    expect(await adapter.currentSummaries([revisedDocument], context)).toEqual({ status: 'ready', value: new Map() });
    await restorePost({ pool: fixture.pool, access: fixture.access, routeKey }, author, initial[4]!.postId, request());
    expect(await adapter.currentSummaries([revisedDocument], context)).toEqual({ status: 'preparing' });

    const restoredDocument = (await currentDocument(initial[4]!.id))!;
    expect(restoredDocument.id).toBe(initial[4]!.id);
    expect(restoredDocument.opening_revision_id).toBe(revisedDocument.opening_revision_id);
    expect(BigInt(restoredDocument.source_position)).toBeGreaterThan(BigInt(revisedDocument.source_position));
    const restoredCard = await adapter.currentSummaries([restoredDocument], context);
    expect(restoredCard.status).toBe('ready');
    if (restoredCard.status === 'ready')
      expect(restoredCard.value.get(restoredDocument.identity)?.text).toBe('Revised public opening.');
  });
});
