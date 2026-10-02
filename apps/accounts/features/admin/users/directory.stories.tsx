import { chooseOption } from '../../shell/select.fixture.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { UserDirectory } from './directory.tsx';
import { ada, ago, finishedJob, grace, hedy, radia, openDialog, users, withAdmin } from '../story-support.tsx';
import { chinese, dark, phone } from '../../../.storybook/variants.ts';

const initialState = { text: '', sort: 'createdAt' as const, direction: 'desc' as const, cursor: null };
const meta = {
  title: 'Accounts/Admin/Users', component: UserDirectory,
  args: { initialState, initial: { status: 'ok', data: { items: users, nextCursor: 'next', exact: null } },
    preferences: { density: 'comfortable', columns: null, views: [{ id: 'reports', name: 'Abuse reports', query: 'status:suspended -role:none' }] } },
  decorators: [withAdmin], parameters: { admin: { section: 'users' } },
} satisfies Meta<typeof UserDirectory>;
export default meta;
type Story = StoryObj<typeof meta>;
const typist = userEvent.setup({ delay: 20 });

export const Directory: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
    const table = canvas.getByRole('table', { name: 'Users' });
    await expect(within(table).getByRole('columnheader', { name: /Created/ })).toHaveAttribute('aria-sort', 'descending');
    await expect(within(table).getByRole('columnheader', { name: /Name/ })).not.toHaveAttribute('aria-sort');
    await expect(within(table).getAllByRole('row')).toHaveLength(users.length + 1);
    await expect(within(table).getByRole('link', { name: 'Radia Perlman' })).toHaveAttribute('href', '/admin/users/u-radia');
    await expect(canvas.getByRole('link', { name: 'Abuse reports' })).toHaveAttribute('href',
      `/admin/users?q=${encodeURIComponent('status:suspended -role:none')}`);
    await expect(canvas.getByText('More users match')).toBeVisible();
  },
};

const exportUsers = fn(async () => ({ ok: true as const, data: {
  blob: new Blob(['id,name,email\r\n']), rows: 1, truncated: false } }));
const savedFile = fn();
export const DownloadFilteredUsers: Story = {
  args: { initialState: { ...initialState, text: 'status:suspended' },
    initial: { status: 'ok', data: { items: [radia], nextCursor: null, exact: null } } },
  parameters: { admin: { section: 'users', api: { exportUsers }, client: { download: savedFile } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(exportUsers).toHaveBeenCalledWith(expect.objectContaining({ status: 'suspended' })));
    await expect(exportUsers).toHaveBeenLastCalledWith(expect.not.objectContaining({ cursor: expect.anything() }));
    await expect(savedFile).toHaveBeenCalledWith(expect.any(Blob), expect.stringMatching(/^rezics-account-users-.*\.csv$/));
  },
};

