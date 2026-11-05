import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@rezics/ui/shadcn/dropdown-menu';
import { settled, withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Dropdown menu',
  component: DropdownMenu,
  tags: ['autodocs'],
  decorators: [withSurface],
  parameters: { docs: { story: { inline: false, iframeHeight: 420 } } },
} satisfies Meta<typeof DropdownMenu>;
export default meta;
type Story = StoryObj<typeof meta>;

const gone = () => waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());

const ShelfMenu = () => {
  const [spoilers, setSpoilers] = useState(true);
  const [sort, setSort] = useState('recent');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" />}>Shelf options</DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Hard science fiction</DropdownMenuLabel>
          <DropdownMenuItem>
            Rename
            <DropdownMenuShortcut>F2</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled>Share</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuCheckboxItem checked={spoilers} onCheckedChange={setSpoilers}>
            Show spoilers
          </DropdownMenuCheckboxItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
          <DropdownMenuRadioItem value="recent">Recently added</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="title">Title</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive">Delete shelf</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const Default: Story = {
  render: () => <ShelfMenu />,
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: 'Shelf options' });
    await userEvent.click(trigger);
    const menu = await settled(await screen.findByRole('menu'));
    await expect(within(menu).getByRole('menuitem', { name: /Rename/ })).toBeVisible();
    await expect(within(menu).getByRole('menuitem', { name: 'Share' })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.keyboard('{Escape}');
    await gone();
    await waitFor(() => expect(trigger).toHaveFocus());
  },
};

export const Selecting: Story = {
  render: () => <ShelfMenu />,
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: 'Shelf options' });
    await userEvent.click(trigger);
    const menu = await settled(await screen.findByRole('menu'));
    // Checkbox and radio items keep the menu open, so choices can be combined.
    const spoilers = within(menu).getByRole('menuitemcheckbox', { name: 'Show spoilers' });
    await expect(spoilers).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(spoilers);
    await waitFor(() => expect(spoilers).toHaveAttribute('aria-checked', 'false'));
    const title = within(menu).getByRole('menuitemradio', { name: 'Title' });
    await userEvent.click(title);
    await waitFor(() => expect(title).toHaveAttribute('aria-checked', 'true'));
    await expect(within(menu).getByRole('menuitemradio', { name: 'Recently added' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Delete shelf' }));
    await gone();
  },
};
