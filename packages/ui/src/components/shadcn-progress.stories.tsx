import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { Progress, ProgressLabel, ProgressValue } from '@rezics/ui/shadcn/progress';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Progress',
  component: Progress,
  tags: ['autodocs'],
  decorators: [withSurface],
  render: (args) => (
    <Progress className="max-w-sm" {...args}>
      <ProgressLabel>Chapters read</ProgressLabel>
      <ProgressValue />
    </Progress>
  ),
} satisfies Meta<typeof Progress>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { value: 40 },
  async play({ canvasElement }) {
    const bar = within(canvasElement).getByRole('progressbar', { name: 'Chapters read' });
    await expect(bar).toHaveAttribute('aria-valuenow', '40');
    await expect(bar).toHaveAttribute('aria-valuetext', '40%');
  },
};

export const Complete: Story = {
  args: { value: 100 },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('progressbar', { name: 'Chapters read' })).toHaveAttribute(
      'aria-valuenow',
      '100',
    );
  },
};

export const Indeterminate: Story = {
  args: { value: null },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('progressbar', { name: 'Chapters read' })).not.toHaveAttribute(
      'aria-valuenow',
    );
  },
};

export const LongCJKLabel: Story = {
  args: { value: 72 },
  render: (args) => (
    <Progress className="max-w-xs" {...args}>
      <ProgressLabel>已阅读的章节：《三体》第三部《死神永生》与全部附录的完整进度</ProgressLabel>
      <ProgressValue />
    </Progress>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('progressbar', { name: /死神永生/ })).toHaveAttribute(
      'aria-valuenow',
      '72',
    );
  },
};
