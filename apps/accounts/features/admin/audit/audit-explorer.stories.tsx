import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { AuditExplorer } from './audit-explorer.tsx';
import { auditPage, withAdmin } from '../story-support.tsx';
import { chinese, dark } from '../../../.storybook/variants.ts';

const initialState = { range: '7d' as const, action: null, outcome: null, actor: null, target: null };
const meta = {
  title: 'Accounts/Admin/Audit log', component: AuditExplorer,
  args: { initialState, initial: { status: 'ok', data: auditPage }, names: { actor: null, target: null } },
  decorators: [withAdmin], parameters: { admin: { section: 'audit' } },
} satisfies Meta<typeof AuditExplorer>;
export default meta;
type Story = StoryObj<typeof meta>;

const audit = fn(async () => ({ ok: true as const, data: { items: auditPage.items.slice(2, 3), nextCursor: null } }));
const replaceUrl = fn();
/** Filters live in the URL; a record opens to its changes and can narrow the log to its actor. */
export const Explore: Story = {
  parameters: { admin: { section: 'audit', api: { audit }, client: { replaceUrl } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const table = await canvas.findByRole('table', { name: 'Audit records' });
    await expect(within(table).getAllByRole('row')).toHaveLength(auditPage.items.length + 1);
    await userEvent.click(within(table).getAllByRole('button', { name: 'Details' })[0]!);
    await expect(await canvas.findByRole('rowheader', { name: 'status' })).toBeVisible();
    await expect(canvas.getByText('suspended')).toBeVisible();
    await userEvent.selectOptions(canvas.getByLabelText('Outcome'), 'failed');
    await waitFor(() => expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', from: expect.stringMatching(/^\d{4}-/) })));
    await expect(replaceUrl).toHaveBeenLastCalledWith('/admin/audit?outcome=failed');
    await waitFor(() => expect(within(canvas.getByRole('table')).getAllByRole('row')).toHaveLength(2));
    await userEvent.click(within(canvas.getByRole('table')).getByRole('button', { name: 'Details' }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Only actions by Margaret Hamilton' }));
    await expect(await canvas.findByText('Staff member: Margaret Hamilton')).toBeVisible();
    await expect(replaceUrl).toHaveBeenLastCalledWith('/admin/audit?outcome=failed&actor=u-margaret');
  },
};

const download = fn();
export const ExportCsv: Story = {
  parameters: { admin: { section: 'audit', client: { download } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(download).toHaveBeenCalledWith(expect.any(Blob), expect.stringMatching(/^rezics-account-audit-.*\.csv$/)));
  },
};

export const NoMatches: Story = {
  args: { initialState: { ...initialState, outcome: 'attempted' }, initial: { status: 'ok', data: { items: [], nextCursor: null } } },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByText('No records match these filters.')).toBeVisible();
  },
};

export const Dark: Story = { ...NoMatches, globals: dark };
export const Chinese: Story = {
  globals: chinese,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: '审计日志' })).toBeVisible();
    await expect(within(canvas.getByRole('table')).getByText('要求重置密码')).toBeVisible();
  },
};
