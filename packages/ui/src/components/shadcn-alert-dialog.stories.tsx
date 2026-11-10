import type { Meta, StoryObj } from '@storybook/react-vite';
import { Trash2Icon } from 'lucide-react';
import { useState, type CSSProperties } from 'react';
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

const expectWithinViewport = (panel: HTMLElement) => {
  const bounds = panel.getBoundingClientRect();
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
  expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
};

const expectReachableIn = (panel: HTMLElement, target: HTMLElement) => {
  target.scrollIntoView({ block: 'nearest' });
  const panelBounds = panel.getBoundingClientRect();
  const targetBounds = target.getBoundingClientRect();
  expect(targetBounds.top).toBeGreaterThanOrEqual(panelBounds.top);
  expect(targetBounds.bottom).toBeLessThanOrEqual(panelBounds.bottom);
};

const DeleteShelf = ({
  title = 'Delete this shelf?',
  description = 'The Works on it stay in your library, but the shelf and its notes are removed.',
  size,
  media,
  contentId,
  contentClassName,
  contentStyle,
}: {
  title?: string;
  description?: string;
  size?: 'default' | 'sm';
  media?: boolean;
  contentId?: string;
  contentClassName?: string;
  contentStyle?: CSSProperties;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button variant="outline" />}>Delete shelf</AlertDialogTrigger>
      <AlertDialogContent id={contentId} className={contentClassName} style={contentStyle} size={size}>
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
  globals: {},
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: 'Delete shelf' });
    await userEvent.click(trigger);
    const dialog = await settled(await screen.findByRole('alertdialog', { name: 'Delete this shelf?' }));
    await expect(dialog).toHaveAccessibleDescription(/stay in your library/);
    await expect(dialog).toHaveAttribute('data-size', 'default');
    expectWithinViewport(dialog);
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
  globals: {},
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Delete shelf' }));
    const dialog = await settled(await screen.findByRole('alertdialog'));
    await expect(dialog).toHaveAttribute('data-size', 'sm');
    expectWithinViewport(dialog);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete shelf' }));
    await gone();
  },
};

export const LongAndCjkText: Story = {
  render: () => (
    <DeleteShelf
      title="刪除書架「硬科幻與太空歌劇：我今年想讀完的所有作品」？"
      description={[
        '書架上的作品會保留在你的書庫中，但書架與其中的筆記將被移除。This also removes the shared link you sent to 24 friends, who will see a not-found page instead. 共有された日本語のリンクも無効になります。',
        '這個書架目前有三十二本作品，包含尚未完成的閱讀進度、每本作品的私人筆記，以及與其他書架相同的篩選條件。',
        '刪除後，作品與進度仍留在你的書庫中，但書架本身、私人筆記、分享連結和這些篩選條件都無法恢復。',
        '請確認你已經匯出需要保留的紀錄，並通知仍在使用分享連結的人。',
        '每位使用者建立的閱讀順序、標籤與搜尋條件都會一起移除，已經完成的評分、評論和作品本身則會保留。',
        '儲存的篩選條件不會自動轉移至其他書架，分享連結也不會顯示替代位置。',
        '此操作完成後無法由管理員或支援人員復原，請先檢查所有近期更新並保留需要的資料。',
        'The shared links and saved filters stop working after deletion, and the works remain in your library.',
      ].join(' ')}
      contentId="alert-dialog-long-cjk"
      contentClassName="alert-dialog-caller-override overflow-y-auto"
      contentStyle={{ '--alert-dialog-caller-marker': 'preserved' } as CSSProperties}
    />
  ),
  globals: {},
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Delete shelf' }));
    const dialog = await settled(await screen.findByRole('alertdialog', { name: /^刪除書架/ }));
    await expect(dialog).toHaveAttribute('data-size', 'default');
    await expect(dialog).toHaveAttribute('id', 'alert-dialog-long-cjk');
    await expect(dialog).toHaveClass('alert-dialog-caller-override');
    expect(dialog.style.getPropertyValue('--alert-dialog-caller-marker')).toBe('preserved');
    await expect(dialog).toBeVisible();
    await expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    expect(dialog.scrollHeight).toBeGreaterThan(dialog.clientHeight);
    expectWithinViewport(dialog);
    await expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull();
    expectReachableIn(dialog, within(dialog).getByRole('button', { name: 'Keep shelf' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep shelf' }));
    await gone();
  },
};
