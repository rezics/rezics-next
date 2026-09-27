import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { Field, FieldError, FieldHelper, FieldLabel } from './field.tsx';
import { TagsInput, TagsInputContext, TagsInputItem } from './tags-input.tsx';

const meta = {
  title: 'Rezics UI/Tags Input',
  component: TagsInput,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'A field that turns typed text into removable tags on Enter or comma, with Backspace and arrow keys to select and delete tags. In REZICS use it for a post’s topic tags, a Work’s alternative titles and keywords, and blocked words in Realm settings. Render the current values as `TagsInputItem`s through `TagsInputContext`; set `max` and `validate` for limits.',
      },
    },
  },
  args: { defaultValue: ['hard-sf', '三体', 'first-contact'], placeholder: 'Add a tag' },
  decorators: [
    (Story, { parameters }) => (
      <div className={cn(parameters.theme === 'dark' && 'dark')}>
        <div className="min-h-40 bg-background p-6 font-sans text-foreground">
          <div className="flex max-w-md flex-col gap-4">
            <Story />
          </div>
        </div>
      </div>
    ),
  ],
  render: (args) => (
    <Field>
      <FieldLabel>Topic tags</FieldLabel>
      <TagsInput {...args}>
        <TagsInputContext>
          {({ value }) =>
            value.map((tag, index) => (
              <TagsInputItem index={index} key={tag} value={tag}>
                {tag}
              </TagsInputItem>
            ))
          }
        </TagsInputContext>
      </TagsInput>
      <FieldHelper>Press Enter or comma to add a tag. Up to 5 tags.</FieldHelper>
    </Field>
  ),
} satisfies Meta<typeof TagsInput>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const input = canvas.getByRole('textbox', { name: 'Topic tags' });
    await userEvent.type(input, 'dark-forest{Enter}');
    await waitFor(() => expect(canvas.getByText('dark-forest')).toBeInTheDocument());
  },
};

export const RemoveTag: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const deletes = canvas.getAllByRole('button', { name: /delete tag/i });
    await userEvent.click(deletes[1] as HTMLElement);
    await waitFor(() => expect(canvas.queryByText('三体')).not.toBeInTheDocument());
    await userEvent.click(canvas.getByRole('button', { name: 'Clear all tags' }));
    await waitFor(() => expect(canvas.queryByText('hard-sf')).not.toBeInTheDocument());
  },
};

export const Empty: Story = { args: { defaultValue: [] } };

export const Limit: Story = {
  args: { max: 5, defaultValue: ['hard-sf', '三体', 'first-contact', 'aliens', 'physics'] },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: 'Topic tags' }), 'one-more{Enter}');
    await expect(canvas.queryByText('one-more')).not.toBeInTheDocument();
  },
};

export const Sizes: Story = {
  render: (args) => (
    <>
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <Field key={size}>
          <FieldLabel>Tags ({size})</FieldLabel>
          <TagsInput {...args} size={size}>
            <TagsInputContext>
              {({ value }) =>
                value.map((tag, index) => (
                  <TagsInputItem index={index} key={tag} value={tag}>
                    {tag}
                  </TagsInputItem>
                ))
              }
            </TagsInputContext>
          </TagsInput>
        </Field>
      ))}
    </>
  ),
};

export const Invalid: Story = {
  args: { defaultValue: ['hard-sf', 'spoilers-ending'] },
  render: (args) => (
    <Field invalid>
      <FieldLabel>Topic tags</FieldLabel>
      <TagsInput {...args}>
        <TagsInputContext>
          {({ value }) =>
            value.map((tag, index) => (
              <TagsInputItem index={index} key={tag} value={tag}>
                {tag}
              </TagsInputItem>
            ))
          }
        </TagsInputContext>
      </TagsInput>
      <FieldError>“spoilers-ending” is a blocked tag in this Realm.</FieldError>
    </Field>
  ),
};

export const Disabled: Story = {
  args: { disabled: true },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('textbox', { name: 'Topic tags' })).toBeDisabled();
  },
};

export const LongTags: Story = {
  args: {
    defaultValue: [
      'remembrance-of-earths-past',
      '地球往事三部曲',
      'the-three-body-problem-netflix-adaptation-discussion',
      'Ken Liu translation',
      'wallfacer',
      '面壁者',
    ],
  },
};

export const Chinese: Story = {
  args: { defaultValue: ['科幻', '硬科幻', '刘慈欣', '黑暗森林法则'], placeholder: '添加标签' },
  render: (args) => (
    <Field>
      <FieldLabel>话题标签</FieldLabel>
      <TagsInput {...args}>
        <TagsInputContext>
          {({ value }) =>
            value.map((tag, index) => (
              <TagsInputItem index={index} key={tag} value={tag}>
                {tag}
              </TagsInputItem>
            ))
          }
        </TagsInputContext>
      </TagsInput>
      <FieldHelper>按回车或逗号添加标签。</FieldHelper>
    </Field>
  ),
};

export const Dark: Story = {
  parameters: { theme: 'dark' },
  render: (args, context) => (
    <>
      {meta.render(args)}
      {Invalid.render?.({ ...args, defaultValue: ['hard-sf', 'spoilers-ending'] }, context)}
    </>
  ),
};
