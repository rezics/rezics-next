import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { settled, withTheme } from '../stories/support.tsx';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from './context-menu.tsx';

const meta = {
  title: 'Rezics UI/Context Menu',
  component: ContextMenu,
  tags: ['autodocs'],
  decorators: [withTheme],
  args: { onSelect: fn() },
  parameters: {
    docs: {
      description: {
        component:
          'A menu opened by right-click or long-press on an object, such as a Work cover on a shelf, a chapter in a reading list or a row in a moderation queue. It is a shortcut only: every action in it must also be reachable from a visible button or overflow menu, because touch and keyboard readers may never open it.',
      },
      story: { inline: false, iframeHeight: 420 },
    },
  },
} satisfies Meta<typeof ContextMenu>;
export default meta;
type Story = StoryObj<typeof meta>;

const ShelfCover = (props: React.ComponentProps<typeof ContextMenu> & { title: string }) => {
  const { title, ...rest } = props;

  return (
    <ContextMenu {...rest}>
      <ContextMenuTrigger className="flex h-56 w-40 flex-col justify-end rounded-sm border border-border/60 bg-card p-3 shadow-(--aura-shadow-card)">
        <span className="font-heading font-semibold">{title}</span>
        <span className="text-muted-foreground text-xs">Right-click for shelf actions</span>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuGroup heading={title}>
          <ContextMenuItem value="open">
            Open Work
            <ContextMenuShortcut>↵</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem value="rate">Rate…</ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger>Move to shelf</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem value="reading">Reading</ContextMenuItem>
              <ContextMenuItem value="read">Read</ContextMenuItem>
              <ContextMenuItem value="dnf">Did not finish</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuItem value="remove" variant="destructive">
          Remove from shelf
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};

const openContextMenu = async (canvasElement: HTMLElement, text: string) => {
  const target = within(canvasElement).getByText(text);
  const { left, top, width, height } = target.getBoundingClientRect();
  await fireEvent.contextMenu(target, { clientX: left + width / 2, clientY: top + height / 2 });
  return settled(await screen.findByRole('menu'));
};

export const Default: Story = {
  render: (args) => <ShelfCover {...args} title="The Three-Body Problem" />,
  async play({ canvasElement }) {
    const menu = await openContextMenu(canvasElement, 'The Three-Body Problem');
    await expect(within(menu).getByRole('menuitem', { name: 'Remove from shelf' })).toBeVisible();
  },
};

export const Select: Story = {
  render: (args) => <ShelfCover {...args} title="The Three-Body Problem" />,
  async play({ args, canvasElement }) {
    const menu = await openContextMenu(canvasElement, 'The Three-Body Problem');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Rate…' }));
    await expect(args.onSelect).toHaveBeenCalledWith({ value: 'rate' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  },
};

export const CloseWithEscape: Story = {
  render: (args) => <ShelfCover {...args} title="The Three-Body Problem" />,
  async play({ canvasElement }) {
    await openContextMenu(canvasElement, 'The Three-Body Problem');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  },
};

export const LongTitle: Story = {
  render: (args) => (
    <ShelfCover
      {...args}
      title="Remembrance of Earth’s Past: The Three-Body Trilogy (Collector’s Box Set)"
    />
  ),
  async play({ canvasElement }) {
    const title = 'Remembrance of Earth’s Past: The Three-Body Trilogy (Collector’s Box Set)';
    const menu = await openContextMenu(canvasElement, title);
    await expect(within(menu).getByRole('group', { name: title })).toBeInTheDocument();
  },
};

export const Chinese: Story = {
  render: (args) => (
    <ContextMenu {...args}>
      <ContextMenuTrigger className="flex h-56 w-40 flex-col justify-end rounded-sm border border-border/60 bg-card p-3 shadow-(--aura-shadow-card)">
        <span className="font-heading font-semibold">《三体》</span>
        <span className="text-muted-foreground text-xs">右键查看书架操作</span>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem value="open">打开作品</ContextMenuItem>
        <ContextMenuItem value="rate">评分…</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem value="remove" variant="destructive">
          从书架移除
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  ),
  async play({ canvasElement }) {
    const menu = await openContextMenu(canvasElement, '《三体》');
    await expect(within(menu).getByRole('menuitem', { name: '从书架移除' })).toBeVisible();
  },
};

export const Dark: Story = {
  ...Default,
  parameters: { theme: 'dark' },
};
