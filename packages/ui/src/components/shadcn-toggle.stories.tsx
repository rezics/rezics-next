import type { Meta, StoryObj } from '@storybook/react-vite';
import { BookmarkIcon } from 'lucide-react';
import { expect, userEvent, within } from 'storybook/test';
import { Toggle } from '@rezics/ui/shadcn/toggle';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Toggle',
  component: Toggle,
  tags: ['autodocs'],
  decorators: [withSurface],
  render: (args) => (
    <Toggle aria-label="Bookmark" {...args}>
      <BookmarkIcon />
      Bookmark
    </Toggle>
  ),
} satisfies Meta<typeof Toggle>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const toggle = within(canvasElement).getByRole('button', { name: 'Bookmark' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  },
};

export const Pressed: Story = {
  args: { defaultPressed: true, variant: 'outline' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: 'Bookmark' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  },
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Toggle size="sm" variant="outline" aria-label="Small bookmark">
        <BookmarkIcon />
      </Toggle>
      <Toggle variant="outline" aria-label="Default bookmark">
        <BookmarkIcon />
      </Toggle>
      <Toggle size="lg" variant="outline" aria-label="Large bookmark">
        <BookmarkIcon />
      </Toggle>
    </div>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getAllByRole('button')).toHaveLength(3);
  },
};

export const Disabled: Story = {
  args: { disabled: true },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: 'Bookmark' })).toBeDisabled();
  },
};

export const CJKLabel: Story = {
  render: () => (
    <Toggle variant="outline" aria-label="收藏到书架：三体与更多的长标题作品">
      <BookmarkIcon />
      收藏到书架：三体与更多的长标题作品
    </Toggle>
  ),
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /收藏到书架/ }));
    await expect(within(canvasElement).getByRole('button', { name: /收藏到书架/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  },
};
