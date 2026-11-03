import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  collectionFilterRoutePath,
  collectionFilterSearch,
  collectionFilterStoryId,
  haremConceptId,
  preparingConceptId,
  routes,
  unmatchedConceptId,
} from '../src/kernel/fake/collection-filters';
import type { FakeRoute } from '../src/kernel/fake-modules';
import type { KernelRecording } from '../src/kernel/fake';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

async function dispatch(request: Request, candidates: FakeRoute[] = routes): Promise<KernelRecording | undefined> {
  const path = new URL(request.url).pathname;
  for (const route of candidates) {
    if (route.method !== request.method) continue;
    const match = typeof route.path === 'string' ? null : route.path.exec(path);
    if (typeof route.path === 'string' ? route.path !== path : !match) continue;
    const response = await route.story?.({ request, match, recordings: {} });
    if (response) return response;
  }
}

function membersRequest(document: unknown) {
  const query = new URLSearchParams({ filter: JSON.stringify(document) });
  return new Request(`https://kernel.test/v1/collections/${collectionFilterStoryId}/members?${query}`);
}

test('the routed Collection filter story uses the generated route, product reader and explicit combined search', () => {
  const story = source('../src/stories/library-collection-filters.stories.tsx');
  const page = source('../src/stories/page.tsx');
  const route = source('../src/routes/collections/$id.tsx');
  const queries = source('../src/library/collection-queries.ts');
  const filters = source('../src/library/collection-filters.tsx');
  const exports = [...story.matchAll(/export const (\w+): Story =/g)];
  expect(exports.map((entry) => entry[1])).toEqual([
    'Reference',
    'ConceptSelected',
    'WordRangeApplied',
    'CombinedFilters',
    'ActualCombined',
    'NoMatches',
    'Preparing',
    'FilterSourceUnavailable',
  ]);
  const scenarios = Object.fromEntries(
    exports.map((entry, index) => [entry[1]!, story.slice(entry.index, exports[index + 1]?.index ?? story.length)]),
  );

  expect(route).toContain("createFileRoute('/collections/$id')");
  expect(route).toContain('collectionPageQuery(');
  expect(queries).toContain('export function collectionPageQuery(');
  expect(filters).toContain('export function CollectionFilters(');
  expect(page).toContain('export function PageStory(');
  expect(scenarios.ActualCombined).toContain('<PageStory visitor="Signed Out"');
  expect(scenarios.ActualCombined).toContain('collectionFilterRoutePath(states.combined)');
  expect(scenarios.ActualCombined).not.toContain('CollectionPage');
  expect(scenarios.ActualCombined).not.toContain('filterProperties');
  expect(scenarios.ActualCombined).not.toContain('FilterRegion');
  expect(collectionFilterRoutePath(collectionFilterSearch.combined)).toContain(collectionFilterStoryId);
  expect(collectionFilterRoutePath(collectionFilterSearch.combined)).toContain(`f.schema%3Akeywords=${haremConceptId}`);
  expect(collectionFilterRoutePath(collectionFilterSearch.combined)).toContain('l.schema%3Akeywords=Harem');
  expect(collectionFilterRoutePath(collectionFilterSearch.combined)).toContain(
    'r.schema%3AwordCount=1000001%2C999999999999999',
  );

  for (const name of ['Reference', 'ConceptSelected', 'WordRangeApplied', 'CombinedFilters', 'NoMatches', 'Preparing'])
    expect(scenarios[name]).toContain('PatternStory');
  expect(story).toContain('longFilterPropertySuffix');
  expect(story).toContain('search === states.combined');
  expect(scenarios.CombinedFilters).toContain('states.combined');
  expect(scenarios.FilterSourceUnavailable).toContain('CollectionFilterFeedback');
  expect(scenarios.FilterSourceUnavailable).toContain('status="failed"');
});

test('the filter scenario seam keeps combined, empty, preparing and unsupported members distinct', async () => {
  const header = await dispatch(new Request(`https://kernel.test/v1/collections/${collectionFilterStoryId}`));
  expect(header?.collection.id).toBe(collectionFilterStoryId);
  expect(header?.collection.memberCount).toBe(5);

  const combined = await dispatch(
    membersRequest({
      and: [
        { statement: { property: 'schema:keywords', in: [haremConceptId] } },
        { statement: { property: 'schema:wordCount', range: { gte: 1_000_001, lte: 999_999_999_999_999 } } },
      ],
    }),
  );
  expect(combined?.status).toBe(200);
  expect(combined?.next).toBeNull();
  expect(combined?.members.map((member: { subject: { label: string } }) => member.subject.label)).toEqual([
    'Snow Country',
  ]);

  const empty = await dispatch(
    membersRequest({ statement: { property: 'schema:keywords', in: [unmatchedConceptId] } }),
  );
  expect(empty?.status).toBe(200);
  expect(empty?.members).toEqual([]);
  expect(empty?.next).toBeNull();

  const preparing = await dispatch(
    membersRequest({ statement: { property: 'schema:keywords', in: [preparingConceptId] } }),
  );
  expect(preparing?.status).toBe(202);
  expect(preparing?.preparing).toBe(true);

  const unsupported = await dispatch(
    membersRequest({ statement: { property: 'schema:author', in: [haremConceptId] } }),
  );
  expect(unsupported?.status).toBe(422);
  expect(unsupported?.code).toBe('unsupported_query');

  expect(
    await dispatch(new Request('https://kernel.test/v1/collections/01a17a3b-6d8f-71f2-a0f8-f4ccbb7c7ba2')),
  ).toBeUndefined();
});
