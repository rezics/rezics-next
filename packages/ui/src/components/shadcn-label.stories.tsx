import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Input } from '@rezics/ui/shadcn/input';
import { Label } from '@rezics/ui/shadcn/label';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Label',
  component: Label,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof Label>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="grid max-w-sm gap-2">
      <Label htmlFor="label-title">Work title</Label>
      <Input id="label-title" />
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('Work title'));
    await expect(canvas.getByRole('textbox', { name: 'Work title' })).toHaveFocus();
  },
};

export const WithCheckbox: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Checkbox id="label-spoilers" />
      <Label htmlFor="label-spoilers">Hide spoilers in reviews</Label>
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('Hide spoilers in reviews'));
    await expect(canvas.getByRole('checkbox', { name: 'Hide spoilers in reviews' })).toBeChecked();
  },
};

export const DisabledControl: Story = {
  render: () => (
    <div className="group grid max-w-sm gap-2" data-disabled="true">
      <Label htmlFor="label-locked">Locked shelf</Label>
      <Input id="label-locked" disabled defaultValue="Archived" />
    </div>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('textbox', { name: 'Locked shelf' })).toBeDisabled();
  },
};

export const LongAndCjkText: Story = {
  render: () => (
    <div className="grid max-w-xs gap-4">
      <div className="grid gap-2">
        <Label htmlFor="label-long">
          The title this Work was first published under, before any translation or later revision
        </Label>
        <Input id="label-long" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="label-cjk">作品的原文標題（含副標題與系列名稱）</Label>
        <Input id="label-cjk" defaultValue="三体Ⅱ：黑暗森林" />
      </div>
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('textbox', { name: /first published under/ })).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: /原文標題/ })).toHaveValue('三体Ⅱ：黑暗森林');
  },
};
