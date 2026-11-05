import type { Meta, StoryObj } from '@storybook/react-vite';
import { CalendarIcon, SearchIcon, SettingsIcon } from 'lucide-react';
import { useState } from 'react';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@rezics/ui/shadcn/command';
import { settled, withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Command',
  component: Command,
  tags: ['autodocs'],
  decorators: [withSurface],
  args: { label: 'Command menu' },
} satisfies Meta<typeof Command>;
export default meta;
type Story = StoryObj<typeof meta>;

const Palette = ({
  onChoose,
  ...props
}: { onChoose?: (value: string) => void } & React.ComponentProps<typeof Command>) => (
  <Command className="max-w-sm rounded-3xl border shadow-md" {...props}>
    <CommandInput placeholder="Search Works and actions" />
    <CommandList>
      <CommandEmpty>Nothing matches your search.</CommandEmpty>
      <CommandGroup heading="Works">
        <CommandItem onSelect={onChoose} value="Dune">
          <SearchIcon />
          Dune
        </CommandItem>
        <CommandItem onSelect={onChoose} value="三體">
          <SearchIcon />
          三體（The Three-Body Problem）
        </CommandItem>
      </CommandGroup>
      <CommandGroup heading="Actions">
        <CommandItem onSelect={onChoose} value="Reading calendar">
          <CalendarIcon />
          Reading calendar
          <CommandShortcut>⌘K</CommandShortcut>
        </CommandItem>
        <CommandItem disabled value="Settings">
          <SettingsIcon />
          Settings
        </CommandItem>
      </CommandGroup>
    </CommandList>
  </Command>
);

export const Default: Story = {
  args: { onValueChange: fn() },
  render: () => <Palette />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('combobox')).toBeVisible();
    await expect(canvas.getAllByRole('option')).toHaveLength(4);
    await expect(canvas.getByRole('option', { name: /Settings/ })).toHaveAttribute('aria-disabled', 'true');
  },
};

export const FilterAndSelect: Story = {
  render: () => {
    const [chosen, setChosen] = useState('nothing');
    return (
      <div className="flex flex-col gap-3">
        <Palette onChoose={setChosen} />
        <p aria-live="polite">Chose {chosen}</p>
      </div>
    );
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('combobox'), 'calen');
    await waitFor(() => expect(canvas.getAllByRole('option')).toHaveLength(1));
    await userEvent.keyboard('{Enter}');
    await expect(await canvas.findByText('Chose Reading calendar')).toBeVisible();
  },
};

const works = ['Dune', 'Hyperion', '三體（The Three-Body Problem）', 'こころ'];

// With no match cmdk leaves an empty listbox, which fails the rule that a listbox holds options. This palette
// filters itself and shows the empty message as a disabled option, so the list is never empty.
const Searchable = () => {
  const [search, setSearch] = useState('');
  const matches = works.filter((work) => work.toLowerCase().includes(search.trim().toLowerCase()));
  return (
    <Command shouldFilter={false} className="max-w-sm rounded-3xl border shadow-md" label="Find a Work">
      <CommandInput placeholder="Search Works" value={search} onValueChange={setSearch} />
      <CommandList>
        <CommandGroup heading="Works">
          {matches.length > 0 ? (
            matches.map((work) => (
              <CommandItem key={work} value={work}>
                {work}
              </CommandItem>
            ))
          ) : (
            <CommandItem disabled value="no-match">
              Nothing matches your search.
            </CommandItem>
          )}
        </CommandGroup>
      </CommandList>
    </Command>
  );
};

export const NoResultsAndCjk: Story = {
  render: () => <Searchable />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const input = canvas.getByRole('combobox');
    await userEvent.type(input, '三體');
    await waitFor(() => expect(canvas.getAllByRole('option')).toHaveLength(1));
    await userEvent.clear(input);
    await userEvent.type(input, 'zzz');
    await expect(await canvas.findByText('Nothing matches your search.')).toBeVisible();
    await expect(canvas.getByRole('option', { name: 'Nothing matches your search.' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  },
};

export const InDialog: Story = {
  parameters: { docs: { story: { inline: false, iframeHeight: 420 } } },
  render: () => {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button variant="outline" onClick={() => setOpen(true)}>
          Open command menu
        </Button>
        <CommandDialog
          open={open}
          onOpenChange={setOpen}
          title="Command menu"
          description="Search for a Work or action"
        >
          <Command label="Command menu">
            <CommandInput placeholder="Search Works and actions" />
            <CommandList>
              <CommandEmpty>Nothing matches your search.</CommandEmpty>
              <CommandGroup heading="Works">
                <CommandItem value="Dune">Dune</CommandItem>
                <CommandItem value="Hyperion">Hyperion</CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </CommandDialog>
      </>
    );
  },
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Open command menu' }));
    const dialog = await settled(await screen.findByRole('dialog', { name: 'Command menu' }));
    await expect(await within(dialog).findByRole('combobox')).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  },
};
