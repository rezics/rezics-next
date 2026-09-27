import { useListCollection } from '@ark-ui/react/combobox';
import { useFilter } from '@ark-ui/react/locale';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { cn } from '../utils.ts';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from './combobox.tsx';
import { Field, FieldError, FieldHelper, FieldLabel } from './field.tsx';

interface Work {
  value: string;
  label: string;
  author: string;
  kind: 'Novel' | 'Series' | 'Manga';
  disabled?: boolean;
}

const works: Work[] = [
  {
    value: 'three-body',
    label: '三体 · The Three-Body Problem',
    author: 'Liu Cixin',
    kind: 'Novel',
  },
  { value: 'dark-forest', label: '黑暗森林 · The Dark Forest', author: 'Liu Cixin', kind: 'Novel' },
  { value: 'deaths-end', label: '死神永生 · Death’s End', author: 'Liu Cixin', kind: 'Novel' },
  {
    value: 'loghe',
    label: '银河英雄传说 · Legend of the Galactic Heroes',
    author: 'Yoshiki Tanaka',
    kind: 'Series',
  },
  { value: 'dune', label: 'Dune', author: 'Frank Herbert', kind: 'Novel' },
  { value: 'planetes', label: 'Planetes', author: 'Makoto Yukimura', kind: 'Manga' },
  {
    value: 'foundation',
    label: 'Foundation',
    author: 'Isaac Asimov',
    kind: 'Series',
    disabled: true,
  },
];

const WorkPicker = ({
  label = 'Related Work',
  items = works,
  grouped = false,
  multiple = false,
  invalid = false,
  disabled = false,
  defaultValue,
  defaultOpen,
  placeholder = 'Search by title or author',
}: {
  label?: string;
  items?: Work[];
  grouped?: boolean;
  multiple?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  defaultValue?: string[];
  defaultOpen?: boolean;
  placeholder?: string;
}) => {
  const { contains } = useFilter({ sensitivity: 'base' });
  const { collection, filter } = useListCollection({
    initialItems: items,
    filter: (text, query, item) => contains(text, query) || contains(item.author, query),
    groupBy: grouped ? (item) => item.kind : undefined,
  });

  const renderItem = (item: Work) => (
    <ComboboxItem item={item} key={item.value}>
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{item.label}</span>
        <span className="text-muted-foreground text-xs">{item.author}</span>
      </span>
    </ComboboxItem>
  );

  return (
    <Field disabled={disabled} invalid={invalid}>
      <FieldLabel>{label}</FieldLabel>
      <Combobox
        collection={collection}
        defaultOpen={defaultOpen}
        defaultValue={defaultValue}
        multiple={multiple}
        onInputValueChange={({ inputValue }) => filter(inputValue)}
      >
        <ComboboxInput placeholder={placeholder} showClear />
        <ComboboxContent>
          <ComboboxEmpty>No Works match. Try the original title.</ComboboxEmpty>
          <ComboboxList>
            {grouped
              ? collection.group().map(([kind, group]) => (
                  <ComboboxGroup heading={kind} key={kind}>
                    {group.map(renderItem)}
                  </ComboboxGroup>
                ))
              : collection.items.map(renderItem)}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      {invalid ? (
        <FieldError>Pick the Work this edition belongs to.</FieldError>
      ) : (
        <FieldHelper>Links this edition to an existing Work in the catalogue.</FieldHelper>
      )}
    </Field>
  );
};

// Popups render in a portal on <body>, outside the story's .dark wrapper, so the dark
// story also marks <html> while it is shown on its own.
const Surface = ({
  dark,
  page,
  children,
}: {
  dark: boolean;
  page: boolean;
  children: React.ReactNode;
}) => {
  useEffect(() => {
    if (!page) return;
    document.documentElement.classList.add('dark');
    return () => document.documentElement.classList.remove('dark');
  }, [page]);
  return (
    <div className={cn(dark && 'dark')}>
      <div className="min-h-[28rem] bg-background p-6 font-sans text-foreground">
        <div className="flex max-w-sm flex-col gap-4">{children}</div>
      </div>
    </div>
  );
};

const meta = {
  title: 'Rezics UI/Combobox',
  component: WorkPicker,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'A text input that filters a list of options as you type and lets you pick one or several. In REZICS use it wherever the list is too long to scan: linking an edition to a Work, choosing the Realm to post in, adding authors or translators in the Work editor. Build the collection with `useListCollection` and filter it in `onInputValueChange`; match authors and original-script titles as well as English ones. Use Autocomplete when free text is also a valid answer.',
      },
    },
  },
  decorators: [
    (Story, { parameters, viewMode }) => (
      <Surface
        dark={parameters.theme === 'dark'}
        page={parameters.theme === 'dark' && viewMode === 'story'}
      >
        <Story />
      </Surface>
    ),
  ],
} satisfies Meta<typeof WorkPicker>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const input = canvas.getByRole('combobox', { name: 'Related Work' });
    await userEvent.type(input, 'liu');
    await waitFor(() => expect(page.getAllByRole('option')).toHaveLength(3));
    await userEvent.click(page.getByRole('option', { name: /黑暗森林/ }));
    await waitFor(() => expect(input).toHaveValue('黑暗森林 · The Dark Forest'));
  },
};

export const Keyboard: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const input = canvas.getByRole('combobox', { name: 'Related Work' });
    await userEvent.type(input, '银河');
    await waitFor(() => expect(page.getAllByRole('option')).toHaveLength(1));
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(input).toHaveValue('银河英雄传说 · Legend of the Galactic Heroes'));
    await userEvent.keyboard('{Escape}');
  },
};

export const NoResults: Story = {
  async play({ canvasElement }) {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.type(within(canvasElement).getByRole('combobox'), 'Solaris');
    await expect(
      await page.findByText('No Works match. Try the original title.'),
    ).toBeInTheDocument();
  },
};

export const Open: Story = { args: { defaultOpen: true, defaultValue: ['three-body'] } };

export const Grouped: Story = { args: { grouped: true, defaultOpen: true } };

export const Multiple: Story = {
  args: {
    multiple: true,
    label: 'Works in this list',
    defaultValue: ['three-body', 'dune'],
    defaultOpen: true,
  },
};

export const Invalid: Story = { args: { invalid: true } };

export const Disabled: Story = {
  args: { disabled: true, defaultValue: ['dune'] },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('combobox')).toBeDisabled();
  },
};

export const Chinese: Story = {
  args: { label: '关联作品', placeholder: '按书名或作者搜索', defaultOpen: true },
};

export const Dark: Story = {
  parameters: { theme: 'dark' },
  args: { defaultOpen: true, defaultValue: ['dark-forest'] },
};
