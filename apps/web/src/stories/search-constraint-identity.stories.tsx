import { useState } from 'react';
import { useLocation } from '@tanstack/react-router';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import { AppShell } from '../shell/shell';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import release from '../kernel/recorded/definitions-release.json';
import { conditionMetadata } from '../search/condition-editor-model';
import { SearchPage, type SearchPageData } from '../search/search';
import { discoveryRequest } from '../search/search-request';
import { discoverySearchHref, searchLoaderDeps, type SearchLoaderDeps } from '../search/search-params';
import { readSearchOutcome, type SearchOutcome, type SearchWireResponse } from '../search/search-recovery';
import { PatternStory } from './page';

type Labels = 'known' | 'missing' | 'mixed' | 'many';
const longLabel = '物語と記憶 · 이야기와 기억 · Geschichten und Erinnerungen · Histoires et mémoires '.repeat(4);
const retainedLabel = 'Fixture current-only genre';
const stamp = '2026-11-02T00:00:00Z';
function selection(labels: Labels) {
  return searchLoaderDeps({
    q: '  Mira | 星  ',
    type: 'schema:Book',
    kinds: ['schema:Book', 'account'],
    'f.schema:genre': ['fixture:genre-a', 'fixture:genre-b'],
    ...(labels === 'many'
      ? { 'f.fixture:missing': Array.from({ length: 24 }, (_, index) => `fixture:${index}-${'長い値'.repeat(32)}`) }
      : {}),
    'r.schema:datePublished': JSON.stringify({ gte: 1900, lte: 2026 }),
    ...(labels === 'known' ? {} : { 'r.fixture:amount': JSON.stringify({ gte: -12.5, unit: 'fixture:opaque-unit' }) }),
    language: ['ja', 'en'],
    condition: JSON.stringify({ not: { type: { in: ['schema:Movie'] } } }),
    filter: JSON.stringify({ type: { in: ['schema:CreativeWork'] } }),
    cursor: 'native+/= opaque',
  });
}

function fixture(state: SearchLoaderDeps, labels: Labels): SearchPageData {
  const metadata = conditionMetadata(release.release);
  const known = labels === 'known';
  const mixed = labels === 'mixed';
  return {
    queryState: state,
    type: state.type,
    ...(known || mixed ? { typeLabels: { en: 'Book' } } : {}),
    ...(known || mixed ? { conditionMetadata: metadata } : {}),
    condition: state.condition,
    ...(state.ranges ? { ranges: state.ranges } : {}),
    selectedFacets: state.facets,
    selectedFacetLabels: known || mixed ? { 'schema:genre': { 'fixture:genre-a': { text: retainedLabel, lang: 'en' } } } : {},
    hitTypes: {},
    yearProperties: [],
    typeChoices: [],
    groups: [],
    facetsAvailable: known || mixed,
    facetRetry: false,
    facetIndexNotReady: false,
    staleCursorRestarted: false,
    sort: 'relevance',
    refinement: {
      key: JSON.stringify(state),
      properties: [],
      initial: {
        status: 'ready',
        page: {
          as_of: stamp,
          facets: [
            {
              property: 'schema:genre',
              next: null,
              values: [
                { value: 'fixture:genre-a', labels: known || mixed ? { en: longLabel } : {} },
                { value: 'fixture:genre-b', labels: known ? { en: 'Mystery' } : {} },
              ],
            },
          ],
        },
      },
    },
    discovery: {
      status: 'ready',
      page: {
        as_of: stamp,
        hits: [],
        next: null,
        kinds: {
          next: null,
          values: [
            { id: 'schema:Book', labels: known || mixed ? { en: 'Book' } : {}, icon: 'book' },
            { id: 'account', labels: known ? { en: 'Account' } : {}, icon: 'user' },
          ],
        },
      },
    },
  };
}

