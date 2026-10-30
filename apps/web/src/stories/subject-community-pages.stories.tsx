import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { PageStory, pagePaths, pageReady } from './page';

const meta = { title: 'Pages/Subjects/Subject', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const PublicCommunity: Story = {
  render: () => <PageStory visitor="Signed Out" path={pagePaths.subject} />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByRole('link', { name: 'A small book with lasting questions' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'What does the fox teach the prince?' })).toBeVisible();
  },
};
