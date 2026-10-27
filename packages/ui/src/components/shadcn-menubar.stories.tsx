import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarGroup,
  MenubarItem,
  MenubarLabel,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from '@rezics/ui/shadcn/menubar';
import { settled, withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Menubar',
  component: Menubar,
  tags: ['autodocs'],
  decorators: [withSurface],
  parameters: { docs: { story: { inline: false, iframeHeight: 420 } } },
} satisfies Meta<typeof Menubar>;
export default meta;
type Story = StoryObj<typeof meta>;

const gone = () => waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument(), { timeout: 3000 });

const Editor = ({ labels = ['Shelf', 'View'] as const }: { labels?: readonly [string, string] }) => {
  const [spoilers, setSpoilers] = useState(true);
  const [layout, setLayout] = useState('grid');
  return (
    <Menubar aria-label="Shelf editor" className="w-fit">
      <MenubarMenu>
        <MenubarTrigger>{labels[0]}</MenubarTrigger>
        <MenubarContent>
          <MenubarItem>
            New shelf
            <MenubarShortcut>Ctrl+N</MenubarShortcut>
          </MenubarItem>
          <MenubarItem disabled>Share</MenubarItem>
          <MenubarSeparator />
          <MenubarSub>
            <MenubarSubTrigger>Export</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem>As CSV</MenubarItem>
              <MenubarItem>As JSON</MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSeparator />
          <MenubarItem variant="destructive">Delete shelf</MenubarItem>
        </MenubarContent>
      </MenubarMenu>
      <MenubarMenu>
        <MenubarTrigger>{labels[1]}</MenubarTrigger>
        <MenubarContent>
          <MenubarCheckboxItem checked={spoilers} onCheckedChange={setSpoilers}>
            Show spoilers
          </MenubarCheckboxItem>
          <MenubarSeparator />
          <MenubarGroup>
            <MenubarLabel>Layout</MenubarLabel>
            <MenubarRadioGroup value={layout} onValueChange={setLayout}>
              <MenubarRadioItem value="grid">Grid</MenubarRadioItem>
              <MenubarRadioItem value="list">List</MenubarRadioItem>
            </MenubarRadioGroup>
          </MenubarGroup>
        </MenubarContent>
      </MenubarMenu>
    </Menubar>
  );
};

export const Default: Story = {
  render: () => <Editor />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const shelf = canvas.getByRole('menuitem', { name: 'Shelf' });
    await userEvent.click(shelf);
    const menu = await settled(await screen.findByRole('menu'));
    await expect(within(menu).getByRole('menuitem', { name: /New shelf/ })).toBeVisible();
    await expect(within(menu).getByRole('menuitem', { name: 'Share' })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.keyboard('{Escape}');
    await gone();
  },
};

export const KeyboardBetweenMenus: Story = {
  render: () => <Editor />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const shelf = canvas.getByRole('menuitem', { name: 'Shelf' });
    shelf.focus();
    await userEvent.keyboard('{Enter}');
    await settled(await screen.findByRole('menuitem', { name: /New shelf/ }));
    // ArrowRight on an open menu hands over to the next menu of the bar.
    await userEvent.keyboard('{ArrowRight}');
    await settled(await screen.findByRole('menuitemcheckbox', { name: 'Show spoilers' }));
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: /New shelf/ })).toBeNull(), { timeout: 3000 });
    await userEvent.keyboard('{Escape}');
    await gone();
  },
};

export const Choices: Story = {
  render: () => <Editor />,
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('menuitem', { name: 'View' }));
    const menu = await settled(await screen.findByRole('menu'));
    const spoilers = within(menu).getByRole('menuitemcheckbox', { name: 'Show spoilers' });
    await expect(spoilers).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(spoilers);
    await waitFor(() => expect(spoilers).toHaveAttribute('aria-checked', 'false'));
    const list = within(menu).getByRole('menuitemradio', { name: 'List' });
    await userEvent.click(list);
    await waitFor(() => expect(list).toHaveAttribute('aria-checked', 'true'));
    await expect(within(menu).getByRole('menuitemradio', { name: 'Grid' })).toHaveAttribute('aria-checked', 'false');
  },
};

export const Submenu: Story = {
  render: () => <Editor />,
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('menuitem', { name: 'Shelf' }));
    await settled(await screen.findByRole('menu'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Export' }));
    const json = await settled(await screen.findByRole('menuitem', { name: 'As JSON' }));
    await expect(json).toBeVisible();
    await userEvent.click(json);
    await gone();
  },
};

export const LongAndCjkText: Story = {
  render: () => <Editor labels={['書架與收藏的管理選項', '檢視']} />,
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('menuitem', { name: '書架與收藏的管理選項' }));
    await settled(await screen.findByRole('menu'));
    await expect(await screen.findByRole('menuitem', { name: /New shelf/ })).toBeVisible();
  },
};
