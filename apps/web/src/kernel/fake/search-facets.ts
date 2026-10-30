import type { KernelClient } from '@rezics/client';
import type { Fixtures, KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';
import emptySearch from '../recorded/search-empty.json';
import typedSearch from '../recorded/search-typed.json';
import { chosenLabels, isRecord, languageList } from './languages.ts';

export const searchFacetStoryPaths = {
  results: '/search?q=Prince&type=schema%3ABook',
  active: '/search?q=Prince&type=schema%3ABook&f.schema%3Agenre=01a17dfd-5da5-76da-bc50-a1fb5dbc87d2',
  noResults: `/search?q=${encodeURIComponent(emptySearch.query)}`,
  emptyQuery: '/search',
};

const storyValues: Record<string, { value: string; labels: Record<string, string> }[]> = {
  'schema:author': [
    {
      value: '00000000-0000-4000-8000-000000000101',
      labels: { en: 'Antoine de Saint-Exupéry', 'zh-Hans': '安托万·德·圣埃克苏佩里' },
    },
  ],
  'schema:genre': [{ value: '01a17dfd-5da5-76da-bc50-a1fb5dbc87d2', labels: { en: 'Fable', 'zh-Hans': '寓言' } }],
  'schema:datePublished': [],
};

async function storySearch(request: Request): Promise<KernelRecording | undefined> {
  let body: { text?: unknown };
  try {
    body = (await request.json()) as { text?: unknown };
  } catch {
    return;
  }
  if (body.text === typedSearch.query) return { ...typedSearch, status: 200 } as KernelRecording;
  if (body.text === emptySearch.query) return emptySearch as KernelRecording;
}

function storyFacets(body: Record<string, unknown>): KernelRecording | undefined {
  const requested = Array.isArray(body.facets) ? body.facets.filter(isRecord) : [];
  if (requested.some((facet) => facet.property === 'type')) return;
  return {
    status: 200,
    facets: requested.map((facet) => {
      const property = typeof facet.property === 'string' ? facet.property : '';
      return { property, values: storyValues[property] ?? [] };
    }),
    as_of: '2026-10-26T18:21:56.818Z',
  };
}

type FacetsResponse = NonNullable<Awaited<ReturnType<KernelClient['subjects']['$facets']['post']>>['data']>;

function requestType(filter: unknown): string | undefined {
  if (!isRecord(filter)) return undefined;
  if (isRecord(filter.type) && Array.isArray(filter.type.in))
    return filter.type.in.find((value): value is string => typeof value === 'string');
  if (Array.isArray(filter.and))
    for (const clause of filter.and) {
      const type = requestType(clause);
      if (type) return type;
    }
  return undefined;
}

function queryMatches(subject: Fixtures['subjects'][number], query: string): boolean {
  if (query.length === 0) return true;
  const needle = query.toLocaleLowerCase();
  return [
    ...Object.values(subject.labels),
    ...Object.values(subject.aliases).flat(),
    ...Object.values(subject.descriptions),
  ].some((label) => typeof label === 'string' && label.toLocaleLowerCase().includes(needle));
}

function responseFromRecording(recording: KernelRecording, requested: Record<string, unknown>[]): FacetsResponse {
  const source = recording.facets;
  const facets = Array.isArray(source) ? source : [];
  return {
    facets: requested.map((request) => {
      const property = typeof request.property === 'string' ? request.property : '';
      const stored = facets.find((facet) => isRecord(facet) && facet.property === property);
      const values = isRecord(stored) && Array.isArray(stored.values) ? stored.values : [];
      const limited = values.slice(0, typeof request.size === 'number' ? Math.max(0, Math.min(request.size, 20)) : 20);
      return {
        property,
        values: limited,
      };
    }),
    as_of: typeof recording.as_of === 'string' ? recording.as_of : '2026-10-27T00:00:00Z',
  } as FacetsResponse;
}

function definitionTypeLabels(
  recordings: Record<string, KernelRecording>,
  type: string,
): Record<string, string> | undefined {
  const release = recordings['definitions-release']?.release;
  if (!isRecord(release) || !isRecord(release.types)) return;
  const definition = release.types[type];
  if (!isRecord(definition) || !isRecord(definition.labels)) return;
  const labels = Object.fromEntries(
    Object.entries(definition.labels).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  return Object.keys(labels).length > 0 ? labels : undefined;
}

function localized(
  response: FacetsResponse,
  languages: readonly string[],
  recordings: Record<string, KernelRecording>,
): FacetsResponse {
  return {
    ...response,
    facets: response.facets.map((facet) => ({
      ...facet,
      values: facet.values.map((value) => ({
        ...value,
        labels: chosenLabels(
          facet.property === 'type' ? (definitionTypeLabels(recordings, value.value) ?? value.labels) : value.labels,
          languages,
        ),
      })),
    })),
  };
}

function withoutCounts(response: FacetsResponse): FacetsResponse {
  return {
    facets: response.facets.map((facet) => ({
      property: facet.property,
      values: facet.values.map((value) => ({ value: value.value, labels: value.labels })),
    })),
    as_of: response.as_of,
  };
}

function fixtureResponse(
  fixtures: Fixtures,
  recordings: Record<string, KernelRecording>,
  body: Record<string, unknown>,
): FacetsResponse {
  const languages = languageList(body.languages);
  const query = typeof body.text === 'string' ? body.text.trim() : '';
  const type = requestType(body.filter);
  const matched = fixtures.subjects.filter(
    (subject) => (!type || subject.type === type) && queryMatches(subject, query),
  );
  const types = new Set(matched.map((subject) => subject.type));
  const release = isRecord(recordings['definitions-release']?.release)
    ? (recordings['definitions-release']!.release as Record<string, unknown>)
    : undefined;
  const definitions = release && isRecord(release.types) ? release.types : {};
  const requested = Array.isArray(body.facets) ? body.facets.filter(isRecord) : [];
  const facets = requested.map((facet) => {
    const property = typeof facet.property === 'string' ? facet.property : '';
    if (property !== 'type') return { property, values: [] };
    const size = typeof facet.size === 'number' ? Math.max(0, Math.min(facet.size, 20)) : 20;
    const values = [...types]
      .map((value) => {
        const definition = definitions[value];
        const labels = isRecord(definition) && isRecord(definition.labels) ? definition.labels : {};
        return {
          value,
          labels: chosenLabels(
            Object.fromEntries(
              Object.entries(labels).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
            ),
            languages,
          ),
        };
      })
      .sort((left, right) => left.value.localeCompare(right.value))
      .slice(0, size);
    return { property, values };
  });
  return {
    facets,
    as_of: '2026-10-27T00:00:00Z',
  } as FacetsResponse;
}

async function requestBody(request: Request): Promise<Record<string, unknown> | undefined> {
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => undefined);
  return isRecord(body) ? body : undefined;
}

export const routes: FakeRoute[] = [
  { method: 'POST', path: '/v1/subjects:search', story: ({ request }) => storySearch(request) },
  {
    method: 'POST',
    path: '/v1/subjects:facets',
    story: async ({ request, recordings }) => {
      const body = await requestBody(request);
      if (!body) return undefined;
      const story = storyFacets(body);
      if (story) return story;
      const languages = languageList(body.languages);
      if (languages.length === 0 || !Array.isArray(body.facets)) return undefined;
      const requested = body.facets.filter(isRecord);
      if (!requested.some((facet) => facet.property === 'type')) return undefined;
      const recording = recordings['search-facets'];
      if (!recording) return undefined;
      const response = localized(responseFromRecording(recording, requested), languages, recordings);
      return { ...withoutCounts(response), status: recording.status };
    },
    fixture: async ({ request, recordings, fixtures }) => {
      const body = await requestBody(request);
      if (!body || languageList(body.languages).length === 0 || !Array.isArray(body.facets)) return undefined;
      const response = fixtureResponse(fixtures, recordings, body);
      return { ...(fixtures.facetsWithoutCounts ? withoutCounts(response) : response), status: 200 };
    },
  },
];
