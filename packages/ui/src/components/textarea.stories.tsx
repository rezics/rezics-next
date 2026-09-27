import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { Field, FieldError, FieldHelper, FieldLabel } from './field.tsx';
import { Textarea } from './textarea.tsx';

const review =
  'The first half of 《三体》 is a slow, patient mystery; the second half turns into a thriller about physics itself. Ye Wenjie’s choice at Red Coast Base still haunts me. Liu Cixin writes ideas better than people, but the ideas are enormous.';

const meta = {
  title: 'Rezics UI/Textarea',
  component: Textarea,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'A multi-line text field that grows with its content. In REZICS use it for review bodies, Realm post replies, moderation notes and Work synopses in the editor. Put it in a Field with a label and helper text; use Input for single-line values such as titles.',
      },
    },
  },
  args: { placeholder: 'What did you think of this Work?' },
  decorators: [
    (Story, { parameters }) => (
      <div className={cn(parameters.theme === 'dark' && 'dark')}>
        <div className="min-h-40 bg-background p-6 font-sans text-foreground">
          <div className="max-w-lg">
            <Story />
          </div>
        </div>
      </div>
    ),
  ],
  render: (args) => (
    <Field>
      <FieldLabel>Your review</FieldLabel>
      <Textarea {...args} />
      <FieldHelper>Markdown and spoiler tags (||like this||) are supported.</FieldHelper>
    </Field>
  ),
} satisfies Meta<typeof Textarea>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const textarea = within(canvasElement).getByRole('textbox', { name: 'Your review' });
    await userEvent.click(textarea);
    await expect(textarea).toHaveFocus();
    await userEvent.type(textarea, 'A slow burn that pays off.');
    await expect(textarea).toHaveValue('A slow burn that pays off.');
  },
};

export const WithValue: Story = { args: { defaultValue: review } };

export const LongContent: Story = {
  args: { defaultValue: Array.from({ length: 4 }, () => review).join('\n\n') },
};

export const Chinese: Story = {
  args: {
    placeholder: '写下你对这部作品的看法……',
    defaultValue:
      '《三体》第一部像一部耐心的悬疑小说，后半部分却变成了关于物理学本身的惊悚故事。叶文洁在红岸基地的选择至今让我难以释怀。Liu Cixin 写观念比写人物更出色，但这些观念实在太宏大了。',
  },
  render: (args) => (
    <Field>
      <FieldLabel>书评</FieldLabel>
      <Textarea {...args} />
      <FieldHelper>支持 Markdown 与剧透标记。</FieldHelper>
    </Field>
  ),
};

export const Disabled: Story = {
  args: { disabled: true, defaultValue: 'Reviews are closed while this Work is under moderation.' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('textbox')).toBeDisabled();
  },
};

export const ReadOnly: Story = {
  args: { readOnly: true, defaultValue: review },
  render: (args) => (
    <Field>
      <FieldLabel>Original review (read-only)</FieldLabel>
      <Textarea {...args} />
      <FieldHelper>Moderators can quote but not edit a reader’s review.</FieldHelper>
    </Field>
  ),
};

export const Invalid: Story = {
  args: { defaultValue: 'Too short' },
  render: (args) => (
    <Field invalid>
      <FieldLabel>Your review</FieldLabel>
      <Textarea {...args} />
      <FieldError>Reviews need at least 50 characters. Add a few more thoughts.</FieldError>
    </Field>
  ),
  async play({ canvasElement }) {
    const textarea = within(canvasElement).getByRole('textbox', { name: 'Your review' });
    await expect(textarea).toBeInvalid();
    await expect(textarea).toHaveAccessibleErrorMessage(/at least 50 characters/);
  },
};

export const Dark: Story = {
  parameters: { theme: 'dark' },
  render: (args) => (
    <div className="flex flex-col gap-6">
      <Field>
        <FieldLabel>Your review</FieldLabel>
        <Textarea {...args} />
        <FieldHelper>Markdown and spoiler tags are supported.</FieldHelper>
      </Field>
      <Field invalid>
        <FieldLabel>Moderator note</FieldLabel>
        <Textarea defaultValue="Too short" />
        <FieldError>Notes need at least 20 characters.</FieldError>
      </Field>
      <Field disabled>
        <FieldLabel>Closed</FieldLabel>
        <Textarea defaultValue="Reviews are closed." />
      </Field>
    </div>
  ),
};
