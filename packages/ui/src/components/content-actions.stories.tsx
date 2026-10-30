import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { waitForFocus } from '../test/focus.ts';
import { dismissed, highlighted } from '../test/waits.ts';
import { settled, withSurface } from '../stories/support.tsx';
import { ContentActions } from './content-actions.tsx';

const meta = {
  title: 'Components/Content Actions',
  component: ContentActions,
  tags: ['autodocs'],
  decorators: [withSurface],
  args: {
    onCopyLink: fn(),
    onReport: fn(async () => undefined),
    ownsContent: false,
    verified: true,
  },
  parameters: { docs: { story: { inline: false, iframeHeight: 520 } } },
} satisfies Meta<typeof ContentActions>;
export default meta;
type Story = StoryObj<typeof meta>;

const StrangerActions = () => (
  <ContentActions
    onCopyLink={fn()}
    onReport={fn(async () => undefined)}
    ownsContent={false}
    verification={
      <div aria-label="Human verification" role="group">
        Complete the verification challenge
      </div>
    }
    verified
  />
);

const ownerActions = {
  copy: fn(),
  edit: fn(),
  delete: fn(async () => undefined),
};

const OwnerActionsDemo = () => (
  <ContentActions
    onCopyLink={ownerActions.copy}
    onDelete={ownerActions.delete}
    onEdit={ownerActions.edit}
    ownsContent
  />
);

export const MenuKeyboard: Story = {
  args: {
    onCopyLink: fn(),
    onReport: fn(async () => undefined),
    ownsContent: false,
    verified: true,
  },
  render: () => <StrangerActions />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: 'More actions' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const menu = await settled(await screen.findByRole('menu'));
    await highlighted(() => within(menu).getAllByRole('menuitem')[0]!);
    // A key pressed before the menu takes focus goes to the trigger and is lost.
    await waitForFocus([menu, ...within(menu).getAllByRole('menuitem')]);
    await userEvent.keyboard('{End}');
    await highlighted(() => within(menu).getAllByRole('menuitem').at(-1)!);
    await userEvent.keyboard('{Enter}');

    const dialog = await settled(await screen.findByRole('dialog', { name: 'Report this content' }));
    const illegal = within(dialog).getByRole('radio', { name: 'Illegal activity' });
    await expect(illegal).toHaveAccessibleDescription('This content may break the law.');
    await userEvent.click(illegal);
    await expect(within(dialog).getByRole('textbox', { name: 'Additional details' })).toBeRequired();
    await expect(within(dialog).getByRole('group', { name: 'Human verification' })).toBeVisible();
    await waitFor(() => expect(menu).not.toBeInTheDocument());
  },
};
export const MenuOpenPhone: Story = {
  args: { onCopyLink: fn(), onReport: fn(async () => undefined), ownsContent: false, verified: true },
  render: () => <StrangerActions />,
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'More actions' }));
    await expect(await screen.findByRole('dialog')).toBeVisible();
    await expect(screen.getByRole('button', { name: 'Report' })).toBeVisible();
  },
};

export const OwnerActions: Story = {
  args: {
    onCopyLink: fn(),
    onDelete: fn(async () => undefined),
    onEdit: fn(),
    ownsContent: true,
  },
  render: () => <OwnerActionsDemo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'More actions' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Report' })).not.toBeInTheDocument();

    await userEvent.click(canvas.getByRole('button', { name: 'More actions' }));
    const menu = await settled(await screen.findByRole('menu'));
    await expect(within(menu).getByRole('menuitem', { name: 'Copy link' })).toBeVisible();
    await expect(within(menu).getByRole('menuitem', { name: 'Edit' })).toBeVisible();
    await expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toBeVisible();
    await expect(within(menu).queryByRole('menuitem', { name: 'Report' })).not.toBeInTheDocument();
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Copy link' }));
    await expect(ownerActions.copy).toHaveBeenCalledTimes(1);
    await dismissed('menu');

    await userEvent.click(canvas.getByRole('button', { name: 'More actions' }));
    const editMenu = await settled(await screen.findByRole('menu'));
    await userEvent.click(within(editMenu).getByRole('menuitem', { name: 'Edit' }));
    await expect(ownerActions.edit).toHaveBeenCalledTimes(1);
    await dismissed('menu');

    await userEvent.click(canvas.getByRole('button', { name: 'More actions' }));
    const deleteMenu = await settled(await screen.findByRole('menu'));
    await userEvent.click(within(deleteMenu).getByRole('menuitem', { name: 'Delete' }));
    const confirmation = await settled(await screen.findByRole('alertdialog', { name: 'Delete this content?' }));
    await expect(within(confirmation).getByRole('button', { name: 'Cancel' })).toBeVisible();
    await userEvent.click(within(confirmation).getByRole('button', { name: 'Delete content' }));
    await waitFor(() => expect(ownerActions.delete).toHaveBeenCalledTimes(1));
    await dismissed('alertdialog');
  },
};
