import type { Meta, StoryObj } from '@storybook/react-vite';
import { ArrowRightIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Button',
  component: Button,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

const Counter = () => {
  const [count, setCount] = useState(0);
  return (
    <Button onClick={() => setCount(count + 1)}>
      Add to shelf <span aria-live="polite">{count}</span>
    </Button>
  );
};

export const Default: Story = {
  render: () => <Counter />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /Add to shelf/ }));
    await expect(canvas.getByRole('button', { name: 'Add to shelf 1' })).toBeVisible();
  },
};

export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      {(['default', 'outline', 'secondary', 'ghost', 'destructive', 'link'] as const).map((variant) => (
        <Button key={variant} variant={variant}>
          {variant}
        </Button>
      ))}
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    for (const name of ['default', 'outline', 'secondary', 'ghost', 'destructive', 'link'])
      await expect(canvas.getByRole('button', { name })).toBeVisible();
  },
};

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button size="xs">Extra small</Button>
      <Button size="sm">Small</Button>
      <Button>Default</Button>
      <Button size="lg">Large</Button>
      <Button size="icon" aria-label="Add">
        <PlusIcon />
      </Button>
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Add' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Large' }).getBoundingClientRect().height).toBeGreaterThan(
      canvas.getByRole('button', { name: 'Small' }).getBoundingClientRect().height,
    );
  },
};

export const WithIcon: Story = {
  render: () => (
    <Button>
      Continue reading
      <ArrowRightIcon data-icon="inline-end" />
    </Button>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: 'Continue reading' })).toBeVisible();
  },
};

export const Disabled: Story = {
  render: () => <Button disabled>Unavailable</Button>,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: 'Unavailable' })).toBeDisabled();
  },
};
