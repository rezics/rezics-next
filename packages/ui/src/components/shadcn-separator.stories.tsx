import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { Separator } from '@rezics/ui/shadcn/separator';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Separator',
  component: Separator,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof Separator>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Horizontal: Story = {
  render: (args) => (
    <div className="max-w-sm space-y-3 text-sm">
      <div>
        <h4 className="font-medium">The Three-Body Problem</h4>
        <p className="text-muted-foreground">A novel by Liu Cixin.</p>
      </div>
      <Separator {...args} />
      <p>Part of the Remembrance of Earth's Past trilogy.</p>
    </div>
  ),
  async play({ canvasElement }) {
    const separator = within(canvasElement).getByRole('separator');
    await expect(separator).toHaveAttribute('data-orientation', 'horizontal');
  },
};

export const Vertical: Story = {
  args: { orientation: 'vertical' },
  render: (args) => (
    <div className="flex h-5 items-center gap-4 text-sm">
      <span>Works</span>
      <Separator {...args} />
      <span>People</span>
      <Separator {...args} />
      <span>作品与人物的长标题：三体、流浪地球、球状闪电</span>
    </div>
  ),
  async play({ canvasElement }) {
    const separators = within(canvasElement).getAllByRole('separator');
    await expect(separators).toHaveLength(2);
    for (const separator of separators) await expect(separator).toHaveAttribute('aria-orientation', 'vertical');
  },
};

export const Sections: Story = {
  render: () => (
    <div className="max-w-sm space-y-3 text-sm">
      <p>上一节：黑暗森林</p>
      <Separator aria-label="Chapter break" />
      <p>Next section: Death's End</p>
      <Separator aria-label="Section break" />
      <p>下一节：掩体纪元与更多的长标题章节</p>
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('separator')).toHaveLength(2);
    await expect(canvas.getByRole('separator', { name: 'Chapter break' })).toBeInTheDocument();
  },
};
