import { chooseOption } from '../../shell/select.fixture.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { UserPage } from './user-page.tsx';
import { detail, openDialog, operators, radia, signalList, timeline, typist, withAdmin } from '../story-support.tsx';
import { chinese, dark, phone } from '../../../.storybook/variants.ts';

const meta = {
  title: 'Accounts/Admin/User', component: UserPage,
  args: { initial: detail(radia), data: { tab: 'overview', show: 'all' } }, decorators: [withAdmin], parameters: { admin: { section: 'users' } },
} satisfies Meta<typeof UserPage>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The whole story on one page: status and why, the timeline of security
 * events, staff actions (with the message the user got) and notes, devices
 * grouped by browser, sign-in methods and apps. */
export const Suspended: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Radia Perlman' })).toBeVisible();
    const status = canvas.getByRole('region', { name: 'Status' });
    await expect(within(status).getByText('Abuse or harassment')).toBeVisible();
    await expect(within(status).getByText('Harassment report #1182 under review')).toBeVisible();
    const tabs = canvas.getByRole('navigation', { name: 'User sections' });
    await expect(within(tabs).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    await expect(within(tabs).getByRole('link', { name: 'Security' })).toHaveAttribute('href', '/admin/users/u-radia?tab=security');
    await expect(within(tabs).queryByRole('link', { name: 'Sanctions' })).toBeNull();
    await expect(canvas.getByRole('button', { name: 'Lift suspension…' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Suspend…' })).toBeNull();
    const story = canvas.getByRole('region', { name: 'Timeline' });
    await expect(within(story).getByText('Suspended')).toBeVisible();
    await expect(within(story).getByText(/We received reports of harassment/)).toBeVisible();
    await expect(within(story).getByText('Staff note')).toBeVisible();
    // The suspension's two signed-out devices read as one line until opened.
    await expect(within(story).getAllByText('Device signed out')).toHaveLength(1);
    await userEvent.click(within(story).getByRole('button', { name: '2 times' }));
    await expect(within(story).getAllByText('Device signed out')).toHaveLength(2);
    await expect(within(story).getByText('Failed sign-in')).toBeVisible();
    await expect(within(story).getByText('with a password')).toBeVisible();
    await expect(within(story).getByText('App allowed')).toBeVisible();
    await expect(within(story).getByText('Notes')).toBeVisible();
    await expect(within(story).getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(1);
    const devices = canvas.getByRole('region', { name: 'Signed-in devices' });
    await expect(within(devices).getByText('REZICS · Firefox · Linux')).toBeVisible();
    await expect(within(devices).getByText('2 sessions')).toBeVisible();
    await expect(within(devices).getByText('Safari · iOS')).toBeVisible();
    await expect(within(canvas.getByRole('region', { name: 'Sign-in methods' })).getByText('1 passkey')).toBeVisible();
    await expect(within(canvas.getByRole('region', { name: 'Notes' })).getByText('Reporter sent screenshots; waiting for the Realm moderators before lifting.')).toBeVisible();
  },
};

const story = fn(async () => ({ ok: true as const, data: { items: timeline.items.slice(0, 2), nextCursor: null } }));
const storyUrl = fn();
/** The timeline filters to one kind of event, kept in the address. */
export const TimelineFilter: Story = {
  parameters: { admin: { section: 'users', api: { timeline: story }, client: { replaceUrl: storyUrl } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const panel = await canvas.findByRole('region', { name: 'Timeline' });
    await expect(within(panel).getByRole('button', { name: 'Everything' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(panel).getByRole('button', { name: 'Staff' }));
    await waitFor(() => expect(story).toHaveBeenCalledWith('u-radia', { category: 'staff' }));
    await waitFor(() => expect(storyUrl).toHaveBeenCalledWith('/admin/users/u-radia?show=staff'));
    await waitFor(() => expect(within(panel).queryByText('Failed sign-in')).toBeNull());
    await expect(within(panel).getByRole('button', { name: 'Staff' })).toHaveAttribute('aria-pressed', 'true');
  },
};

const more = fn(async () => ({ ok: true as const, data: { items: [{ ...timeline.items[6]!, id: 't8', action: 'password_changed' }], nextCursor: null } }));
export const TimelineMore: Story = {
  parameters: { admin: { section: 'users', api: { timeline: more } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const panel = await canvas.findByRole('region', { name: 'Timeline' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(more).toHaveBeenCalledWith('u-radia', { category: 'all', cursor: 'more' }));
    await expect(await within(panel).findByText('Password changed')).toBeVisible();
    await expect(within(panel).queryByRole('button', { name: 'Load more' })).toBeNull();
  },
};

const reviewSignal = fn(async () => ({ ok: true as const, data: { status: true, requestId: 'req-user' } }));
/** Open signals about this person sit above their story, with Review. */
export const NeedsReview: Story = {
  args: { initial: detail(radia, { signals: [{ ...signalList[3]!, subject: { kind: 'user', id: radia.id, name: radia.name, email: radia.email } }] }) },
  parameters: { admin: { section: 'users', api: { reviewSignal } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const review = await canvas.findByRole('region', { name: 'Needs review' });
    await expect(within(review).getByText('New passkey on an account 400 days old')).toBeVisible();
    await userEvent.click(within(review).getByRole('button', { name: /^Review:/ }));
    const dialog = await openDialog('dialog', 'Mark as reviewed');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark reviewed' }));
    await waitFor(() => expect(reviewSignal).toHaveBeenCalledWith(expect.objectContaining({ key: 'new-passkey:3e1f' })));
    await waitFor(() => expect(canvas.queryByRole('region', { name: 'Needs review' })).toBeNull());
  },
};

/** n adds a note from anywhere on the story. */
export const NoteByKeyboard: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await canvas.findByRole('region', { name: 'Timeline' });
    await userEvent.keyboard('n');
    await waitFor(() => expect(canvas.getByRole('textbox', { name: 'Add a note about Radia Perlman' })).toHaveFocus());
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
    const dialog = await openDialog('alertdialog', 'Suspend Radia Perlman?');
    await expect(within(dialog).getByText(/They are signed out on every device/)).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(within(dialog).getByText('That doesn’t match.')).toBeVisible());
    await expect(act).not.toHaveBeenCalled();
    await chooseOption(within(dialog).getByRole('combobox', { name: 'Reason' }), 'abuse');
    await typist.type(within(dialog).getByLabelText('Details for the audit log'), 'Harassment report #1190');
    await typist.type(within(dialog).getByLabelText('Message to the user (optional)'), 'We received reports of harassment.');
    await chooseOption(within(dialog).getByRole('combobox', { name: 'Duration' }), 'month');
    await typist.type(within(dialog).getByLabelText('Type radia@example.test to confirm'), 'radia@example.test');
    await typist.type(within(dialog).getByLabelText('Your password'), 'correct horse');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(reauthenticate).toHaveBeenCalledWith('correct horse', undefined), { timeout: 5_000 });
    await waitFor(() => expect(act).toHaveBeenCalledWith('u-radia', expect.objectContaining({ action: 'suspend', reasonCode: 'abuse',
      reason: 'Harassment report #1190', userMessage: 'We received reports of harassment.', expiresAt: expect.stringMatching(/^\d{4}-/) })), { timeout: 5_000 });
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
    const dialog = await openDialog('alertdialog', 'Sign Radia Perlman out everywhere?');
    await expect(within(dialog).queryByLabelText('Your password')).toBeNull();
    await chooseOption(within(dialog).getByRole('combobox', { name: 'Reason' }), 'user-request');
    await typist.type(within(dialog).getByLabelText('Details for the audit log'), 'Lost a laptop');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));
    await expect(await within(dialog).findByText('Confirm it’s you to continue.', {}, { timeout: 5_000 })).toBeVisible();
    await typist.type(within(dialog).getByLabelText('Your password'), 'correct horse');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith('correct horse', undefined), { timeout: 5_000 });
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
    await typist.type(text, 'Called the reporter back.');
    await userEvent.click(canvas.getByRole('button', { name: 'Save note' }));
    await expect(await canvas.findByText(/The note wasn’t saved/)).toBeVisible();
    await expect(text).toHaveValue('Called the reporter back.');
    await waitFor(() => expect(note).toHaveBeenCalledWith('u-radia', expect.objectContaining({ action: 'add-note', note: 'Called the reporter back.' })), { timeout: 5_000 });
  },
};

export const Security: Story = {
  args: { data: { tab: 'security' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('region', { name: 'Sign-in methods' })).toBeVisible();
    await expect(canvas.getByText('MacBook Touch ID')).toBeVisible();
    await expect(canvas.getByText('REZICS · Firefox · Linux')).toBeVisible();
    await expect(canvas.getByText('2 failed sign-ins in the last 24 hours')).toBeVisible();
    await expect(canvas.getByText('Failed sign-in')).toBeVisible();
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
    const dialog = await openDialog('alertdialog', 'Change the role of Radia Perlman');
    await userEvent.click(within(dialog).getByRole('radio', { name: /^Admin/ }));
    await expect(within(dialog).queryByLabelText('Your password')).toBeNull();
    await userEvent.click(within(dialog).getByRole('radio', { name: /^Owner/ }));
    await expect(within(dialog).getByLabelText('Your password')).toBeVisible();
    await userEvent.click(within(dialog).getByRole('radio', { name: /^Support/ }));
    await typist.type(within(dialog).getByLabelText('Why (for the audit log)'), 'Joining the support rotation');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Change role' }));
    await waitFor(() => expect(setRole).toHaveBeenCalledWith('u-radia', 'support', 'Joining the support rotation'), { timeout: 5_000 });
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
/** On a phone: status first, then the story; nothing scrolls sideways. */
export const Phone: Story = {
  globals: phone,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const status = await canvas.findByRole('region', { name: 'Status' });
    const story = canvas.getByRole('region', { name: 'Timeline' });
    await expect(status.compareDocumentPosition(story) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await expect(canvasElement.ownerDocument.documentElement.scrollWidth).toBeLessThanOrEqual(canvasElement.ownerDocument.documentElement.clientWidth);
  },
};
export const Chinese: Story = {
  globals: chinese,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: '解除暂停…' })).toBeVisible();
    await expect(within(canvas.getByRole('region', { name: '状态' })).getByText('滥用或骚扰')).toBeVisible();
    await expect(within(canvas.getByRole('region', { name: '时间线' })).getByText('员工备注')).toBeVisible();
    await expect(canvas.getByRole('button', { name: '员工' })).toBeVisible();
  },
};
