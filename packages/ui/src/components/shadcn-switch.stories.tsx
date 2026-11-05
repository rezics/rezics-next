import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Label } from '@rezics/ui/shadcn/label';
import { Switch } from '@rezics/ui/shadcn/switch';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Switch',
  component: Switch,
  tags: ['autodocs'],
  decorators: [withSurface],
  render: (args) => (
    <Label className="flex max-w-sm items-center gap-3">
      <Switch aria-label="Show spoilers" {...args} />
      Show spoilers in reviews
    </Label>
  ),
} satisfies Meta<typeof Switch>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const toggle = within(canvasElement).getByRole('switch', { name: 'Show spoilers' });
    await expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    await expect(toggle).toBeChecked();
    await userEvent.keyboard(' ');
    await expect(toggle).not.toBeChecked();
  },
};

export const Checked: Story = {
  args: { defaultChecked: true },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('switch', { name: 'Show spoilers' })).toBeChecked();
  },
};

export const Small: Story = {
  args: { size: 'sm' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('switch')).toHaveAttribute('data-size', 'sm');
  },
};

export const Disabled: Story = {
  args: { disabled: true, defaultChecked: true },
  async play({ canvasElement }) {
    const toggle = within(canvasElement).getByRole('switch', { name: 'Show spoilers' });
    await expect(toggle).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(toggle);
    await expect(toggle).toBeChecked();
  },
};

export const Invalid: Story = {
  args: { 'aria-invalid': true },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('switch', { name: 'Show spoilers' })).toBeInvalid();
  },
};

export const LongCJKLabel: Story = {
  render: (args) => (
    <Label className="flex max-w-xs items-start gap-3">
      <Switch aria-label="显示剧透" className="mt-0.5" {...args} />
      在书评与评论中显示含有剧透内容的长说明文字，关闭后将折叠所有标记为剧透的段落
    </Label>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('switch', { name: '显示剧透' })).toBeInTheDocument();
  },
};
