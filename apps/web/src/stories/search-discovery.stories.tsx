import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory, pageReady } from './page';

const meta = { title: 'Pages/Discovery/Search', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const MixedCards: Story = {
  render: () => <PageStory visitor="Signed Out" path="/search?q=Mira" />,
  play: async (context) => {
    await pageReady(context);
    const main = within(context.canvasElement).getByRole('main');
    await within(main).findByText('Mira Reading Room');
    await expect(main.querySelectorAll('[data-slot="discovery-results"] > li')).toHaveLength(4);
    const canvas = within(context.canvasElement);
    if (window.matchMedia('(max-width: 767px)').matches)
      await userEvent.click(canvas.getByRole('button', { name: m.search_label() }));
    else await userEvent.click(canvas.getByRole('combobox', { name: m.search_label() }));
    const input = canvas.getByRole('combobox', { name: m.search_label() });
    await userEvent.clear(input);
    await userEvent.type(input, 'Mira unavailable{Enter}');
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.search_failed());
  },
};
export const MixedUnavailable: Story = {
  render: () => <PageStory visitor="Signed Out" path="/search?q=Mira%20unavailable" />,
  play: async (context) => {
    await pageReady(context);
    await expect(await within(context.canvasElement).findByRole('alert')).toHaveTextContent(m.search_failed());
  },
};
export const MixedPreparing: Story = {
  render: () => <PageStory visitor="Signed Out" path="/search?q=Mira%20preparing" />,
  play: async (context) => {
    await pageReady(context);
    await expect(await within(context.canvasElement).findByRole('status')).toHaveTextContent(m.discovery_not_ready());
  },
};
