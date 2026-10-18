import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { settled } from '../stories/support.tsx';
import { expectControlBoundary, expectInvalidFieldKeyboardFocus } from '../test/control-contrast.ts';
import { waitForFocus } from '../test/focus.ts';
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
      <div>
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
    await waitForFocus(textarea);
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
  globals: { theme: 'dark' },
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

/** A keyboard user can locate the field even before entering any text. */
async function expectTextareaKeyboardFocus(textarea: HTMLElement): Promise<void> {
  await expect(textarea).not.toHaveFocus();
  const resting = getComputedStyle(textarea);
  const visibleOutlineWidth = resting.outlineStyle === 'none' ? 0 : Number.parseFloat(resting.outlineWidth);
  await userEvent.tab();
  await waitForFocus(textarea);
  await settled(textarea);
  await expect(textarea.matches(':focus-visible')).toBe(true);
  const focused = getComputedStyle(textarea);
  await expect(focused.outlineStyle, 'keyboard focus adds a visible cue').toBe('solid');
  await expect(Number.parseFloat(focused.outlineWidth), 'focus changes the field outline').toBeGreaterThan(visibleOutlineWidth);
  await expectControlBoundary(textarea);
}

export const EmptyFields: Story = {
  globals: { theme: 'light', viewport: { value: 'desktop1440' } },
  render: () => (
    <div className="flex flex-col gap-4">
      {['bg-background', 'bg-card', 'bg-muted'].map(surface => (
        <div className={`rounded-2xl border p-4 ${surface}`} key={surface}>
          <Field>
            <FieldLabel>Your review</FieldLabel>
            <Textarea autoComplete="off" />
          </Field>
        </div>
      ))}
    </div>
  ),
  async play({ canvasElement }) {
    const textareas = within(canvasElement).getAllByRole('textbox');
    await expect(textareas).toHaveLength(3);
    for (const textarea of textareas) {
      await expect(textarea).toBeEnabled();
      await expect(textarea).toHaveValue('');
      await expect(textarea).not.toHaveAttribute('placeholder');
      await expectControlBoundary(textarea);
      await userEvent.hover(textarea);
      await settled(textarea);
      await expect(textarea).not.toHaveFocus();
      await expectControlBoundary(textarea);
      await userEvent.unhover(textarea);
      await expectTextareaKeyboardFocus(textarea);
    }
    await userEvent.type(textareas.at(-1)!, 'A slow burn that pays off.');
    await expect(textareas.at(-1)!).toHaveValue('A slow burn that pays off.');
  },
};

export const EmptyFieldsDark: Story = {
  ...EmptyFields, globals: { theme: 'dark', viewport: { value: 'desktop1440' } },
};

export const EmptyFieldsPhone: Story = {
  ...EmptyFields, globals: { theme: 'light', viewport: { value: 'phone' } },
};

export const EmptyFieldsDarkPhone: Story = {
  ...EmptyFields, globals: { theme: 'dark', viewport: { value: 'phone' } },
};

export const InvalidFields: Story = {
  globals: { theme: 'light', viewport: { value: 'desktop1440' } },
  render: () => (
    <div className="flex flex-col gap-4">
      <Field invalid>
        <FieldLabel>Your review</FieldLabel>
        <Textarea defaultValue="" />
        <FieldError>Write a review before submitting.</FieldError>
      </Field>
      <Field invalid>
        <FieldLabel>Updated review</FieldLabel>
        <Textarea defaultValue="Too short" />
        <FieldError>Reviews need at least 50 characters. Add a few more thoughts.</FieldError>
      </Field>
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textareas = canvas.getAllByRole('textbox');
    await expect(textareas).toHaveLength(2);
    await expect(textareas[0]!).toHaveAccessibleErrorMessage('Write a review before submitting.');
    await expect(textareas[1]!).toHaveAccessibleErrorMessage(/at least 50 characters/);
    for (const textarea of textareas) {
      await expectInvalidFieldKeyboardFocus(textarea);
    }
    await expect(canvas.getByText('Write a review before submitting.')).toBeVisible();
    await expect(canvas.getByText(/Reviews need at least 50 characters/)).toBeVisible();
  },
};

export const InvalidFieldsDark: Story = {
  ...InvalidFields, globals: { theme: 'dark', viewport: { value: 'desktop1440' } },
};

export const InvalidFieldsPhone: Story = {
  ...InvalidFields, globals: { theme: 'light', viewport: { value: 'phone' } },
};

export const InvalidFieldsDarkPhone: Story = {
  ...InvalidFields, globals: { theme: 'dark', viewport: { value: 'phone' } },
};

export const Availability: Story = {
  globals: { theme: 'light', viewport: { value: 'desktop1440' } },
  render: () => (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel>Original review (read-only)</FieldLabel>
        <Textarea defaultValue="A slow burn that pays off." readOnly />
        <FieldHelper>Moderators can quote but not edit a reader’s review.</FieldHelper>
      </Field>
      <Field disabled>
        <FieldLabel>Review unavailable</FieldLabel>
        <Textarea defaultValue="Reviews are closed while this Work is under moderation." />
      </Field>
      <Field>
        <FieldLabel>Moderator note</FieldLabel>
        <Textarea />
      </Field>
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const original = canvas.getByRole('textbox', { name: 'Original review (read-only)' });
    const unavailable = canvas.getByRole('textbox', { name: 'Review unavailable' });
    const note = canvas.getByRole('textbox', { name: 'Moderator note' });
    await expect(original).toBeEnabled();
    await expect(original).toHaveAttribute('readonly');
    await expect(unavailable).toBeDisabled();
    await expectControlBoundary(original);
    await expectTextareaKeyboardFocus(original);
    await userEvent.type(original, 'Changed');
    await expect(original).toHaveValue('A slow burn that pays off.');
    await userEvent.tab();
    await expect(note).toHaveFocus();
    await expect(unavailable).not.toHaveFocus();
    await expect(unavailable).toHaveValue('Reviews are closed while this Work is under moderation.');
    await userEvent.type(note, 'Check the cited passage.');
    await expect(note).toHaveValue('Check the cited passage.');
  },
};

export const AvailabilityDark: Story = {
  ...Availability, globals: { theme: 'dark', viewport: { value: 'desktop1440' } },
};

export const AvailabilityPhone: Story = {
  ...Availability, globals: { theme: 'light', viewport: { value: 'phone' } },
};

export const AvailabilityDarkPhone: Story = {
  ...Availability, globals: { theme: 'dark', viewport: { value: 'phone' } },
};
