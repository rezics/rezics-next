import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { acting, adminApi, agents, basisFor, header, members, names, now, outgoingInvitations, publishedRules,
  queue, queueApi, queuePage, realm, roles, settings } from './fixtures.ts';
import { decideReport, reportDecision } from './commands.ts';
import { MembersView } from './members-view.tsx';
import { messages } from './messages.ts';
import { QueueView, outcomeOf } from './queue-view.tsx';
import type { QueueApi } from './queue-api.ts';
import { RealmFrame } from './realm-frame.tsx';
import { decisionReceipt, recoveryReasons } from './recovery-fixtures.ts';
import { RolesView } from './roles-view.tsx';
import { readReportAttempt, retainCommand, type ReportAttempt } from './safety-pending.ts';
import { SettingsView } from './settings-view.tsx';
import type { MainClient, ModerationItem, RoleCommand } from './types.ts';

const report = queue.find(item => item.kind === 'content_report')!;
const body = () => within(document.body);
const sent: { body: unknown; key: string }[] = [];
let complete = false;
let previews = 0;
const admin = adminApi();
const lostAdmin = { ...admin,
  preview: async (command: RoleCommand) => { previews++; return admin.preview(command); },
  changeRole: async (...args: Parameters<typeof admin.changeRole>) => {
    sent.push({ body: { command: args[0], digest: args[1] }, key: args[2] });
    return sent.length === 1 ? { ok: false as const, failure: 'unavailable' as const } : admin.changeRole(...args);
  },
  saveSettings: async (...args: Parameters<typeof admin.saveSettings>) => {
    sent.push({ body: args[0], key: args[1] });
    return sent.length === 1 ? { ok: false as const, failure: 'unavailable' as const } : admin.saveSettings(...args);
  },
};
function seed(item: ModerationItem, action: 'remove' | 'interim-restrict' | 'final-restrict') {
  const command = reportDecision(basisFor(item), action, 'The reported revision breaches the rule.', acting.iri, 'retained-key')!;
  const attempt: ReportAttempt = { realm, actingSubject: acting.iri, key: 'retained-key', item,
    decision: { action, reason: recoveryReasons.facts, note: null, reasons: recoveryReasons },
    input: { ...command, reasons: recoveryReasons }, status: 'pending' };
  retainCommand(`report:${item.id}`, attempt);
  return attempt;
}
function recoveryApi(item: ModerationItem): QueueApi {
  const post = async (input: unknown, options: { headers: { 'idempotency-key': string } }) => {
    sent.push({ body: input, key: options.headers['idempotency-key'] });
    return { data: decisionReceipt(item, complete ? 'completed' : 'accepted'), error: null };
  };
  const main = { v1: { moderation: { decisions: { post } }, rights: { restrictions: { post } }, realms: () => {
    throw new Error('Resume must not read a new decision basis');
  } } } as unknown as MainClient;
  return { ...queueApi(), commit: (target, decision, key) => decideReport(main, realm, target, decision, acting.iri, key) };
}
function ReloadableQueue({ item }: { item: ModerationItem }) {
  const [version, setVersion] = useState(0);
  return <>
    <button type="button" onClick={() => setVersion(value => value + 1)}>Reload queue</button>
    <QueueView key={version} realm={realm} actingSubject={acting.iri} view={{ state: 'open', type: null }}
      initial={{ ...queuePage, items: version ? [] : [item], nextCursor: null }} names={names} now={now}
      realmRules={publishedRules()} locale="en" messages={messages} api={recoveryApi(item)} />
  </>;
}
const frame = (children: ReactNode) => <RealmFrame realm={realm} header={header} agent={acting}
  locale="en" messages={messages}>{children}</RealmFrame>;
const meta = {
  title: 'Manage/Recoverable operations',
  parameters: { route: { pathname: `/en/manage/r/${realm}` } },
  beforeEach() {
    sent.length = 0; complete = false; previews = 0;
    // Remove only this isolated fixture's recovery records and draft.
    const prefix = `rezics:manage:command:${encodeURIComponent(realm)}:${encodeURIComponent(acting.iri)}:`;
    for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
    localStorage.removeItem(`rezics:manage:rules-draft:${realm}`);
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const RemovePending: Story = {
  beforeEach: () => { seed(report, 'remove'); },
  render: () => frame(<ReloadableQueue item={report} />),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Resume' })).toBeVisible();
    await expect(canvas.getByText(/recorded, but not every effect is confirmed/)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Resume' }));
    await expect(await canvas.findByRole('button', { name: 'Resume' })).toBeVisible();
    await expect(readReportAttempt(realm, acting.iri, report.id)?.status).toBe('pending');
    await expect(canvas.getByRole('list', { name: 'Queue items' }).children).toHaveLength(1);
    await expect(sent).toHaveLength(1);
    await expect(outcomeOf({ ok: true, data: decisionReceipt(report, 'accepted') }, true)).toEqual({ kind: 'pending' });
    await expect(outcomeOf({ ok: true, data: { saved: true } }, true)).toEqual({ kind: 'pending' });
  },
};

export const ResumeAfterReload: Story = {
  beforeEach: () => { seed(report, 'remove'); },
  render: () => frame(<ReloadableQueue item={report} />),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const original = readReportAttempt(realm, acting.iri, report.id)!;
    await expect(await canvas.findByRole('button', { name: 'Resume' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Reload queue' }));
    await expect(await canvas.findByRole('button', { name: 'Resume' })).toBeVisible();
    complete = true;
    await userEvent.click(canvas.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(canvas.queryByRole('button', { name: 'Resume' })).toBeNull());
    await expect(sent).toEqual([{ body: original.input, key: original.key }]);
    await expect(readReportAttempt(realm, acting.iri, report.id)).toBeNull();
    await expect(canvas.getByText('All caught up')).toBeVisible();
  },
};

const complaint = { ...report, kind: 'rights_complaint' as const };
export const InterimRestrictionPending: Story = {
  beforeEach: () => { seed(complaint, 'interim-restrict'); },
  render: () => frame(<ReloadableQueue item={complaint} />),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Resume' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Resume' }));
    await expect(sent[0]?.body).toMatchObject({ profile: 'rights-restriction-v1', outcome: 'interim_restrict' });
  },
};
export const FinalRestrictionPending: Story = {
  ...InterimRestrictionPending,
  beforeEach: () => { seed(complaint, 'final-restrict'); },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Resume' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Resume' }));
    await expect(sent[0]?.body).toMatchObject({ profile: 'rights-restriction-v1', outcome: 'final_restrict' });
  },
};