const search = fn(async () => ({ ok: true as const, data: { items: [radia], nextCursor: null, exact: null } }));
const replaceUrl = fn();
/** Filters are text; the service is asked once typing pauses, and the URL keeps the search. */
export const SearchAsYouType: Story = {
  parameters: { admin: { section: 'users', api: { users: search }, client: { replaceUrl } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await typist.type(await canvas.findByRole('searchbox', { name: 'Search users' }), 'status:suspended -role:none');
    await waitFor(() => expect(search).toHaveBeenCalledWith(expect.objectContaining({ status: 'suspended',
      role: 'owner,admin,support' }), expect.anything()));
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    await waitFor(() => expect(replaceUrl).toHaveBeenLastCalledWith('/admin/users?q=status%3Asuspended+-role%3Anone', false), { timeout: 5_000 });
    await expect(canvas.getByRole('button', { name: 'Remove filter Status: Suspended' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Remove filter Role: any staff role' })).toBeVisible();
    await waitFor(() => expect(within(canvas.getByRole('table')).getAllByRole('row')).toHaveLength(2));
    await typist.type(canvas.getByRole('searchbox'), ' handle:ada');
    await expect(await canvas.findByText(/Accounts don’t have handles/)).toBeVisible();
  },
};

const exact = fn(async () => ({ ok: true as const, data: { items: [], nextCursor: null, exact: ada } }));
const navigate = fn();
/** An exact email or ID is offered wherever it sorts; Enter opens it. */
export const ExactJump: Story = {
  parameters: { admin: { section: 'users', api: { users: exact }, client: { navigate } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await typist.type(await canvas.findByRole('searchbox'), 'ada@example.test');
    await expect(await canvas.findByText('Exact match: Ada Lovelace')).toBeVisible();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/admin/users/u-ada'), { timeout: 5_000 });
  },
};

export const NoMatches: Story = {
  args: { initialState: { ...initialState, text: 'zzz' }, initial: { status: 'ok', data: { items: [], nextCursor: null, exact: null } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'No users match' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Clear search and filters' })).toBeVisible();
  },
};

export const NothingYet: Story = {
  args: { initial: { status: 'ok', data: { items: [], nextCursor: null, exact: null } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'No users yet' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Clear search and filters' })).toBeNull();
  },
};

const pending = fn(() => new Promise<never>(() => {}));
/** A failed read offers Retry; retrying keeps the columns with skeleton rows. */
export const ErrorAndRetry: Story = {
  args: { initial: { status: 'error', code: 'temporarily_unavailable' } },
  parameters: { admin: { section: 'users', api: { users: pending } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Couldn’t load this: temporarily_unavailable.')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Try again' }));
    const table = await canvas.findByRole('table');
    await expect(table).toHaveAttribute('aria-busy', 'true');
    await expect(within(table).getByRole('columnheader', { name: /Last sign-in/ })).toBeVisible();
  },
};

const bulk = fn(async () => ({ ok: true as const, data: { jobId: finishedJob.id } }));
const reauthenticate = fn(async () => ({ ok: true as const, data: { verifiedUntil: new Date().toISOString() } }));
/** j/k move, x selects; the toolbar turns into bulk actions. The dialog
 * previews who would change and who is left out (already suspended), sends
 * only those who change, then shows each user's result. */
export const KeyboardAndBulk: Story = {
  parameters: { admin: { section: 'users', api: { bulk, reauthenticate } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await canvas.findByRole('table');
    await userEvent.keyboard('jxjjx');
    await expect(canvas.getByRole('link', { name: '李明' })).not.toHaveFocus();
    await expect(canvas.getByRole('link', { name: 'Radia Perlman' })).toHaveFocus();
    const toolbar = canvas.getByRole('toolbar', { name: '2 selected' });
    await userEvent.click(within(toolbar).getByRole('button', { name: 'Suspend…' }));
    const dialog = await openDialog('alertdialog', 'Suspend 1 user?');
    await expect(within(dialog).getByText('1 will change')).toBeVisible();
    await expect(within(dialog).getByText(/— Ada Lovelace/)).toBeVisible();
    await expect(within(dialog).getByText('1 is already in that state and is left out')).toBeVisible();
    await expect(within(dialog).getByText(/Nothing changes for 10 seconds/)).toBeVisible();
    await chooseOption(within(dialog).getByRole('combobox', { name: 'Reason' }), 'spam');
    await typist.type(within(dialog).getByLabelText('Details for the audit log'), 'Coordinated spam wave');
    await typist.type(within(dialog).getByLabelText('Type 1 to confirm'), '1');
    await typist.type(within(dialog).getByLabelText('Your password'), 'correct horse');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(reauthenticate).toHaveBeenCalledWith('correct horse', undefined), { timeout: 5_000 });
    await waitFor(() => expect(bulk).toHaveBeenCalledWith(expect.objectContaining({ action: 'suspend', reasonCode: 'spam', reason: 'Coordinated spam wave',
      userIds: ['u-ada'], undoSeconds: 10 })), { timeout: 5_000 });
    // The job's dialog replaces the form once the service has admitted it, then polls the job.
    await waitFor(() => expect(screen.getByText('1 done · 1 unchanged · 1 failed')).toBeVisible(), { timeout: 5_000 });
    await expect(screen.getByText(/staff accounts need an owner/)).toBeVisible();
  },
};

let undone = false;
const scheduledJob = fn(async () => ({ ok: true as const, data: undone
  ? { ...finishedJob, total: 2, pending: 0, succeeded: 0, skipped: 0, failed: 0, cancelled: 2, finishedAt: ago(0), cancelledAt: ago(0),
    items: finishedJob.items.slice(0, 2).map(item => ({ ...item, state: 'cancelled' as const, error: null })) }
  : { ...finishedJob, total: 2, pending: 2, succeeded: 0, skipped: 0, failed: 0, startsAt: new Date(Date.now() + 9_000).toISOString(), finishedAt: null,
    items: finishedJob.items.slice(0, 2).map(item => ({ ...item, state: 'pending' as const, error: null })) } }));
const undo = fn(async () => { undone = true; return { ok: true as const, data: { cancelled: 2 } }; });
const resend = fn(async () => ({ ok: true as const, data: { jobId: 'job-3' } }));
/** A bulk action waits out its undo window with a countdown; Undo cancels all of it. */
export const UndoWindow: Story = {
  parameters: { admin: { section: 'users', api: { bulk: resend, job: scheduledJob, cancelJob: undo } } },
  async play({ canvasElement }) {
    undone = false;
    const canvas = within(canvasElement);
    const table = await canvas.findByRole('table');
    await userEvent.click(within(table).getByRole('checkbox', { name: `Select ${ada.name}` }));
    await userEvent.click(within(table).getByRole('checkbox', { name: `Select ${hedy.name}` }));
    await userEvent.click(within(canvas.getByRole('toolbar')).getByRole('button', { name: 'Sign out everywhere…' }));
    const form = await openDialog('alertdialog', 'Sign 2 users out everywhere?');
    await chooseOption(within(form).getByRole('combobox', { name: 'Reason' }), 'support');
    await typist.type(within(form).getByLabelText('Details for the audit log'), 'Asked to sign out');
    await userEvent.click(within(form).getByRole('button', { name: 'Sign out everywhere' }));
    const job = await openDialog('dialog', 'Sign 2 users out everywhere?');
    await expect(within(job).getByText(/Starts in \d+ seconds\. Nothing has changed yet\./)).toBeVisible();
    await userEvent.click(within(job).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(undo).toHaveBeenCalledWith('job-3'));
    await waitFor(() => expect(within(job).getByText('Stopped: 0 done, 2 not changed')).toBeVisible());
    await waitFor(() => expect(screen.getByText('Undone. Nothing was changed.')).toBeVisible());
  },
};

const pages = fn(async (params: { cursor?: string }) => ({ ok: true as const, data: params.cursor
  ? { items: users.slice(3), nextCursor: null, exact: null } : { items: users.slice(0, 3), nextCursor: 'next', exact: null } }));
/** A selection survives paging: pick some here, some on the next page. */
export const SelectionAcrossPages: Story = {
  args: { initial: { status: 'ok', data: { items: users.slice(0, 3), nextCursor: 'next', exact: null } } },
  parameters: { admin: { section: 'users', api: { users: pages } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(within(await canvas.findByRole('table')).getByRole('checkbox', { name: `Select ${ada.name}` }));
    await userEvent.click(canvas.getByRole('button', { name: 'Next page' }));
    await userEvent.click(await within(canvas.getByRole('table')).findByRole('checkbox', { name: `Select ${grace.name}` }));
    const toolbar = canvas.getByRole('toolbar', { name: '2 selected' });
    await expect(within(toolbar).getByText('including 1 on another page')).toBeVisible();
  },
};

/** Staff rows offer only notes to a non-owner: only owners act on staff. */
export const StaffRowActions: Story = {
  parameters: { admin: { section: 'users', me: { ...(await import('../story-support.tsx')).owner, role: 'admin',
    permissions: ['users:read', 'users:suspend', 'sessions:revoke', 'password:require-reset', 'verification:send', 'notes:write',
      'clients:manage', 'audit:read'] } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: `Actions for ${grace.name}` }));
    const menu = await screen.findByRole('menu');
    await expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Add note…']);
  },
};

export const Compact: Story = { parameters: { admin: { section: 'users', density: 'compact' } }, play: Directory.play };
export const Dark: Story = { ...Directory, globals: dark };
/** On a phone the directory is a list of cards, with the same selection and actions. */
export const Phone: Story = {
  globals: phone,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('searchbox', { name: 'Search users' })).toBeVisible();
    await expect(canvas.queryByRole('table')).toBeNull();
    const list = canvas.getByRole('list', { name: 'Users' });
    await expect(within(list).getByRole('link', { name: 'Radia Perlman' })).toHaveAttribute('href', '/admin/users/u-radia');
    await userEvent.click(within(list).getByRole('checkbox', { name: `Select ${radia.name}` }));
    await expect(canvas.getByRole('toolbar', { name: '1 selected' })).toBeVisible();
    await expect(canvasElement.ownerDocument.documentElement.scrollWidth).toBeLessThanOrEqual(canvasElement.ownerDocument.documentElement.clientWidth);
  },
};
export const Chinese: Story = {
  globals: chinese,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: '用户' })).toBeVisible();
    await expect(canvas.getByRole('columnheader', { name: /创建时间/ })).toHaveAttribute('aria-sort', 'descending');
  },
};
