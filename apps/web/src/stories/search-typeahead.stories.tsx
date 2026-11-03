import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { suggestionResponse } from '../search/suggestions';
import searchRecording from '../kernel/recorded/search.json';
import type { SuggestionResult } from '../search/suggestions';
import { problem } from '../media/kernel';
import { m } from '../paraglide/messages.js';
import { PageStory, pageReady } from './page';

let releaseLate: (() => void) | undefined;
let lateStarted = false;
let settledReads = 0;
let scopedRequests: URL[] = [];
let scopedAttempt = 0;

const collectionId = '438cb7b1-e7a2-4a40-831e-a90b1b143264';
const scopedFilter = JSON.stringify({
  and: [
    { collection: { id: collectionId } },
    { or: [{ type: { in: ['schema:Book'] } }, { not: { statement: { property: 'schema:genre', in: ['private'] } } }] },
  ],
});
const scopedPage: SuggestionResult = {
  as_of: searchRecording.as_of,
  subjects: searchRecording.subjects.map(({ id, type, labels, summary }) => ({
    id,
    type,
    labels,
    summary: summary ?? null,
  })),
  types: { 'schema:Book': { en: 'Book' } },
};
const lateExcludedPage: SuggestionResult = {
  ...scopedPage,
  subjects: [
    {
      ...scopedPage.subjects[0]!,
      id: '018f0000-0000-7000-8000-00a000000099',
      labels: { en: 'Outside the selected Collection' },
    },
  ],
};
const scopedPath = `/search?filter=${encodeURIComponent(scopedFilter)}`;

/** Only the site's HTTP boundary is adapted for Storybook; the real shell and typed native read stay mounted. */
const meta = {
  title: 'Pages/Discovery/Search Typeahead',
  parameters: { layout: 'fullscreen' },
  render: () => <PageStory visitor="Signed Out" path="/search" />,
  beforeEach: ({ parameters }) => {
    const original = globalThis.fetch;
    releaseLate = undefined;
    lateStarted = false;
    settledReads = 0;
    scopedRequests = [];
    scopedAttempt = 0;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname !== '/api/search/suggestions') return original(input, init);
      const request = new Request(url, init);
      const q = url.searchParams.get('q');
      if (parameters.scopedOutcome) {
        scopedRequests.push(url);
        if (parameters.scopedOutcome === 'replacement' && url.searchParams.get('filter') === scopedFilter) {
          lateStarted = true;
          await new Promise<void>((resolve) => {
            releaseLate = resolve;
          });
          return Response.json(lateExcludedPage, { headers: { 'cache-control': 'private, no-store' } });
        }
        if (parameters.scopedOutcome === 'preparing' && scopedAttempt++ === 0)
          return Response.json(
            { code: 'index_not_ready' },
            { status: 503, headers: { 'cache-control': 'private, no-store', 'retry-after': '0' } },
          );
        if (parameters.scopedOutcome === 'withdrawn' && scopedAttempt++ === 0)
          return Response.json({ code: 'forbidden' }, { status: 403, headers: { 'cache-control': 'private, no-store' } });
        return Response.json(scopedPage, { headers: { 'cache-control': 'private, no-store' } });
      }
      if (parameters.suggestionFailure)
        return suggestionResponse(request, {}, async () => {
          throw problem(503, 'dependency_unavailable', 'Unavailable');
        });
      const response = await suggestionResponse(request, {});
      if (parameters.staleResponse && q === 'The') {
        lateStarted = true;
        // Deliberately ignore abort so the consumer must reject a superseded response.
        await new Promise<void>((resolve) => {
          releaseLate = resolve;
        });
      } else settledReads++;
      return response;
    }) as typeof fetch;
    return () => {
      releaseLate?.();
      globalThis.fetch = original;
    };
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

async function open(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const canvas = within(context.canvasElement);
  if (window.matchMedia('(max-width: 767px)').matches)
    await userEvent.click(await canvas.findByRole('button', { name: m.search_label() }));
  else await userEvent.click(await canvas.findByRole('combobox', { name: m.search_label() }));
  const input = await canvas.findByRole('combobox', { name: m.search_label() });
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  await expect(context.canvasElement.querySelectorAll('input[role="combobox"]')).toHaveLength(1);
  return { canvas, input };
}

export const KeyboardAndPointer: Story = {
  play: async (context) => {
    let { canvas, input } = await open(context);
    await userEvent.type(input, 'Prince');
    const option = await canvas.findByRole('option');
    await userEvent.keyboard('{ArrowUp}');
    await expect(input).toHaveFocus();
    await expect(input).toHaveAttribute('aria-activedescendant', option.id);
    await expect(option).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(input).toHaveAttribute('aria-expanded', 'false'));
    // Visit through pointer selection in the same mounted shell after the keyboard journey.
    ({ canvas, input } = await open(context));
    await userEvent.clear(input);
    await userEvent.type(input, 'Prince');
    const current = await canvas.findByRole('option');
    const link = within(current).getByRole('link');
    await expect(link.getAttribute('href')).toMatch(/\/subjects\/[^/]+\//);
    await userEvent.click(link);
    await waitFor(() => expect(input).toHaveAttribute('aria-expanded', 'false'));
    await expect(canvas.queryByRole('option')).toBeNull();
  },
};

