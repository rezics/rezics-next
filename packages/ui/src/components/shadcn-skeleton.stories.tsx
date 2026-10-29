import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';
import { useEffect, useState } from 'react';
import { Skeleton } from '@rezics/ui/shadcn/skeleton';
import { withSurface } from '../stories/support.tsx';
import { MetaLine } from './meta-line.tsx';

const meta = {
  title: 'shadcn/Skeleton',
  component: Skeleton,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof Skeleton>;
export default meta;
type Story = StoryObj<typeof meta>;

const WorkCardSkeleton = () => (
  <div role="status" aria-label="Loading Work" className="flex max-w-sm items-center gap-4">
    <Skeleton className="h-24 w-16 shrink-0" />
    <div className="grid flex-1 gap-2">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  </div>
);

export const Default: Story = {
  render: () => <WorkCardSkeleton />,
  async play({ canvasElement }) {
    const card = within(canvasElement).getByRole('status', { name: 'Loading Work' });
    await expect(card.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(4);
  },
};

export const Avatar: Story = {
  render: () => (
    <div role="status" aria-label="Loading person" className="flex items-center gap-3">
      <Skeleton className="size-10 rounded-full" />
      <Skeleton className="h-4 w-40" />
    </div>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('status', { name: 'Loading person' })).toBeInTheDocument();
  },
};

const Loaded = () => {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return ready ? (
    <article className="max-w-sm text-sm">
      <h3 className="font-medium">《三体》第三部：死神永生与更多的长标题作品</h3>
      <p className="text-muted-foreground">
        <MetaLine items={['刘慈欣', '科幻小说']} />
      </p>
    </article>
  ) : (
    <WorkCardSkeleton />
  );
};

export const ReplacedByContent: Story = {
  render: () => <Loaded />,
  async play({ canvasElement }) {
    await within(canvasElement).findByRole('heading', { name: /死神永生/ });
    await waitFor(() => expect(canvasElement.querySelector('[data-slot="skeleton"]')).toBeNull());
  },
};
