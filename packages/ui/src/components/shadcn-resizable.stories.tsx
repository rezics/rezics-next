import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@rezics/ui/shadcn/resizable';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Resizable',
  component: ResizablePanelGroup,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof ResizablePanelGroup>;
export default meta;
type Story = StoryObj<typeof meta>;

const Pane = ({ children }: { children: string }) => (
  <div className="flex h-full items-center justify-center p-2 text-sm">{children}</div>
);

export const Horizontal: Story = {
  args: { orientation: 'horizontal', children: null },
  render: (args) => (
    <ResizablePanelGroup {...args} className="max-w-md rounded-2xl border" style={{ height: 200 }}>
      <ResizablePanel defaultSize="30%" minSize="20%">
        <Pane>Shelves</Pane>
      </ResizablePanel>
      <ResizableHandle withHandle aria-label="Resize shelves" />
      <ResizablePanel defaultSize="70%">
        <Pane>Works</Pane>
      </ResizablePanel>
    </ResizablePanelGroup>
  ),
  async play({ canvasElement }) {
    const handle = within(canvasElement).getByRole('separator', { name: 'Resize shelves' });
    await expect(Number(handle.getAttribute('aria-valuenow'))).toBeCloseTo(30, 0);
    handle.focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(Number(handle.getAttribute('aria-valuenow'))).toBeGreaterThan(30);
    await userEvent.keyboard('{Home}');
    await expect(Number(handle.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(20);
  },
};

export const Vertical: Story = {
  args: { orientation: 'vertical', children: null },
  render: (args) => (
    <ResizablePanelGroup {...args} className="max-w-md rounded-2xl border" style={{ height: 260 }}>
      <ResizablePanel defaultSize="40%">
        <Pane>简介</Pane>
      </ResizablePanel>
      <ResizableHandle withHandle aria-label="调整简介高度" />
      <ResizablePanel defaultSize="60%">
        <Pane>Reviews</Pane>
      </ResizablePanel>
    </ResizablePanelGroup>
  ),
  async play({ canvasElement }) {
    const handle = within(canvasElement).getByRole('separator', { name: '调整简介高度' });
    await expect(handle).toHaveAttribute('aria-orientation', 'horizontal');
    handle.focus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(Number(handle.getAttribute('aria-valuenow'))).toBeGreaterThan(40);
  },
};

export const Disabled: Story = {
  args: { orientation: 'horizontal', children: null },
  render: (args) => (
    <ResizablePanelGroup {...args} className="max-w-md rounded-2xl border" style={{ height: 160 }}>
      <ResizablePanel defaultSize="50%">
        <Pane>Fixed left</Pane>
      </ResizablePanel>
      <ResizableHandle disabled aria-label="Locked divider" />
      <ResizablePanel defaultSize="50%">
        <Pane>Fixed right</Pane>
      </ResizablePanel>
    </ResizablePanelGroup>
  ),
  async play({ canvasElement }) {
    const handle = within(canvasElement).getByRole('separator', { name: 'Locked divider' });
    const before = Number(handle.getAttribute('aria-valuenow'));
    await expect(before).toBeCloseTo(50, 0);
    handle.focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(Number(handle.getAttribute('aria-valuenow'))).toBe(before);
  },
};
