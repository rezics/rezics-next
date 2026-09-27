import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { Overview } from './overview.tsx';
import { overview, settled, support, users, withAdmin } from '../story-support.tsx';
import { chinese, dark, phone } from '../../../.storybook/variants.ts';

const meta = {
  title: 'Accounts/Admin/Overview', component: Overview,
  args: { data: overview }, decorators: [withAdmin], parameters: { admin: { section: 'overview' } },
} satisfies Meta<typeof Overview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WorkQueues: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    const suspended = canvas.getByRole('region', { name: 'Suspended' });
    await expect(within(suspended).getByText('2')).toBeVisible();
    await expect(within(suspended).getByRole('link', { name: /Radia Perlman/ })).toHaveAttribute('href', '/admin/users/u-radia');
    await expect(within(suspended).getByRole('link', { name: 'View all' })).toHaveAttribute('href', '/admin/users?q=status%3Asuspended');
    // A capped count says so instead of pretending to be exact.
    await expect(within(canvas.getByRole('region', { name: 'Unverified email' })).getByText(/1,000\+/)).toBeVisible();
    await expect(within(canvas.getByRole('region', { name: 'Repeated failed sign-ins' })).getByText('Nothing waiting')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Open the audit log' })).toHaveAttribute('href', '/admin/audit');
    await expect(canvas.getByText('8 of 12 done')).toBeVisible();
    await expect(canvas.getAllByRole('link', { name: 'Overview' })[0]).toHaveAttribute('aria-current', 'page');
  },
};

/** Support staff don't read the audit log, so the panel doesn't offer it. */
export const SupportRole: Story = {
  args: { data: { ...overview, recentActions: null, jobs: [] } }, parameters: { admin: { me: support, section: 'overview' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await expect(canvas.queryByText('Recent admin actions')).toBeNull();
    await expect(canvas.queryByRole('link', { name: 'Audit log' })).toBeNull();
    await expect(canvas.queryByRole('link', { name: 'OAuth clients' })).toBeNull();
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
    const dialog = await settled(await screen.findByRole('dialog', { name: 'Command palette' }));
    const input = within(dialog).getByRole('combobox', { name: 'Command palette' });
    await waitFor(() => expect(input).toHaveFocus());
    await expect(within(dialog).getByRole('option', { name: /Staff & roles/ })).toBeVisible();
    await userEvent.type(input, 'ada', { delay: 30 });
    await waitFor(() => expect(found).toHaveBeenCalledWith(expect.objectContaining({ q: 'ada', limit: 5 }), expect.anything()));
    const option = await within(dialog).findByRole('option', { name: /Ada Lovelace/ });
    await userEvent.click(option);
    await expect(navigate).toHaveBeenCalledWith('/admin/users/u-ada');
  },
};

/** `?` lists the keyboard shortcuts. */
export const Shortcuts: Story = {
  async play({ canvasElement }) {
    await within(canvasElement).findByRole('heading', { level: 1, name: 'Overview' });
    await userEvent.keyboard('?');
    const dialog = await settled(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' }));
    await expect(within(dialog).getByText('Select or deselect the row')).toBeVisible();
  },
};

export const Dark: Story = { ...WorkQueues, globals: dark };
export const Phone: Story = {
  globals: phone,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Open navigation' }));
    const sheet = await settled(await screen.findByRole('dialog', { name: 'Admin sections' }));
    await expect(within(sheet).getByRole('link', { name: 'Users' })).toHaveAttribute('href', '/admin/users');
  },
};
export const Chinese: Story = {
  globals: chinese,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: '概览' })).toBeVisible();
    await expect(canvas.getByRole('region', { name: '已暂停' })).toBeVisible();
    await expect(canvas.getByText('多次登录失败')).toBeVisible();
  },
};