export const RoleAssignmentLostResponse: Story = {
  render: () => frame(<MembersView realm={realm} actingSubject={acting.iri}
    first={{ generation: '12', items: members, nextCursor: null }} agents={agents} roles={roles}
    invitations={{ ok: true, data: outgoingInvitations }} now={now} locale="en" messages={messages} api={lostAdmin} />),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Actions for Sophie Li 李素菲' }));
    const menu = await body().findByRole('menu');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Give a role…' }));
    const element = await body().findByRole('dialog', { name: 'Give Sophie Li 李素菲 a role' });
    await waitFor(() => expect(element.contains(document.activeElement)).toBe(true));
    const dialog = within(element);
    await expect(await dialog.findByText('1 member gains: Moderate the queue')).toBeVisible();
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Share moderation.');
    await userEvent.click(dialog.getByRole('button', { name: 'Give role' }));
    await expect(await dialog.findByRole('button', { name: 'Resume' })).toBeVisible();
    const before = previews;
    await userEvent.click(dialog.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    await expect(sent[1]).toEqual(sent[0]);
    await expect(previews).toBe(before);
  },
};

export const RoleDefinitionLostResponse: Story = {
  render: () => frame(<RolesView realm={realm} actingSubject={acting.iri} list={{ generation: '12', cap: 32, roles }}
    agents={agents} locale="en" messages={messages} api={lostAdmin} />),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'New role' }));
    const element = await body().findByRole('dialog', { name: 'New role' });
    await waitFor(() => expect(element.contains(document.activeElement)).toBe(true));
    const dialog = within(element);
    await userEvent.type(dialog.getByRole('textbox', { name: 'Role name' }), 'Recovery reviewers');
    await userEvent.click(dialog.getByRole('checkbox', { name: 'Moderate the queue' }));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Share review work.');
    await waitFor(() => expect(dialog.getByRole('button', { name: 'Create role' })).toBeEnabled());
    await userEvent.click(dialog.getByRole('button', { name: 'Create role' }));
    await expect(await dialog.findByRole('button', { name: 'Resume' })).toBeVisible();
    const before = previews;
    await userEvent.click(dialog.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    await expect(sent[1]).toEqual(sent[0]);
    await expect(previews).toBe(before);
  },
};

export const RulePublicationLostResponse: Story = {
  render: () => frame(<SettingsView realm={realm} actingSubject={acting.iri} initial={settings}
    locale="en" messages={messages} api={lostAdmin} />),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: /No one/ }));
    await userEvent.click(canvas.getByRole('button', { name: 'Review changes' }));
    const element = await body().findByRole('dialog', { name: 'Review before publishing' });
    await waitFor(() => expect(element.contains(document.activeElement)).toBe(true));
    const dialog = within(element);
    await userEvent.type(dialog.getByRole('textbox', { name: 'What changed and why' }), 'Pause new submissions.');
    await userEvent.click(dialog.getByRole('button', { name: 'Publish' }));
    await expect(await dialog.findByRole('button', { name: 'Resume' })).toBeVisible();
    await userEvent.click(dialog.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    await expect(sent[1]).toEqual(sent[0]);
    await expect(await canvas.findByText('Revision 4 is published.')).toBeVisible();
  },
};

const restoredRole: RoleCommand = { actingSubject: acting.iri, expectedGeneration: '12', reason: 'Share review work.',
  change: { kind: 'role', roleId: '00000000-0000-4000-8000-000000009001', name: 'Recovery reviewers',
    permissions: ['governance.moderate'] } };
export const NewRolePendingAfterReload: Story = {
  async beforeEach() {
    const impact = await admin.preview(restoredRole);
    if (!impact.ok) throw new Error('fixture impact unavailable');
    retainCommand(`role:role:${restoredRole.change.roleId}`, { realm, actingSubject: acting.iri, key: 'role-original',
      status: 'recorded', input: { command: restoredRole, digest: impact.data.digest } });
  },
  render: RoleDefinitionLostResponse.render,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Resume' })).toBeVisible();
    await expect(canvas.getByText(/Recovery reviewers: Still not confirmed/)).toBeVisible();
  },
};
export const NewRoleResumeAfterReload: Story = {
  ...NewRolePendingAfterReload,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const original = { body: { command: restoredRole, digest: 'b'.repeat(64) }, key: 'role-original' };
    sent.push(original);
    await userEvent.click(await canvas.findByRole('button', { name: 'Resume' }));
    await expect(await canvas.findByText('Role saved.')).toBeVisible();
    await expect(sent[1]).toEqual(original);
    await expect(previews).toBe(0);
  },
};
