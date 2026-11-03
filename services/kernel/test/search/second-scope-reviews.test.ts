import { describe, expect, test } from 'bun:test';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import type { DiscoveryReadContext } from '../../src/search/discovery.ts';
import {
  createReviewDiscoveryAdapter,
  reviewDiscoveryDocument,
  type ContentReviewDiscoverySource,
  type ReviewDiscoveryObservation,
  type ReviewDiscoveryRecord,
} from '../../src/search/review-discovery.ts';

function id(suffix: number): string {
  return `00000000-0000-7000-8000-${suffix.toString(16).padStart(12, '0')}`;
}

function review(value: string, version: bigint): ReviewDiscoveryRecord {
  const route = routeOf(value);
  if (route === null) throw new Error('Test review id must be routable');
  return {
    id: value,
    route,
    version,
    openingRevisionId: `revision-${version}`,
    canonicalDestination: `/threads/${value}`,
    title: `Review ${version}`,
    text: `Opening text ${version}`,
  };
}

function source(overrides: Partial<ContentReviewDiscoverySource> = {}): ContentReviewDiscoverySource {
  return {
    readiness: async () => 'ready',
    count: async (partition) => ({ partition, position: 20n, count: 0 }),
    page: async (partition, _after, _limit, atPosition) => ({
      partition,
      position: atPosition,
      reviews: [],
      next: null,
    }),
    read: async (partition, ids, atLeast) => ({
      partition,
      position: atLeast > 0n ? atLeast : 1n,
      observations: ids.map((value) => {
        const route = routeOf(value)!;
        return { state: 'concealed' as const, id: value, route, version: 1n };
      }),
    }),
    summaries: async () => [],
    ...overrides,
  };
}

