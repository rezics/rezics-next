import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { CollectionFilterParams } from '../library/collection-filter-params';
import { CollectionFilters } from '../library/collection-filters';
import type { CollectionFacetLoader, CollectionFacetRequest } from '../library/collection-facet-values';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

const properties = Array.from({ length: 10 }, (_, index) => ({
  id: `fixture:property:${index}`,
  label: `Released property ${index + 1}`,
  labels: { en: `Released property ${index + 1}` },
  datatype: 'wikibase-item',
  targets: ['fixture:Target'],
}));
const selectedValue = '00000000-0000-4000-8000-000000000091';
const applied: CollectionFilterParams = {
  selected: { [properties[9]!.id]: [selectedValue] },
  selectedLabels: { [properties[9]!.id]: 'Saved selected value' },
  ranges: {},
  ignored: [],
  document: { statement: { property: properties[9]!.id, in: [selectedValue] } },
};
const empty: CollectionFilterParams = { selected: {}, selectedLabels: {}, ranges: {}, ignored: [] };

function fixtureLoader(mode: 'pages' | 'unavailable', reads: CollectionFacetRequest[]): CollectionFacetLoader {
  return async (request) => {
    reads.push(request);
    if (mode === 'unavailable') return { status: 'unavailable', code: 'collection_resource_scope_unavailable' };
    return {
      status: 'ready',
      page: {
        as_of: new Date(0).toISOString(),
        facets: request.facets.map(({ property, cursor }) => ({
          property,
          values: Array.from({ length: 10 }, (_, index) => {
            const ordinal = index + (cursor ? 11 : 1);
            return { value: `fixture:value:${ordinal}`, labels: { en: `Fixture value ${ordinal}` } };
          }),
          next: cursor ? null : 'opaque-next',
        })),
      },
    };
  };
}

function AdvancedFacets({
  state,
  reader,
}: {
  state: 'released' | 'next' | 'outside' | 'unavailable';
  reader: 'curated' | 'builtin';
}) {
  const reads: CollectionFacetRequest[] = [];
  const params = state === 'outside' ? applied : empty;
  const loader = fixtureLoader(state === 'unavailable' ? 'unavailable' : 'pages', reads);
  return (
    <PatternStory visitor={reader === 'builtin' ? 'Signed In' : 'Signed Out'} path="/collections/advanced-facets-story">
      <section className="mx-auto min-w-0 max-w-3xl space-y-4 p-4 text-foreground">
        <p>
          {reader === 'curated'
            ? 'Anonymous reader of a public curated Collection'
            : 'Signed-in owner of a built-in Collection'}
        </p>
        <CollectionFilters
          id={reader === 'curated' ? 'public-curated-collection' : 'builtin-owner-collection'}
          type="fixture:Book"
          properties={properties}
          params={params}
          filterReleaseKey="story-release"
          viewerKey={reader === 'builtin' ? 'fixture:owner' : 'anonymous'}
          facetLoader={loader}
        />
      </section>
    </PatternStory>
  );
}

async function openFields(canvasElement: HTMLElement, property: string) {
  await userEvent.click(within(canvasElement).getByRole('button', { name: m.collection_filters() }));
  const fields = within(await within(document.body).findByRole('dialog', { name: m.collection_filters() }));
  const picker = fields.getByRole('combobox', { name: m.refinement_property() });
  await userEvent.selectOptions(picker, property);
  return fields;
}

const meta = {
  title: 'Pages/Collections/Advanced facets',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The shared Collection overlay uses illustrative count-free pages for UI states only. Search has not delivered a generated Collection resource binding, so the installed loader remains privately unavailable and never falls back to Global facets. Review each state at phone390 and desktop1280, in both themes and all launch locales. ReleasedFields and NextValues exercise the public curated reader; SelectedOutsideWindow and ScopeUnavailable exercise the signed-in built-in owner. Fixture pages are not native proof.',
      },
    },
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const ReleasedFields: Story = {
  globals: { locale: 'en', viewport: { value: 'phone390' } },
  render: () => <AdvancedFacets state="released" reader="curated" />,
  play: async ({ canvasElement }) => {
    const fields = await openFields(canvasElement, properties[9]!.id);
    await expect(await fields.findByRole('checkbox', { name: 'Fixture value 1' })).toBeVisible();
    await expect(fields.queryByText(/count/i)).toBeNull();
  },
};

export const NextValues: Story = {
  globals: { locale: 'en', viewport: { value: 'desktop1280' } },
  render: () => <AdvancedFacets state="next" reader="curated" />,
  play: async ({ canvasElement }) => {
    const fields = await openFields(canvasElement, properties[0]!.id);
    await userEvent.click(await fields.findByRole('button', { name: m.refinement_more_values() }));
    await expect(await fields.findByRole('checkbox', { name: 'Fixture value 20' })).toBeVisible();
    await expect(fields.queryByText(/count/i)).toBeNull();
  },
};

export const SelectedOutsideWindow: Story = {
  globals: { locale: 'en', viewport: { value: 'phone390' } },
  render: () => <AdvancedFacets state="outside" reader="builtin" />,
  play: async ({ canvasElement }) => {
    const fields = await openFields(canvasElement, properties[9]!.id);
    const selected = await fields.findByRole('checkbox', { name: 'Saved selected value' });
    await expect(selected).toBeChecked();
  },
};

export const ScopeUnavailable: Story = {
  globals: { locale: 'en', viewport: { value: 'desktop1280' } },
  render: () => <AdvancedFacets state="unavailable" reader="builtin" />,
  play: async ({ canvasElement }) => {
    const fields = await openFields(canvasElement, properties[0]!.id);
    await expect(await fields.findByRole('alert')).toHaveTextContent(m.search_reader_facets_unavailable());
    await expect(fields.queryByText(m.refinement_no_values())).toBeNull();
  },
};
