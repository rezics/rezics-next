import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@rezics/ui/shadcn/dialog';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { waitForFocus } from '../test/focus.ts';
import { settled, withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Dialog',
  component: Dialog,
  tags: ['autodocs'],
  decorators: [withSurface],
  parameters: { docs: { story: { inline: false, iframeHeight: 560 } } },
} satisfies Meta<typeof Dialog>;
export default meta;
type Story = StoryObj<typeof meta>;

const NewShelf = () => (
  <Dialog>
    <DialogTrigger render={<Button />}>New shelf</DialogTrigger>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Create a shelf</DialogTitle>
        <DialogDescription>Shelves group Works you are reading, want to read or have finished.</DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor="dialog-shelf-name">Shelf name</FieldLabel>
        <Input id="dialog-shelf-name" defaultValue="Hard science fiction" />
      </Field>
      <DialogFooter showCloseButton>
        <Button>Create shelf</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

const gone = () => waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

export const Default: Story = {
  render: () => <NewShelf />,
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: 'New shelf' });
    await userEvent.click(trigger);
    const dialog = await settled(await screen.findByRole('dialog', { name: 'Create a shelf' }));
    await expect(dialog).toHaveAccessibleDescription(/Shelves group Works/);
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await userEvent.keyboard('{Escape}');
    await gone();
    await waitForFocus(trigger);
  },
};

export const CloseButton: Story = {
  render: () => <NewShelf />,
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'New shelf' }));
    const dialog = await settled(await screen.findByRole('dialog'));
    await userEvent.click(within(dialog).getAllByRole('button', { name: 'Close' })[0]!);
    await gone();
  },
};

export const WithoutCloseIcon: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" />}>Delete shelf</DialogTrigger>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Delete this shelf?</DialogTitle>
          <DialogDescription>The Works on it stay in your library.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Keep shelf</DialogClose>
          <Button variant="destructive">Delete shelf</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Delete shelf' }));
    const dialog = await settled(await screen.findByRole('dialog', { name: 'Delete this shelf?' }));
    await expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep shelf' }));
    await gone();
  },
};
