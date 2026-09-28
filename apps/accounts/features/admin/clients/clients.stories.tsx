import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { ClientsPage } from './clients.tsx';
import { clients, openDialog, typist, withAdmin } from '../story-support.tsx';
import { dark, phone } from '../../../.storybook/variants.ts';

const meta = {
  title: 'Accounts/Admin/OAuth clients', component: ClientsPage,
  args: { clients }, decorators: [withAdmin], parameters: { admin: { section: 'clients' } },
} satisfies Meta<typeof ClientsPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Clients: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const table = await canvas.findByRole('table', { name: 'OAuth clients' });
    const notes = within(table).getAllByRole('row').find(row => row.textContent?.includes('Notes'))!;
    await expect(within(notes).getByText('Disabled')).toBeVisible();
    await expect(within(notes).getByText('Revoked')).toBeVisible();
    await userEvent.click(within(table).getByRole('button', { name: 'Details of REZICS' }));
    await expect(await canvas.findByText('https://rezics.test/auth/callback')).toBeVisible();
    await expect(within(table).getByRole('button', { name: 'Details of REZICS' })).toHaveAttribute('aria-expanded', 'true');
  },
};

const manyScopes = Array.from({ length: 76 }, (_, index) => `permission:${index}`);
export const ManyScopes: Story = {
  args: { clients: { nextCursor: null, items: [{ ...clients.items[0]!, scopes: manyScopes }] } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const count = await canvas.findByRole('button', { name: '76 scopes' });
    await expect(canvas.queryByText(manyScopes.join(' '))).not.toBeInTheDocument();
    await userEvent.click(count);
    await expect(canvas.getByText(manyScopes.join(' '))).toBeVisible();
    await expect(count).toHaveAttribute('aria-expanded', 'true');
  },
};

const setClient = fn(async () => ({ ok: true as const, data: { status: true, requestId: 'req-6' } }));
const refresh = fn();
/** Disabling breaks the App for everyone: type its name and confirm with a password. */
export const Disable: Story = {
  parameters: { admin: { section: 'clients', api: { setClient }, client: { refresh } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Actions for REZICS' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Disable…' }));
    const dialog = await openDialog('alertdialog', 'Disable REZICS?');
    await typist.type(within(dialog).getByLabelText('Details for the audit log'), 'Leaked secret in a public repo');
    await typist.type(within(dialog).getByLabelText('Type REZICS to confirm'), 'REZICS');
    await typist.type(within(dialog).getByLabelText('Your password'), 'correct horse');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(setClient).toHaveBeenCalledWith('rezics-web', expect.objectContaining({ action: 'disable',
      reason: 'Leaked secret in a public repo' })), { timeout: 5_000 });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  },
};

export const Empty: Story = {
  args: { clients: { items: [], nextCursor: null } },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByText('No OAuth clients are registered.')).toBeVisible();
  },
};

/** An App signal links here with `?client=`: that App opens with its details. */
export const FocusedFromSignal: Story = {
  args: { focus: 'notes-app' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Details of Notes' })).toHaveAttribute('aria-expanded', 'true');
    await expect(canvas.getByRole('button', { name: 'Details of REZICS' })).toHaveAttribute('aria-expanded', 'false');
  },
};

export const Dark: Story = { ...Clients, globals: dark };
export const Phone: Story = { ...ManyScopes, globals: phone };
