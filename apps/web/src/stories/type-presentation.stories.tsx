import type { Meta, StoryObj } from '@storybook/react-vite';
import { CoverList } from '../features/pages/cover-list';
import type { Item, RowValue } from '../features/pages/overview';
import { releasedListPresentation } from '../media/type-presentation';
import { ResultList, type ResultHit } from '../search/results';
import { PatternStory } from './page';

// Controlled current-page inputs, not a claim that the pending member-fact producer is available.
const hits: ResultHit[] = [
  { id: '00000000-0000-4000-8000-000000000001', type: 'schema:Book', labels: { en: 'A field guide to the night sky' } },
  {
    id: '00000000-0000-4000-8000-000000000002',
    type: 'schema:Movie',
    labels: { en: 'Across the river' },
    facts: { 'schema:duration': [{ kind: 'quantity', amount: 90, unit: 'min' }] },
  },
  { id: '00000000-0000-4000-8000-000000000003', type: 'schema:MusicAlbum', labels: { en: 'Evening variations' } },
];
const releaseTypes = {
  'schema:Movie': {
    properties: ['schema:duration'],
    listPresentation: { imageAspect: 'landscape', keyFacts: ['schema:duration'] },
  },
};
const listPresentationFor = (types: readonly string[]) => releasedListPresentation(types, releaseTypes);
const items: Item[] = hits.map((hit) => ({
  id: hit.id,
  type: hit.type,
  label: { text: hit.labels.en!, lang: 'en' },
  notes: [],
  gated: false,
}));
const value: RowValue = {
  locale: 'en',
  link: ({ children, ...props }) => <a {...props}>{children}</a>,
  reader: { spoilerLevel: 0, suitability: 'blur' },
  labels: {
    spoilerShow: 'Show',
    documentSpoiler: 'Reveal',
    cover: { withheld: 'Sensitive cover', reveal: 'Show cover', credit: 'Cover credit', via: 'via' },
  },
  unlabelled: 'Unlabelled',
  spoilerShow: 'Show',
};

const meta = { title: 'Patterns/Type Presentation', parameters: { layout: 'padded' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Mixed: Story = {
  render: (_, context) => (
    <PatternStory>
      <div className="mx-auto max-w-4xl space-y-8">
        <ResultList
          hits={hits}
          locale={String(context.globals.locale ?? 'en')}
          hitTypes={{}}
          yearProperties={[]}
          listPresentationFor={listPresentationFor}
        />
        <CoverList
          items={items}
          value={{ ...value, locale: String(context.globals.locale ?? 'en') }}
          label="Members"
          listPresentationFor={listPresentationFor}
          memberFacts={{ [hits[1]!.id]: hits[1]!.facts! }}
        />
      </div>
    </PatternStory>
  ),
};
