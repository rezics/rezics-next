import type { KernelClient } from '@rezics/client';
import defaultFixtures from '../fixtures.json' with { type: 'json' };
import type { Fixtures, KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';
import { chosenLabels, isRecord, languageList, localizeRecording, originalLanguage } from './languages.ts';

type SearchResponse = NonNullable<Awaited<ReturnType<KernelClient['subjects']['$search']['post']>>['data']>;
type SuggestionResponse = NonNullable<Awaited<ReturnType<KernelClient['subjects']['$suggest']['get']>>['data']>;

const storyFixtures = defaultFixtures as unknown as Fixtures;

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

function statementFilters(filter: unknown): { property: string; values: string[] }[] {
  if (!isRecord(filter)) return [];
  const found: { property: string; values: string[] }[] = [];
  if (isRecord(filter.statement) && typeof filter.statement.property === 'string' && Array.isArray(filter.statement.in))
    found.push({
      property: filter.statement.property,
      values: filter.statement.in.filter((value): value is string => typeof value === 'string'),
    });
  if (Array.isArray(filter.and)) for (const clause of filter.and) found.push(...statementFilters(clause));
  return found;
}

function matchesText(subject: Fixtures['subjects'][number], query: string): boolean {
  if (!query) return true;
  const needle = query.toLocaleLowerCase();
  const labels = [
    ...Object.values(subject.labels),
    ...Object.values(subject.aliases).flat(),
    ...Object.values(subject.descriptions),
  ];
  return labels.some((label) => typeof label === 'string' && label.toLocaleLowerCase().includes(needle));
}

function matchesStatements(
  subject: Fixtures['subjects'][number],
  filters: { property: string; values: string[] }[],
): boolean {
  const statements = subject.statements as unknown as Record<string, { value: { type: string; content?: unknown } }[]>;
  return filters.every(({ property, values }) =>
    (statements[property] ?? []).some(
      (statement) =>
        statement.value.type === 'value' &&
        typeof statement.value.content === 'string' &&
        values.includes(statement.value.content),
    ),
  );
}

function subjectHit(
  fixtures: Fixtures,
  subject: Fixtures['subjects'][number],
  languages: readonly string[],
): SearchResponse['subjects'][number] {
  const original = originalLanguage(subject);
  const labels = chosenLabels(subject.labels, languages, original);
  const language = Object.keys(labels)[0] ?? 'en';
  const types = [subject.type, ...(fixtures.types[subject.type]?.bases ?? [])];
  return {
    id: subject.id,
    type: subject.type,
    labels,
    descriptions: chosenLabels(subject.descriptions, languages, original),
    summary: {
      id: subject.id,
      type: subject.type,
      types,
      creativeWork: types.includes('schema:CreativeWork'),
      label: { value: labels[language] ?? '', language },
      cover: subject.cover ?? null,
    },
  } as SearchResponse['subjects'][number];
}

function fixtureSearch(fixtures: Fixtures, body: Record<string, unknown>): SearchResponse {
  const languages = languageList(body.languages);
  const query = typeof body.text === 'string' ? body.text.trim() : '';
  const type = requestType(body.filter);
  const properties = statementFilters(body.filter);
  const matched = fixtures.subjects
    .filter(
      (subject) =>
        (!type || subject.type === type) && matchesText(subject, query) && matchesStatements(subject, properties),
    )
    .sort((left, right) => {
      const byLabel = (left.labels.en ?? '').localeCompare(right.labels.en ?? '');
      return byLabel || left.id.localeCompare(right.id);
    });
  const limit =
    typeof body.limit === 'number' && Number.isInteger(body.limit) ? Math.max(1, Math.min(body.limit, 100)) : 20;
  const response = {
    subjects: matched.slice(0, limit).map((subject) => subjectHit(fixtures, subject, languages)),
    total: { value: matched.length, relation: 'exact' as const },
    next: null,
    as_of: '2026-10-27T00:00:00Z',
  };
  return response as SearchResponse;
}

function fixtureSuggestions(fixtures: Fixtures, request: Request): SuggestionResponse {
  const url = new URL(request.url);
  const query = url.searchParams.get('q')?.trim() ?? '';
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') ?? 8) || 8, 8));
  const languages = languageList(url.searchParams.getAll('languages'));
  const subjects = fixtures.subjects
    .filter((subject) => matchesText(subject, query))
    .slice(0, limit)
    .map((subject) => subjectHit(fixtures, subject, languages));
  return { subjects, as_of: '2026-10-27T00:00:00Z' } as SuggestionResponse;
}

function bodyFromRecording(recording: KernelRecording, languages: readonly string[]): KernelRecording {
  return localizeRecording(recording, languages, storyFixtures);
}

async function searchStory(
  request: Request,
  recordings: Record<string, KernelRecording>,
): Promise<KernelRecording | undefined> {
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => undefined);
  if (!isRecord(body)) return undefined;
  const languages = languageList(body.languages);
  if (languages.length === 0) return undefined;
  const query = typeof body.text === 'string' ? body.text : undefined;
  const type = requestType(body.filter);
  if (query === undefined) return undefined;
  const baseName = type ? 'search-typed' : 'search';
  const recording = [...languages.map((language) => recordings[`${baseName}-${language}`]), recordings[baseName]].find(
    (candidate) =>
      candidate !== undefined &&
      candidate.query === query &&
      (candidate.filterType ?? undefined) === type &&
      Array.isArray(candidate.subjects),
  );
  return recording ? bodyFromRecording(recording, languages) : undefined;
}

async function suggestionStory(
  request: Request,
  recordings: Record<string, KernelRecording>,
): Promise<KernelRecording | undefined> {
  const url = new URL(request.url);
  const languages = languageList(url.searchParams.getAll('languages'));
  const query = url.searchParams.get('q')?.trim().toLocaleLowerCase() ?? '';
  if (languages.length === 0 || query.length === 0) return undefined;
  const source = recordings.search;
  if (!source || !Array.isArray(source.subjects)) return undefined;
  const subjects = source.subjects.filter(
    (subject) =>
      isRecord(subject) &&
      isRecord(subject.labels) &&
      Object.values(subject.labels).some(
        (label) => typeof label === 'string' && label.toLocaleLowerCase().includes(query),
      ),
  );
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') ?? 8) || 8, 8));
  return bodyFromRecording(
    { status: 200, subjects: subjects.slice(0, limit), as_of: source.as_of ?? '2026-10-27T00:00:00Z' },
    languages,
  );
}

export const routes: FakeRoute[] = [
  {
    method: 'POST',
    path: '/v1/subjects:search',
    story: ({ request, recordings }) => searchStory(request, recordings),
    fixture: async ({ request, fixtures }) => {
      const body: unknown = await request
        .clone()
        .json()
        .catch(() => undefined);
      return isRecord(body) && body.sort !== 'rating' && languageList(body.languages).length > 0
        ? ({ ...fixtureSearch(fixtures, body), status: 200 } as KernelRecording)
        : undefined;
    },
  },
  {
    method: 'GET',
    path: '/v1/subjects:suggest',
    story: ({ request, recordings }) => suggestionStory(request, recordings),
    fixture: ({ request, fixtures }) => {
      const url = new URL(request.url);
      return url.searchParams.has('languages')
        ? ({ ...fixtureSuggestions(fixtures, request), status: 200 } as KernelRecording)
        : undefined;
    },
  },
];
