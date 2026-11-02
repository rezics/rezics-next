import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { createKernelClient } from '@rezics/client';
import { AppShell } from '../shell/shell';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import releaseRecording from '../kernel/recorded/definitions-release.json';
import { discoveryExample } from '../kernel/fake/search-discovery';
import { conditionMetadata } from '../search/condition-editor-model';
import { SearchPage, type SearchPageData } from '../search/search';
import { discoveryRequest } from '../search/search-request';
import { discoverySearchHref, searchLoaderDeps } from '../search/search-params';
import {
  readSearchOutcome,
  searchRecoveryFromResponse,
  searchUnavailablePage,
  type SearchOutcome,
  type SearchWireResponse,
} from '../search/search-recovery';
import { PatternStory } from './page';

const tree = { not: { type: { in: ['schema:Movie'] } } };
const state = searchLoaderDeps({
  q: 'Mira',
  condition: JSON.stringify(tree),
  language: ['ja', 'en'],
  kinds: ['schema:Book'],
  cursor: 'native+/= opaque',
});
const metadataUnavailableState = searchLoaderDeps({
  q: state.query,
  type: 'schema:Book',
  kinds: state.kinds,
  language: state.languages,
  condition: JSON.stringify(tree),
  cursor: state.cursor,
  'f.schema:genre': ['fixture:genre-a', 'fixture:genre-b'],
  'r.schema:datePublished': JSON.stringify({ gte: 1900, lte: 2026 }),
  'r.fixture:amount': JSON.stringify({ lte: 12.5, unit: 'fixture:opaque-unit' }),
});
const base: SearchPageData = {
  queryState: state,
  condition: tree,
  conditionMetadata: conditionMetadata(releaseRecording.release),
  hitTypes: {},
  yearProperties: [],
  typeChoices: [],
  groups: [],
  selectedFacets: {},
  selectedFacetLabels: {},
  facetsAvailable: true,
  facetRetry: false,
  facetIndexNotReady: false,
  staleCursorRestarted: false,
  sort: 'relevance',
};
const book = discoveryExample.hits.filter((hit) => hit.summary.kind === 'subject' && hit.key.kind === 'schema:Book');
const ready = {
  ...discoveryExample,
  hits: book,
  kinds: { values: discoveryExample.kinds.values.filter(({ id }) => id === 'schema:Book'), next: null },
  next: null,
};

