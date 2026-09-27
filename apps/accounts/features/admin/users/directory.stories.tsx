import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { UserDirectory } from './directory.tsx';
import { ada, finishedJob, grace, radia, settled, users, withAdmin } from '../story-support.tsx';
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
    await expect(search).toHaveBeenCalledTimes(1);
    await expect(replaceUrl).toHaveBeenLastCalledWith('/admin/users?q=status%3Asuspended+-role%3Anone', false);
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
    await expect(navigate).toHaveBeenCalledWith('/admin/users/u-ada');
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
/** j/k move, x selects; the toolbar turns into bulk actions with count, sample, reason and progress. */
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
    const dialog = await settled(await screen.findByRole('alertdialog', { name: 'Suspend 2 users?' }));
    await expect(within(dialog).getByText(/Including Ada Lovelace and Radia Perlman/)).toBeVisible();
    await userEvent.selectOptions(within(dialog).getByLabelText('Reason'), 'spam');
    await userEvent.type(within(dialog).getByLabelText('Details for the audit log'), 'Coordinated spam wave');
    await userEvent.type(within(dialog).getByLabelText('Type 2 to confirm'), '2');
    await userEvent.type(within(dialog).getByLabelText('Your password'), 'correct horse');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    await expect(reauthenticate).toHaveBeenCalledWith('correct horse', undefined);
    await expect(bulk).toHaveBeenCalledWith(expect.objectContaining({ action: 'suspend', reasonCode: 'spam', reason: 'Coordinated spam wave',
      userIds: ['u-ada', 'u-radia'] }));
    // The job's dialog replaces the form once the service has admitted it, then polls the job.
    await waitFor(() => expect(screen.getByText('1 done · 1 unchanged · 1 failed')).toBeVisible(), { timeout: 5_000 });
    await expect(screen.getByText(/staff accounts need an owner/)).toBeVisible();
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
export const Phone: Story = {
  globals: phone,
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('searchbox', { name: 'Search users' })).toBeVisible();
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
