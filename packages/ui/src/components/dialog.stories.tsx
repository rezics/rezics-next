import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { dismissed, settled, withSurface } from '../stories/support.tsx';
import { Button } from './button.tsx';
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from './dialog.tsx';
import { Field, FieldError, FieldHelper, FieldLabel } from './field.tsx';
import { Input } from './input.tsx';
import { Menu, MenuContent, MenuItem, MenuTrigger } from './menu.tsx';

const meta = {
  title: 'Rezics UI/Dialog',
  component: Dialog,
  tags: ['autodocs'],
  decorators: [withSurface],
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 560 },
    },
  },
} satisfies Meta<typeof Dialog>;
export default meta;
type Story = StoryObj<typeof meta>;

const NewShelf = (props: { invalid?: boolean; saving?: boolean }) => (
  <Dialog pending={props.saving}>
    <DialogTrigger asChild>
      <Button>New shelf</Button>
    </DialogTrigger>
    <DialogContent>
      <DialogHeader
        description="Shelves group Works you are reading, want to read or have finished."
        title="Create a shelf"
      />
      <DialogBody>
        <Field invalid={props.invalid}>
          <FieldLabel>Shelf name</FieldLabel>
          <Input defaultValue={props.invalid ? '' : 'Hard science fiction'} />
          {props.invalid ? (
            <FieldError>Give the shelf a name.</FieldError>
          ) : (
            <FieldHelper>Visible on your profile to anyone you share it with.</FieldHelper>
          )}
        </Field>
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="outline">Cancel</Button>
        </DialogClose>
        <Button isLoading={props.saving}>Create shelf</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

const openDialog = async (canvasElement: HTMLElement, name: RegExp | string) => {
  await userEvent.click(within(canvasElement).getByRole('button', { name }));
  return settled(await screen.findByRole('dialog'));
};

export const Default: Story = {
  render: () => <NewShelf />,
  async play({ canvasElement }) {
    const dialog = await openDialog(canvasElement, 'New shelf');
    const title = within(dialog).getByRole('heading', { name: 'Create a shelf' });
    await expect(title).toBeVisible();
    await expect(title).toHaveClass('font-sans');
    await expect(within(dialog).getByLabelText('Shelf name')).toHaveValue('Hard science fiction');
    await expect(within(dialog).getByLabelText('Shelf name')).toHaveFocus();
  },
};

export const CloseWithKeyboard: Story = {
  render: () => <NewShelf />,
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: 'New shelf' });
    await userEvent.tab();
    await expect(trigger).toHaveFocus();
    await userEvent.keyboard(' ');
    const dialog = await settled(await screen.findByRole('dialog'));
    await userEvent.tab();
    await expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await userEvent.keyboard('{Escape}');
    await dismissed('dialog');
    await waitFor(() => expect(trigger).toHaveFocus());
  },
};

export const CloseWithButton: Story = {
  render: () => <NewShelf />,
  async play({ canvasElement }) {
    const dialog = await openDialog(canvasElement, 'New shelf');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await dismissed('dialog');
  },
};

export const Invalid: Story = {
  render: () => <NewShelf invalid />,
  async play({ canvasElement }) {
    const dialog = await openDialog(canvasElement, 'New shelf');
    await expect(within(dialog).getByText('Give the shelf a name.')).toBeVisible();
    await expect(within(dialog).getByLabelText('Shelf name')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  },
};

export const Saving: Story = {
  render: () => <NewShelf saving />,
  async play({ canvasElement }) {
    const dialog = await openDialog(canvasElement, 'New shelf');
    await expect(within(dialog).getByRole('button', { name: 'Create shelf' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await userEvent.keyboard('{Escape}');
    await expect(dialog).toBeVisible();
    await expect(within(dialog).getByRole('button', { name: 'Close' })).toBeDisabled();
    await expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
  },
};

export const MenuLaunch: Story = {
  render: () => {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Menu>
          <MenuTrigger asChild>
            <Button>Post actions</Button>
          </MenuTrigger>
          <MenuContent>
            <MenuItem value="new-shelf" onClick={() => setOpen(true)}>
              New shelf
            </MenuItem>
          </MenuContent>
        </Menu>
        <Dialog open={open} onOpenChange={({ open: next }) => setOpen(next)}>
          <DialogContent>
            <DialogHeader title="Create a shelf" />
            <DialogBody>
              <Input aria-label="Shelf name" />
            </DialogBody>
          </DialogContent>
        </Dialog>
      </>
    );
  },
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Post actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'New shelf' }));
    const dialog = await settled(await screen.findByRole('dialog'));
    await waitFor(() =>
      expect(within(dialog).getByRole('textbox', { name: 'Shelf name' })).toHaveFocus(),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(dialog).toBeVisible();
  },
};

export const ChainedDialogs: Story = {
  render: () => {
    const [step, setStep] = useState(0);
    return (
      <>
        <Button onClick={() => setStep(1)}>Start</Button>
        <Dialog
          open={step === 1}
          onOpenChange={({ open }) => {
            if (!open) setStep(2);
          }}
        >
          <DialogContent>
            <DialogHeader title="First step" />
            <DialogFooter>
              <DialogClose asChild>
                <Button>Continue</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog
          open={step === 2}
          onOpenChange={({ open }) => {
            if (!open) setStep(0);
          }}
        >
          <DialogContent>
            <DialogHeader title="Second step" />
            <DialogBody>
              <Input aria-label="Shelf name" />
            </DialogBody>
          </DialogContent>
        </Dialog>
      </>
    );
  },
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Start' }));
    const first = await settled(await screen.findByRole('dialog', { name: 'First step' }));
    await userEvent.click(within(first).getByRole('button', { name: 'Continue' }));
    const second = await settled(await screen.findByRole('dialog', { name: 'Second step' }));
    await waitFor(() =>
      expect(within(second).getByRole('textbox', { name: 'Shelf name' })).toHaveFocus(),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(second).toBeVisible();
  },
};