export const StaleResponseAndDismissal: Story = {
  parameters: { staleResponse: true },
  play: async (context) => {
    const { canvas, input } = await open(context);
    await userEvent.type(input, 'The');
    await waitFor(() => expect(lateStarted).toBe(true));
    await userEvent.clear(input);
    await userEvent.type(input, 'Prince');
    const current = await canvas.findByRole('option');
    const href = within(current).getByRole('link').getAttribute('href');
    releaseLate?.();
    await waitFor(() => expect(canvas.getAllByRole('option')).toHaveLength(1));
    await expect(within(canvas.getByRole('option')).getByRole('link')).toHaveAttribute('href', href!);
    await userEvent.keyboard('{Escape}');
    await expect(input).toHaveValue('Prince');
    await expect(input).not.toHaveAttribute('aria-activedescendant');
    await expect(canvas.queryByRole('option')).toBeNull();
    const before = settledReads;
    await open(context);
    await canvas.findByRole('option');
    await expect(settledReads).toBe(before + 1);
  },
};

export const SubmitWhenSuggestionsUnavailable: Story = {
  parameters: { suggestionFailure: true },
  play: async (context) => {
    const { canvas, input } = await open(context);
    await userEvent.type(input, 'Prince');
    await canvas.findByText(m.search_suggestions_unavailable());
    await expect(canvas.queryByRole('option')).toBeNull();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(input).toHaveAttribute('aria-expanded', 'false'));
    await expect(input).toHaveValue('Prince');
    await expect(canvas.getByRole('main')).toHaveTextContent('Prince');
  },
};

const constructedScopedReadyPlay: NonNullable<Story['play']> = async (context) => {
  await pageReady(context);
  const { canvas, input } = await open(context);
  await userEvent.type(input, 'The');
  const option = await canvas.findByRole('option');
  await expect(option).toBeVisible();
  await expect(scopedRequests[0]?.searchParams.get('filter')).toBe(scopedFilter);
  await userEvent.keyboard('{ArrowDown}');
  await expect(input).toHaveAttribute('aria-activedescendant', option.id);
  const form = canvas.getByRole('search', { name: m.search_label() });
  await expect(form).toHaveAttribute('method', 'get');
  await expect(form.querySelector<HTMLInputElement>('input[name="filter"]')).toHaveValue(scopedFilter);
  await userEvent.click(within(form).getByRole('button', { name: m.search_submit() }));
  await waitFor(() => {
    const submitted = new URL(window.location.href);
    if (submitted.searchParams.get('filter') !== scopedFilter || submitted.searchParams.get('q') !== 'The')
      throw new Error('The submitted search lost its selected Collection filter.');
  });
};

/** Constructed UI response from the recorded public Search subjects; not native permission evidence. */
export const ConstructedScopedCollectionDesktop: Story = {
  name: 'Constructed: signed-in permitted Collection suggestions (desktop)',
  parameters: { scopedOutcome: 'ready' },
  render: () => <PageStory visitor="Signed In" path={scopedPath} />,
  play: constructedScopedReadyPlay,
};

export const ConstructedScopedCollectionNarrow: Story = {
  name: 'Constructed: signed-in permitted Collection suggestions (narrow)',
  globals: { viewport: { value: 'phone390' } },
  parameters: { scopedOutcome: 'ready' },
  render: () => <PageStory visitor="Signed In" path={scopedPath} />,
  play: constructedScopedReadyPlay,
};

export const ConstructedScopedPreparingManualRetry: Story = {
  name: 'Constructed native preparing state with deliberate retry',
  parameters: { scopedOutcome: 'preparing' },
  render: () => <PageStory visitor="Signed In" path={scopedPath} />,
  play: async (context) => {
    await pageReady(context);
    const { canvas, input } = await open(context);
    await userEvent.type(input, 'The');
    await canvas.findByText(m.discovery_not_ready());
    await expect(scopedRequests).toHaveLength(1);
    await userEvent.click(await canvas.findByRole('button', { name: m.search_facet_retry() }));
    await canvas.findByRole('option');
    await expect(scopedRequests).toHaveLength(2);
  },
};

export const ConstructedScopedWithdrawalManualRecovery: Story = {
  name: 'Constructed Collection withdrawal/refusal with manual recovery',
  parameters: { scopedOutcome: 'withdrawn' },
  render: () => <PageStory visitor="Signed In" path={scopedPath} />,
  play: async (context) => {
    await pageReady(context);
    const { canvas, input } = await open(context);
    await userEvent.type(input, 'The');
    await canvas.findByText(m.search_suggestions_unavailable());
    await expect(canvas.queryByRole('option')).toBeNull();
    await expect(scopedRequests).toHaveLength(1);
    await userEvent.click(await canvas.findByRole('button', { name: m.search_facet_retry() }));
    await canvas.findByRole('option');
    await expect(scopedRequests).toHaveLength(2);
  },
};

export const ConstructedScopedReplacementQuarantinesLateResponse: Story = {
  name: 'Constructed scope removal retires a pending scoped response',
  parameters: { scopedOutcome: 'replacement' },
  render: () => <PageStory visitor="Signed In" path={scopedPath} />,
  play: async (context) => {
    await pageReady(context);
    const { canvas, input } = await open(context);
    await userEvent.type(input, 'The');
    await waitFor(() => expect(lateStarted).toBe(true));
    await expect(scopedRequests[0]?.searchParams.get('filter')).toBe(scopedFilter);
    await userEvent.click(canvas.getByRole('button', { name: /remove/i }));
    await waitFor(() => expect(scopedRequests.some((url) => !url.searchParams.has('filter'))).toBe(true));
    await canvas.findByRole('option');
    releaseLate?.();
    await waitFor(() => expect(canvas.queryByText('Outside the selected Collection')).toBeNull());
    await expect(input).toHaveAttribute('placeholder', m.header_search_global());
  },
};
