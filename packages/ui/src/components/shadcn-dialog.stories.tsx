import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type CSSProperties } from 'react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@rezics/ui/shadcn/alert-dialog';
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
import { Command, CommandDialog, CommandInput, CommandItem, CommandList } from '@rezics/ui/shadcn/command';
import { CoverViewer } from './cover-viewer.tsx';
import type { CoverSummary, CoverSubject } from './cover-model.ts';
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

const editFields = [
  ['profile-name', 'Display name', '林默'],
  ['profile-pronouns', 'Pronouns', 'they / them'],
  ['profile-email', 'Email address', 'lin@example.test'],
  ['profile-location', 'Location', 'Taipei'],
  ['profile-language', 'Preferred language', '繁體中文'],
  ['profile-website', 'Personal website', 'https://example.test/people/lin'],
  ['profile-work', 'Current work', 'The Three-Body Problem'],
  ['profile-note', 'Reading note', 'A long-form note for this profile'],
  ['profile-handle', 'Public handle', 'lin-mo'],
  [
    'profile-bio',
    'Biography and interests — 作品名稱作品名稱作品名稱作品名稱作品名稱作品名稱作品名稱作品名稱',
    'Writer and reader',
  ],
] as const;

function LongProfileEdit() {
  const [open, setOpen] = useState(false);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [dialogOpenChanges, setDialogOpenChanges] = useState(0);
  const [confirmationCloseRequests, setConfirmationCloseRequests] = useState(0);

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setDialogOpenChanges((count) => count + 1);
          setOpen(next);
        }}
      >
        <DialogTrigger render={<Button variant="outline" />}>Edit profile</DialogTrigger>
        <DialogContent
          id="profile-edit-dialog"
          className="modal-workflow-override sm:max-w-xl"
          style={{ '--modal-workflow-marker': 'preserved' } as CSSProperties}
        >
          <DialogHeader>
            <DialogTitle>Edit profile</DialogTitle>
            <DialogDescription>Review the profile fields, then confirm the save.</DialogDescription>
          </DialogHeader>
          <form
            className="grid min-w-0 gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              setSaveMessage('');
              setPending(false);
              setConfirmationOpen(true);
            }}
          >
            {editFields.map(([id, label, value]) => (
              <Field key={id}>
                <FieldLabel htmlFor={id}>{label}</FieldLabel>
                <Input id={id} name={id} defaultValue={value} />
              </Field>
            ))}
            {saveMessage ? <p role="status">{saveMessage}</p> : null}
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>Cancel edit</DialogClose>
              <Button type="submit">Review save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={confirmationOpen}
        onOpenChange={(next, details) => {
          if (!next) setConfirmationCloseRequests((count) => count + 1);
          if (!next && pending) {
            details.cancel();
            return;
          }
          setConfirmationOpen(next);
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Save profile changes?</AlertDialogTitle>
            <AlertDialogDescription>
              The profile and its long biography will be updated together. You can keep editing until the save is
              confirmed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pending ? <p role="status">Save is pending. Dismissal is held until the result arrives.</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Keep editing</AlertDialogCancel>
            <AlertDialogAction type="button" onClick={() => setPending(true)}>
              Save now
            </AlertDialogAction>
          </AlertDialogFooter>
          {pending ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setPending(false);
                  setSaveMessage('The save was refused. Your edits are still open.');
                }}
              >
                Resolve as refused
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setPending(false);
                  setConfirmationOpen(false);
                  setOpen(false);
                }}
              >
                Finish save
              </Button>
            </div>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>
      <span
        aria-hidden="true"
        className="sr-only"
        data-testid="modal-callback-counts"
        data-dialog={dialogOpenChanges}
        data-confirmation-close={confirmationCloseRequests}
      />
    </>
  );
}

const expectReachableIn = (panel: HTMLElement, target: HTMLElement) => {
  target.scrollIntoView({ block: 'nearest' });
  const panelBounds = panel.getBoundingClientRect();
  const targetBounds = target.getBoundingClientRect();
  expect(targetBounds.top).toBeGreaterThanOrEqual(panelBounds.top);
  expect(targetBounds.bottom).toBeLessThanOrEqual(panelBounds.bottom);
};

const expectWithinViewport = (panel: HTMLElement) => {
  const bounds = panel.getBoundingClientRect();
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
  expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
};

