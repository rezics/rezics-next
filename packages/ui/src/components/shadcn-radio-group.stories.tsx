import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Label } from '@rezics/ui/shadcn/label';
import { RadioGroup, RadioGroupItem } from '@rezics/ui/shadcn/radio-group';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/RadioGroup',
  component: RadioGroup,
  tags: ['autodocs'],
  decorators: [withSurface],
  render: (args) => (
    <RadioGroup aria-label="Visibility" className="max-w-sm" {...args}>
      <Label className="flex items-center gap-2">
        <RadioGroupItem value="public" />
        Public
      </Label>
      <Label className="flex items-center gap-2">
        <RadioGroupItem value="followers" />
        Followers only
      </Label>
      <Label className="flex items-center gap-2">
        <RadioGroupItem value="private" />
        Only me
      </Label>
      <Label className="flex items-start gap-2">
        <RadioGroupItem value="cjk" className="mt-0.5" />
        仅限我关注的人可见，并且不会出现在搜索结果与推荐列表中的长说明文字
      </Label>
    </RadioGroup>
  ),
} satisfies Meta<typeof RadioGroup>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { defaultValue: 'public' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('radio', { name: 'Public' })).toBeChecked();
    await userEvent.click(canvas.getByRole('radio', { name: 'Only me' }));
    await expect(canvas.getByRole('radio', { name: 'Only me' })).toBeChecked();
    await expect(canvas.getByRole('radio', { name: 'Public' })).not.toBeChecked();
  },
};

export const Keyboard: Story = {
  args: { defaultValue: 'public' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    canvas.getByRole('radio', { name: 'Public' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(canvas.getByRole('radio', { name: 'Followers only' })).toBeChecked();
  },
};

export const CJKLabel: Story = {
  args: { defaultValue: 'cjk' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('radio', { name: /仅限我关注的人/ })).toBeChecked();
  },
};

export const Disabled: Story = {
  args: { disabled: true, defaultValue: 'followers' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('radio', { name: 'Followers only' })).toBeChecked();
    await expect(canvas.getByRole('radio', { name: 'Public' })).toHaveAttribute('aria-disabled', 'true');
  },
};

export const Invalid: Story = {
  render: () => (
    <RadioGroup aria-label="Visibility" className="max-w-sm">
      <Label className="flex items-center gap-2">
        <RadioGroupItem value="public" aria-invalid />
        Public
      </Label>
      <Label className="flex items-center gap-2">
        <RadioGroupItem value="private" aria-invalid />
        Only me
      </Label>
    </RadioGroup>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('radio', { name: 'Public' })).toBeInvalid();
  },
};
