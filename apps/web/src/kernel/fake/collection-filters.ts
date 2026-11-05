import type { FakeRoute } from '../fake-modules.ts';
import type { KernelRecording } from '../fake.ts';

export const collectionFilterStoryId = '00000000-0000-4000-8000-000000000200';
export const haremConceptId = '00000000-0000-4000-8000-000000000123';
export const unmatchedConceptId = '00000000-0000-4000-8000-000000000999';
export const preparingConceptId = '00000000-0000-4000-8000-000000000998';
const collectionId = collectionFilterStoryId;
const otherConceptId = '00000000-0000-4000-8000-000000000124';
const fixtures = [
  ['00000000-0000-4000-8000-000000000201', 'Snow Country', haremConceptId, 1_500_000],
  ['00000000-0000-4000-8000-000000000202', 'A harem novel at the boundary', haremConceptId, 1_000_000],
  ['00000000-0000-4000-8000-000000000203', 'A harem novel without a count', haremConceptId, undefined],
  ['00000000-0000-4000-8000-000000000204', 'A long book without the tag', otherConceptId, 2_000_000],
  ['00000000-0000-4000-8000-000000000205', 'A short book without the tag', otherConceptId, 300_000],
] as const;

/** Explicit Collection route search. Concept and property IDs are canonical; labels are presentation only. */
export const collectionFilterSearch = {
  reference: {},
  concept: { 'f.schema:keywords': haremConceptId, 'l.schema:keywords': 'Harem' },
  range: { 'r.schema:wordCount': '1000001,' },
  combined: {
    'f.schema:keywords': haremConceptId,
    'l.schema:keywords': 'Harem',
    'r.schema:wordCount': '1000001,999999999999999',
  },
  noMatch: {
    'f.schema:keywords': unmatchedConceptId,
    'l.schema:keywords': 'Harem',
  },
  preparing: {
    'f.schema:keywords': preparingConceptId,
    'l.schema:keywords': 'Preparing',
  },
} satisfies Record<string, Record<string, string>>;

/** Pattern-story presentation overlay. The Collection reader takes property labels from the definitions release. */
export const longFilterPropertySuffix = {
  quantity: 'the complete work, including every published volume',
  concept: 'catalogue concepts associated with the complete work',
} as const;

export function collectionFilterRoutePath(search: Record<string, string> = {}): string {
  const query = new URLSearchParams(search).toString();
  return query ? `/collections/${collectionId}?${query}` : `/collections/${collectionId}`;
}

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: `/v1/collections/${collectionId}`,
    story: () => ({
      status: 200,
      collection: {
        id: collectionId,
        membershipKind: 'curated',
        curatorAccountId: 'story-filter-curator',
        title: 'A filtered reading list',
        description: null,
        visibility: 'public',
        revision: 1,
        memberCount: fixtures.length,
        createdAt: '2026-10-29T00:00:00Z',
        updatedAt: '2026-10-29T00:00:00Z',
        curator: null,
      },
    }),
  },
  {
    method: 'GET',
    path: '/v1/subjects:suggest',
    story: ({ request }) => suggestion(request),
    fixture: ({ request }) => suggestion(request),
  },
  {
    method: 'GET',
    path: new RegExp(`^/v1/collections/${collectionId}/members$`),
    story: ({ request }) => answer(request),
    fixture: ({ request }) => answer(request),
  },
];

function suggestion(request: Request): KernelRecording | undefined {
  const query = new URL(request.url).searchParams.get('q')?.toLocaleLowerCase() ?? '';
  if (
    !query ||
    (query !== haremConceptId && !['harem', '后宫'].some((label) => label.includes(query) || query.includes(label)))
  )
    return;
  return {
    status: 200,
    as_of: '2026-10-29T00:00:00Z',
    subjects: [
      {
        id: haremConceptId,
        type: 'skos:Concept',
        labels: { en: 'Harem', 'zh-Hans': '后宫' },
        summary: {
          id: haremConceptId,
          type: 'skos:Concept',
          types: ['skos:Concept'],
          label: { value: 'Harem', language: 'en' },
          cover: null,
        },
        facts: {},
      },
    ],
  };
}

function answer(request: Request): KernelRecording {
  const url = new URL(request.url);
  let document: { and?: unknown[]; statement?: Statement; range?: unknown } | null;
  try {
    document = JSON.parse(url.searchParams.get('filter') ?? 'null');
  } catch {
    return { status: 400, code: 'invalid_request' };
  }
  if (document?.and || document?.statement || document?.range) {
    const leaves = document.and ?? [document];
    const statements = leaves.flatMap((leaf) => (isStatementLeaf(leaf) ? [leaf.statement] : []));
    if (statements.some((statement) => !['schema:keywords', 'schema:wordCount'].includes(statement.property)))
      return { status: 422, code: 'unsupported_query' };
    if (
      statements.some(
        (statement) => statement.property === 'schema:keywords' && statement.in?.includes(preparingConceptId),
      )
    )
      return { status: 202, headers: { 'retry-after': '0' }, preparing: true };
    const members = fixtures.filter(([, , tag, count]) =>
      statements.every((statement) => {
        if (statement.property === 'schema:keywords') return statement.in?.includes(tag);
        if (statement.property === 'schema:wordCount')
          return (
            typeof count === 'number' &&
            count >= (statement.range?.gte ?? -Infinity) &&
            count <= (statement.range?.lte ?? Infinity)
          );
        return true;
      }),
    );
    return { status: 200, members: members.map(member), next: null };
  }
  return { status: 200, members: fixtures.map(member), next: null };
}

type Statement = { property: string; in?: string[]; range?: { gte?: number; lte?: number } };

function isStatementLeaf(value: unknown): value is { statement: Statement } {
  return Boolean(value && typeof value === 'object' && 'statement' in value && value.statement);
}

function member([id, label]: (typeof fixtures)[number]) {
  return {
    id,
    subjectId: id,
    note: null,
    addedAt: '2026-10-29T00:00:00Z',
    subject: { id, type: 'schema:Book', label, types: ['schema:Book'], cover: null },
  };
}
