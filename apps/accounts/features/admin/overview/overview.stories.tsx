import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { Overview } from './overview.tsx';
import { ago, ahead, finishedJob, noSignals, openDialog, overview, signals, support, typist, users, withAdmin } from '../story-support.tsx';
import { chinese, dark, phone } from '../../../.storybook/variants.ts';

const meta = {
  title: 'Accounts/Admin/Overview', component: Overview,
  args: { data: overview }, decorators: [withAdmin], parameters: { admin: { section: 'overview' } },
} satisfies Meta<typeof Overview>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The first screen answers “what needs me now”: severe signals first, each
 * with its evidence and why it matters, then the queues waiting on someone. */
export const NeedsReview: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    const review = canvas.getByRole('region', { name: /Needs review/ });
    await expect(within(review).getByText('4 to review')).toBeVisible();
    const rows = within(within(review).getByRole('list', { name: 'Needs review' })).getAllByRole('listitem');
    await expect(rows).toHaveLength(4);
    await expect(within(rows[0]!).getByText(/^Email changed 2 hours after a password change$/)).toBeVisible();
    await expect(within(rows[0]!).getByRole('link', { name: 'Ken Thompson' })).toHaveAttribute('href', '/admin/users/u-ken');
    await expect(within(rows[1]!).getByText('12 failed sign-ins in a day')).toBeVisible();
    await expect(within(rows[1]!).getByText('Then signed in')).toBeVisible();
    await expect(within(rows[2]!).getByText('14 accounts allowed Notes in a day')).toBeVisible();
    await expect(within(rows[2]!).getByText(/Usually about 0.6 a day/)).toBeVisible();
    await expect(within(rows[3]!).getByText('Check')).toBeVisible();
    await expect(within(rows[3]!).getByText('New passkey on an account 400 days old')).toBeVisible();
    await expect(within(review).getByText('2 reviewed in the last day')).toBeVisible();
    const suspended = canvas.getByRole('region', { name: 'Suspended' });
    await expect(within(suspended).getByText('2')).toBeVisible();
    await expect(within(suspended).getByRole('link', { name: 'View all' })).toHaveAttribute('href', '/admin/users?q=status%3Asuspended');
    // A capped count says so instead of pretending to be exact.
    await expect(within(canvas.getByRole('region', { name: 'Unverified email' })).getByText(/1,000\+/)).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Open the audit log' })).toHaveAttribute('href', '/admin/audit');
    await expect(canvas.getByText(/8 of 12 done/)).toBeVisible();
    await expect(canvas.getAllByRole('link', { name: 'Overview' })[0]).toHaveAttribute('aria-current', 'page');
  },
};

const reviewSignal = fn(async () => ({ ok: true as const, data: { status: true, requestId: 'req-review' } }));
const refreshed = fn(async () => ({ ok: true as const, data: { items: signals.items.slice(1), reviewedLastDay: 3,
  counts: { ...signals.counts, 'email-after-password': { count: 0, capped: false } } } }));
