import type { Meta, StoryObj } from '@storybook/react-vite';
import type { Release } from '@rezics/definitions';
import type { Related } from '../subject/types';
import type { Stmt } from '../features/pages/shared';
import { WorkTagReadingView } from '../features/catalogue/work-tag-reading/view';
import type { WorkTagAssertion, WorkTagProjection } from '../features/catalogue/work-tag-reading/model';

const subjectId = '00000000-0000-4000-8000-000000000001';
const facetLabel = { text: 'Themes', lang: 'en' } as WorkTagAssertion['facetLabel'];
const conceptId = (index: number) => `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`;
const snak = (property: string, dataType: string, content: unknown) => ({
  property: { id: property, data_type: dataType },
  value: { type: 'value', content },
});

function statement(index: number): Stmt {
  const duplicate = index === 6;
  const weighted = index === 0 || index === 5;
  return {
    id: `00000000-0000-4000-8000-${String(index + 200).padStart(12, '0')}`,
    rank: 'normal',
    property: { id: 'schema:genre', data_type: 'wikibase-item' },
    value: { type: 'value', content: duplicate ? conceptId(5) : conceptId(index) },
    qualifiers: [
      ...(weighted
        ? [
            snak('rezics:sourceTagWeight', 'quantity', { amount: index === 0 ? '2.6' : '1.8', unit: '1' }),
            snak('rezics:sourceTagWeightMetric', 'string', 'vndbTagsRating'),
          ]
        : []),
      ...(index === 14 ? [snak('rezics:spoilerLevel', 'quantity', { amount: '+2', unit: '1' })] : []),
    ],
    references: weighted
      ? [
          {
            parts: [
              snak('schema:url', 'url', 'https://vndb.org/v17'),
              snak('rezics:sourceTagId', 'string', `g${index + 1}`),
              snak('rezics:sourceSnapshot', 'string', `unversioned:sha256:${'a'.repeat(64)}`),
            ],
          },
          { parts: [snak('schema:url', 'url', 'https://api.vndb.org/kana#post-vn')] },
        ]
      : [],
    rezics: { release: 'storybook-release', revision: 1 },
  } as unknown as Stmt;
}

const rows: WorkTagAssertion[] = Array.from({ length: 29 }, (_, index) => ({
  key: `schema:genre:${index}`,
  property: 'schema:genre',
  facetLabel,
  targetId: conceptId(index),
  statement: statement(index),
  spoilerLevel: index === 14 ? 2 : 0,
  hasSpoilerQualifier: index === 14,
  spoilerQualifiers: index === 14 ? [{ property: 'rezics:spoilerLevel', in: ['2'] }] : [],
}));
rows[6] = { ...rows[6]!, targetId: conceptId(5) };
rows[22] = { ...rows[22]!, targetId: conceptId(22) };

const multilingual = '連續的日文標籤名稱'.repeat(12) + ' / ' + 'OriginalUnbrokenTagName'.repeat(5);
const related = Object.fromEntries(
  rows.map((row, index) => [
    row.targetId,
    {
      type: 'skos:Concept',
      labels: index === 22 ? { ja: multilingual } : { en: `Story theme ${index + 1}` },
    },
  ]),
) as unknown as Related;
const definitions = {
  types: { 'skos:Concept': { bases: [] } },
  properties: {},
} as unknown as Pick<Release, 'types' | 'properties'>;

const model: WorkTagProjection = {
  state: 'available',
  rows,
  disclosedCount: 28,
  hasUnavailable: false,
  workHref: `/en/subjects/${subjectId}/demo-work`,
  sourceKey: 'storybook-work-tag-reading',
};

const meta = {
  title: 'Pages/Work tag reading',
  component: WorkTagReadingView,
  args: { model, related, definitions, locale: 'en', spoilerThreshold: 0 },
} satisfies Meta<typeof WorkTagReadingView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BoundedReading: Story = {};
