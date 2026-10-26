import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ToggleGroup, ToggleGroupItem } from '@rezics/ui/shadcn/toggle-group';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/ToggleGroup',
  component: ToggleGroup,
  tags: ['autodocs'],
  decorators: [withSurface],
  render: (args) => (
    <ToggleGroup aria-label="Reading status" {...args}>
      <ToggleGroupItem value="want">Want to read</ToggleGroupItem>
      <ToggleGroupItem value="reading">Reading</ToggleGroupItem>
      <ToggleGroupItem value="read">Read</ToggleGroupItem>
    </ToggleGroup>
  ),
} satisfies Meta<typeof ToggleGroup>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { variant: 'outline', multiple: true },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Reading' }));
    await expect(canvas.getByRole('button', { name: 'Reading' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(canvas.getByRole('button', { name: 'Read' }));
    await expect(canvas.getByRole('button', { name: 'Reading' })).toHaveAttribute('aria-pressed', 'true');
    await expect(canvas.getByRole('button', { name: 'Read' })).toHaveAttribute('aria-pressed', 'true');
  },
};

export const Single: Story = {
  args: { variant: 'outline', multiple: false, defaultValue: ['want'], spacing: 0 },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Read' }));
    await expect(canvas.getByRole('button', { name: 'Read' })).toHaveAttribute('aria-pressed', 'true');
    await expect(canvas.getByRole('button', { name: 'Want to read' })).toHaveAttribute('aria-pressed', 'false');
  },
};

export const Disabled: Story = {
  args: { disabled: true, defaultValue: ['read'] },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Read' })).toHaveAttribute('aria-pressed', 'true');
    await expect(canvas.getByRole('button', { name: 'Reading' })).toBeDisabled();
  },
};

export const Vertical: Story = {
  args: { orientation: 'vertical', variant: 'outline', spacing: 0 },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('group', { name: 'Reading status' })).toHaveAttribute(
      'data-orientation',
      'vertical',
    );
  },
};

export const CJKLabels: Story = {
  render: (args) => (
    <ToggleGroup aria-label="阅读状态" className="max-w-full flex-wrap" {...args}>
      <ToggleGroupItem value="want">想读的长标题作品</ToggleGroupItem>
      <ToggleGroupItem value="reading">在读</ToggleGroupItem>
      <ToggleGroupItem value="read">读过</ToggleGroupItem>
    </ToggleGroup>
  ),
  args: { variant: 'outline' },
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: '在读' }));
    await expect(within(canvasElement).getByRole('button', { name: '在读' })).toHaveAttribute('aria-pressed', 'true');
  },
};
