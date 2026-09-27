import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { Skeleton, SkeletonCircle, SkeletonText } from './skeleton.tsx';

// Renders on the theme page color; `parameters.dark` switches to dark mode
// until Storybook has a global theme toolbar.
const surface: Decorator = (Story, { parameters }) => (
  <div
    className={cn(
      parameters.dark && 'dark',
      'max-w-xl bg-background p-6 font-sans text-foreground',
    )}
  >
    <Story />
  </div>
);

const meta = {
  title: 'Rezics UI/Feedback/Skeleton',
  component: Skeleton,
  tags: ['autodocs'],
  decorators: [surface],
  parameters: {
    docs: {
      description: {
        component:
          'A pulsing placeholder in the shape of content that is still loading: Work cards in a feed, a Realm header, a member row or review text. Skeletons are decorative; mark the loading region with `aria-busy` and a visually hidden label so screen readers hear one "loading" message. Use Spinner when the shape of the result is unknown.',
      },
    },
  },
} satisfies Meta<typeof Skeleton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { className: 'h-4 w-48' },
};

export const Shapes: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <SkeletonCircle />
      <Skeleton className="h-9 w-24" />
      <Skeleton className="aspect-2/3 w-16 rounded-sm" />
      <SkeletonText className="w-48" lines={3} />
    </div>
  ),
};

const WorkCardSkeleton = () => (
  <div className="flex gap-4 rounded-2xl border border-border/60 bg-card p-4 shadow-(--aura-shadow-card)">
    <Skeleton className="aspect-2/3 w-20 shrink-0 rounded-sm" />
    <div className="flex flex-1 flex-col gap-3">
      <Skeleton className="h-5 w-3/4" />
      <Skeleton className="h-4 w-1/3" />
      <SkeletonText lines={2} />
    </div>
  </div>
);

export const WorkFeed: Story = {
  name: 'Loading a Work feed',
  render: () => (
    <section aria-busy="true" aria-label="Works in Hard Science Fiction">
      <span className="sr-only">Loading Works…</span>
      <div className="flex flex-col gap-4">
        <WorkCardSkeleton />
        <WorkCardSkeleton />
      </div>
    </section>
  ),
  async play({ canvasElement }) {
    const region = within(canvasElement).getByRole('region', {
      name: 'Works in Hard Science Fiction',
    });
    await expect(region).toHaveAttribute('aria-busy', 'true');
    await expect(within(region).getByText('Loading Works…')).toBeInTheDocument();
  },
};

export const MemberRow: Story = {
  render: () => (
    <div aria-busy="true" className="flex items-center gap-3">
      <span className="sr-only">Loading member</span>
      <SkeletonCircle className="size-8" />
      <div className="flex flex-1 flex-col gap-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-20" />
      </div>
    </div>
  ),
};

export const Dark: Story = {
  parameters: { dark: true },
  render: () => (
    <div aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading Works…</span>
      <WorkCardSkeleton />
    </div>
  ),
};
