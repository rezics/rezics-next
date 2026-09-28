import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { AuditExplorer } from './audit-explorer.tsx';
import type { AuditState } from './state.ts';
import { auditPage, typist, withAdmin } from '../story-support.tsx';
import { chinese, dark, phone } from '../../../.storybook/variants.ts';

const initialState: AuditState = { range: '7d', from: null, to: null, action: null, outcome: null, reason: null, actor: null,
  target: null, request: null, text: null };
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
    await expect(within(table).getAllByRole('button', { name: 'Details' })).toHaveLength(auditPage.items.length);
    await userEvent.click(within(table).getAllByRole('button', { name: 'Details' })[0]!);
    await expect(await canvas.findByRole('rowheader', { name: 'status' })).toBeVisible();
    await expect(canvas.getByText('suspended')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Copy link' })).toBeVisible();
    await userEvent.selectOptions(canvas.getByLabelText('Outcome'), 'failed');
    await waitFor(() => expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', from: expect.stringMatching(/^\d{4}-/) })));
    await waitFor(() => expect(replaceUrl).toHaveBeenLastCalledWith('/admin/audit?outcome=failed'), { timeout: 5_000 });
    await waitFor(() => expect(within(canvas.getByRole('table')).getAllByRole('button', { name: 'Details' })).toHaveLength(1));
    await userEvent.click(within(canvas.getByRole('table')).getByRole('button', { name: 'Details' }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Only actions by Margaret Hamilton' }));
    await expect(await canvas.findByText('Staff member: Margaret Hamilton')).toBeVisible();
    await waitFor(() => expect(replaceUrl).toHaveBeenLastCalledWith('/admin/audit?outcome=failed&actor=u-margaret'), { timeout: 5_000 });
  },
};

const searched = fn(async () => ({ ok: true as const, data: { items: auditPage.items.slice(0, 1), nextCursor: null } }));
const searchUrl = fn();
/** One box takes words, `actor:`/`target:` with an email or ID, and a pasted
 * request ID; each becomes a removable chip and a URL parameter. */
export const SearchTheLog: Story = {
  parameters: { admin: { section: 'audit', api: { audit: searched }, client: { replaceUrl: searchUrl } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const box = await canvas.findByRole('searchbox', { name: 'Search the audit log' });
    await typist.type(box, 'actor:olive@rezics.test #1182{Enter}');
    await waitFor(() => expect(searched).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'olive@rezics.test', q: '#1182' })));
    await expect(canvas.getByText('Staff member: olive@rezics.test')).toBeVisible();
    await expect(canvas.getByText('“#1182”')).toBeVisible();
    await waitFor(() => expect(searchUrl).toHaveBeenLastCalledWith('/admin/audit?actor=olive%40rezics.test&q=%231182'));
    await userEvent.click(canvas.getByRole('button', { name: 'Clear the words' }));
    await waitFor(() => expect(searched).toHaveBeenLastCalledWith(expect.not.objectContaining({ q: expect.anything() })));
    await userEvent.clear(box);
    await typist.type(box, '6d1f3c1e-3b7a-4f5e-9a51-2f6c0a1d7e11{Enter}');
    await waitFor(() => expect(searched).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: '6d1f3c1e-3b7a-4f5e-9a51-2f6c0a1d7e11' })));
    // A single record found by its request opens straight to its details.
    await expect(await canvas.findByRole('rowheader', { name: 'status' })).toBeVisible();
    await userEvent.selectOptions(canvas.getByLabelText('Reason'), 'abuse');
    await waitFor(() => expect(searched).toHaveBeenLastCalledWith(expect.objectContaining({ reasonCode: 'abuse' })));
  },
};

const customUrl = fn();
const custom = fn(async () => ({ ok: true as const, data: auditPage }));
/** Custom UTC dates, both included. */
export const CustomDates: Story = {
  parameters: { admin: { section: 'audit', api: { audit: custom }, client: { replaceUrl: customUrl } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(await canvas.findByLabelText('Period'), 'custom');
    const from = canvas.getByLabelText('From (UTC)');
    await userEvent.clear(from);
    await userEvent.type(from, '2026-09-01');
    await waitFor(() => expect(custom).toHaveBeenLastCalledWith(expect.objectContaining({ from: '2026-09-01T00:00:00.000Z',
      to: expect.stringMatching(/T00:00:00\.000Z$/) })));
    await waitFor(() => expect(customUrl).toHaveBeenLastCalledWith(expect.stringMatching(/^\/admin\/audit\?range=custom&from=2026-09-01&to=/)));
  },
};

/** Opens the Export menu and picks an item from that menu, not from one still closing. */
async function exportAs(canvasElement: HTMLElement, item: string) {
  const trigger = await within(canvasElement).findByRole('button', { name: 'Export' });
  await userEvent.click(trigger);
  const menu = await waitFor(() => {
    const content = document.getElementById(trigger.getAttribute('aria-controls') ?? '');
    if (content?.getAttribute('data-state') !== 'open') throw new Error('The Export menu is not open');
    return content;
  });
  await userEvent.click(within(menu).getByRole('menuitem', { name: item }));
}

const download = fn();
const exportAudit = fn(async () => ({ ok: true as const, data: { blob: new Blob(['{}\n']), rows: 4, truncated: false } }));
/** JSON Lines carry each record's before and after, for machines. */
export const ExportJsonLines: Story = {
  parameters: { admin: { section: 'audit', api: { exportAudit }, client: { download } } },
  async play({ canvasElement }) {
    await exportAs(canvasElement, 'Export JSON Lines (with before and after)');
    await waitFor(() => expect(exportAudit).toHaveBeenCalledWith(expect.objectContaining({ from: expect.stringMatching(/^\d{4}-/) }), 'jsonl'));
    await waitFor(() => expect(download).toHaveBeenCalledWith(expect.any(Blob), expect.stringMatching(/^rezics-account-audit-.*\.jsonl$/)));
  },
};

const csvDownload = fn();
/** CSV for spreadsheets. */
export const ExportCsv: Story = {
  parameters: { admin: { section: 'audit', client: { download: csvDownload } } },
  async play({ canvasElement }) {
    await exportAs(canvasElement, 'Export CSV');
    await waitFor(() => expect(csvDownload).toHaveBeenCalledWith(expect.any(Blob), expect.stringMatching(/^rezics-account-audit-.*\.csv$/)));
  },
};

export const NoMatches: Story = {
  args: { initialState: { ...initialState, outcome: 'attempted' }, initial: { status: 'ok', data: { items: [], nextCursor: null } } },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByText('No records match these filters.')).toBeVisible();
  },
};

export const Dark: Story = { ...Explore, parameters: { admin: { section: 'audit' } }, globals: dark,
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('table', { name: 'Audit records' })).toBeVisible();
  } };
/** On a phone each record is a card that opens in place. */
export const Phone: Story = {
  globals: phone,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole('list', { name: 'Audit records' });
    const cards = within(list).getAllByRole('button', { expanded: false });
    await expect(cards).toHaveLength(auditPage.items.length);
    await userEvent.click(cards[0]!);
    await expect(await within(list).findByRole('rowheader', { name: 'status' })).toBeVisible();
  },
};
export const Chinese: Story = {
  globals: chinese,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: '审计日志' })).toBeVisible();
    await expect(within(canvas.getByRole('table')).getByText('要求重置密码')).toBeVisible();
  },
};