describe('public review discovery adapter', () => {
  test('keeps absent coverage unavailable and incomplete coverage preparing', async () => {
    const first = review(id(1), 5n);
    const partition = partitionOf(first.route);
    const absent = createReviewDiscoveryAdapter();
    expect(await absent.readiness()).toBe('unavailable');
    expect(await absent.count(partition)).toEqual({ status: 'unavailable' });

    let pageCalls = 0;
    const preparing = createReviewDiscoveryAdapter(
      source({
        readiness: async () => 'preparing',
        page: async (...args) => {
          pageCalls += 1;
          return source().page(...args);
        },
      }),
    );
    const census = { partition, position: 20n, count: 1 };
    expect(await preparing.page(partition, null, 1, census, 0)).toEqual({ status: 'preparing' });
    expect(pageCalls).toBe(0);
  });

  test('validates whole native pages before exposing their review frontier and documents', async () => {
    const partition = partitionOf(routeOf(id(1))!);
    const rows = [review(id(1), 6n), review(id(2), 7n)].sort((a, b) => a.route - b.route || a.id.localeCompare(b.id));
    const native = source({
      count: async () => ({ partition, position: 20n, count: rows.length }),
      page: async (_partition, after, limit, atPosition) => {
        const start = after ? rows.findIndex((row) => row.id === after.id) + 1 : 0;
        const reviews = rows.slice(start, start + limit);
        const last = reviews.at(-1);
        const more = start + reviews.length < rows.length;
        return {
          partition,
          position: atPosition,
          reviews,
          next: more && last ? { route: last.route, id: last.id } : null,
        };
      },
    });
    const adapter = createReviewDiscoveryAdapter(native);
    const counted = await adapter.count(partition);
    expect(counted.status).toBe('ready');
    if (counted.status !== 'ready') return;
    const census = counted.value;
    const first = await adapter.page(partition, null, 1, census, 0);
    expect(first.status).toBe('ready');
    if (first.status !== 'ready') return;
    expect(first.value.next).toEqual({ route: rows[0]!.route, id: rows[0]!.id });
    expect(first.value.documents[0]).toMatchObject({
      identity: `content:review:${rows[0]!.id}`,
      owner: 'content',
      kind: 'review',
      source_position: '20',
      opening_revision_id: rows[0]!.openingRevisionId,
      canonical_destination: rows[0]!.canonicalDestination,
      text: rows[0]!.text,
    });
    expect(first.value.documents[0]).not.toHaveProperty('vote');
    const last = await adapter.page(partition, first.value.next, 1, census, first.value.consumed);
    expect(last).toMatchObject({ status: 'ready', value: { next: null, consumed: 2 } });

    const wrongPosition = createReviewDiscoveryAdapter(
      source({
        page: async () => ({
          partition,
          position: 21n,
          reviews: [rows[0]!],
          next: { route: rows[0]!.route, id: rows[0]!.id },
        }),
      }),
    );
    await expect(wrongPosition.page(partition, null, 1, census, 0)).rejects.toThrow();
    const wrongFrontier = createReviewDiscoveryAdapter(
      source({
        page: async () => ({
          partition,
          position: 20n,
          reviews: [rows[0]!],
          next: { route: rows[1]!.route, id: rows[1]!.id },
        }),
      }),
    );
    await expect(wrongFrontier.page(partition, null, 1, census, 0)).rejects.toThrow();
  });

  test('withdrawal and deletion suppress lagging hits; restoration needs its newer indexed revision', async () => {
    const active = review(id(3), 6n);
    const partition = partitionOf(active.route);
    let current: { position: bigint; observation: ReviewDiscoveryObservation } = {
      position: 21n,
      observation: { state: 'withdrawn', id: active.id, route: active.route, version: 7n },
    };
    let authorizedSummary = active;
    let summaryCalls = 0;
    const native = source({
      read: async () => ({ partition, position: current.position, observations: [current.observation] }),
      summaries: async () => {
        summaryCalls += 1;
        return [authorizedSummary];
      },
    });
    const adapter = createReviewDiscoveryAdapter(native);
    const stale = reviewDiscoveryDocument(partition, 20n, active);
    const context = {} as DiscoveryReadContext;

    const afterWithdrawal = await adapter.currentSummaries([stale], context);
    expect(afterWithdrawal.status).toBe('ready');
    if (afterWithdrawal.status !== 'ready') return;
    expect(afterWithdrawal.value.size).toBe(0);
    current = {
      position: 22n,
      observation: { state: 'deleted', id: active.id, route: active.route, version: 8n },
    };
    const afterDeletion = await adapter.currentSummaries([stale], context);
    expect(afterDeletion.status).toBe('ready');
    if (afterDeletion.status !== 'ready') return;
    expect(afterDeletion.value.size).toBe(0);
    const restored = review(active.id, 9n);
    current = { position: 23n, observation: { state: 'eligible', ...restored } };
    const beforeReindex = await adapter.currentSummaries([stale], context);
    expect(beforeReindex.status).toBe('ready');
    if (beforeReindex.status !== 'ready') return;
    expect(beforeReindex.value.size).toBe(0);

    const restoredDocument = reviewDiscoveryDocument(partition, 23n, restored);
    authorizedSummary = restored;
    const summaries = await adapter.currentSummaries([restoredDocument], context);
    expect(summaryCalls).toBe(1);
    expect(summaries.status).toBe('ready');
    if (summaries.status !== 'ready') return;
    expect(summaries.value.get(`content:review:${active.id}`)).toEqual({
      kind: 'review',
      id: restored.id,
      route: restored.route,
      openingRevisionId: restored.openingRevisionId,
      canonicalDestination: restored.canonicalDestination,
      title: restored.title,
      text: restored.text,
    });

    const wrongKey = createReviewDiscoveryAdapter(
      source({
        read: async (_partition, _ids, atLeast) => ({
          partition,
          position: atLeast,
          observations: [
            {
              state: 'concealed' as const,
              id: id(4),
              route: routeOf(id(4))!,
              version: 1n,
            },
          ],
        }),
      }),
    );
    await expect(wrongKey.currentSummaries([restoredDocument], context)).rejects.toThrow();
  });
});
