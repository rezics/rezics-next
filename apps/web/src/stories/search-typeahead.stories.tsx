import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { suggestionResponse } from '../search/suggestions';
import { problem } from '../media/kernel';
import { m } from '../paraglide/messages.js';
import { PageStory, pageReady } from './page';

let releaseLate: (() => void) | undefined;
let lateStarted = false;
let settledReads = 0;

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
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname !== '/api/search/suggestions') return original(input, init);
      const request = new Request(url, init);
      const q = url.searchParams.get('q');
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