export const LongFormWorkflow: Story = {
  render: () => <LongProfileEdit />,
  globals: { viewport: { value: 'phone390', isRotated: true } },
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: 'Edit profile' });
    const callbackCounts = () => {
      const counts = canvasElement.querySelector<HTMLElement>('[data-testid="modal-callback-counts"]')!;
      return {
        dialog: Number(counts.dataset.dialog),
        confirmationClose: Number(counts.dataset.confirmationClose),
      };
    };
    await userEvent.click(trigger);
    const dialog = await settled(await screen.findByRole('dialog', { name: 'Edit profile' }));
    expect(callbackCounts()).toEqual({ dialog: 1, confirmationClose: 0 });
    expect(dialog).toHaveAttribute('id', 'profile-edit-dialog');
    expect(dialog).toHaveClass('modal-workflow-override');
    expect(dialog.style.getPropertyValue('--modal-workflow-marker')).toBe('preserved');
    expect(dialog.scrollHeight).toBeGreaterThan(dialog.clientHeight);
    expectWithinViewport(dialog);

    const firstField = within(dialog).getByLabelText('Display name');
    const lastField = within(dialog).getByLabelText(/Biography and interests/);
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expectReachableIn(dialog, lastField);
    expectReachableIn(dialog, within(dialog).getByRole('button', { name: 'Close' }));
    expectReachableIn(dialog, firstField);
    expectReachableIn(dialog, within(dialog).getByRole('button', { name: 'Review save' }));
    expectReachableIn(dialog, within(dialog).getByRole('button', { name: 'Cancel edit' }));
    await userEvent.clear(firstField);
    await userEvent.type(firstField, 'Edited before save');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Review save' }));

    const confirmation = await settled(await screen.findByRole('alertdialog', { name: 'Save profile changes?' }));
    expectWithinViewport(confirmation);
    await waitFor(() => expect(confirmation.contains(document.activeElement)).toBe(true));
    await userEvent.click(within(confirmation).getByRole('button', { name: 'Save now' }));
    await expect(within(confirmation).getByRole('status')).toHaveTextContent(/Save is pending/);
    await userEvent.click(within(confirmation).getByRole('button', { name: 'Keep editing' }));
    expect(callbackCounts()).toEqual({ dialog: 1, confirmationClose: 1 });
    await expect(screen.getByRole('alertdialog', { name: 'Save profile changes?' })).toBeVisible();
    await userEvent.click(within(confirmation).getByRole('button', { name: 'Resolve as refused' }));
    await userEvent.click(within(confirmation).getByRole('button', { name: 'Keep editing' }));
    await gone();
    expect(callbackCounts()).toEqual({ dialog: 1, confirmationClose: 2 });
    await expect(screen.getByRole('dialog', { name: 'Edit profile' })).toBeVisible();
    const refusedDialog = screen.getByRole('dialog', { name: 'Edit profile' });
    await expect(within(refusedDialog).getByRole('status')).toHaveTextContent(/save was refused/i);
    const retainedField = within(refusedDialog).getByLabelText('Display name');
    expect(retainedField).toBe(firstField);
    await expect(retainedField).toHaveValue('Edited before save');
    await waitForFocus(within(refusedDialog).getByRole('button', { name: 'Review save' }));
    await userEvent.click(within(refusedDialog).getByRole('button', { name: 'Cancel edit' }));
    await gone();
    expect(callbackCounts()).toEqual({ dialog: 2, confirmationClose: 2 });
    await waitForFocus(trigger);

    await userEvent.click(trigger);
    const reviewDialog = await settled(await screen.findByRole('dialog', { name: 'Edit profile' }));
    expect(callbackCounts()).toEqual({ dialog: 3, confirmationClose: 2 });
    await userEvent.click(within(reviewDialog).getByRole('button', { name: 'Review save' }));
    const secondConfirmation = await settled(await screen.findByRole('alertdialog', { name: 'Save profile changes?' }));
    await waitFor(() => expect(secondConfirmation.contains(document.activeElement)).toBe(true));
    await userEvent.click(within(secondConfirmation).getByRole('button', { name: 'Save now' }));
    await userEvent.click(within(secondConfirmation).getByRole('button', { name: 'Finish save' }));
    await gone();
    expect(callbackCounts()).toEqual({ dialog: 3, confirmationClose: 2 });
    await waitForFocus(trigger);

    await userEvent.click(trigger);
    const reopened = await settled(await screen.findByRole('dialog', { name: 'Edit profile' }));
    expect(callbackCounts()).toEqual({ dialog: 4, confirmationClose: 2 });
    const reopenedName = within(reopened).getByLabelText('Display name');
    await userEvent.clear(reopenedName);
    await userEvent.type(reopenedName, 'Edited through the native input');
    await expect(reopenedName).toHaveValue('Edited through the native input');
    await userEvent.click(within(reopened).getByRole('button', { name: 'Close' }));
    await gone();
    expect(callbackCounts()).toEqual({ dialog: 5, confirmationClose: 2 });
    await waitForFocus(trigger);
  },
};

