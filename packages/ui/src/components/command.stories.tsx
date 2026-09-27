import { createListCollection, useListCollection } from '@ark-ui/react/collection';
import { useFilter } from '@ark-ui/react/locale';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { BookOpenIcon, InboxIcon, PenSquareIcon, SearchIcon, UsersIcon } from 'lucide-react';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { settled, withSurface } from '../stories/support.tsx';
import { Button } from './button.tsx';
import {
  Command,
  CommandContent,
  CommandDialog,
  CommandDialogContent,
  CommandDialogTrigger,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from './command.tsx';
import { Kbd } from './kbd.tsx';

interface Entry {
  value: string;
  label: string;
  group: string;
  hint?: string;
  shortcut?: string;
  icon?: React.ReactNode;
}

const entries: Entry[] = [
  {
    value: 'work:three-body',
    label: 'The Three-Body Problem',
    group: 'Works',
    hint: 'Liu Cixin · 2006',
    icon: <BookOpenIcon />,
  },
  {
    value: 'work:dark-forest',
    label: 'The Dark Forest',
    group: 'Works',
    hint: 'Liu Cixin · 2008',
    icon: <BookOpenIcon />,
  },
  {
    value: 'work:death-end',
    label: 'Death’s End',
    group: 'Works',
    hint: 'Liu Cixin · 2010',
    icon: <BookOpenIcon />,
  },
  {
    value: 'work:santi',
    label: '三体',
    group: 'Works',
    hint: '刘慈欣 · 重庆出版社',
    icon: <BookOpenIcon />,
  },
  {
    value: 'realm:hard-sf',
    label: 'Hard SF',
    group: 'Realms',
    hint: '18.2k members',
    icon: <UsersIcon />,
  },
  {
    value: 'realm:translated',
    label: 'Translated Fiction',
    group: 'Realms',
    hint: '6.4k members',
    icon: <UsersIcon />,
  },
  {
    value: 'action:post',
    label: 'Create a post',
    group: 'Actions',
    shortcut: 'C',
    icon: <PenSquareIcon />,
  },
  {
    value: 'action:inbox',
    label: 'Go to Inbox',
    group: 'Actions',
    shortcut: 'G I',
    icon: <InboxIcon />,
  },
];

// Typing faster than the combobox re-renders its controlled input drops keys, as no reader would.
const typist = userEvent.setup({ delay: 30 });

const Palette = (props: {
  onValueChange?: (details: { value: string[] }) => void;
  className?: string;
  placeholder?: string;
  emptyText?: string;
  footer?: boolean;
}) => {
  const { contains } = useFilter({ sensitivity: 'base' });
  const { collection, filter } = useListCollection({
    initialItems: entries,
    filter: contains,
    groupBy: (item) => item.group,
  });

  return (
    <Command
      className={props.className}
      collection={collection}
      onInputValueChange={(details) => filter(details.inputValue)}
      onValueChange={props.onValueChange}
    >
      <CommandInput
        aria-label="Search REZICS"
        placeholder={props.placeholder ?? 'Search Works, Realms and actions'}
      />
      <CommandEmpty>{props.emptyText}</CommandEmpty>
      <CommandContent>
        <CommandList>
          {collection.group().map(([group, items]) => (
            <CommandGroup key={group}>
              <CommandGroupLabel>{group}</CommandGroupLabel>
              {items.map((item) => (
                <CommandItem item={item} key={item.value}>
                  {item.icon}
                  <span className="truncate">{item.label}</span>
                  {item.hint ? (
                    <span className="truncate text-muted-foreground text-xs">{item.hint}</span>
                  ) : null}
                  {item.shortcut ? <CommandShortcut>{item.shortcut}</CommandShortcut> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </CommandContent>
      {props.footer === false ? null : (
        <CommandFooter>
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> to move · <Kbd>↵</Kbd> to open
          </span>
          <span>
            <Kbd>Esc</Kbd> to close
          </span>
        </CommandFooter>
      )}
    </Command>
  );
};

const meta = {
  title: 'Rezics UI/Command',
  component: Command,
  tags: ['autodocs'],
  decorators: [withSurface],
  // Stories build their own filtered collection; this one only satisfies the required prop.
  args: { collection: createListCollection<unknown>({ items: entries }), onValueChange: fn() },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 520 },
    },
  },
} satisfies Meta<typeof Command>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Inline: Story = {
  render: (args) => <Palette className="max-w-lg" onValueChange={args.onValueChange} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    await expect(canvas.getByRole('combobox', { name: 'Search REZICS' })).toBeInTheDocument();
    await expect(canvas.getByRole('option', { name: /The Three-Body Problem/ })).toBeVisible();
  },
};

export const Filter: Story = {
  render: Inline.render,
  async play({ args, canvasElement }) {
    const canvas = within(canvasElement);
    const input = canvas.getByRole('combobox', { name: 'Search REZICS' });
    await typist.type(input, 'forest');
    await expect(input).toHaveValue('forest');
    await waitFor(() => expect(canvas.getAllByRole('option')).toHaveLength(1));
    await userEvent.keyboard('{Enter}');
    await expect(args.onValueChange).toHaveBeenCalledWith(
      expect.objectContaining({ value: ['work:dark-forest'] }),
    );
  },
};

export const KeyboardNavigation: Story = {
  render: Inline.render,
  async play({ canvasElement }) {
    const input = within(canvasElement).getByRole('combobox', { name: 'Search REZICS' });
    await userEvent.click(input);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    await waitFor(() =>
      expect(input).toHaveAttribute(
        'aria-activedescendant',
        within(canvasElement).getByRole('option', { name: /The Dark Forest/ }).id,
      ),
    );
  },
};

export const Empty: Story = {
  render: (args) => (
    <Palette
      className="max-w-lg"
      emptyText="No Works, Realms or actions match “foundation”."
      onValueChange={args.onValueChange}
    />
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await typist.type(canvas.getByRole('combobox', { name: 'Search REZICS' }), 'foundation');
    await expect(await canvas.findByRole('status')).toHaveTextContent(
      /No Works, Realms or actions/,
    );
    await expect(canvas.queryByRole('listbox')).not.toBeInTheDocument();
  },
};

export const Chinese: Story = {
  render: (args) => (
    <Palette
      className="max-w-lg"
      footer={false}
      onValueChange={args.onValueChange}
      placeholder="搜索作品、Realm 和操作"
    />
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await typist.type(canvas.getByRole('combobox', { name: 'Search REZICS' }), '三体');
    await waitFor(() => expect(canvas.getAllByRole('option')).toHaveLength(1));
    await expect(canvas.getByRole('option', { name: /刘慈欣/ })).toBeVisible();
  },
};

/** Opens with the search field focused. Escape closes it in a real browser; synthetic key events don't reach the dialog through the combobox. */
export const Dialog: Story = {
  render: (args) => (
    <CommandDialog>
      <CommandDialogTrigger asChild>
        <Button variant="outline">
          <SearchIcon aria-hidden />
          Search REZICS
          <Kbd>⌘K</Kbd>
        </Button>
      </CommandDialogTrigger>
      <CommandDialogContent
        description="Jump to a Work, a Realm or an action."
        title="Search REZICS"
      >
        <Palette onValueChange={args.onValueChange} />
      </CommandDialogContent>
    </CommandDialog>
  ),
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Search REZICS/ }));
    const dialog = await settled(await screen.findByRole('dialog', { name: 'Search REZICS' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('combobox', { name: 'Search REZICS' })).toHaveFocus(),
    );
  },
};

export const DialogOpen: Story = {
  render: Dialog.render,
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Search REZICS/ }));
    const dialog = await settled(await screen.findByRole('dialog', { name: 'Search REZICS' }));
    await expect(within(dialog).getByRole('option', { name: /Hard SF/ })).toBeVisible();
  },
};

export const Dark: Story = {
  ...Inline,
  globals: { theme: 'dark' },
};