/** Reviewing records what was checked; the signal leaves the list once the service has it. */
export const Review: Story = {
  parameters: { admin: { section: 'overview', api: { reviewSignal, signals: refreshed } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Review: Email changed 2 hours after a password change' }));
    const dialog = await openDialog('dialog', 'Mark as reviewed');
    await expect(within(dialog).getByText(/leaves this list for everyone/)).toBeVisible();
    await typist.type(within(dialog).getByLabelText('What you checked (optional)'), 'Called Ken; he changed both on his new laptop');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark reviewed' }));
    await waitFor(() => expect(reviewSignal).toHaveBeenCalledWith(expect.objectContaining({ key: 'email-after-password:9b0c',
      note: 'Called Ken; he changed both on his new laptop', commandId: expect.stringMatching(/^[0-9a-f-]{36}$/) })));
    await waitFor(() => expect(screen.getByText('Marked as reviewed')).toBeVisible());
    await waitFor(() => expect(canvas.getByText('3 to review')).toBeVisible());
    await expect(canvas.getByText('3 reviewed in the last day')).toBeVisible();
  },
};

const quickReview = fn(async () => ({ ok: true as const, data: { status: true, requestId: 'req-keys' } }));
/** j/k move through the signals; r reviews the one you are on. */
export const KeyboardReview: Story = {
  parameters: { admin: { section: 'overview', api: { reviewSignal: quickReview } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await canvas.findByRole('region', { name: /Needs review/ });
    await userEvent.keyboard('jj');
    await expect(canvas.getByRole('link', { name: 'Ada Lovelace' })).toHaveFocus();
    await userEvent.keyboard('r');
    const dialog = await openDialog('dialog', 'Mark as reviewed');
    await expect(within(dialog).getByText('12 failed sign-ins in a day')).toBeVisible();
    await expect(within(dialog).getByText(/counts again from now/)).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark reviewed' }));
    await waitFor(() => expect(quickReview).toHaveBeenCalledWith(expect.objectContaining({ key: 'failed-sign-ins:u-ada' })));
  },
};

/** Nothing to review is said calmly, with what was checked. */
export const AllClear: Story = {
  args: { data: { ...overview, signals: noSignals } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Nothing needs review')).toBeVisible();
    await expect(canvas.getByText(/bursts of failed sign-ins/)).toBeVisible();
  },
};

/** Support staff review account signals, not Apps', and don't read the audit log. */
export const SupportRole: Story = {
  args: { data: { ...overview, recentActions: null, jobs: [] } }, parameters: { admin: { me: support, section: 'overview' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Review: 12 failed sign-ins in a day' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Review: 14 accounts allowed Notes in a day' })).toBeNull();
    await expect(canvas.queryByText('Recent admin actions')).toBeNull();
    await expect(canvas.queryByRole('link', { name: 'See reviews' })).toBeNull();
    await expect(canvas.queryByRole('link', { name: 'Audit log' })).toBeNull();
    await expect(canvas.queryByRole('link', { name: 'OAuth clients' })).toBeNull();
  },
};

let undone = false;
// Times are taken when asked, so the undo window is open whenever the story runs.
const waiting = fn(async () => ({ ok: true as const, data: !undone
  ? { ...finishedJob, pending: 3, succeeded: 0, skipped: 0, failed: 0, startsAt: new Date(Date.now() + 8_000).toISOString(), finishedAt: null,
    items: finishedJob.items.map(item => ({ ...item, state: 'pending' as const, error: null })) }
  : { ...finishedJob, pending: 0, succeeded: 0, skipped: 0, failed: 0, cancelled: 3, cancelledAt: ago(0), finishedAt: ago(0),
    items: finishedJob.items.map(item => ({ ...item, state: 'cancelled' as const, error: null })) } }));
const cancelJob = fn(async () => { undone = true; return { ok: true as const, data: { cancelled: 3 } }; });
/** A bulk action still in its undo window can be undone from the overview. */
export const UndoFromOverview: Story = {
  args: { data: { ...overview, jobs: [{ ...overview.jobs[0]!, startsAt: ahead(10 / 1440), pending: 12, succeeded: 0, skipped: 0 }] } },
  parameters: { admin: { section: 'overview', api: { job: waiting, cancelJob } } },
  async play({ canvasElement }) {
    undone = false;
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/Starting soon/)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Open' }));
    const dialog = await openDialog('dialog', 'Suspend 3 users?');
    await expect(within(dialog).getByText(/Nothing has changed yet/)).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(cancelJob).toHaveBeenCalledWith('job-1'));
    await waitFor(() => expect(within(dialog).getByText('Stopped: 0 done, 3 not changed')).toBeVisible());
    await expect(within(dialog).getAllByText('Not changed')).toHaveLength(3);
  },
};

