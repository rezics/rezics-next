import { createListCollection } from '@ark-ui/react/listbox';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { FlagIcon, HashIcon, TrashIcon } from 'lucide-react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { cn } from '../utils.ts';
import {
  Listbox,
  ListboxContent,
  ListboxItem,
  ListboxItemGroup,
  ListboxItemIndicator,
  ListboxItemText,
  ListboxLabel,
  ListboxShortcut,
} from './listbox.tsx';

interface Realm {
  value: string;
  label: string;
  members: string;
  group: 'Joined' | 'Suggested';
  disabled?: boolean;
}

const realms = createListCollection<Realm>({
  items: [
    { value: 'scifi', label: 'r/scifi', members: '48k', group: 'Joined' },
    { value: 'kehuan', label: 'r/科幻', members: '21k', group: 'Joined' },
    { value: 'liu-cixin', label: 'r/LiuCixin', members: '6.2k', group: 'Joined' },
    { value: 'loghe', label: 'r/银河英雄传说', members: '3.9k', group: 'Suggested' },
    {
      value: 'archive',
      label: 'r/scifi-archive (read-only)',
      members: '12k',
      group: 'Suggested',
      disabled: true,
    },
  ],
  groupBy: (item) => item.group,
});

const meta = {
  title: 'Rezics UI/Listbox',
  component: Listbox,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'An always-visible list of selectable options with keyboard navigation and typeahead. In REZICS use it inside panels and dialogs where the options should stay on screen: choosing the Realm to cross-post to, picking a moderation action, or a filter list in a sidebar. Use Select or Combobox when the options belong in a popup.',
      },
    },
  },
  args: { collection: realms, defaultValue: ['scifi'] },
  decorators: [
    (Story, { parameters }) => (
      <div className={cn(parameters.theme === 'dark' && 'dark')}>
        <div className="min-h-40 bg-background p-6 font-sans text-foreground">
          <div className="max-w-xs">
            <Story />
          </div>
        </div>
      </div>
    ),
  ],
  render: (args) => (
    <Listbox {...args}>
      <ListboxLabel>Post to Realm</ListboxLabel>
      <ListboxContent>
        {realms.items.map((item) => (
          <ListboxItem item={item} key={item.value}>
            <HashIcon aria-hidden />
            <ListboxItemText>{item.label}</ListboxItemText>
            <span className="text-muted-foreground text-xs tabular-nums">{item.members}</span>
            <ListboxItemIndicator />
          </ListboxItem>
        ))}
      </ListboxContent>
    </Listbox>
  ),
} satisfies Meta<typeof Listbox<Realm>>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('listbox', { name: 'Post to Realm' })).toBeInTheDocument();
    await expect(canvas.getByRole('option', { name: /r\/scifi 48k/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await userEvent.click(canvas.getByRole('option', { name: /r\/科幻/ }));
    await expect(canvas.getByRole('option', { name: /r\/科幻/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await waitFor(() =>
      expect(canvas.getByRole('option', { name: /r\/LiuCixin/ })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
  },
};

export const Multiple: Story = {
  args: { selectionMode: 'multiple', defaultValue: ['scifi', 'kehuan'] },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('option', { name: /r\/LiuCixin/ }));
    await expect(canvas.getAllByRole('option', { selected: true })).toHaveLength(3);
  },
};

export const Grouped: Story = {
  render: (args) => (
    <Listbox {...args}>
      <ListboxLabel>Post to Realm</ListboxLabel>
      <ListboxContent>
        {realms.group().map(([group, items]) => (
          <ListboxItemGroup heading={group} key={group}>
            {items.map((item) => (
              <ListboxItem item={item} key={item.value}>
                <ListboxItemText>{item.label}</ListboxItemText>
                <ListboxItemIndicator />
              </ListboxItem>
            ))}
          </ListboxItemGroup>
        ))}
      </ListboxContent>
    </Listbox>
  ),
};

const actions = createListCollection({
  items: [
    { value: 'flag', label: 'Flag for review', shortcut: 'F' },
    { value: 'lock', label: 'Lock thread', shortcut: 'L' },
    { value: 'remove', label: 'Remove post', shortcut: '⌫' },
  ],
});

export const Actions: Story = {
  render: () => (
    <Listbox collection={actions}>
      <ListboxLabel>Moderation action</ListboxLabel>
      <ListboxContent>
        {actions.items.map((item) => (
          <ListboxItem
            item={item}
            key={item.value}
            variant={item.value === 'remove' ? 'destructive' : 'default'}
          >
            {item.value === 'remove' ? <TrashIcon aria-hidden /> : <FlagIcon aria-hidden />}
            <ListboxItemText>{item.label}</ListboxItemText>
            <ListboxShortcut>{item.shortcut}</ListboxShortcut>
          </ListboxItem>
        ))}
      </ListboxContent>
    </Listbox>
  ),
};

const sorts = createListCollection({
  items: [
    { value: 'hot', label: 'Hot' },
    { value: 'new', label: 'New' },
    { value: 'top', label: 'Top' },
  ],
});

export const Horizontal: Story = {
  render: () => (
    <Listbox collection={sorts} defaultValue={['new']} orientation="horizontal">
      <ListboxLabel>Sort</ListboxLabel>
      <ListboxContent>
        {sorts.items.map((item) => (
          <ListboxItem item={item} key={item.value}>
            <ListboxItemText>{item.label}</ListboxItemText>
          </ListboxItem>
        ))}
      </ListboxContent>
    </Listbox>
  ),
};

export const Disabled: Story = { args: { disabled: true } };

export const LongContent: Story = {
  render: () => {
    const long = createListCollection({
      items: [
        {
          value: 'a',
          label:
            'r/RemembranceOfEarthsPast — discussion of all three volumes, adaptations and fan translations',
        },
        { value: 'b', label: 'r/地球往事三部曲读书会（含剧透讨论区与翻译对照）' },
      ],
    });
    return (
      <Listbox collection={long} defaultValue={['b']}>
        <ListboxLabel>Post to Realm</ListboxLabel>
        <ListboxContent>
          {long.items.map((item) => (
            <ListboxItem item={item} key={item.value}>
              <ListboxItemText>{item.label}</ListboxItemText>
              <ListboxItemIndicator />
            </ListboxItem>
          ))}
        </ListboxContent>
      </Listbox>
    );
  },
};

export const Dark: Story = {
  parameters: { theme: 'dark' },
  render: (args, context) => (
    <div className="flex flex-col gap-8">
      {meta.render(args)}
      {Actions.render?.(args, context)}
    </div>
  ),
};
