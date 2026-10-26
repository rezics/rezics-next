import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import { Spinner } from '@rezics/ui/shadcn/spinner';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Spinner',
  component: Spinner,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof Spinner>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  },
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Spinner className="size-3" aria-label="Loading small" />
      <Spinner aria-label="Loading default" />
      <Spinner className="size-8" aria-label="Loading large" />
    </div>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getAllByRole('status')).toHaveLength(3);
  },
};

export const InButton: Story = {
  render: () => (
    <Button disabled>
      <Spinner data-icon="inline-start" aria-label="正在保存" />
      保存书架中…
    </Button>
  ),
  async play({ canvasElement }) {
    const button = within(canvasElement).getByRole('button', { name: /保存书架中/ });
    await expect(button).toBeDisabled();
    await expect(within(button).getByRole('status', { name: '正在保存' })).toBeInTheDocument();
  },
};
