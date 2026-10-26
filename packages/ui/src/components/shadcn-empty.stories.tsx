import type { Meta, StoryObj } from '@storybook/react-vite';
import { BookOpenIcon } from 'lucide-react';
import { expect, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Empty',
  component: Empty,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof Empty>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <BookOpenIcon />
        </EmptyMedia>
        <EmptyTitle>No Works on this shelf</EmptyTitle>
        <EmptyDescription>Add a Work from its page and it will appear here.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button>Browse Works</Button>
      </EmptyContent>
    </Empty>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('No Works on this shelf')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Browse Works' })).toBeEnabled();
  },
};

export const TextOnly: Story = {
  render: () => (
    <Empty className="border">
      <EmptyHeader>
        <EmptyTitle>Nothing to review yet</EmptyTitle>
        <EmptyDescription>
          Reports from the community appear here. <a href="#guidelines">Read the guidelines</a>
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: 'Read the guidelines' })).toBeVisible();
  },
};

export const LongAndCjkText: Story = {
  render: () => (
    <div className="grid max-w-md gap-4">
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BookOpenIcon />
          </EmptyMedia>
          <EmptyTitle>這個書架還沒有任何作品</EmptyTitle>
          <EmptyDescription>從作品頁面加入作品之後，它們會顯示在這裡，也可以隨時重新排序。</EmptyDescription>
        </EmptyHeader>
      </Empty>
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>No Works match “a-very-long-search-phrase-without-any-natural-break-points-in-it”</EmptyTitle>
          <EmptyDescription>Try fewer words, or check the spelling of the original title.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('這個書架還沒有任何作品')).toBeVisible();
    await expect(canvas.getByText(/No Works match/)).toBeVisible();
  },
};
