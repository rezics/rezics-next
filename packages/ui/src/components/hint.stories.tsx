import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { ArrowBigUpIcon, InfoIcon } from 'lucide-react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { buttonVariants } from './button.tsx';
import { Hint, HintContent, HintTrigger } from './hint.tsx';

const surface: Decorator = (Story, { parameters }) => (
  <div
    className={cn(
      'flex min-h-48 items-center justify-center bg-background p-6 font-sans text-foreground',
    )}
  >
    <Story />
  </div>
);

const meta = {
  title: 'Rezics UI/Feedback/Hint',
  component: Hint,
  tags: ['autodocs'],
  decorators: [surface],
  parameters: {
    docs: {
      description: {
        component:
          'A lightweight CSS-positioned tooltip that names or explains an icon button, such as the upvote arrow, the "source statistic" info icon or a moderation badge. It opens on hover and focus, closes on blur and `Escape`, and describes its trigger with `aria-describedby`. Keep the text short and never put interactive content in it; use Tooltip when the hint must escape a clipping container, and Popover for rich content.',
      },
    },
  },
} satisfies Meta<typeof Hint>;
export default meta;
type Story = StoryObj<typeof meta>;

const iconButton = buttonVariants({ variant: 'ghost', size: 'icon-md' });

export const Default: Story = {
  render: (args) => (
    <Hint {...args}>
      <HintTrigger aria-label="Upvote" className={iconButton}>
        <ArrowBigUpIcon aria-hidden />
      </HintTrigger>
      <HintContent>Upvote this review</HintContent>
    </Hint>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: 'Upvote' });
    await expect(canvas.queryByRole('tooltip')).not.toBeInTheDocument();

    await userEvent.hover(trigger);
    await expect(await canvas.findByRole('tooltip')).toHaveTextContent('Upvote this review');
    await expect(trigger).toHaveAccessibleDescription('Upvote this review');

    await userEvent.unhover(trigger);
    await waitFor(() => expect(canvas.queryByRole('tooltip')).not.toBeInTheDocument());
  },
};

export const KeyboardFocus: Story = {
  name: 'Keyboard focus and Escape',
  render: Default.render,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'Upvote' })).toHaveFocus();
    await expect(await canvas.findByRole('tooltip')).toHaveTextContent('Upvote this review');

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(canvas.queryByRole('tooltip')).not.toBeInTheDocument());
  },
};

export const Placements: Story = {
  render: () => (
    <div className="grid grid-cols-2 gap-x-56 gap-y-20 py-8">
      {(['top', 'right', 'bottom', 'left'] as const).map((placement) => (
        <Hint defaultOpen key={placement} positioning={{ placement }}>
          <HintTrigger className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {placement}
          </HintTrigger>
          <HintContent>Source statistic</HintContent>
        </Hint>
      ))}
    </div>
  ),
};

export const Open: Story = {
  args: { defaultOpen: true },
  render: (args) => (
    <Hint {...args}>
      <HintTrigger aria-label="About this score" className={iconButton}>
        <InfoIcon aria-hidden />
      </HintTrigger>
      <HintContent>Goodreads average, refreshed 2 days ago</HintContent>
    </Hint>
  ),
};

export const Chinese: Story = {
  name: 'zh-CN',
  render: () => (
    <Hint defaultOpen>
      <HintTrigger aria-label="评分说明" className={iconButton}>
        <InfoIcon aria-hidden />
      </HintTrigger>
      <HintContent lang="zh-CN">《三体》的豆瓣评分，2 天前更新</HintContent>
    </Hint>
  ),
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  render: Open.render,
  args: { defaultOpen: true },
};
