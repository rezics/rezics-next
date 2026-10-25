import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Field, FieldError, FieldHelper, FieldLabel } from './field.tsx';
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from './native-select.tsx';

const shelves = (
  <>
    <NativeSelectOption value="">Choose a shelf</NativeSelectOption>
    <NativeSelectOption value="want">Want to read</NativeSelectOption>
    <NativeSelectOption value="reading">Currently reading</NativeSelectOption>
    <NativeSelectOption value="read">Read</NativeSelectOption>
    <NativeSelectOption value="dnf">Did not finish</NativeSelectOption>
  </>
);

const meta = {
  title: 'Rezics UI/Native Select',
  component: NativeSelect,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'A styled browser `<select>` for the Accounts app. It uses the platform picker on phones. The main web app uses the Ark UI Select or Menu so choice controls look consistent across browsers and themes.',
      },
    },
  },
  args: { defaultValue: '' },
  decorators: [
    (Story, { parameters }) => (
      <div>
        <div className="min-h-40 bg-background p-6 font-sans text-foreground">
          <div className="flex max-w-xs flex-col gap-4">
            <Story />
          </div>
        </div>
      </div>
    ),
  ],
  render: (args) => (
    <Field>
      <FieldLabel>Shelf</FieldLabel>
      <NativeSelect {...args}>{shelves}</NativeSelect>
      <FieldHelper>Shelves are public unless you make them private.</FieldHelper>
    </Field>
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
    await expect(
      within(canvasElement).getByRole('option', { name: 'Currently reading' }),
    ).toHaveProperty('selected', true);
  },
};

export const Selected: Story = { args: { defaultValue: 'read' } };

export const Grouped: Story = {
  args: { defaultValue: 'zh' },
  render: (args) => (
    <Field>
      <FieldLabel>Original language</FieldLabel>
      <NativeSelect {...args}>
        <NativeSelectOptGroup label="Most catalogued">
          <NativeSelectOption value="en">English</NativeSelectOption>
          <NativeSelectOption value="zh">中文 (Chinese)</NativeSelectOption>
          <NativeSelectOption value="ja">日本語 (Japanese)</NativeSelectOption>
        </NativeSelectOptGroup>
        <NativeSelectOptGroup label="Other">
          <NativeSelectOption value="ko">한국어 (Korean)</NativeSelectOption>
          <NativeSelectOption value="ru">Русский (Russian)</NativeSelectOption>
        </NativeSelectOptGroup>
      </NativeSelect>
    </Field>
  ),
};

export const Sizes: Story = {
  render: (args) => (
    <>
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <Field key={size}>
          <FieldLabel>Shelf ({size})</FieldLabel>
          <NativeSelect {...args} defaultValue="want" size={size}>
            {shelves}
          </NativeSelect>
        </Field>
      ))}
    </>
  ),
};

export const Invalid: Story = {
  render: (args) => (
    <Field invalid>
      <FieldLabel>Report category</FieldLabel>
      <NativeSelect {...args}>
        <NativeSelectOption value="">Choose a category</NativeSelectOption>
        <NativeSelectOption value="spam">Spam</NativeSelectOption>
        <NativeSelectOption value="spoiler">Unmarked spoiler</NativeSelectOption>
      </NativeSelect>
      <FieldError>Choose a category so the report reaches the right moderators.</FieldError>
    </Field>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('combobox')).toBeInvalid();
  },
};

export const Disabled: Story = {
  args: { defaultValue: 'read' },
  render: (args) => (
    <Field disabled>
      <FieldLabel>Shelf</FieldLabel>
      <NativeSelect {...args}>{shelves}</NativeSelect>
      <FieldHelper>Sign in to shelve Works.</FieldHelper>
    </Field>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('combobox')).toBeDisabled();
  },
};

export const Chinese: Story = {
  args: { defaultValue: 'reading' },
  render: (args) => (
    <Field>
      <FieldLabel>书架</FieldLabel>
      <NativeSelect {...args}>
        <NativeSelectOption value="want">想读</NativeSelectOption>
        <NativeSelectOption value="reading">在读 · 《三体Ⅱ：黑暗森林》</NativeSelectOption>
        <NativeSelectOption value="read">读过</NativeSelectOption>
      </NativeSelect>
    </Field>
  ),
};

export const LongOption: Story = {
  args: { defaultValue: 'long' },
  render: (args) => (
    <Field>
      <FieldLabel>Edition</FieldLabel>
      <NativeSelect {...args}>
        <NativeSelectOption value="long">
          The Three-Body Problem (Remembrance of Earth’s Past, Book 1), Tor Books hardcover, 2014,
          translated by Ken Liu
        </NativeSelectOption>
        <NativeSelectOption value="short">三体 (重庆出版社, 2008)</NativeSelectOption>
      </NativeSelect>
    </Field>
  ),
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  render: (args, context) => (
    <>
      {meta.render({ ...args, defaultValue: 'reading' })}
      {meta.render(args)}
      {Invalid.render?.(args, context)}
      {Disabled.render?.({ ...args, defaultValue: 'read' }, context)}
    </>
  ),
};
