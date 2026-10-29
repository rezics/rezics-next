import type { FakeRoute } from '../fake-modules.ts';
import type { KernelRecording } from '../fake.ts';

const collectionId = '01a17a3b-6d8f-71f2-a0f8-f4ccbb7c7ba2';
const harem = '00000000-0000-4000-8000-000000000123';
const preparing = '00000000-0000-4000-8000-000000000998';
const fixtures = [
  ['00000000-0000-4000-8000-000000000201', 'Snow Country', harem, 1_500_000],
  ['00000000-0000-4000-8000-000000000202', 'A harem novel at the boundary', harem, 1_000_000],
  ['00000000-0000-4000-8000-000000000203', 'A harem novel without a count', harem, undefined],
  [
    '00000000-0000-4000-8000-000000000204',
    'A long book without the tag',
    '00000000-0000-4000-8000-000000000124',
    2_000_000,
  ],
  [
    '00000000-0000-4000-8000-000000000205',
    'A short book without the tag',
    '00000000-0000-4000-8000-000000000124',
    300_000,
  ],
] as const;

export const routes: FakeRoute[] = [
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
  if (!query || (query !== harem && !['harem', '后宫'].some((label) => label.includes(query) || query.includes(label))))
    return;
  return {
    status: 200,
    as_of: '2026-10-29T00:00:00Z',
    subjects: [
      {
        id: harem,
        type: 'skos:Concept',
        labels: { en: 'Harem', 'zh-Hans': '后宫' },
        summary: {
          id: harem,
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
  let document: any;
  try {
    document = JSON.parse(url.searchParams.get('filter') ?? 'null');
  } catch {
    return { status: 400, code: 'invalid_request' };
  }
  if (document?.and || document?.statement || document?.range) {
    const leaves = document.and ?? [document];
    const statements = leaves.flatMap((leaf: any) => (leaf.statement ? [leaf.statement] : []));
    if (statements.some((statement: any) => !['schema:keywords', 'schema:wordCount'].includes(statement.property)))
      return { status: 422, code: 'unsupported_query' };
    if (
      statements.some((statement: any) => statement.property === 'schema:keywords' && statement.in?.includes(preparing))
    )
      return { status: 202, headers: { 'retry-after': '0' }, preparing: true };
    const members = fixtures.filter(([, , tag, count]) =>
      statements.every((statement: any) => {
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

function member([id, label]: (typeof fixtures)[number]) {
  return {
    id,
    subjectId: id,
    note: null,
    addedAt: '2026-10-29T00:00:00Z',
    subject: { id, type: 'schema:Book', label, types: ['schema:Book'], cover: null },
  };
}
