import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { UserPage } from './user-page.tsx';
import { auditPage, detail, operators, radia, settled, withAdmin } from '../story-support.tsx';
import { chinese, dark, phone } from '../../../.storybook/variants.ts';

const meta = {
  title: 'Accounts/Admin/User', component: UserPage,
  args: { initial: detail(radia), data: { tab: 'overview' } }, decorators: [withAdmin], parameters: { admin: { section: 'users' } },
} satisfies Meta<typeof UserPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Suspended: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Radia Perlman' })).toBeVisible();
    const status = canvas.getByRole('region', { name: 'Status' });
    await expect(within(status).getByText('Abuse or harassment')).toBeVisible();
    await expect(within(status).getByText('Harassment report #1182 under review')).toBeVisible();
    const tabs = canvas.getByRole('navigation', { name: 'User sections' });
    await expect(within(tabs).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    await expect(within(tabs).getByRole('link', { name: 'Sanctions' })).toHaveAttribute('href', '?tab=sanctions');
    await expect(canvas.getByRole('button', { name: 'Lift suspension…' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Suspend…' })).toBeNull();
    await expect(canvas.getByText('Reporter sent screenshots; waiting for the Realm moderators before lifting.')).toBeVisible();
  },
};

const act = fn(async () => ({ ok: true as const, data: { status: true, requestId: 'req-1' } }));
const reauthenticate = fn(async () => ({ ok: true as const, data: { verifiedUntil: new Date().toISOString() } }));
/** The worst actions need the user's email typed and the operator's password;
 * the page changes only after the service confirms. */
export const SuspendWithFriction: Story = {
  args: { initial: detail({ ...radia, status: 'active', suspendedAt: null, suspendedUntil: null, suspensionReason: null, suspensionCode: null }) },
  parameters: { admin: { section: 'users', api: { act, reauthenticate } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Suspend…' }));
    const dialog = await settled(await screen.findByRole('alertdialog', { name: 'Suspend Radia Perlman?' }));
    await expect(within(dialog).getByText(/They are signed out on every device/)).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(within(dialog).getByText('That doesn’t match.')).toBeVisible());
    await expect(act).not.toHaveBeenCalled();
    await userEvent.selectOptions(within(dialog).getByLabelText('Reason'), 'abuse');
    await userEvent.type(within(dialog).getByLabelText('Details for the audit log'), 'Harassment report #1190');
    await userEvent.type(within(dialog).getByLabelText('Message to the user (optional)'), 'We received reports of harassment.');
    await userEvent.selectOptions(within(dialog).getByLabelText('Duration'), 'month');
    await userEvent.type(within(dialog).getByLabelText('Type radia@example.test to confirm'), 'radia@example.test');
    await userEvent.type(within(dialog).getByLabelText('Your password'), 'correct horse');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    await expect(reauthenticate).toHaveBeenCalledWith('correct horse', undefined);
    await expect(act).toHaveBeenCalledWith('u-radia', expect.objectContaining({ action: 'suspend', reasonCode: 'abuse',
      reason: 'Harassment report #1190', userMessage: 'We received reports of harassment.', expiresAt: expect.stringMatching(/^\d{4}-/) }));
    // Toasts slide in; wait for the confirmation to settle.
    await waitFor(() => expect(screen.getByText('Radia Perlman is suspended')).toBeVisible());
  },
};

// Storybook resets queued mock values between stories, so the first answer is counted here.
let staleCalls = 0;
const stale = fn(async () => staleCalls++ === 0 ? { ok: false as const, code: 'step_up_required' as const, status: 403 }
  : { ok: true as const, data: { status: true, requestId: 'req-2' } });
const confirm = fn(async () => ({ ok: true as const, data: { verifiedUntil: new Date().toISOString() } }));
/** An old sign-in is confirmed in the same dialog, then the same command is retried. */
export const StepUpThenRetry: Story = {
  parameters: { admin: { section: 'users', api: { act: stale, reauthenticate: confirm } } },
  async play({ canvasElement }) {
    staleCalls = 0;
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Sign out everywhere…' }));
    const dialog = await settled(await screen.findByRole('alertdialog', { name: 'Sign Radia Perlman out everywhere?' }));
    await expect(within(dialog).queryByLabelText('Your password')).toBeNull();
    await userEvent.selectOptions(within(dialog).getByLabelText('Reason'), 'user-request');
    await userEvent.type(within(dialog).getByLabelText('Details for the audit log'), 'Lost a laptop');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));
    await expect(await within(dialog).findByText('Confirm it’s you to continue.')).toBeVisible();
    await userEvent.type(within(dialog).getByLabelText('Your password'), 'correct horse');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));
    await expect(confirm).toHaveBeenCalledWith('correct horse', undefined);
    await waitFor(() => expect(stale).toHaveBeenCalledTimes(2));
    const [first, second] = stale.mock.calls as unknown as [[string, { commandId: string }], [string, { commandId: string }]];
    await expect(second[1].commandId).toBe(first[1].commandId);
    await waitFor(() => expect(screen.getByText('Radia Perlman is signed out everywhere')).toBeVisible());
  },
};