function CurrentSelection({ labels, retirement = false }: { labels: Labels; retirement?: boolean }) {
  const state = searchLoaderDeps(useLocation().search);
  const [outcome, setOutcome] = useState<SearchOutcome | undefined>();
  const [releaseLate, setReleaseLate] = useState<(() => void) | undefined>();
  const [settled, setSettled] = useState(false);
  const data = fixture(state, labels);
  function loseAuthority(late: boolean) {
    if (late) {
      const controller = new AbortController();
      let finish!: (response: SearchWireResponse) => void;
      const response = new Promise<SearchWireResponse>((resolve) => {
        finish = resolve;
      });
      void readSearchOutcome(discoveryRequest(state, ['en']), () => response, controller.signal).then(setOutcome, () =>
        setSettled(true),
      );
      controller.abort();
      setReleaseLate(
        () => () => finish({ status: 200, data: data.discovery?.status === 'ready' ? data.discovery.page : undefined }),
      );
    }
    setOutcome({ recovery: { status: 'denied' } });
  }
  return (
    <AppShell>
      {retirement && (
        <aside aria-label="Illustrative authority transition" className="flex flex-wrap gap-2">
          <Button onClick={() => loseAuthority(false)}>Fixture: lose current authority</Button>
          <Button onClick={() => loseAuthority(true)}>Fixture: retire pending read</Button>
          <Button disabled={!releaseLate} onClick={() => releaseLate?.()}>
            Fixture: deliver late response
          </Button>
          {settled && <p>Fixture: retired response settled</p>}
        </aside>
      )}
      <SearchPage query={state.query} data={{ ...data, ...outcome }} />
    </AppShell>
  );
}
function Journey({ labels, retirement = false }: { labels: Labels; retirement?: boolean }) {
  return (
    <PatternStory path={discoverySearchHref(getLocale(), selection(labels))}>
      <CurrentSelection labels={labels} retirement={retirement} />
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Discovery/Search Constraint Identity',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Actual SearchPage and AppShell with supplied illustrative metadata and exact selected URL operands. No metadata lookup is added. Known, missing, mixed and growth fixtures include long multilingual text. Authority controls exercise the existing recovery/abort adapter, not native authority. Assertions, phone/desktop visuals, native bounds and SSR remain UNRUN; this is no acceptance evidence.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const KnownLabels: Story = {
  render: () => <Journey labels="known" />,
  play: async ({ canvasElement }) => {
    const selected = await within(canvasElement).findByRole('list', { name: m.refinement_selected() });
    await expect(within(selected).getAllByRole('link', { name: /Book/ })).toHaveLength(2);
    await expect(selected.textContent).toContain(longLabel);
  },
};
export const MissingLabels: Story = {
  render: () => <Journey labels="missing" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const selected = await canvas.findByRole('list', { name: m.refinement_selected() });
    const links = within(selected).getAllByRole('link');
    await expect(new Set(links.map((link) => link.getAttribute('aria-label'))).size).toBe(links.length);
    await expect(selected.textContent).toContain(m.search_constraint_identity_kind_unavailable());
    await expect(selected.textContent).toContain(m.search_constraint_identity_property_unavailable());
    await expect(selected.textContent).toContain(m.search_constraint_identity_value_unavailable());
    const summary = canvas.getByText(m.search_constraint_identity_details(), { exact: true });
    summary.focus();
    await userEvent.keyboard('{Enter}');
    await expect(summary.closest('details')).toHaveAttribute('open');
    const code = canvasElement.querySelector<HTMLDivElement>('[data-search-constraint-details] code')!;
    code.focus();
    await expect(code).toHaveFocus();
    await expect(canvasElement.querySelector('[data-search-constraint-details]')?.textContent).toContain(
      'fixture:opaque-unit',
    );
    const url = new URL(links[0]!.getAttribute('href')!, 'https://example.test');
    await expect(url.searchParams.get('type')).toBeNull();
    await expect(url.searchParams.getAll('f.schema:genre')).toEqual(['fixture:genre-a', 'fixture:genre-b']);
    await expect(url.searchParams.get('r.fixture:amount')).toBe(
      JSON.stringify({ gte: -12.5, unit: 'fixture:opaque-unit' }),
    );
    await expect(url.searchParams.get('cursor')).toBeNull();
    // Clear every selected constraint using the existing individual keyboard actions.
    while (canvas.queryByRole('list', { name: m.refinement_selected() })) {
      const first = within(canvas.getByRole('list', { name: m.refinement_selected() })).getAllByRole('link')[0]!;
      const count = within(canvas.getByRole('list', { name: m.refinement_selected() })).getAllByRole('link').length;
      first.focus();
      await userEvent.keyboard('{Enter}');
      await waitFor(() =>
        expect(canvas.queryByRole('list', { name: m.refinement_selected() })?.querySelectorAll('a').length ?? 0).toBe(
          count - 1,
        ),
      );
    }
    await expect(canvas.queryByText(m.search_constraint_identity_details())).toBeNull();
  },
};
export const MixedMetadata: Story = { render: () => <Journey labels="mixed" /> };
export const ManyMissingLongValues: Story = {
  render: () => <Journey labels="many" />,
  play: async ({ canvasElement }) => {
    const selected = await within(canvasElement).findByRole('list', { name: m.refinement_selected() });
    await expect(within(selected).getAllByRole('link')).toHaveLength(35);
    await expect(selected.querySelector('.truncate')).toBeNull();
  },
};
export const CurrentAuthorityLoss: Story = {
  render: () => <Journey labels="mixed" retirement />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.search_constraint_identity_details());
    await userEvent.click(canvas.getByRole('button', { name: 'Fixture: lose current authority' }));
    await waitFor(() => expect(canvasElement.querySelector('[data-search-recovery="denied"]')).not.toBeNull());
    await expect(canvasElement.innerHTML).not.toContain(retainedLabel);
    await expect(canvasElement.innerHTML).not.toContain(longLabel);
    await expect(canvasElement.querySelector('[data-search-constraint-details]')?.textContent).toContain(
      'fixture:genre-a',
    );
  },
};
export const LateResultRetirement: Story = {
  render: () => <Journey labels="mixed" retirement />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.search_constraint_identity_details());
    await userEvent.click(canvas.getByRole('button', { name: 'Fixture: retire pending read' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Fixture: deliver late response' }));
    await canvas.findByText('Fixture: retired response settled');
    await expect(canvasElement.querySelector('[data-search-recovery="denied"]')).not.toBeNull();
    await expect(canvasElement.innerHTML).not.toContain(retainedLabel);
    await expect(canvasElement.querySelector('[data-slot="discovery-results"]')).toBeNull();
  },
};