const availableCommands = [
  'Open collection',
  'Browse subjects',
  'Edit profile',
  'Manage labels',
  'Create list',
  'Review reports',
  'Open settings',
  'Find a reader',
  'Switch realm',
  'Import works',
  'Manage zones',
];

function NestedCommandPalette() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Open command palette
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen} title="Commands" description="Choose a site command">
        <Command>
          <CommandInput placeholder="Find a command" />
          <CommandList aria-label="Available commands">
            {availableCommands.map((command) => (
              <CommandItem key={command} value={command}>
                {command}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}

export const NestedScrollCompatibility: Story = {
  render: () => <NestedCommandPalette />,
  globals: { viewport: { value: 'phone390' } },
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: 'Open command palette' });
    await userEvent.click(trigger);
    const dialog = await settled(await screen.findByRole('dialog', { name: 'Commands' }));
    expectWithinViewport(dialog);
    expect(getComputedStyle(dialog).overflowY).toBe('hidden');
    const list = within(dialog).getByRole('listbox', { name: 'Available commands' });
    expect(getComputedStyle(list).overflowY).toBe('auto');
    const finalCommand = within(list).getByRole('option', { name: 'Manage zones' });
    finalCommand.scrollIntoView({ block: 'nearest' });
    expect(list.scrollTop).toBeGreaterThan(0);
    const listBounds = list.getBoundingClientRect();
    const commandBounds = finalCommand.getBoundingClientRect();
    expect(commandBounds.top).toBeGreaterThanOrEqual(listBounds.top);
    expect(commandBounds.bottom).toBeLessThanOrEqual(listBounds.bottom);
    await userEvent.keyboard('{Escape}');
    await gone();
    await waitForFocus(trigger);
  },
};

const coverSubject: CoverSubject = {
  id: 'cover-viewer-compatibility',
  title: 'The Wind-Up Bird Chronicle',
  types: ['schema:Book', 'schema:CreativeWork'],
  byline: 'Haruki Murakami',
};

const coverSummary: CoverSummary = {
  media: 'cover-viewer-compatibility',
  width: 1200,
  height: 1800,
  placeholder: { thumbhash: '3OcRJYB4d3h/iIeHeEh3eIhw+j3A', color: '#36516a' },
  variants: [{ format: 'webp', width: 640 }],
  focalPoint: null,
  credit: {
    rightsHolder: 'Fictional Publisher With A Long Multiword Attribution',
    via: { name: 'Public catalogue', url: 'https://example.test/catalogue' },
    license: 'Rights reserved',
  },
};

function FullScreenCoverViewer() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Open cover viewer
      </Button>
      <CoverViewer
        subject={coverSubject}
        cover={coverSummary}
        src={() =>
          `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 180"><rect width="120" height="180" fill="#36516a"/></svg>')}`
        }
        labels={{ title: 'Cover viewer', via: 'via', close: 'Close cover' }}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

export const FullScreenCoverCompatibility: Story = {
  render: () => <FullScreenCoverViewer />,
  globals: { viewport: { value: 'phone390', isRotated: true } },
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: 'Open cover viewer' });
    await userEvent.click(trigger);
    const dialog = await settled(await screen.findByRole('dialog', { name: 'Cover viewer' }));
    await expect(dialog).toHaveClass('w-fit', 'overflow-auto');
    expectWithinViewport(dialog);
    const image = within(dialog).getByRole('img', { name: coverSubject.title });
    const imageBounds = image.getBoundingClientRect();
    const dialogBounds = dialog.getBoundingClientRect();
    expect(imageBounds.height).toBeGreaterThan(0);
    expect(imageBounds.top).toBeGreaterThanOrEqual(dialogBounds.top);
    expect(imageBounds.bottom).toBeLessThanOrEqual(dialogBounds.bottom);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close cover' }));
    await gone();
    await waitForFocus(trigger);
  },
};
