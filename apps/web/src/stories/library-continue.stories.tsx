import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory, pageReady } from './page';

const meta = { title: 'Pages/Library/Continue', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Unavailable: Story = {
  parameters: { admitted: ['personal_library', 'reading_progress', 'collections'] },
  render: () => <PageStory visitor="Signed In" path="/library/continue" />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: m.library_continue() })).toBeVisible();
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.library_continue_unavailable());
    await expect(canvas.queryByText(m.library_continue_empty())).toBeNull();
    await expect(canvas.getByRole('button', { name: m.library_follow_retry() })).toBeEnabled();
  },
};
