import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { CheckIcon } from 'lucide-react';
import { expect, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { Status } from './status.tsx';

// Renders on the theme page color; `parameters.dark` switches to dark mode
// until Storybook has a global theme toolbar.
const surface: Decorator = (Story, { parameters }) => (
  <div className={cn(parameters.dark && 'dark', 'bg-background p-6 font-sans text-foreground')}>
    <Story />
  </div>
);

const meta = {
  title: 'Rezics UI/Feedback/Status',
  component: Status,
  tags: ['autodocs'],
  decorators: [surface],
  args: { variant: 'success' },
  parameters: {
    docs: {
      description: {
        component:
          'A small colored dot for the state of a member, a source import or a moderation case, such as "reading now", "sync stale" or "case open". It is hidden from assistive technology, so always place the state in text next to it. Dots use the text-safe semantic tones so they keep 3:1 against the page. For unread and "new" marks use the brand red instead, and for counts use a Badge.',
      },
    },
  },
} satisfies Meta<typeof Status>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <span className="inline-flex items-center gap-2 text-sm">
      <Status {...args} />
      Reading now
    </span>
  ),
  async play({ canvasElement }) {
    const dot = canvasElement.querySelector('[data-slot="status-indicator"]');
    await expect(dot).toHaveAttribute('aria-hidden', 'true');
    await expect(within(canvasElement).getByText('Reading now')).toBeVisible();
  },
};

const states = [
  ['default', 'Draft'],
  ['success', 'Import finished'],
  ['info', 'Case assigned'],
  ['warning', 'Provider sync stale'],
  ['destructive', 'Case escalated'],
] as const;

export const Variants: Story = {
  render: () => (
    <ul className="flex flex-col gap-2 text-sm">
      {states.map(([variant, label]) => (
        <li className="flex items-center gap-2" key={variant}>
          <Status variant={variant} />
          {label}
        </li>
      ))}
    </ul>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-4 text-sm">
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <span className="inline-flex items-center gap-2" key={size}>
          <Status size={size} variant="success" /> {size}
        </span>
      ))}
      <span className="inline-flex items-center gap-2">
        <Status className="size-4" variant="success">
          <CheckIcon />
        </Status>
        With icon
      </span>
    </div>
  ),
};

export const Chinese: Story = {
  name: 'zh-CN',
  render: () => (
    <ul className="flex flex-col gap-2 text-sm" lang="zh-CN">
      <li className="flex items-center gap-2">
        <Status variant="success" />
        正在阅读《三体》
      </li>
      <li className="flex items-center gap-2">
        <Status variant="warning" />
        豆瓣评分同步已过期 9 天
      </li>
    </ul>
  ),
};

export const Dark: Story = {
  parameters: { dark: true },
  render: Variants.render,
};
