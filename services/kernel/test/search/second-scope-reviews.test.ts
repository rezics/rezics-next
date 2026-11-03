import { afterAll, describe, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createThread, revisePost } from '../../src/content/commands.ts';
import { erasePost } from '../../src/content/moderation.ts';
import { restorePost } from '../../src/content/restore-post.ts';
import { createNativeReviewDiscoveryAdapter, createReviewDiscoveryAdapter } from '../../src/search/review-discovery.ts';
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

    async function publish(target: string, ordinal: number) {
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
      return { id: result.value.threadId, postId: result.value.itemId, subjectId: target };
    }

    const initial = [];
    for (let ordinal = 0; ordinal < 5; ordinal += 1) initial.push(await publish(await subject(ordinal), ordinal));
    initial.sort((left, right) => left.id.localeCompare(right.id));
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

    const late = await publish(await subject(9), 9);
    expect(late.id.localeCompare(initial[4]!.id)).toBeGreaterThan(0);
    const fifth = await adapter.page(partition, sparse.value.next, 1);
    expect(fifth.status).toBe('ready');
    if (fifth.status !== 'ready') return;
    const fifthDocument = fifth.value.documents[0]!;
    expect(fifthDocument).toMatchObject({
      identity: `content:review:${initial[4]!.id}`,
      owner: 'content',
      kind: 'review',
      route,
      id: initial[4]!.id,
      source_position: fifth.value.position.toString(),
      version: fifth.value.position.toString(),
      opening_revision_id: expect.any(String),
      text: 'Public review opening 4.',
    });
    expect(fifthDocument).not.toHaveProperty('authorId');
    expect(fifthDocument).not.toHaveProperty('voteCitation');
    expect(fifth.value.position).toBeGreaterThan(sparse.value.position);
    expect(fifth.value.next).toEqual({ route, id: initial[4]!.id });

    const latePage = await adapter.page(partition, fifth.value.next, 1);
    expect(latePage).toMatchObject({ status: 'ready', value: { next: null } });
    if (latePage.status !== 'ready') return;
    expect(latePage.value.documents[0]?.identity).toBe(`content:review:${late.id}`);
    const lateCard = await adapter.currentSummaries(latePage.value.documents, context);
    expect(lateCard).toMatchObject({ status: 'ready' });
    if (lateCard.status === 'ready') {
      expect(lateCard.value.get(`content:review:${late.id}`)).toEqual({
        kind: 'review',
        id: late.id,
        route,
        openingRevisionId: latePage.value.documents[0]!.opening_revision_id,
        title: 'Native review 9',
        text: 'Public review opening 9.',
      });
      expect(lateCard.value.get(`content:review:${late.id}`)).not.toHaveProperty('authorId');
    }

    const firstCard = await adapter.currentSummaries([fifthDocument], context);
    expect(firstCard.status).toBe('ready');
    if (firstCard.status !== 'ready') return;
    expect(firstCard.value.get(fifthDocument.identity)?.text).toBe('Public review opening 4.');
    const authorSummary = await adapter.readCurrent([initial[4]!.id], context);
    expect(authorSummary.get(initial[4]!.id)).toEqual({
      id: initial[4]!.id,
      title: 'Native review 4',
      summary: 'Public review opening 4.',
    });

    await revisePost(
      { pool: fixture.pool, access: fixture.access, routeKey },
      author,
      { threadId: initial[4]!.id, itemId: initial[4]!.postId, body: fromPlainText('Revised public opening.') } as never,
      request(),
    );
    const withdrawn = await adapter.currentSummaries([fifthDocument], context);
    expect(withdrawn).toEqual({ status: 'ready', value: new Map() });

    const revisedPage = await adapter.page(partition, sparse.value.next, 1);
    expect(revisedPage.status).toBe('ready');
    if (revisedPage.status !== 'ready') return;
    const revisedDocument = revisedPage.value.documents[0]!;
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

    const restoredPage = await adapter.page(partition, sparse.value.next, 1);
    expect(restoredPage.status).toBe('ready');
    if (restoredPage.status !== 'ready') return;
    const restoredDocument = restoredPage.value.documents[0]!;
    expect(restoredDocument.id).toBe(initial[4]!.id);
    expect(restoredDocument.opening_revision_id).toBe(revisedDocument.opening_revision_id);
    expect(BigInt(restoredDocument.source_position)).toBeGreaterThan(BigInt(revisedDocument.source_position));
    const restoredCard = await adapter.currentSummaries([restoredDocument], context);
    expect(restoredCard.status).toBe('ready');
    if (restoredCard.status === 'ready')
      expect(restoredCard.value.get(restoredDocument.identity)?.text).toBe('Revised public opening.');
  });
});
