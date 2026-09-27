import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { settled, withTheme } from '../stories/support.tsx';
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

const meta = {
  title: 'Rezics UI/Dialog',
  component: Dialog,
  tags: ['autodocs'],
  decorators: [withTheme],
  parameters: {
    docs: {
      description: {
        component:
          'A modal window for a short, focused task that must finish or be dismissed before the page continues: creating a shelf, editing a Work’s details, writing a moderation note. It traps focus, closes on Escape and returns focus to its trigger. On phones it sticks to the bottom edge (`bottomStickOnMobile`). Use an alert dialog for irreversible confirmations, a sheet for side panels that keep context, and a popover for light, non-blocking choices.',
      },
      story: { inline: false, iframeHeight: 560 },
    },
  },
} satisfies Meta<typeof Dialog>;
export default meta;
type Story = StoryObj<typeof meta>;

const NewShelf = (props: { invalid?: boolean; saving?: boolean }) => (
  <Dialog>
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
    await expect(within(dialog).getByRole('heading', { name: 'Create a shelf' })).toBeVisible();
    await expect(within(dialog).getByLabelText('Shelf name')).toHaveValue('Hard science fiction');
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
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  },
};

export const CloseWithButton: Story = {
  render: () => <NewShelf />,
  async play({ canvasElement }) {
    const dialog = await openDialog(canvasElement, 'New shelf');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
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
  parameters: { theme: 'dark' },
};
