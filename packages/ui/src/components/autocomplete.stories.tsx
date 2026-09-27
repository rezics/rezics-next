import { useListCollection } from '@ark-ui/react/combobox';
import { useFilter } from '@ark-ui/react/locale';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { SearchIcon } from 'lucide-react';
import { useEffect } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { cn } from '../utils.ts';
import {
  Autocomplete,
  AutocompleteContent,
  AutocompleteEmpty,
  AutocompleteGroup,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
} from './autocomplete.tsx';
import { Field, FieldError, FieldHelper, FieldLabel } from './field.tsx';
import { InputGroupAddon } from './input-group.tsx';

interface Suggestion {
  value: string;
  label: string;
  kind: 'Recent searches' | 'Works' | 'Realms';
}

const suggestions: Suggestion[] = [
  { value: 'dark forest theory', label: 'dark forest theory', kind: 'Recent searches' },
  { value: '三体 英文版 翻译', label: '三体 英文版 翻译', kind: 'Recent searches' },
  { value: 'The Three-Body Problem', label: 'The Three-Body Problem', kind: 'Works' },
  { value: '银河英雄传说', label: '银河英雄传说', kind: 'Works' },
  { value: 'Dune Messiah', label: 'Dune Messiah', kind: 'Works' },
  { value: 'r/scifi', label: 'r/scifi', kind: 'Realms' },
  { value: 'r/科幻', label: 'r/科幻', kind: 'Realms' },
];

const SearchBox = ({
  label = 'Search REZICS',
  placeholder = 'Works, Realms or anything',
  invalid = false,
  disabled = false,
  defaultOpen,
  defaultInputValue,
}: {
  label?: string;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
  defaultOpen?: boolean;
  defaultInputValue?: string;
}) => {
  const { contains } = useFilter({ sensitivity: 'base' });
  const { collection, filter } = useListCollection({
    initialItems: suggestions,
    filter: contains,
    groupBy: (item) => item.kind,
  });
  // Filtering runs on input changes, so apply a preset input value once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once with the initial text
  useEffect(() => filter(defaultInputValue ?? ''), []);

  return (
    <Field disabled={disabled} invalid={invalid}>
      <FieldLabel>{label}</FieldLabel>
      <Autocomplete
        collection={collection}
        defaultInputValue={defaultInputValue}
        defaultOpen={defaultOpen}
        onInputValueChange={({ inputValue }) => filter(inputValue)}
      >
        <AutocompleteInput placeholder={placeholder} showClear>
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
        </AutocompleteInput>
        <AutocompleteContent>
          <AutocompleteEmpty>Press Enter to search for this text.</AutocompleteEmpty>
          <AutocompleteList>
            {collection.group().map(([kind, items]) => (
              <AutocompleteGroup heading={kind} key={kind}>
                {items.map((item) => (
                  <AutocompleteItem item={item} key={item.value} showIndicator={false}>
                    {item.label}
                  </AutocompleteItem>
                ))}
              </AutocompleteGroup>
            ))}
          </AutocompleteList>
        </AutocompleteContent>
      </Autocomplete>
      {invalid ? (
        <FieldError>Search needs at least two characters.</FieldError>
      ) : (
        <FieldHelper>Suggestions match titles in any script.</FieldHelper>
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

// storybook/test types faster than a real keyboard; a key typed while the popup is
// opening can be lost, so wait for the popup after the first character.
const typeIntoPopup = async (input: HTMLElement, text: string) => {
  await userEvent.type(input, text.slice(0, 1));
  await waitFor(() => expect(input).toHaveAttribute('aria-expanded', 'true'));
  await userEvent.type(input, text.slice(1));
};

const meta = {
  title: 'Rezics UI/Autocomplete',
  component: SearchBox,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'A free-text input with suggestions: the reader may pick a suggestion or keep what they typed, and arrow keys preview suggestions in the input. In REZICS use it for the global search box (recent searches, Works and Realms), post tags that may not exist yet, and a Work’s alternative titles. Use Combobox when only listed values are valid.',
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
} satisfies Meta<typeof SearchBox>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const input = canvas.getByRole('combobox', { name: 'Search REZICS' });
    await typeIntoPopup(input, 'dune');
    await waitFor(() => expect(page.getAllByRole('option')).toHaveLength(1));
    await userEvent.click(page.getByRole('option', { name: 'Dune Messiah' }));
    await waitFor(() => expect(input).toHaveValue('Dune Messiah'));
  },
};

export const FreeText: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const input = canvas.getByRole('combobox', { name: 'Search REZICS' });
    await typeIntoPopup(input, 'Solaris Lem');
    await expect(await page.findByText('Press Enter to search for this text.')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await expect(input).toHaveValue('Solaris Lem');
  },
};

export const Open: Story = { args: { defaultOpen: true } };

export const Filtered: Story = { args: { defaultOpen: true, defaultInputValue: '三体' } };

export const Invalid: Story = { args: { invalid: true, defaultInputValue: 'a' } };

export const Disabled: Story = {
  args: { disabled: true },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('combobox')).toBeDisabled();
  },
};

export const Chinese: Story = {
  args: {
    label: '搜索 REZICS',
    placeholder: '作品、Realm 或任意内容',
    defaultOpen: true,
    defaultInputValue: '科幻',
  },
};

export const Dark: Story = { parameters: { theme: 'dark' }, args: { defaultOpen: true } };
