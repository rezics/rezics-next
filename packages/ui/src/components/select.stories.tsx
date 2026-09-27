import { createListCollection } from '@ark-ui/react/select';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { BookCheckIcon, BookMarkedIcon, BookOpenIcon, BookXIcon } from 'lucide-react';
import { Fragment } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Field, FieldError, FieldHelper, FieldLabel } from './field.tsx';
import {
  Select,
  SelectContent,
  SelectEmpty,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './select.tsx';

const shelves = createListCollection({
  items: [
    { value: 'want', label: 'Want to read', icon: BookMarkedIcon },
    { value: 'reading', label: 'Currently reading', icon: BookOpenIcon },
    { value: 'read', label: 'Read', icon: BookCheckIcon },
    { value: 'dnf', label: 'Did not finish', icon: BookXIcon, disabled: true },
  ],
});

const genres = createListCollection({
  items: [
    { value: 'hard-sf', label: 'Hard science fiction', group: 'Science fiction' },
    { value: 'space-opera', label: 'Space opera', group: 'Science fiction' },
    { value: 'wuxia', label: 'Wuxia 武侠', group: 'Fantasy' },
    { value: 'xianxia', label: 'Xianxia 仙侠', group: 'Fantasy' },
    { value: 'mystery', label: 'Mystery', group: 'Other' },
  ],
  groupBy: (item) => item.group,
});

const chineseShelves = createListCollection({
  items: [
    { value: 'want', label: '想读' },
    { value: 'reading', label: '在读 · 《三体Ⅲ：死神永生》' },
    { value: 'read', label: '读过' },
  ],
});

const editions = createListCollection({
  items: [
    {
      value: 'tor',
      label:
        'The Three-Body Problem (Remembrance of Earth’s Past, Book 1), Tor Books hardcover, translated by Ken Liu, 2014',
    },
    { value: 'cq', label: '三体 · 重庆出版社 · 2008' },
  ],
});

const noShelves = createListCollection<{ value: string; label: string }>({ items: [] });

const Surface = ({ children }: { children: React.ReactNode }) => {
  return (
    <div>
      <div className="min-h-96 bg-background p-6 font-sans text-foreground">
        <div className="flex max-w-xs flex-col gap-4">{children}</div>
      </div>
    </div>
  );
};

const meta = {
  title: 'Rezics UI/Select',
  component: Select,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'A custom listbox for picking one or more values from a short, known list, with icons, groups and full keyboard support. In REZICS use it for the shelf picker on a Work, genre and content-rating fields in the Work editor, and sort orders on Realm feeds. Pass a `createListCollection` collection; use Native Select for plain lists in forms and Combobox when the list is long enough to search.',
      },
    },
  },
  args: { collection: shelves },
  decorators: [
    (Story) => (
      <Surface>
        <Story />
      </Surface>
    ),
  ],
  render: (args) => (
    <Field>
      <FieldLabel>Shelf</FieldLabel>
      <Select {...args}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Choose a shelf" />
        </SelectTrigger>
        <SelectContent>
          {shelves.items.map(({ value, label, icon: Icon, disabled }) => (
            <SelectItem item={{ value, label, disabled }} key={value}>
              <Icon aria-hidden />
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldHelper>《三体》 · Liu Cixin</FieldHelper>
    </Field>
  ),
} satisfies Meta<typeof Select<(typeof shelves.items)[number]>>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const trigger = canvas.getByRole('combobox', { name: 'Shelf' });
    await userEvent.click(trigger);
    const listbox = await page.findByRole('listbox');
    await waitFor(() => expect(listbox).toBeVisible(), { timeout: 3000 });
    await userEvent.click(page.getByRole('option', { name: 'Currently reading' }));
    await waitFor(() => expect(page.queryByRole('listbox')).not.toBeInTheDocument());
    await expect(trigger).toHaveTextContent('Currently reading');
  },
};

export const Keyboard: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const trigger = canvas.getByRole('combobox', { name: 'Shelf' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const listbox = await page.findByRole('listbox');
    await waitFor(() => expect(listbox).toBeVisible(), { timeout: 3000 });
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    await waitFor(() => expect(trigger).toHaveTextContent('Read'));
  },
};

