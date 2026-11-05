import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { Kbd, KbdGroup } from '@rezics/ui/shadcn/kbd';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Kbd',
  component: Kbd,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof Kbd>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <p className="text-sm">
      Press <Kbd>Esc</Kbd> to close the shelf editor.
    </p>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('Esc').tagName).toBe('KBD');
  },
};

export const Combination: Story = {
  render: () => (
    <p className="text-sm">
      Search every Work with{' '}
      <KbdGroup>
        <Kbd>Ctrl</Kbd>
        <Kbd>K</Kbd>
      </KbdGroup>
      .
    </p>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Ctrl')).toBeVisible();
    await expect(canvas.getByText('K').closest('[data-slot="kbd-group"]')).not.toBeNull();
  },
};

export const LongAndCjkLabels: Story = {
  render: () => (
    <div className="grid max-w-xs gap-3 text-sm">
      <p>
        <Kbd>⌘</Kbd> <Kbd>⇧</Kbd> <Kbd>Enter</Kbd>
      </p>
      <p>
        換行：<Kbd>Shift</Kbd> + <Kbd>Enter</Kbd>
      </p>
      <p>
        <Kbd>前往下一個未讀章節的第一頁</Kbd>
      </p>
    </div>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getAllByText('Enter')).toHaveLength(2);
    await expect(within(canvasElement).getByText('前往下一個未讀章節的第一頁')).toBeVisible();
  },
};