const found = fn(async () => ({ ok: true as const, data: { items: users.slice(0, 1), nextCursor: null, exact: null } }));
const navigate = fn();
/** ⌘K / Ctrl-K finds users as you type and opens them. */
export const CommandPalette: Story = {
  parameters: { admin: { section: 'overview', api: { users: found }, client: { navigate } } },
  async play({ canvasElement }) {
    await within(canvasElement).findByRole('heading', { level: 1, name: 'Overview' });
    await userEvent.keyboard('{Control>}k{/Control}');
    const dialog = await openDialog('dialog', 'Command palette');
    const input = within(dialog).getByRole('combobox', { name: 'Command palette' });
    await waitFor(() => expect(input).toHaveFocus());
    await expect(within(dialog).getByRole('option', { name: /Staff & roles/ })).toBeVisible();
    await typist.type(input, 'ada');
    await waitFor(() => expect(found).toHaveBeenCalledWith(expect.objectContaining({ q: 'ada', limit: 5 }), expect.anything()));
    const option = await within(dialog).findByRole('option', { name: /Ada Lovelace/ });
    await userEvent.click(option);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/admin/users/u-ada'), { timeout: 5_000 });
  },
};

const recentNavigate = fn();
/** Two keystrokes back to someone: the palette opens on the users opened recently;
 * a pasted request ID offers its audit record. */
export const PaletteRecents: Story = {
  parameters: { admin: { section: 'overview', client: { navigate: recentNavigate } } },
  async play({ canvasElement }) {
    sessionStorage.setItem('rezics-admin-recent-users', JSON.stringify([{ id: 'u-radia', name: 'Radia Perlman', email: 'radia@example.test' }]));
    await within(canvasElement).findByRole('heading', { level: 1, name: 'Overview' });
    await userEvent.keyboard('{Control>}k{/Control}');
    const dialog = await openDialog('dialog', 'Command palette');
    await expect(await within(dialog).findByRole('option', { name: /Radia Perlman/ })).toBeVisible();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(recentNavigate).toHaveBeenCalledWith('/admin/users/u-radia'));
    await userEvent.keyboard('{Control>}k{/Control}');
    const again = await openDialog('dialog', 'Command palette');
    await userEvent.click(within(again).getByRole('combobox', { name: 'Command palette' }));
    await userEvent.paste('6d1f3c1e-3b7a-4f5e-9a51-2f6c0a1d7e11');
    await userEvent.click(await within(again).findByRole('option', { name: /Find request 6d1f3c1e… in the audit log/ }));
    await waitFor(() => expect(recentNavigate).toHaveBeenLastCalledWith('/admin/audit?range=all&request=6d1f3c1e-3b7a-4f5e-9a51-2f6c0a1d7e11'));
    sessionStorage.removeItem('rezics-admin-recent-users');
  },
};

const goNavigate = fn();
/** `?` lists the keys by where they work; g then a letter changes section. */
export const Shortcuts: Story = {
  parameters: { admin: { section: 'overview', client: { navigate: goNavigate } } },
  async play({ canvasElement }) {
    await within(canvasElement).findByRole('heading', { level: 1, name: 'Overview' });
    await userEvent.keyboard('?');
    const dialog = await openDialog('dialog', 'Keyboard shortcuts');
    await expect(within(dialog).getByText('Select or deselect the row')).toBeVisible();
    await expect(within(dialog).getByText('Go to Audit log')).toBeVisible();
    await expect(within(dialog).getByText('Review the selected signal')).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull());
    await userEvent.keyboard('ga');
    await waitFor(() => expect(goNavigate).toHaveBeenCalledWith('/admin/audit'));
  },
};

export const Dark: Story = { ...NeedsReview, globals: dark };
export const Phone: Story = {
  globals: phone,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Review: 12 failed sign-ins in a day' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Open navigation' }));
    const sheet = await openDialog('dialog', 'Admin sections');
    await expect(within(sheet).getByRole('link', { name: 'Users' })).toHaveAttribute('href', '/admin/users');
  },
};
export const Chinese: Story = {
  globals: chinese,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: '概览' })).toBeVisible();
    await expect(canvas.getByText('一天内登录失败 12 次')).toBeVisible();
    await expect(canvas.getByText('一天内有 14 个账号授权了 Notes')).toBeVisible();
    await expect(canvas.getByRole('region', { name: '已暂停' })).toBeVisible();
  },
};
