import type { Meta, StoryObj } from '@storybook/react-vite';
import { Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@rezics/ui/shadcn/alert-dialog';
import { Button } from '@rezics/ui/shadcn/button';
import { waitForFocus } from '../test/focus.ts';
import { settled, withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/AlertDialog',
  component: AlertDialog,
  tags: ['autodocs'],
  decorators: [withSurface],
  parameters: { docs: { story: { inline: false, iframeHeight: 420 } } },
} satisfies Meta<typeof AlertDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

const gone = () => waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());

const DeleteShelf = ({
  title = 'Delete this shelf?',
  description = 'The Works on it stay in your library, but the shelf and its notes are removed.',
  size,
  media,
}: {
  title?: string;
  description?: string;
  size?: 'default' | 'sm';
  media?: boolean;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button variant="outline" />}>Delete shelf</AlertDialogTrigger>
      <AlertDialogContent size={size}>
        <AlertDialogHeader>
          {media ? (
            <AlertDialogMedia>
              <Trash2Icon />
            </AlertDialogMedia>
          ) : null}
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep shelf</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => setOpen(false)}>
            Delete shelf
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export const Default: Story = {
  render: () => <DeleteShelf />,
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: 'Delete shelf' });
    await userEvent.click(trigger);
    const dialog = await settled(await screen.findByRole('alertdialog', { name: 'Delete this shelf?' }));
    await expect(dialog).toHaveAccessibleDescription(/stay in your library/);
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await userEvent.keyboard('{Escape}');
    await gone();
    await waitForFocus(trigger);
  },
};

export const Cancel: Story = {
  render: () => <DeleteShelf />,
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Delete shelf' }));
    const dialog = await settled(await screen.findByRole('alertdialog'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep shelf' }));
    await gone();
  },
};

export const ConfirmWithMedia: Story = {
  render: () => <DeleteShelf media size="sm" />,
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Delete shelf' }));
    const dialog = await settled(await screen.findByRole('alertdialog'));
    await expect(dialog).toHaveAttribute('data-size', 'sm');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete shelf' }));
    await gone();
  },
};

export const LongAndCjkText: Story = {
  render: () => (
    <DeleteShelf
      title="刪除書架「硬科幻與太空歌劇：我今年想讀完的所有作品」？"
      description="書架上的作品會保留在你的書庫中，但書架與其中的筆記將被移除。This also removes the shared link you sent to 24 friends, who will see a not-found page instead. 共有された日本語のリンクも無効になります。"
    />
  ),
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Delete shelf' }));
    const dialog = await settled(await screen.findByRole('alertdialog', { name: /^刪除書架/ }));
    await expect(dialog).toBeVisible();
    await expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep shelf' }));
    await gone();
  },
};
