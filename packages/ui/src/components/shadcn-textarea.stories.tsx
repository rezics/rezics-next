import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Label } from '@rezics/ui/shadcn/label';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Textarea',
  component: Textarea,
  tags: ['autodocs'],
  decorators: [withSurface],
  render: (args) => (
    <div className="grid max-w-sm gap-2">
      <Label htmlFor="textarea-story">Review</Label>
      <Textarea id="textarea-story" {...args} />
    </div>
  ),
} satisfies Meta<typeof Textarea>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { placeholder: 'What did you think?' },
  async play({ canvasElement }) {
    const textarea = within(canvasElement).getByRole('textbox', { name: 'Review' });
    await userEvent.type(textarea, '黑暗森林{Enter}A second line');
    await expect(textarea).toHaveValue('黑暗森林\nA second line');
  },
};

export const LongText: Story = {
  args: {
    defaultValue: `${'一个很长的段落，没有换行，用来检查文本框在窄屏幕上自动换行与增高的表现。'.repeat(4)}\nA long English line that wraps as well.`,
  },
  async play({ canvasElement }) {
    const textarea = within(canvasElement).getByRole('textbox', { name: 'Review' });
    await expect((textarea as HTMLTextAreaElement).value).toContain('一个很长的段落');
    await expect(textarea.scrollWidth).toBeLessThanOrEqual(textarea.clientWidth);
  },
};

export const Disabled: Story = {
  args: { disabled: true, defaultValue: 'Reviews are closed.' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('textbox', { name: 'Review' })).toBeDisabled();
  },
};

export const Invalid: Story = {
  args: { 'aria-invalid': true, defaultValue: '' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('textbox', { name: 'Review' })).toBeInvalid();
  },
};