export const PreferredFocusAndTyping: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button>Edit shelf</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader title="Edit shelf" />
        <DialogBody className="flex flex-col gap-3">
          <Input aria-label="First field" />
          <Input aria-label="Shelf name" data-autofocus />
        </DialogBody>
      </DialogContent>
    </Dialog>
  ),
  async play({ canvasElement }) {
    const dialog = await openDialog(canvasElement, 'Edit shelf');
    const input = within(dialog).getByRole('textbox', { name: 'Shelf name' });
    await expect(input).toHaveFocus();
    await userEvent.setup({ delay: 35 }).type(input, 'Hard SF');
    await expect(input).toHaveValue('Hard SF');
    await expect(dialog).toBeVisible();
  },
};

export const OverflowingBodyFocus: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button>Realm guidelines</Button>
      </DialogTrigger>
      <DialogContent className="max-h-64">
        <DialogHeader title="Realm guidelines" />
        <DialogBody>
          {guidelines.map(([title, text]) => (
            <p className="mb-4" key={title}>
              {text}
            </p>
          ))}
        </DialogBody>
      </DialogContent>
    </Dialog>
  ),
  async play({ canvasElement }) {
    const dialog = await openDialog(canvasElement, 'Realm guidelines');
    const close = within(dialog).getByRole('button', { name: 'Close' });
    await waitFor(() => expect(close).toHaveFocus());
    await expect(dialog.querySelector('[data-slot="scroll-area-viewport"]')).toHaveAttribute(
      'tabindex',
      '0',
    );
  },
};

const guidelines = [
  [
    'Stay on the Work',
    'Discuss the Work, its editions and its reception. Off-topic threads move to the Realm lounge.',
  ],
  [
    'Mark spoilers',
    'Hide plot turns behind a spoiler tag, and name the chapter or volume they come from.',
  ],
  [
    'Rate what you read',
    'Ratings count only once you mark an edition as read. Re-rating after a re-read replaces the old score.',
  ],
  [
    'Credit translators',
    'When you quote a translation, name the translator and the edition, for example Ken Liu’s 2014 English translation.',
  ],
  [
    'No piracy links',
    'Link to publishers, libraries and legitimate stores. Moderators remove unlicensed scans without warning.',
  ],
  [
    'Report, don’t retaliate',
    'Use Report on posts that break these rules. Moderators answer reports in the order they arrive.',
  ],
  [
    'Respect other languages',
    'Posts in 中文, 日本語 and other languages are welcome; add a short English summary if you want wider replies.',
  ],
  [
    'Appeals',
    'If a moderator removes your post, you can appeal once from your inbox. A different moderator reviews it.',
  ],
];

export const LongContent: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">Realm guidelines</Button>
      </DialogTrigger>
      <DialogContent size="lg">
        <DialogHeader
          description="Read these before you post in Hard SF. Moderators apply them to every thread."
          title="Hard SF Realm guidelines"
        />
        <DialogBody scrollFade>
          <ol className="flex list-decimal flex-col gap-4 ps-5 text-sm">
            {guidelines.map(([title, text]) => (
              <li key={title}>
                <p className="font-medium">{title}</p>
                <p className="text-muted-foreground">{text}</p>
              </li>
            ))}
          </ol>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button>I understand</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
  async play({ canvasElement }) {
    const dialog = await openDialog(canvasElement, 'Realm guidelines');
    await expect(within(dialog).getByText('Appeals')).toBeInTheDocument();
  },
};

export const Small: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">Leave Realm</Button>
      </DialogTrigger>
      <DialogContent size="sm">
        <DialogHeader
          description="You stop receiving Hard SF posts in your feed. Your ratings and reviews stay public."
          title="Leave Hard SF?"
        />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Stay</Button>
          </DialogClose>
          <DialogClose asChild>
            <Button>Leave Realm</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
  async play({ canvasElement }) {
    const dialog = await openDialog(canvasElement, 'Leave Realm');
    await expect(within(dialog).getByRole('heading', { name: 'Leave Hard SF?' })).toBeVisible();
  },
};

export const WithoutCloseButton: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">Mark as read</Button>
      </DialogTrigger>
      <DialogContent showCloseButton={false} size="sm">
        <DialogHeader
          description="Finished The Three-Body Problem. Add a rating now or later from your Read shelf."
          title="Added to Read"
        />
        <DialogFooter>
          <DialogClose asChild>
            <Button>Done</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
  async play({ canvasElement }) {
    const dialog = await openDialog(canvasElement, 'Mark as read');
    await expect(within(dialog).queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  },
};

export const Chinese: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button>编辑作品信息</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader
          description="修改会进入修订记录，审核通过后对所有读者可见。"
          title="编辑《三体》的作品信息"
        />
        <DialogBody>
          <Field>
            <FieldLabel>作品标题</FieldLabel>
            <Input defaultValue="三体 (The Three-Body Problem)" />
            <FieldHelper>原文标题在前，译名放在括号中，例如 Liu Cixin 的英文版。</FieldHelper>
          </Field>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button>提交修订</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
  async play({ canvasElement }) {
    const dialog = await openDialog(canvasElement, '编辑作品信息');
    await expect(
      within(dialog).getByRole('heading', { name: '编辑《三体》的作品信息' }),
    ).toBeVisible();
  },
};

export const Dark: Story = {
  ...Invalid,
  globals: { theme: 'dark' },
};
