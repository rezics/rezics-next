import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  BookmarkIcon,
  EllipsisIcon,
  FlagIcon,
  LinkIcon,
  LibraryIcon,
  PencilIcon,
  Trash2Icon,
} from 'lucide-react';
import React from 'react';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { settled, withTheme } from '../stories/support.tsx';
import { Button } from './button.tsx';
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from './menu.tsx';

const meta = {
  title: 'Rezics UI/Menu',
  component: Menu,
  tags: ['autodocs'],
  decorators: [withTheme],
  args: { onSelect: fn() },
  parameters: {
    docs: {
      description: {
        component:
          'A list of actions or options behind a button, such as the overflow menu at the end of a post’s engagement bar, a Work’s “Add to shelf” menu, or feed sort and display options. Items support icons, shortcuts, checkbox and radio items, groups and submenus, and full keyboard use (arrows, typeahead, Enter, Escape). Destructive items use the text-safe red and sit last, after a separator. For navigation between pages use links, not a menu.',
      },
      story: { inline: false, iframeHeight: 420 },
    },
  },
} satisfies Meta<typeof Menu>;
export default meta;
type Story = StoryObj<typeof meta>;

const PostMenu = (props: React.ComponentProps<typeof Menu> & { moderator?: boolean }) => {
  const { moderator = true, ...rest } = props;

  return (
    <div className="flex justify-end">
      <Menu {...rest}>
        <MenuTrigger asChild>
          <Button aria-label="Post actions" size="icon-sm" variant="secondary">
            <EllipsisIcon />
          </Button>
        </MenuTrigger>
        <MenuContent>
          <MenuItem value="copy-link">
            <LinkIcon />
            Copy link
            <MenuShortcut>⌘L</MenuShortcut>
          </MenuItem>
          <MenuItem value="save">
            <BookmarkIcon />
            Save post
            <MenuShortcut>S</MenuShortcut>
          </MenuItem>
          <MenuSub onSelect={rest.onSelect}>
            <MenuSubTrigger>
              <LibraryIcon />
              Add Work to shelf
            </MenuSubTrigger>
            <MenuSubContent>
              <MenuItem value="want-to-read">Want to read</MenuItem>
              <MenuItem value="reading">Reading</MenuItem>
              <MenuItem value="read">Read</MenuItem>
            </MenuSubContent>
          </MenuSub>
          <MenuItem disabled value="edit">
            <PencilIcon />
            Edit (locked after 24 hours)
          </MenuItem>
          <MenuItem value="report">
            <FlagIcon />
            Report
          </MenuItem>
          {moderator ? (
            <>
              <MenuSeparator />
              <MenuItem value="remove" variant="destructive">
                <Trash2Icon />
                Remove post
                <MenuShortcut>⌫</MenuShortcut>
              </MenuItem>
            </>
          ) : null}
        </MenuContent>
      </Menu>
    </div>
  );
};

const openMenu = async (canvasElement: HTMLElement, name: string) => {
  await userEvent.click(within(canvasElement).getByRole('button', { name }));
  return settled(await screen.findByRole('menu'));
};

