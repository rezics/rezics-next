import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { PageStory, pageReady } from './page';
import { m } from '../paraglide/messages.js';
import { trendingResponse } from '../search/trending';
import { problem } from '../media/kernel';

/** The actual shell/typed consumer. No qualified response is invented while native activation is pending. */
const meta = {
  title: 'Discovery/Search Trending',
  id: 'pages-discovery-search-trending',
  parameters: { layout: 'fullscreen' },
  render: () => <PageStory visitor="Signed Out" path="/search" />,
  beforeEach: ({ parameters }) => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname !== '/api/search/trending') return original(input, init);
      return trendingResponse(new Request(url, init), {}, async () => {
        throw problem(503, parameters.trendingFailure ? 'dependency_unavailable' : 'semantic_not_ready', 'Unavailable');
      });
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
async function open(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const canvas = within(context.canvasElement);
  await userEvent.click(
    window.matchMedia('(max-width: 767px)').matches
      ? canvas.getByRole('button', { name: m.search_label() })
      : canvas.getByRole('combobox', { name: m.search_label() }),
  );
  await expect(canvas.getByText(m.header_search_recent())).toBeVisible();
  return canvas;
}
export const Preparing: Story = {
  play: async (context) => {
    const canvas = await open(context);
    await expect(await canvas.findByText(m.discovery_not_ready())).toBeVisible();
  },
};
export const Unavailable: Story = {
  parameters: { trendingFailure: true },
  play: async (context) => {
    const canvas = await open(context);
    await expect(await canvas.findByText(m.trending_unavailable())).toBeVisible();
    await userEvent.type(canvas.getByRole('combobox', { name: m.search_label() }), 'Prince');
    await expect(canvas.queryByText(m.header_search_trending_searches())).toBeNull();
  },
};
