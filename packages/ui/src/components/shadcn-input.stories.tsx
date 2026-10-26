import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Input } from '@rezics/ui/shadcn/input';
import { Label } from '@rezics/ui/shadcn/label';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Input',
  component: Input,
  tags: ['autodocs'],
  decorators: [withSurface],
  render: (args) => (
    <div className="grid max-w-sm gap-2">
      <Label htmlFor="input-story">Shelf name</Label>
      <Input id="input-story" {...args} />
    </div>
  ),
} satisfies Meta<typeof Input>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { placeholder: 'Hard science fiction' },
  async play({ canvasElement }) {
    const input = within(canvasElement).getByRole('textbox', { name: 'Shelf name' });
    await userEvent.type(input, '三体');
    await expect(input).toHaveValue('三体');
  },
};

export const Disabled: Story = {
  args: { disabled: true, defaultValue: 'Locked shelf' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('textbox', { name: 'Shelf name' })).toBeDisabled();
  },
};

export const Invalid: Story = {
  args: { 'aria-invalid': true, defaultValue: '' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('textbox', { name: 'Shelf name' })).toBeInvalid();
  },
};

export const Password: Story = {
  args: { type: 'password', defaultValue: 'correct horse' },
  render: (args) => (
    <div className="grid max-w-sm gap-2">
      <Label htmlFor="input-story">Password</Label>
      <Input id="input-story" autoComplete="current-password" {...args} />
    </div>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByLabelText('Password')).toHaveValue('correct horse');
  },
};