export const Open: Story = {
  args: { defaultValue: ['reading'], defaultOpen: true },
};

export const Grouped: Story = {
  args: { defaultValue: ['wuxia'], defaultOpen: true },
  render: ({ defaultValue, defaultOpen, multiple }) => (
    <Field>
      <FieldLabel>Genre</FieldLabel>
      <Select
        collection={genres}
        defaultOpen={defaultOpen}
        defaultValue={defaultValue}
        multiple={multiple}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Choose a genre" />
        </SelectTrigger>
        <SelectContent>
          {genres.group().map(([group, items], index) => (
            <Fragment key={group}>
              {index > 0 && <SelectSeparator />}
              <SelectGroup heading={group}>
                {items.map((item) => (
                  <SelectItem item={item} key={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </Fragment>
          ))}
        </SelectContent>
      </Select>
    </Field>
  ),
  async play({ canvasElement }) {
    const page = within(canvasElement.ownerDocument.body);
    const label = await page.findByText('Fantasy');
    await waitFor(() => expect(label).toBeVisible());
  },
};

export const Multiple: Story = {
  args: { multiple: true, defaultValue: ['hard-sf', 'wuxia'] },
  render: ({ defaultValue, defaultOpen, multiple }) => (
    <Field>
      <FieldLabel>Genres</FieldLabel>
      <Select
        collection={genres}
        defaultOpen={defaultOpen}
        defaultValue={defaultValue}
        multiple={multiple}
      >
        <SelectTrigger className="w-full" showClear>
          <SelectValue placeholder="Any genre" />
        </SelectTrigger>
        <SelectContent>
          {genres.items.map((item) => (
            <SelectItem item={item} key={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldHelper>Pick up to three genres for this Work.</FieldHelper>
    </Field>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Clear selected value(s)' }));
    await expect(canvas.getByRole('combobox', { name: 'Genres' })).toHaveTextContent('Any genre');
  },
};

export const EmptyList: Story = {
  args: { defaultOpen: true },
  render: ({ defaultValue, defaultOpen, multiple }) => (
    <>
      <Select collection={noShelves} defaultOpen={defaultOpen}>
        <SelectLabel>Custom shelf</SelectLabel>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Choose a shelf" />
        </SelectTrigger>
        <SelectContent>
          <SelectEmpty>You have no custom shelves yet.</SelectEmpty>
        </SelectContent>
      </Select>
    </>
  ),
};

export const Sizes: Story = {
  render: (args) => (
    <>
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <Field key={size}>
          <FieldLabel>Shelf ({size})</FieldLabel>
          <Select {...args} defaultValue={['want']}>
            <SelectTrigger className="w-full" size={size}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {shelves.items.map((item) => (
                <SelectItem item={item} key={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ))}
    </>
  ),
};

export const Invalid: Story = {
  render: (args) => (
    <Field invalid>
      <FieldLabel>Shelf</FieldLabel>
      <Select {...args}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Choose a shelf" />
        </SelectTrigger>
        <SelectContent>
          {shelves.items.map((item) => (
            <SelectItem item={item} key={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldError>Choose a shelf before writing a review.</FieldError>
    </Field>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('combobox')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  },
};

export const Disabled: Story = {
  args: { disabled: true, defaultValue: ['read'] },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('combobox')).toBeDisabled();
  },
};

export const Chinese: Story = {
  args: { defaultValue: ['reading'], defaultOpen: true },
  render: ({ defaultValue, defaultOpen }) => (
    <Field>
      <FieldLabel>书架</FieldLabel>
      <Select collection={chineseShelves} defaultOpen={defaultOpen} defaultValue={defaultValue}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="选择书架" />
        </SelectTrigger>
        <SelectContent>
          {chineseShelves.items.map((item) => (
            <SelectItem item={item} key={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  ),
};

export const LongContent: Story = {
  args: { defaultValue: ['tor'], defaultOpen: true },
  render: ({ defaultValue, defaultOpen }) => (
    <Field>
      <FieldLabel>Edition</FieldLabel>
      <Select collection={editions} defaultOpen={defaultOpen} defaultValue={defaultValue}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-w-xs">
          {editions.items.map((item) => (
            <SelectItem item={item} key={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  ),
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  args: { defaultValue: ['reading'], defaultOpen: true },
};
