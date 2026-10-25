import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { Button } from './button.tsx';
import { Progress, ProgressLabel, ProgressValue } from './progress.tsx';

const surface: Decorator = (Story, { parameters }) => (
  <div className={cn('max-w-md bg-background p-6 font-sans text-foreground')}>
    <Story />
  </div>
);

const meta = {
  title: 'Rezics UI/Feedback/Progress',
  component: Progress,
  tags: ['autodocs'],
  decorators: [surface],
  args: { value: 62, 'aria-label': 'Reading progress' },
  parameters: {
    docs: {
      description: {
        component:
          'A linear bar for a measurable amount: how far a reader is through a Work, a shelf import or a reading challenge. Children render above the bar, typically a `ProgressLabel` and a `ProgressValue`. Always pass `aria-label` (or `aria-labelledby`): Ark names the bar with its value text only, so an indeterminate bar would have no name. Use `indeterminate` when the total is unknown, and Circular Progress where space is tight.',
      },
    },
  },
} satisfies Meta<typeof Progress>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const bar = within(canvasElement).getByRole('progressbar', { name: 'Reading progress' });
    await expect(bar).toHaveAttribute('aria-valuenow', '62');
  },
};

export const WithLabelAndValue: Story = {
  render: (args) => (
    <Progress {...args}>
      <ProgressLabel>The Left Hand of Darkness</ProgressLabel>
      <ProgressValue />
    </Progress>
  ),
};

export const Values: Story = {
  render: () => (
    <div className="flex flex-col gap-5">
      {[0, 8, 50, 100].map((value) => (
        <Progress aria-label={`Challenge progress ${value}`} key={value} value={value}>
          <ProgressLabel>
            {value === 100 ? '2026 challenge complete' : '2026 challenge'}
          </ProgressLabel>
          <ProgressValue />
        </Progress>
      ))}
    </div>
  ),
};

export const Indeterminate: Story = {
  args: { indeterminate: true, 'aria-label': 'Importing shelf from Goodreads' },
  render: (args) => (
    <Progress {...args}>
      <ProgressLabel>Importing shelf from Goodreads…</ProgressLabel>
    </Progress>
  ),
  async play({ canvasElement }) {
    const bar = within(canvasElement).getByRole('progressbar', {
      name: 'Importing shelf from Goodreads',
    });
    await expect(bar).not.toHaveAttribute('aria-valuenow');
  },
};

export const CustomMax: Story = {
  name: 'Custom max (pages)',
  args: { max: 412, value: 187, 'aria-label': 'Pages read' },
  render: (args) => (
    <Progress {...args}>
      <ProgressLabel>Pages read</ProgressLabel>
      <ProgressValue>
        {args.value} of {args.max} pages
      </ProgressValue>
    </Progress>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('187 of 412 pages')).toBeVisible();
    await expect(canvas.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '412');
  },
};

const Interactive = () => {
  const [value, setValue] = useState(11);

  return (
    <div className="flex flex-col gap-4">
      <Progress aria-label="Chapters read" max={12} value={value}>
        <ProgressLabel>Chapters read</ProgressLabel>
        <ProgressValue />
      </Progress>
      <Button onClick={() => setValue((current) => Math.min(current + 1, 12))} variant="outline">
        Finish a chapter
      </Button>
    </div>
  );
};

export const Updating: Story = {
  render: () => <Interactive />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Finish a chapter' }));
    await expect(canvas.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '12');
  },
};

export const Vertical: Story = {
  args: { orientation: 'vertical', value: 70, 'aria-label': 'Weekly reading goal' },
  render: (args) => (
    <div className="h-32">
      <Progress {...args} />
    </div>
  ),
};

export const Chinese: Story = {
  name: 'zh-CN',
  args: { value: 35, 'aria-label': '阅读进度' },
  render: (args) => (
    <div lang="zh-CN">
      <Progress {...args}>
        <ProgressLabel>《三体 II：黑暗森林》阅读进度</ProgressLabel>
        <ProgressValue />
      </Progress>
    </div>
  ),
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  render: () => (
    <div className="flex flex-col gap-5">
      <Progress aria-label="Reading progress" value={62}>
        <ProgressLabel>The Left Hand of Darkness</ProgressLabel>
        <ProgressValue />
      </Progress>
      <Progress aria-label="Importing shelf" indeterminate>
        <ProgressLabel>Importing shelf…</ProgressLabel>
      </Progress>
    </div>
  ),
};
