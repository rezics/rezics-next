import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageStory, pagePaths, pageReady } from './page';

const meta = { title: 'Pages/Discovery/Home', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const SignedIn: Story = {
  name: 'Member, Continue unavailable pending native binding',
  parameters: { admitted: ['personal_library', 'library_continue.list', 'reading_progress', 'collections'] },
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.library_continue_unavailable());
    const region = canvas.getByRole('region', { name: m.home_continue_heading() });
    await expect(within(region).getByRole('link', { name: m.library_more() })).toHaveAttribute(
      'href',
      `/${getLocale()}/library/continue`,
    );
    await expect(canvas.queryByText(m.library_continue_empty())).toBeNull();
  },
};
export const SignedOut: Story = {
  render: () => <PageStory visitor="Signed Out" path={pagePaths.home} />,
  play: async (context) => {
    await pageReady(context);
    await expect(within(context.canvasElement).queryByRole('region', { name: m.home_continue_heading() })).toBeNull();
  },
};
