import type { Meta, StoryObj } from '@storybook/react-vite';
import { ArrowRightIcon } from 'lucide-react';
import { expect, within } from 'storybook/test';
import { Button } from './button.tsx';

const meta = {
  title: 'Rezics UI/Button',
  component: Button,
  tags: ['autodocs'],
  args: { children: 'Add to shelf' },
  decorators: [
    (Story) => (
      <div className="flex min-h-40 items-center p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      {(['default', 'secondary', 'outline', 'soft', 'ghost', 'link', 'destructive'] as const).map(
        (variant) => (
          <Button key={variant} variant={variant}>
            {variant}
          </Button>
        ),
      )}
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      {(['xs', 'sm', 'md', 'lg', 'xl'] as const).map((size) => (
        <Button key={size} size={size}>
          <ArrowRightIcon aria-hidden />
          {size}
        </Button>
      ))}
    </div>
  ),
};

export const CallerDisabled: Story = {
  args: { 'aria-disabled': true },
  async play({ canvasElement }) {
    await expect(
      within(canvasElement).getByRole('button', { name: 'Add to shelf' }),
    ).toHaveAttribute('aria-disabled', 'true');
  },
};

export const Loading: Story = {
  args: { isLoading: true },
  async play({ canvasElement }) {
    const button = within(canvasElement).getByRole('button', { name: 'Add to shelf' });
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toHaveAttribute('aria-disabled', 'true');
  },
};
