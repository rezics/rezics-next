import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { PageStory, pagePaths, pageReady } from './page';

const meta = {
  title: 'Subjects/Composed Discussion Review',
  id: 'pages-subjects-composed-discussion-review',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  render: () => <PageStory visitor="Signed Out" path={pagePaths.subject} />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByRole('link', { name: 'A small book with lasting questions' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'What does the fox teach the prince?' })).toBeVisible();
  },
};

export const ReviewContinuation: Story = {
  render: () => <PageStory visitor="Signed Out" path={`${pagePaths.subject}/reviews?cursor=community-next`} />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByRole('link', { name: 'Reading it again' })).toBeVisible();
    await expect(context.canvasElement.querySelector('[data-slot="community-next"]')).toBeNull();
  },
};

export const DiscussionContinuation: Story = {
  render: () => <PageStory visitor="Signed Out" path={`${pagePaths.subject}/discussion?cursor=community-next`} />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByRole('link', { name: 'The final meeting' })).toBeVisible();
    await expect(context.canvasElement.querySelector('[data-slot="community-next"]')).toBeNull();
  },
};

export const CursorRefused: Story = {
  render: () => <PageStory visitor="Signed Out" path={`${pagePaths.subject}/reviews?cursor=refuse`} />,
  play: async (context) => {
    await pageReady(context);
    await expect(
      context.canvasElement.querySelector('[data-slot="review-list"][data-state="unavailable"]'),
    ).toBeVisible();
    await expect(context.canvasElement.querySelector('[data-slot="retry"]')).toBeVisible();
  },
};
