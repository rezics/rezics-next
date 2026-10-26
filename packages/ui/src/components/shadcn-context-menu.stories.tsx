import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fireEvent, screen, userEvent, waitFor, within } from 'storybook/test';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@rezics/ui/shadcn/context-menu';
import { settled, withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Context menu',
  component: ContextMenu,
  tags: ['autodocs'],
  decorators: [withSurface],
  parameters: { docs: { story: { inline: false, iframeHeight: 420 } } },
} satisfies Meta<typeof ContextMenu>;
export default meta;
type Story = StoryObj<typeof meta>;

const gone = () => waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());

const Cover = ({ title = 'The Three-Body Problem' }: { title?: string }) => {
  const [spoilers, setSpoilers] = useState(true);
  const [sort, setSort] = useState('recent');
  return (
    <ContextMenu>
      <ContextMenuTrigger className="grid h-40 w-64 place-items-center rounded-2xl border border-dashed p-4 text-center text-sm">
        {title}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuGroup>
          <ContextMenuLabel>Shelf</ContextMenuLabel>
          <ContextMenuItem>
            Add to shelf
            <ContextMenuShortcut>⌘S</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem disabled>Share</ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuCheckboxItem checked={spoilers} onCheckedChange={setSpoilers}>
          Show spoilers
        </ContextMenuCheckboxItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>Sort by</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuRadioGroup value={sort} onValueChange={setSort}>
              <ContextMenuRadioItem value="recent">Recently added</ContextMenuRadioItem>
              <ContextMenuRadioItem value="title">Title</ContextMenuRadioItem>
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive">Remove from shelf</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};

const open = async (canvasElement: HTMLElement, text: string) => {
  const target = within(canvasElement).getByText(text);
  const { left, top, width, height } = target.getBoundingClientRect();
  await fireEvent.contextMenu(target, { clientX: left + width / 2, clientY: top + height / 2 });
  return settled(await screen.findByRole('menu'));
};

export const Default: Story = {
  render: () => <Cover />,
  async play({ canvasElement }) {
    const menu = await open(canvasElement, 'The Three-Body Problem');
    await expect(within(menu).getByRole('menuitem', { name: /Add to shelf/ })).toBeVisible();
    await expect(within(menu).getByRole('menuitem', { name: 'Share' })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.keyboard('{Escape}');
    await gone();
  },
};

export const CheckboxAndRadioItems: Story = {
  render: () => <Cover />,
  async play({ canvasElement }) {
    const menu = await open(canvasElement, 'The Three-Body Problem');
    // Checkbox and radio items keep the menu open, so choices can be combined.
    const spoilers = within(menu).getByRole('menuitemcheckbox', { name: 'Show spoilers' });
    await expect(spoilers).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(spoilers).not.toHaveStyle({ pointerEvents: 'none' }));
    await userEvent.click(spoilers);
    await waitFor(() => expect(spoilers).toHaveAttribute('aria-checked', 'false'));
    await userEvent.keyboard('{Escape}');
    await gone();
  },
};

export const Submenu: Story = {
  render: () => <Cover />,
  async play({ canvasElement }) {
    const menu = await open(canvasElement, 'The Three-Body Problem');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Sort by' }));
    const title = await screen.findByRole('menuitemradio', { name: 'Title' });
    await expect(screen.getByRole('menuitemradio', { name: 'Recently added' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(title);
    await waitFor(() => expect(title).toHaveAttribute('aria-checked', 'true'));
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryAllByRole('menu')).toHaveLength(0));
  },
};

export const LongAndCjkText: Story = {
  render: () => <Cover title="三體：地球往事——一部書名很長、需要在觸發區域內折行顯示的科幻小說（日本語版を含む）" />,
  async play({ canvasElement }) {
    const menu = await open(
      canvasElement,
      '三體：地球往事——一部書名很長、需要在觸發區域內折行顯示的科幻小說（日本語版を含む）',
    );
    await expect(within(menu).getByRole('menuitem', { name: 'Remove from shelf' })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await gone();
  },
};
