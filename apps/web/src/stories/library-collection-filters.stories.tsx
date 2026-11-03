import type { Meta, StoryObj } from '@storybook/react-vite';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Suspense } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { CollectionFilterFeedback } from '../library/collection-filters';
import { CollectionPage } from '../library/collection-page';
import { collectionPageQuery } from '../library/collection-queries';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageStory, PatternStory, pageReady } from './page';
import {
  collectionFilterRoutePath,
  collectionFilterSearch,
  collectionFilterStoryId,
  longFilterPropertySuffix,
} from '../kernel/fake/collection-filters';

const meta = {
  title: 'Patterns/Library/Collection filters',
  parameters: {
    docs: {
      description: {
        component:
          'ActualCombined enters the generated Collection route through PageStory, using the product reader, filter dialog and common renderer. Pattern stories keep supporting apply/clear and no-match/preparing/unavailable interactions. Combined long property labels are a pattern overlay; Concept IDs, property IDs and the long range bound travel in explicit route search. Illustrative Collection fixture, not native scope evidence. Review phone390/desktop1280, locale and theme globals. Visual, keyboard and 44px observation remain unmeasured until admitted.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const id = collectionFilterStoryId;
const states = collectionFilterSearch;

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
              property.datatype === 'quantity' ? longFilterPropertySuffix.quantity : longFilterPropertySuffix.concept
            }`,
          })),
        }
      : data;
  return (
    <section className="min-w-0 space-y-4 p-4 text-foreground">
      <code className="block break-all text-xs">{collectionFilterRoutePath(search)}</code>
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
    <PatternStory path={collectionFilterRoutePath(search)}>
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

export const ActualCombined: Story = {
  name: 'Routed concept and word range',
  parameters: { layout: 'fullscreen' },
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const canvas = within(within(canvasElement).getByRole('main'));
    await canvas.findByRole('heading', { level: 1, name: 'A filtered reading list' });
    await canvas.findByRole('link', { name: 'Snow Country' });
    await expect(canvas.queryByRole('link', { name: 'A harem novel at the boundary' })).toBeNull();
    await selectedState(canvasElement, 'combined');
    const fields = within(await within(document.body).findByRole('dialog', { name: m.collection_filters() }));
    await expect(await fields.findByDisplayValue('999999999999999')).toBeVisible();
    await expect(fields.getByRole('button', { name: m.collection_filter_apply() })).toBeVisible();
    await expect(fields.getByRole('link', { name: m.collection_filter_clear() })).toBeVisible();
  },
  render: () => <PageStory visitor="Signed Out" path={collectionFilterRoutePath(states.combined)} />,
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
