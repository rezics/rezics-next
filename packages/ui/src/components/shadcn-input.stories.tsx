import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Input } from '@rezics/ui/shadcn/input';
import { Label } from '@rezics/ui/shadcn/label';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { Button } from '@rezics/ui/shadcn/button';
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

export const Empty: Story = {
  render: () => (
    <form className="grid max-w-sm gap-3" onSubmit={(event) => event.preventDefault()}>
      <Label htmlFor="empty-name">Name of the collection shared with your reading group</Label>
      <Input id="empty-name" />
      <Label htmlFor="empty-description">Description</Label>
      <Textarea id="empty-description" />
      <div className="flex flex-wrap gap-2">
        <Button type="submit">Save collection</Button>
        <Button type="reset" variant="outline">
          Reset
        </Button>
      </div>
    </form>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('textbox', { name: 'Name of the collection shared with your reading group' }),
    ).toHaveValue('');
    await expect(canvas.getByRole('textbox', { name: 'Description' })).toHaveValue('');
  },
};

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