const note = fn(async () => ({ ok: false as const, code: 'temporarily_unavailable' as const, status: 503 }));
/** A note shows as pending; if it isn't saved, the text stays for another try. */
export const NoteNotSaved: Story = {
  parameters: { admin: { section: 'users', api: { act: note } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Add note' }));
    const text = canvas.getByRole('textbox', { name: 'Add a note about Radia Perlman' });
    await userEvent.type(text, 'Called the reporter back.');
    await userEvent.click(canvas.getByRole('button', { name: 'Save note' }));
    await expect(await canvas.findByText(/The note wasn’t saved/)).toBeVisible();
    await expect(text).toHaveValue('Called the reporter back.');
    await expect(note).toHaveBeenCalledWith('u-radia', expect.objectContaining({ action: 'add-note', note: 'Called the reporter back.' }));
  },
};

export const Security: Story = {
  args: { data: { tab: 'security' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('region', { name: 'Sign-in methods' })).toBeVisible();
    await expect(canvas.getByText('MacBook Touch ID')).toBeVisible();
    await expect(canvas.getByText('Firefox · Linux', { selector: 'p' })).toBeVisible();
    await expect(canvas.getByText('2 failed sign-ins in the last 24 hours')).toBeVisible();
    await expect(canvas.getByText('Failed sign-in')).toBeVisible();
  },
};

export const Sanctions: Story = {
  args: { data: { tab: 'sanctions', page: { items: auditPage.items.slice(0, 2), nextCursor: null } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const history = await canvas.findByRole('region', { name: 'Sanctions' });
    await expect(within(history).getAllByRole('listitem')).toHaveLength(2);
    await expect(within(history).getByText('Account compromised')).toBeVisible();
  },
};

const setRole = fn(async () => ({ ok: true as const, data: { status: true, requestId: 'req-3' } }));
/** Owners change roles; making someone an owner needs their email and a password. */
export const Roles: Story = {
  args: { data: { tab: 'roles', permissions: operators.permissions } },
  parameters: { admin: { section: 'users', api: { setRole } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Change role' }));
    const dialog = await settled(await screen.findByRole('alertdialog', { name: 'Change the role of Radia Perlman' }));
    await userEvent.click(within(dialog).getByRole('radio', { name: /^Admin/ }));
    await expect(within(dialog).queryByLabelText('Your password')).toBeNull();
    await userEvent.click(within(dialog).getByRole('radio', { name: /^Owner/ }));
    await expect(within(dialog).getByLabelText('Your password')).toBeVisible();
    await userEvent.click(within(dialog).getByRole('radio', { name: /^Support/ }));
    await userEvent.type(within(dialog).getByLabelText('Why (for the audit log)'), 'Joining the support rotation');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Change role' }));
    await expect(setRole).toHaveBeenCalledWith('u-radia', 'support', 'Joining the support rotation');
  },
};

export const Apps: Story = {
  args: { data: { tab: 'apps' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Notes')).toBeVisible();
    await expect(canvas.getByText('Read your Works')).toBeVisible();
  },
};

export const Dark: Story = { ...Suspended, globals: dark };
export const Phone: Story = { ...Suspended, globals: phone };
export const Chinese: Story = {
  globals: chinese,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: '解除暂停…' })).toBeVisible();
    await expect(canvas.getByText('滥用或骚扰')).toBeVisible();
  },
};
