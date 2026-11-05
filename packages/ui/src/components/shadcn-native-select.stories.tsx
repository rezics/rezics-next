import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Label } from '@rezics/ui/shadcn/label';
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/NativeSelect',
  component: NativeSelect,
  tags: ['autodocs'],
  decorators: [withSurface],
  render: (args) => (
    <div className="grid max-w-xs gap-2">
      <Label htmlFor="native-select-story">Shelf</Label>
      <NativeSelect id="native-select-story" className="w-full" {...args}>
        <NativeSelectOption value="">Choose a shelf</NativeSelectOption>
        <NativeSelectOptGroup label="Reading">
          <NativeSelectOption value="want">Want to read</NativeSelectOption>
          <NativeSelectOption value="reading">Currently reading</NativeSelectOption>
        </NativeSelectOptGroup>
        <NativeSelectOptGroup label="Done">
          <NativeSelectOption value="read">Read</NativeSelectOption>
          <NativeSelectOption value="cjk">已读完的科幻小说：三体、流浪地球与更多的长标题作品</NativeSelectOption>
        </NativeSelectOptGroup>
      </NativeSelect>
    </div>
  ),
} satisfies Meta<typeof NativeSelect>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const select = within(canvasElement).getByRole('combobox', { name: 'Shelf' });
    await expect(select).toHaveValue('');
    await userEvent.selectOptions(select, 'reading');
    await expect(select).toHaveValue('reading');
  },
};

export const CJKOption: Story = {
  async play({ canvasElement }) {
    const select = within(canvasElement).getByRole('combobox', { name: 'Shelf' });
    await userEvent.selectOptions(select, 'cjk');
    await expect(select).toHaveDisplayValue(/三体/);
  },
};

export const Small: Story = {
  args: { size: 'sm', defaultValue: 'read' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('combobox', { name: 'Shelf' })).toHaveValue('read');
  },
};

export const Disabled: Story = {
  args: { disabled: true, defaultValue: 'want' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('combobox', { name: 'Shelf' })).toBeDisabled();
  },
};

export const Invalid: Story = {
  args: { 'aria-invalid': true },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('combobox', { name: 'Shelf' })).toBeInvalid();
  },
};
