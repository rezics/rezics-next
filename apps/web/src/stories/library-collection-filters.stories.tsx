import type { Meta, StoryObj } from '@storybook/react-vite';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Suspense } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { CollectionFilterFeedback, CollectionFilters } from '../library/collection-filters';
import { collectionPageQuery } from '../library/collection-queries';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PatternStory, pagePaths } from './page';

const meta = { title: 'Patterns/Library/Collection filters' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const id = pagePaths['library-collection'].split('/').at(-1)!;
const path = pagePaths['library-collection'];
const harem = '00000000-0000-4000-8000-000000000123';

const states = {
  reference: {},
  concept: { 'f.schema:keywords': harem, 'l.schema:keywords': 'Harem' },
  range: { 'r.schema:wordCount': '1000001,' },
  combined: {
    'f.schema:keywords': harem,
    'l.schema:keywords': 'Harem',
    'r.schema:wordCount': '1000001,',
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
  const { data } = useSuspenseQuery(collectionPageQuery(id, undefined, 'anonymous', search));
  if (!data.filterProperties || !data.filterParams)
    throw new Error('Collection filters are not enabled in the Storybook runtime.');
  return (
    <section className="w-full max-w-3xl space-y-4 p-4 text-foreground">
      <CollectionFilters
        id={data.id}
        type={data.filterType ?? 'schema:Book'}
        properties={data.filterProperties}
        params={data.filterParams}
      />
      <CollectionFilterFeedback
        id={data.id}
        {...(data.filter ? { filter: data.filter } : {})}
        {...(data.filterIgnored ? { ignored: data.filterIgnored } : {})}
        {...(data.filterStatus ? { status: data.filterStatus } : {})}
        {...(data.filterType ? { filterType: data.filterType } : {})}
        empty={data.members.length === 0}
        unavailable={'unavailable' in data && data.unavailable}
        emptyLabel={m.library_collection_empty()}
      />
    </section>
  );
}

function render(search: Record<string, string>) {
  return (
    <PatternStory path={path}>
      <Suspense fallback={null}>
        <FilterRegion search={search} />
      </Suspense>
    </PatternStory>
  );
}

async function regionReady(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: m.collection_filters() }));
  if (window.innerWidth < 1024) {
    const dialog = await within(document.body).findByRole('dialog');
    await expect(dialog).toBeVisible();
    return { canvas, fields: within(dialog) };
  }
  const menu = await within(document.body).findByRole('menu');
  await expect(menu).toBeVisible();
  return { canvas, fields: within(menu) };
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
