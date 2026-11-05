import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createReviewLifecycleFixture, requestKey } from '../content/review-native-lifecycle-fixture.ts';
import { createReviewDiscoverySource } from '../../src/content/review-discovery.ts';
import { revisePost } from '../../src/content/commands.ts';
import { softDeletePost } from '../../src/content/erase-post.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { createRatedSubjectSource } from '../../src/search/rated-source.ts';
import { nativeDiscoveryRegistry } from '../../src/search/account-discovery.ts';
import { createDiscoveryProducerEntry } from '../../src/composition/discovery.ts';
import { hydrateOwnerDiscoveryHits } from '../../src/search/discovery-hydration.ts';
import { discoveryHttpPage } from '../../src/search/discovery-http.ts';
import { prepareSearchReviewContexts, REVIEW_CONTEXT_LIMITS } from '../../src/search/review-context.ts';
import type { DiscoveryPage } from '../../src/search/discovery.ts';

// Real native Content creation, vote writer, selected hydration and closed Search wire.
// Broader query/ranking/census growth acceptance remains with the integrated controller.
test('selected mixed Search preserves the opening citation and current target, and refuses assembly movement', async () => {
  const f = await createReviewLifecycleFixture();
  try {
    const deps = {
      pool: f.system.database.pool,
      access: f.system.access,
      tokens: f.system.tokenKeys,
      routeKey: f.system.routeKey,
    };
    const context = () => ({
      access: deps.access,
      actor: { kind: 'anonymous' as const },
      deadline: Date.now() + 120_000,
      languages: ['en'],
    });
    const writer = f.system.actors.author.actor;
    const request = () => ({
      idempotencyKey: requestKey('search-review'),
      requestId: Bun.randomUUIDv7(),
      deadline: Date.now() + 120_000,
    });
    const targets = [await f.subject('Same title'), await f.subject('Same title')];
    const votes = [];
    const ids: string[] = [];
    const posts: string[] = [];
    for (const subjectId of targets) {
      const vote = await f.call('PUT', `/v1/subjects/${subjectId}/ratings/${STANDARD_QUESTION_ID}/vote`, {
        bearer: f.author.bearer,
        body: { units: 0 },
      });
      expect(vote.response.status, vote.text).toBe(200);
      const citation = { questionId: STANDARD_QUESTION_ID, units: 0, revision: vote.value.revision as number };
      votes.push(citation);
      const created = await f.call('POST', '/v1/threads', {
        bearer: f.author.bearer,
        body: {
          kind: 'review',
          title: 'A native review',
          body: fromPlainText('Opening observation.'),
          licence: 'CC-BY-4.0',
          boardId: f.boardId,
          subjectIds: [subjectId],
          visibility: 'published',
          voteCitation: citation,
        },
      });
      expect(created.response.status, created.text).toBe(201);
      ids.push(created.value.thread.id);
      posts.push(created.value.thread.firstPost.id);
      const changed = await f.call('PUT', `/v1/subjects/${subjectId}/ratings/${STANDARD_QUESTION_ID}/vote`, {
        bearer: f.author.bearer,
        body: { units: 19 },
      });
      expect(changed.response.status, changed.text).toBe(200);
    }
    const source = createRatedSubjectSource(deps.pool, deps.routeKey).source;
    const producers = createDiscoveryProducerEntry({ ...deps, subjects: source });
    const registry = await nativeDiscoveryRegistry(
      deps.pool,
      deps.routeKey,
      producers.subjects,
      { ownerAdapters: producers.ownerAdapters, accounts: producers.accounts, languages: ['en'] },
    );
    async function selected(): Promise<DiscoveryPage> {
      const read = context();
      const source = createReviewDiscoverySource(deps, () => read);
      const snapshot = await source.hydrate(partitionOf(routeOf(ids[0]!)!), ids);
      expect(snapshot.reviews).toHaveLength(2);
      const hits = await hydrateOwnerDiscoveryHits(
        registry,
        snapshot.reviews.map((row) => ({
          key: { owner: 'content' as const, kind: 'review' as const, route: routeOf(row.id)!, id: row.id },
          revision: row.revisionId,
          sourceVersion: row.sourceVersion,
          sourcePosition: snapshot.position.toString(),
        })),
        read,
      );
      return {
        hits: hits.flatMap((hit) => (hit ? [hit] : [])),
        kinds: { values: [], next: null },
        as_of: new Date().toISOString(),
        next: null,
      };
    }
    const page = await selected();
    const prepared = await prepareSearchReviewContexts(deps, page, context());
    const result = await prepared.finish(page);
    const wire = discoveryHttpPage(result);
    expect(wire.hits.map((hit) => hit.key.id)).toEqual(page.hits.map((hit) => hit.key.id));
    expect(wire.next).toBe(page.next);
    expect(wire.kinds).toEqual(page.kinds);
    for (const [index, hit] of wire.hits.entries()) {
      if (hit.summary.kind !== 'review') throw new Error('Expected native review');
      expect(hit.summary.value.source?.openingRevisionId).toBeTruthy();
      expect(hit.summary.value.searchContext).toMatchObject({
        state: 'available',
        openingPostId: posts[index],
        target: {
          state: 'available',
          subject: { id: targets[index], type: 'schema:Book', label: { value: 'Same title' } },
        },
        citation: { state: 'available', recorded: votes[index], historicalQuestion: { state: 'unavailable' } },
      });
      expect(JSON.stringify(hit.summary.value.searchContext)).not.toContain('How much did you like');
      expect(JSON.stringify(hit.summary.value.searchContext)).not.toContain('"units":19');
    }
    expect(Buffer.byteLength(JSON.stringify(wire.hits))).toBeLessThan(REVIEW_CONTEXT_LIMITS.pageBytes);

    const moving = await prepareSearchReviewContexts(deps, page, context());
    await revisePost(
      { ...deps },
      writer,
      {
        threadId: ids[0]!,
        itemId: posts[0]!,
        title: 'Changed while assembling',
        body: fromPlainText('A replacement opening.'),
      },
      request(),
    );
    await expect(moving.finish(page)).rejects.toMatchObject({ code: 'search_restart_required' });

    const updated = await selected();
    const concealing = await prepareSearchReviewContexts(deps, updated, context());
    await f.admin.query(
      "UPDATE semantic.subject SET visibility='hidden',security_revision=security_revision+1 WHERE route=$1 AND subject_id=$2",
      [routeOf(targets[0]!), targets[0]],
    );
    await expect(concealing.finish(updated)).rejects.toMatchObject({ code: 'search_restart_required' });
    await f.admin.query(
      "UPDATE semantic.subject SET visibility='visible',security_revision=security_revision+1 WHERE route=$1 AND subject_id=$2",
      [routeOf(targets[0]!), targets[0]],
    );

    const restored = await selected();
    const removing = await prepareSearchReviewContexts(deps, restored, context());
    await softDeletePost(deps, writer, { postId: posts[0]!, reason: 'withdraw opening' }, request());
    await expect(removing.finish(restored)).rejects.toMatchObject({ code: 'search_restart_required' });
    await expect(
      prepareSearchReviewContexts(deps, { ...page, hits: Array(101).fill(page.hits[0]) }, context()),
    ).rejects.toThrow('At most 100 selected Search reviews');
  } finally {
    await f.close();
  }
}, 240_000);