const meta = {
  title: 'Pages/Discovery/Search Recovery',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Actual SearchPage in AppShell. Native-shaped failure fixtures and the existing public card fixture exercise the same one-request SDK recovery adapter. Index preparation is exposed by the current producer as 503 index_not_ready, without a progress or job API. These stories establish no native readiness or visual approval. Use shared phone390/desktop1280, locale and theme globals.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Journey({
  response,
  metadata = true,
  initiallyOpen = false,
  identity = false,
}: {
  response: SearchWireResponse;
  metadata?: boolean;
  initiallyOpen?: boolean;
  identity?: boolean;
}) {
  const [outcome, setOutcome] = useState<SearchOutcome>(() => ({ recovery: searchRecoveryFromResponse(response) }));
  const { conditionMetadata: _metadata, ...withoutMetadata } = base;
  const selectedState = identity ? metadataUnavailableState : state;
  const selectedData = identity ? searchUnavailablePage(selectedState) : metadata ? base : withoutMetadata;
  async function retry() {
    setOutcome({ recovery: { status: 'loading' } });
    const client = createKernelClient('http://search-story.local', {
      fetch: (async (_input, _init) => Response.json(ready)) as typeof fetch,
    });
    setOutcome(
      await readSearchOutcome(discoveryRequest(selectedState, ['en']), (body) => client.subjects.$search.post(body)),
    );
  }
  return (
    <PatternStory path={discoverySearchHref(getLocale(), selectedState)}>
      <AppShell>
        <SearchPage
          query={selectedState.query}
          initiallyOpen={initiallyOpen}
          data={{ ...selectedData, ...outcome }}
          onRetry={() => void retry()}
        />
      </AppShell>
    </PatternStory>
  );
}

export const Restart: Story = {
  render: () => <Journey response={{ status: 409, error: { code: 'search_restart_required' } }} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const link = await canvas.findByRole('link', { name: m.discovery_restart_action() });
    const url = new URL(link.getAttribute('href')!, 'https://example.test');
    await expect(url.searchParams.get('cursor')).toBeNull();
    await expect(url.searchParams.get('q')).toBe('Mira');
    await expect(url.searchParams.getAll('language')).toEqual(['ja', 'en']);
    await expect(JSON.parse(url.searchParams.get('condition')!)).toEqual(tree);
    await expect(canvas.queryByRole('link', { name: m.search_more() })).toBeNull();
  },
};
export const IndexNotReady: Story = {
  render: () => (
    <Journey
      response={{
        status: 503,
        error: { code: 'index_not_ready' },
        response: { headers: new Headers({ 'retry-after': '1' }) },
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const retry = await canvas.findByRole('button', { name: m.search_facet_retry() });
    await expect(await canvas.findByText(m.search_reader_results_unavailable())).toBeVisible();
    await waitFor(() => expect(retry).toBeEnabled());
    await userEvent.click(retry);
    await waitFor(() => expect(canvas.queryByText(m.search_reader_results_unavailable())).toBeNull());
    await expect(canvasElement.querySelector('[data-slot="discovery-results"]')).not.toBeNull();
  },
};
export const SourceNotReady: Story = {
  render: () => <Journey response={{ status: 503, error: { code: 'semantic_not_ready' } }} />,
};
export const Unavailable: Story = {
  render: () => <Journey response={{ status: 503, error: { code: 'overloaded' } }} />,
};
export const InvalidCursor: Story = {
  render: () => (
    <Journey
      response={{
        status: 400,
        error: { code: 'invalid_request', errors: [{ pointer: '/cursor', code: 'invalid_format' }] },
      }}
    />
  ),
};
export const InvalidConditions: Story = {
  render: () => (
    <Journey
      initiallyOpen
      response={{
        status: 422,
        error: { code: 'unsupported_query', errors: [{ pointer: '/filter/and/0/not/type', code: 'unsupported' }] },
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.ownerDocument.querySelector('[data-condition-errors]')).not.toBeNull());
    await expect(
      canvasElement.ownerDocument.querySelector('[data-error-pointer="/filter/and/0/not/type"]'),
    ).not.toBeNull();
    await expect(canvasElement.ownerDocument.querySelector('input[name="condition"]')).toHaveValue(
      JSON.stringify(tree),
    );
  },
};
export const SessionExpired: Story = {
  render: () => <Journey response={{ status: 401, error: { code: 'invalid_credentials' } }} />,
  play: async ({ canvasElement }) => {
    const region = canvasElement.querySelector('[data-search-recovery="session"]')!;
    const link = within(region as HTMLElement).getByRole('link', { name: m.account_sign_in() });
    const url = new URL(link.getAttribute('href')!, 'https://example.test');
    const returnTo = new URL(url.searchParams.get('return_to')!, url);
    await expect(returnTo.searchParams.get('cursor')).toBe(state.cursor);
    await expect(returnTo.searchParams.get('q')).toBe(state.query);
  },
};
export const Closed: Story = {
  render: () => <Journey response={{ status: 403, error: { code: 'platform_closed' } }} />,
};
export const Denied: Story = { render: () => <Journey response={{ status: 403, error: { code: 'forbidden' } }} /> };
export const MetadataUnavailable: Story = {
  render: () => (
    <Journey
      identity
      metadata={false}
      initiallyOpen
      response={{ status: 503, error: { code: 'semantic_not_ready' } }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const selected = await canvas.findByRole('list', { name: m.refinement_selected() });
    await expect(selected.textContent).toContain(m.search_constraint_identity_kind_unavailable());
    await expect(selected.textContent).toContain(m.search_constraint_identity_property_unavailable());
    await expect(selected.textContent).toContain(m.search_constraint_identity_value_unavailable());
    await expect(selected.textContent).not.toContain('schema:genre');
    const details = canvas.getByText(m.search_constraint_identity_details(), { exact: true });
    details.focus();
    await userEvent.keyboard('{Enter}');
    await expect(details.closest('details')).toHaveAttribute('open');
    await expect(canvasElement.querySelector('[data-search-constraint-details]')?.textContent).toContain(
      JSON.stringify({ property: 'fixture:amount', range: { lte: 12.5, unit: 'fixture:opaque-unit' } }, null, 2),
    );
  },
};
