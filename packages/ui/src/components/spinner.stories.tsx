import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { Button } from './button.tsx';
import { Spinner } from './spinner.tsx';

const surface: Decorator = (Story, { parameters }) => (
  <div className={cn('bg-background p-6 font-sans text-foreground')}>
    <Story />
  </div>
);

const meta = {
  title: 'Rezics UI/Feedback/Spinner',
  component: Spinner,
  tags: ['autodocs'],
  decorators: [surface],
  parameters: {
    docs: {
      description: {
        component:
          'A spinning loader for short waits of unknown length, such as fetching the next page of a Realm feed, submitting a rating or loading a reading position. It inherits the text color and announces itself as a status; give it a specific `aria-label` when the default "Loading" is too vague. Prefer Skeleton when the shape of the coming content is known, and Progress when the wait has a measurable value.',
      },
    },
  },
} satisfies Meta<typeof Spinner>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status', { name: 'Loading' })).toBeVisible();
  },
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Spinner aria-label="Loading comments" className="size-3" />
      <Spinner aria-label="Loading Works" />
      <Spinner aria-label="Loading Realm" className="size-6" />
      <Spinner aria-label="Loading reader" className="size-8" />
    </div>
  ),
};

export const Colors: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Spinner aria-label="Loading feed" className="text-primary" />
      <Spinner aria-label="Loading notifications" className="text-muted-foreground" />
      <Spinner aria-label="Loading ratings" className="text-rating" />
    </div>
  ),
};

export const WithText: Story = {
  name: 'With text (zh-CN)',
  render: () => (
    <p className="flex items-center gap-2 text-muted-foreground text-sm" lang="zh-CN">
      <Spinner aria-label="正在加载" />
      正在加载《三体》的评分与书评……
    </p>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status', { name: '正在加载' })).toBeInTheDocument();
  },
};

export const InButton: Story = {
  name: 'Inside a button',
  render: () => (
    <Button disabled>
      <Spinner aria-label="Saving rating" />
      Saving rating
    </Button>
  ),
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  render: () => (
    <div className="flex items-center gap-4 text-sm">
      <Spinner aria-label="Loading feed" className="text-primary" />
      <span className="flex items-center gap-2 text-muted-foreground">
        <Spinner aria-label="Loading Works" /> Loading Works in Realm Hard SF
      </span>
    </div>
  ),
};
