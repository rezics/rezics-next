import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, screen, userEvent, within } from 'storybook/test';
import { dismissed, settled, withSurface } from '../stories/support.tsx';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTrigger,
} from './alert-dialog.tsx';
import { Button } from './button.tsx';

const meta = {
  title: 'Rezics UI/Alert Dialog',
  component: AlertDialog,
  tags: ['autodocs'],
  decorators: [withSurface],
  args: { onOpenChange: fn() },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 420 },
    },
  },
} satisfies Meta<typeof AlertDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

const openAlert = async (canvasElement: HTMLElement, name: string) => {
  await userEvent.click(within(canvasElement).getByRole('button', { name }));
  return settled(await screen.findByRole('alertdialog'));
};

export const RemovePost: Story = {
  render: (args) => (
    <AlertDialog {...args}>
      <AlertDialogTrigger asChild>
        <Button variant="destructive">Remove post</Button>
      </AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader
          description="“Chapter 12 spoilers without a tag” disappears from Hard SF. The author is notified and can appeal once."
          title="Remove this post?"
        />
        <AlertDialogFooter>
          <AlertDialogCancel>Keep post</AlertDialogCancel>
          <AlertDialogAction variant="destructive">Remove post</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ),
  async play({ args, canvasElement }) {
    const alert = await openAlert(canvasElement, 'Remove post');
    await expect(within(alert).queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    await expect(args.onOpenChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ open: true }),
    );
  },
};

export const CancelWithEscape: Story = {
  ...RemovePost,
  async play({ canvasElement }) {
    await openAlert(canvasElement, 'Remove post');
    await userEvent.keyboard('{Escape}');
    await dismissed('alertdialog');
    await expect(within(canvasElement).getByRole('button', { name: 'Remove post' })).toHaveFocus();
  },
};

export const CancelWithButton: Story = {
  ...RemovePost,
  async play({ canvasElement }) {
    const alert = await openAlert(canvasElement, 'Remove post');
    await userEvent.click(within(alert).getByRole('button', { name: 'Keep post' }));
    await dismissed('alertdialog');
  },
};

export const Removing: Story = {
  render: (args) => (
    <AlertDialog {...args}>
      <AlertDialogTrigger asChild>
        <Button variant="outline">Delete shelf</Button>
      </AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader
          description="The shelf “Hugo Award winners, 1953–2025” and its 71 Works are removed from your profile. Your ratings stay."
          title="Delete this shelf?"
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled>Cancel</AlertDialogCancel>
          <AlertDialogAction isLoading variant="destructive">
            Delete shelf
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ),
  async play({ canvasElement }) {
    const alert = await openAlert(canvasElement, 'Delete shelf');
    await expect(within(alert).getByRole('button', { name: 'Delete shelf' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
  },
};

export const Confirm: Story = {
  render: (args) => (
    <AlertDialog {...args}>
      <AlertDialogTrigger asChild>
        <Button>Publish revision</Button>
      </AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader
          description="Your edits to The Three-Body Problem go live for every reader and enter the public revision history."
          title="Publish this revision?"
        />
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <AlertDialogAction>Publish</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ),
  async play({ canvasElement }) {
    const alert = await openAlert(canvasElement, 'Publish revision');
    await expect(within(alert).getByRole('button', { name: 'Publish' })).toBeVisible();
  },
};

export const Chinese: Story = {
  render: (args) => (
    <AlertDialog {...args}>
      <AlertDialogTrigger asChild>
        <Button variant="destructive">封禁用户</Button>
      </AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader
          description="该用户将在 30 天内无法在「科幻」Realm 发帖或评分。《三体》讨论串中的历史回复会保留。"
          title="确定封禁 @luoji_2007 吗？"
        />
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction variant="destructive">封禁 30 天</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ),
  async play({ canvasElement }) {
    const alert = await openAlert(canvasElement, '封禁用户');
    await expect(
      within(alert).getByRole('heading', { name: '确定封禁 @luoji_2007 吗？' }),
    ).toBeVisible();
  },
};

export const Dark: Story = {
  ...RemovePost,
  globals: { theme: 'dark' },
};
