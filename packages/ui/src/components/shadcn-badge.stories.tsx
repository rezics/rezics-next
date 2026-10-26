import type { Meta, StoryObj } from '@storybook/react-vite';
import { CheckIcon } from 'lucide-react';
import { expect, within } from 'storybook/test';
import { Badge } from '@rezics/ui/shadcn/badge';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Badge',
  component: Badge,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof Badge>;
export default meta;
type Story = StoryObj<typeof meta>;

const variants = ['default', 'secondary', 'destructive', 'outline', 'ghost', 'link'] as const;

export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      {variants.map((variant) => (
        <Badge key={variant} variant={variant}>
          {variant}
        </Badge>
      ))}
    </div>
  ),
  async play({ canvasElement }) {
    for (const name of variants) await expect(within(canvasElement).getByText(name)).toBeVisible();
  },
};

export const WithIconAndLink: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="secondary">
        <CheckIcon data-icon="inline-start" />
        Verified
      </Badge>
      <Badge render={<a href="#new" />} variant="outline">
        3 new editions
      </Badge>
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Verified')).toBeVisible();
    await expect(canvas.getByRole('link', { name: '3 new editions' })).toHaveAttribute('href', '#new');
  },
};

export const Invalid: Story = {
  render: () => (
    <Badge variant="outline" aria-invalid="true">
      Missing ISBN
    </Badge>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('Missing ISBN')).toHaveAttribute('aria-invalid', 'true');
  },
};

export const LongAndCjkText: Story = {
  render: () => (
    <div className="flex max-w-48 flex-col items-start gap-2">
      <Badge variant="secondary">Science fiction, hard SF and space opera</Badge>
      <Badge>科幻小說・硬科幻</Badge>
      <Badge variant="destructive">已下架（日本語）</Badge>
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('科幻小說・硬科幻')).toBeVisible();
    await expect(canvas.getByText('已下架（日本語）')).toBeVisible();
  },
};