export const PostActions: Story = {
  render: (args) => <PostMenu {...args} />,
  async play({ canvasElement }) {
    const menu = await openMenu(canvasElement, 'Post actions');
    await expect(within(menu).getByRole('menuitem', { name: /Remove post/ })).toBeVisible();
    await expect(within(menu).getByRole('menuitem', { name: /Edit/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  },
};

export const SelectWithKeyboard: Story = {
  render: (args) => <PostMenu {...args} />,
  async play({ args, canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: 'Post actions' });
    await userEvent.tab();
    await expect(trigger).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    const menu = await settled(await screen.findByRole('menu'));
    // Opening from the keyboard highlights the first item; wait for it before moving on.
    await waitFor(() =>
      expect(within(menu).getByRole('menuitem', { name: /Copy link/ })).toHaveAttribute(
        'data-highlighted',
      ),
    );
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() =>
      expect(within(menu).getByRole('menuitem', { name: /Save post/ })).toHaveAttribute(
        'data-highlighted',
      ),
    );
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await expect(args.onSelect).toHaveBeenCalledWith({ value: 'save' });
  },
};

export const CloseWithEscape: Story = {
  render: (args) => <PostMenu {...args} />,
  async play({ canvasElement }) {
    await openMenu(canvasElement, 'Post actions');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await expect(within(canvasElement).getByRole('button', { name: 'Post actions' })).toHaveFocus();
  },
};

export const Submenu: Story = {
  render: (args) => <PostMenu {...args} />,
  async play({ args, canvasElement }) {
    await openMenu(canvasElement, 'Post actions');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    await userEvent.keyboard('{ArrowRight}');
    await settled(await screen.findByRole('menuitem', { name: 'Reading' }));
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await expect(args.onSelect).toHaveBeenCalledWith({ value: 'reading' });
  },
};

export const Reader: Story = {
  render: (args) => <PostMenu {...args} moderator={false} />,
  async play({ canvasElement }) {
    const menu = await openMenu(canvasElement, 'Post actions');
    await expect(within(menu).queryByRole('menuitem', { name: /Remove post/ })).toBeNull();
  },
};

const sorts = { hot: 'Hot', new: 'New', 'top-week': 'Top this week' } as const;

// Radio and checkbox items are controlled only: pass value and checked with their change handlers.
const FeedOptionsMenu = (props: React.ComponentProps<typeof Menu>) => {
  const [sort, setSort] = React.useState<keyof typeof sorts>('hot');
  const [blurSpoilers, setBlurSpoilers] = React.useState(true);
  const [compact, setCompact] = React.useState(false);

  return (
    <Menu {...props} closeOnSelect={false} positioning={{ placement: 'bottom-start' }}>
      <MenuTrigger asChild>
        <Button variant="outline">Sort: {sorts[sort]}</Button>
      </MenuTrigger>
      <MenuContent className="w-56">
        <MenuRadioGroup
          heading="Sort posts"
          onValueChange={(details) => setSort(details.value as keyof typeof sorts)}
          value={sort}
        >
          {Object.entries(sorts).map(([value, label]) => (
            <MenuRadioItem key={value} value={value}>
              {label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuGroup heading="Display">
          <MenuCheckboxItem
            checked={blurSpoilers}
            onCheckedChange={setBlurSpoilers}
            value="spoilers"
          >
            Blur spoilers
          </MenuCheckboxItem>
          <MenuCheckboxItem checked={compact} onCheckedChange={setCompact} value="compact">
            Compact cards
          </MenuCheckboxItem>
        </MenuGroup>
      </MenuContent>
    </Menu>
  );
};

export const FeedOptions: Story = {
  render: (args) => <FeedOptionsMenu {...args} />,
  async play({ canvasElement }) {
    const menu = await openMenu(canvasElement, 'Sort: Hot');
    await expect(within(menu).getByRole('menuitemradio', { name: 'Hot' })).toBeChecked();
    await userEvent.click(within(menu).getByRole('menuitemradio', { name: 'New' }));
    await expect(within(menu).getByRole('menuitemradio', { name: 'New' })).toBeChecked();
    await userEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'Compact cards' }));
    await expect(
      within(menu).getByRole('menuitemcheckbox', { name: 'Compact cards' }),
    ).toBeChecked();
  },
};

export const LongContent: Story = {
  render: (args) => (
    <Menu {...args} positioning={{ placement: 'bottom-start' }}>
      <MenuTrigger asChild>
        <Button variant="outline">Move to Realm</Button>
      </MenuTrigger>
      <MenuContent className="max-h-72 w-72">
        {[
          'Hard SF',
          'Translated Fiction',
          'Chinese Science Fiction and Fantasy Readers’ Circle',
          'First Contact',
          'Space Opera',
          'Climate Fiction',
          'Classic Golden Age SF',
          'Book Clubs',
          'Worldbuilding',
          'Hugo and Nebula Awards Discussion',
          'New Releases',
        ].map((realm) => (
          <MenuItem key={realm} value={realm}>
            <span className="truncate">{realm}</span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  ),
  async play({ canvasElement }) {
    const menu = await openMenu(canvasElement, 'Move to Realm');
    await expect(within(menu).getAllByRole('menuitem')).toHaveLength(11);
  },
};

export const Chinese: Story = {
  render: (args) => (
    <Menu {...args} positioning={{ placement: 'bottom-start' }}>
      <MenuTrigger asChild>
        <Button variant="outline">加入书架</Button>
      </MenuTrigger>
      <MenuContent>
        <MenuGroup heading="《三体》">
          <MenuItem value="want">想读</MenuItem>
          <MenuItem value="reading">在读</MenuItem>
          <MenuItem value="read">读过</MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem value="remove" variant="destructive">
          从所有书架移除
        </MenuItem>
      </MenuContent>
    </Menu>
  ),
  async play({ canvasElement }) {
    const menu = await openMenu(canvasElement, '加入书架');
    await expect(within(menu).getByRole('menuitem', { name: '在读' })).toBeVisible();
  },
};

export const Dark: Story = {
  ...PostActions,
  parameters: { theme: 'dark' },
};
