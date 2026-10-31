import type { Meta, StoryObj } from '@storybook/react-vite';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Suspense } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { CollectionFilterFeedback } from '../library/collection-filters';
import { CollectionPage } from '../library/collection-page';
import { collectionPageQuery } from '../library/collection-queries';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PatternStory } from './page';
import { collectionFilterStoryId } from '../kernel/fake/collection-filters';

const meta = {
  title: 'Patterns/Library/Collection filters',
  parameters: {
    docs: {
      description: {
        component:
          'The public Collection composition and its supplied bounded facets. Review these same states with phone390/desktop1280 viewport, locale and theme globals. The combined state uses long presentation labels and a long upper bound; data remains the existing illustrative Collection fixture, not native scope evidence.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const id = collectionFilterStoryId;
const path = `/collections/${id}`;
const harem = '00000000-0000-4000-8000-000000000123';

const states = {
  reference: {},
  concept: { 'f.schema:keywords': harem, 'l.schema:keywords': 'Harem' },
  range: { 'r.schema:wordCount': '1000001,' },
  combined: {
    'f.schema:keywords': harem,
    'l.schema:keywords': 'Harem',
    'r.schema:wordCount': '1000001,999999999999999',
  },
  noMatch: {
    'f.schema:keywords': '00000000-0000-4000-8000-000000000999',
    'l.schema:keywords': 'Harem',
  },
  preparing: {
    'f.schema:keywords': '00000000-0000-4000-8000-000000000998',
    'l.schema:keywords': 'Preparing',
  },
} satisfies Record<string, Record<string, string>>;

function FilterRegion({ search }: { search: Record<string, string> }) {
  const client = useQueryClient();
  const options = collectionPageQuery(id, undefined, 'anonymous', search);
  const { data } = useSuspenseQuery(options);
  if (!data.filterProperties || !data.filterParams)
    throw new Error('Collection filters are not enabled in the Storybook runtime.');
  if ('preparing' in data) throw new Error('This story requires the public curated Collection composition.');
  const page =
    search === states.combined
      ? {
          ...data,
          filterProperties: data.filterProperties.map((property) => ({
            ...property,
            label: `${property.label} — ${
              property.datatype === 'quantity'
                ? 'the complete work, including every published volume'
                : 'catalogue concepts associated with the complete work'
            }`,
          })),
        }
      : data;
  return (
    <section className="min-w-0 space-y-4 p-4 text-foreground">
      <code className="block break-all text-xs">{`${path}?${new URLSearchParams(search)}`}</code>
      <CollectionPage
        page={page}
        queryKey={options.queryKey}
        cursor={undefined}
        search={search}
        refreshPage={async () => {
          const next = await client.fetchQuery(options);
          if ('preparing' in next) throw new Error('Expected a curated Collection.');
          return next;
        }}
      />
    </section>
  );
}

function render(search: Record<string, string>) {
  return (
    <PatternStory path={`${path}?${new URLSearchParams(search)}`}>
      <Suspense fallback={null}>
        <FilterRegion search={search} />
      </Suspense>
    </PatternStory>
  );
}

async function regionReady(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: m.collection_filters() }));
  const dialog = await within(document.body).findByRole('dialog', { name: m.collection_filters() });
  await expect(dialog).toBeVisible();
  return { canvas, fields: within(dialog) };
}

async function selectedState(
  canvasElement: HTMLElement,
  kind: 'reference' | 'concept' | 'range' | 'combined' | 'noMatch' | 'preparing',
) {
  const { canvas, fields } = await regionReady(canvasElement);
  if (kind === 'concept' || kind === 'combined' || kind === 'noMatch' || kind === 'preparing') {
    const label =
      kind === 'preparing'
        ? getLocale() === 'zh-Hans'
          ? '准备中'
          : 'Preparing'
        : getLocale() === 'zh-Hans'
          ? '后宫'
          : 'Harem';
    await expect(await fields.findByDisplayValue(label)).toBeVisible();
  }
  if (kind === 'range' || kind === 'combined') await expect(await fields.findByDisplayValue('1000001')).toBeVisible();
  if (kind === 'noMatch') await expect(await canvas.findByText(m.collection_filter_no_match())).toBeVisible();
  if (kind === 'preparing') await expect(await canvas.findByText(m.collection_filter_preparing())).toBeVisible();
  if (kind === 'reference')
    await expect(fields.getByRole('button', { name: m.collection_filter_apply() })).toBeVisible();
}

export const Reference: Story = {
  name: 'No filters selected',
  play: ({ canvasElement }) => selectedState(canvasElement, 'reference'),
  render: () => render(states.reference),
};

export const ConceptSelected: Story = {
  name: 'Concept selected',
  play: ({ canvasElement }) => selectedState(canvasElement, 'concept'),
  render: () => render(states.concept),
};

export const WordRangeApplied: Story = {
  name: 'Word range applied',
  play: ({ canvasElement }) => selectedState(canvasElement, 'range'),
  render: () => render(states.range),
};

export const CombinedFilters: Story = {
  name: 'Concept and word range applied',
  play: ({ canvasElement }) => selectedState(canvasElement, 'combined'),
  render: () => render(states.combined),
};

export const NoMatches: Story = {
  name: 'No matching results',
  play: ({ canvasElement }) => selectedState(canvasElement, 'noMatch'),
  render: () => render(states.noMatch),
};

export const Preparing: Story = {
  name: 'Results preparing',
  play: ({ canvasElement }) => selectedState(canvasElement, 'preparing'),
  render: () => render(states.preparing),
};

export const FilterSourceUnavailable: Story = {
  name: 'Filter source unavailable',
  render: () => (
    <PatternStory>
      <CollectionFilterFeedback
        id={id}
        filterType="schema:Book"
        status="failed"
        empty
        emptyLabel={m.library_collection_empty()}
      />
    </PatternStory>
  ),
  play: async (context) => {
    const canvas = within(context.canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(m.collection_filter_failed());
    await expect(canvas.getByRole('link', { name: m.collection_filter_clear() })).toHaveAttribute(
      'href',
      `/${getLocale()}/collections/${encodeURIComponent(id)}?type=schema%3ABook`,
    );
  },
};
