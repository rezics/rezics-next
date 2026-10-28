import type { KernelClient } from '@rezics/client';
import type { Fixtures, KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';
import { chosenLabels, isRecord, languageList } from './languages.ts';

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
        relation: isRecord(stored) && stored.relation === 'lower_bound' ? 'lower_bound' : 'exact',
        values: limited,
      };
    }),
    total: isRecord(recording.total) ? (recording.total as FacetsResponse['total']) : { value: 0, relation: 'exact' },
    as_of: typeof recording.as_of === 'string' ? recording.as_of : '2026-10-27T00:00:00Z',
  } as FacetsResponse;
}

function localized(response: FacetsResponse, languages: readonly string[]): FacetsResponse {
  return {
    ...response,
    facets: response.facets.map((facet) => ({
      ...facet,
      values: facet.values.map((value) => ({
        ...value,
        labels: chosenLabels(value.labels, languages),
      })),
    })),
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
  const counts = new Map<string, number>();
  for (const subject of matched) counts.set(subject.type, (counts.get(subject.type) ?? 0) + 1);
  const release = isRecord(recordings['definitions-release']?.release)
    ? (recordings['definitions-release']!.release as Record<string, unknown>)
    : undefined;
  const definitions = release && isRecord(release.types) ? release.types : {};
  const requested = Array.isArray(body.facets) ? body.facets.filter(isRecord) : [];
  const facets = requested.map((facet) => {
    const property = typeof facet.property === 'string' ? facet.property : '';
    if (property !== 'type') return { property, relation: 'exact' as const, values: [] };
    const size = typeof facet.size === 'number' ? Math.max(0, Math.min(facet.size, 20)) : 20;
    const values = [...counts]
      .map(([value, count]) => {
        const definition = definitions[value];
        const labels = isRecord(definition) && isRecord(definition.labels) ? definition.labels : {};
        return {
          value,
          count,
          labels: chosenLabels(
            Object.fromEntries(
              Object.entries(labels).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
            ),
            languages,
          ),
        };
      })
      .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
      .slice(0, size);
    return { property, relation: 'exact' as const, values };
  });
  return {
    facets,
    total: { value: matched.length, relation: 'exact' },
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
  {
    method: 'POST',
    path: '/v1/subjects:facets',
    story: async ({ request, recordings }) => {
      const body = await requestBody(request);
      if (!body) return undefined;
      const languages = languageList(body.languages);
      if (languages.length === 0 || !Array.isArray(body.facets)) return undefined;
      const requested = body.facets.filter(isRecord);
      if (!requested.some((facet) => facet.property === 'type')) return undefined;
      const recording = recordings['search-facets'];
      if (!recording) return undefined;
      return { ...localized(responseFromRecording(recording, requested), languages), status: recording.status };
    },
    fixture: async ({ request, recordings, fixtures }) => {
      const body = await requestBody(request);
      if (!body || languageList(body.languages).length === 0 || !Array.isArray(body.facets)) return undefined;
      return { ...fixtureResponse(fixtures, recordings, body), status: 200 };
    },
  },
];
