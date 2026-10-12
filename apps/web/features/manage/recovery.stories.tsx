import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { acting, adminApi, agents, basisFor, header, members, names, now, outgoingInvitations, publishedRules,
  queue, queueApi, queuePage, realm, roles, settings } from './fixtures.ts';
import { decideReport, decideSubmission, reportDecision } from './commands.ts';
import { MembersView } from './members-view.tsx';
import { messages } from './messages.ts';
import { QueueView, outcomeOf } from './queue-view.tsx';
import type { QueueApi } from './queue-api.ts';
import { RealmFrame } from './realm-frame.tsx';
import { decisionReceipt, recoveryReasons } from './recovery-fixtures.ts';
import { RolesView } from './roles-view.tsx';
import { attemptStorage, forgetCommand, recoveryIndexKey, readQueueAttempt, readCommand, retainedCommands, readReportAttempt as readStoredReport, retainCommand as retainStoredCommand, type ReportAttempt } from './safety-pending.ts';
import { SettingsView } from './settings-view.tsx';
import type { MainClient, ModerationItem, RoleCommand } from './types.ts';

const recoveryStore = () => attemptStorage('storybook:account-one');
const readReportAttempt = (realm: string, actor: string, id: string) => readStoredReport(realm, actor, id, recoveryStore());
const retainCommand = <Input,>(operation: string, attempt: Parameters<typeof retainStoredCommand<Input>>[1]) =>
  retainStoredCommand(operation, attempt, recoveryStore());
const report = queue.find(item => item.kind === 'content_report')!;
const body = () => within(document.body);
async function settleOverlay(element: HTMLElement) {
  await waitFor(() => expect(element.contains(document.activeElement)).toBe(true));
  await Promise.all(element.getAnimations().map(animation => animation.finished));
}
const sent: { body: unknown; key: string }[] = [];
let complete = false;
let cancelled = false;
let latestSettings = settings;
let settingsRead: Promise<void> | null = null;
let rolesRead: Promise<void> | null = null;
let previews = 0;
const admin = adminApi();
const roleReceipts = new Map<string, Awaited<ReturnType<typeof admin.changeRole>>>();
const roleWrites = new Map<string, RoleCommand>();
const settingsReceipts = new Map<string, Awaited<ReturnType<typeof admin.saveSettings>>>();
const lostAdmin = { ...admin,
  settings: async () => { await settingsRead; return { ok: true as const, data: latestSettings }; },
  roles: async () => {
    await rolesRead;
    const read = await admin.roles();
    if (!read.ok) return read;
    const current = new Map(read.data.roles.map(role => [role.id, role]));
    for (const { change } of roleWrites.values()) if (change.kind === 'role') {
      current.set(change.roleId, { ...current.get(change.roleId), id: change.roleId, name: change.name,
        permissions: change.permissions, holders: [], moreHolders: false });
    }
    return { ok: true as const, data: { ...read.data, generation: roleWrites.size ? '13' : '12', roles: [...current.values()] } };
  },
  members: async (...args: Parameters<typeof admin.members>) => {
    const read = await admin.members(...args);
    if (!read.ok) return read;
    const items = read.data.items.map(member => {
      let held = member.roles;
      for (const { change } of roleWrites.values()) if (change.kind === 'assignment' && change.member === member.member) {
        held = held.filter(role => role.id !== change.roleId);
        if (change.assigned) held = [...held, { id: change.roleId,
          name: roles.find(role => role.id === change.roleId)!.name, validUntil: change.validUntil }];
      }
      return { ...member, roles: held };
    });
    return { ok: true as const, data: { ...read.data, generation: roleWrites.size ? '13' : '12', items } };
  },
  preview: async (command: RoleCommand) => { previews++; return admin.preview(command); },
  changeRole: async (...args: Parameters<typeof admin.changeRole>) => {
    sent.push({ body: { command: args[0], digest: args[1] }, key: args[2] });
    const result = roleReceipts.get(args[2]) ?? await admin.changeRole(...args);
    roleReceipts.set(args[2], result);
    if (result.ok) roleWrites.set(args[2], args[0]);
    return sent.length === 1 ? { ok: false as const, failure: 'unavailable' as const }
      : result.ok ? { ok: true as const, data: { ...result.data, replayed: true } } : result;
  },
  saveSettings: async (...args: Parameters<typeof admin.saveSettings>) => {
    sent.push({ body: args[0], key: args[1] });
    const result = settingsReceipts.get(args[1]) ?? await admin.saveSettings(...args);
    settingsReceipts.set(args[1], result);
    if (result.ok && BigInt(result.data.generation) >= BigInt(latestSettings.generation)) latestSettings = result.data;
    return sent.length === 1 ? { ok: false as const, failure: 'unavailable' as const }
      : result.ok ? { ok: true as const, data: { ...result.data, replayed: true } } : result;
  },
};
async function seed(item: ModerationItem, action: 'remove' | 'interim-restrict' | 'final-restrict', key = 'retained-key') {
  const command = reportDecision(basisFor(item), action, 'The reported revision breaches the rule.', acting.iri, key)!;
  const attempt: ReportAttempt = { realm, actingSubject: acting.iri, key, item,
    decision: { action, reason: recoveryReasons.facts, note: null, reasons: recoveryReasons },
    input: { ...command, reasons: recoveryReasons,
      profile: item.kind === 'rights_complaint' ? 'rights-restriction-v1' : 'moderation-decision-v1' }, status: 'pending' };
  await retainCommand(`report:${item.id}`, attempt);
  return attempt;
}
function recoveryApi(item: ModerationItem): QueueApi {
  const post = async (input: unknown, options: { headers: { 'idempotency-key': string } }) => {
    sent.push({ body: input, key: options.headers['idempotency-key'] });
    const data = decisionReceipt(item, cancelled ? 'cancelled' : complete ? 'completed' : 'accepted');
    if (cancelled) data.operation.continuation = null;
    return { data, error: null };
  };
  const main = { v1: { moderation: { decisions: { post } }, rights: { restrictions: { post } }, realms: () => {
    throw new Error('Resume must not read a new decision basis');
  } } } as unknown as MainClient;
  return { ...queueApi(), commit: (target, decision, key) => decideReport(main, realm, target, decision, acting.iri, key, recoveryStore()) };
}
function ReloadableQueue({ item, api }: { item: ModerationItem; api?: QueueApi }) {
  const [version, setVersion] = useState(0);
  return <>
    <button type="button" onClick={() => setVersion(value => value + 1)}>Reload queue</button>
    <QueueView principal="storybook:account-one" key={version} realm={realm} actingSubject={acting.iri} view={{ state: 'open', type: null }}
      initial={{ ...queuePage, items: version ? [] : [item], nextCursor: null }} names={names} now={now}
      realmRules={publishedRules()} locale="en" messages={messages} api={api ?? recoveryApi(item)} undoWindowMs={0} />
  </>;
}
const frame = (children: ReactNode) => <RealmFrame realm={realm} header={header} agent={acting}
  locale="en" messages={messages}>{children}</RealmFrame>;
const meta = {
  title: 'Manage/Recoverable operations',
  parameters: { route: { pathname: `/en/manage/r/${realm}` } },
  beforeEach() {
    sent.length = 0; complete = false; cancelled = false; previews = 0; latestSettings = settings; settingsRead = null; rolesRead = null;
    roleReceipts.clear(); roleWrites.clear(); settingsReceipts.clear();
    // Remove only this isolated fixture's recovery records.
    localStorage.removeItem(recoveryIndexKey('storybook:account-one', realm));
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const RemovePending: Story = {
  beforeEach: async () => { await seed(report, 'remove'); },
  render: () => frame(<ReloadableQueue item={report} />),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Resume' })).toBeVisible();
    await expect(canvas.getByText(/recorded, but not every effect is confirmed/)).toBeVisible();
    await expect(canvas.getByText('Effects not confirmed')).toBeVisible();
    await expect(canvas.queryByText('Waiting for review')).toBeNull();
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
  beforeEach: async () => { await seed(report, 'remove'); },
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
  beforeEach: async () => { await seed(complaint, 'interim-restrict'); },
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
  beforeEach: async () => { await seed(complaint, 'final-restrict'); },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Resume' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Resume' }));
    await expect(sent[0]?.body).toMatchObject({ profile: 'rights-restriction-v1', outcome: 'final_restrict' });
  },
};

export const RoleAssignmentLostResponse: Story = {
  parameters: { route: { pathname: `/en/manage/r/${realm}/members` } },
  render: () => frame(<MembersView principal="storybook:account-one" realm={realm} actingSubject={acting.iri}
    first={{ generation: '12', items: members, nextCursor: null }} agents={agents} roles={roles}
    invitations={{ ok: true, data: outgoingInvitations }} now={now} locale="en" messages={messages} api={lostAdmin} />),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Actions for Sophie Li 李素菲' }));
    const menu = await body().findByRole('menu');
    await settleOverlay(menu);
    const choice = within(menu).getByRole('menuitem', { name: 'Give a role…' });
    const highlighted = () => menu.querySelector('[data-highlighted]');
    for (let step = 0; step <= within(menu).getAllByRole('menuitem').length && highlighted() !== choice; step++) {
      const previous = highlighted();
      await userEvent.keyboard('{ArrowDown}');
      await waitFor(() => expect(highlighted()).not.toBe(previous));
    }
    await expect(choice).toHaveAttribute('data-highlighted');
    await userEvent.keyboard('{Enter}');
    const element = await body().findByRole('dialog', { name: 'Give Sophie Li 李素菲 a role' });
    await settleOverlay(element);
    const dialog = within(element);
    await expect(await dialog.findByText('1 member gains: Moderate the queue')).toBeVisible();
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Share moderation.');
    await userEvent.click(dialog.getByRole('button', { name: 'Give role' }));
    await expect(await dialog.findByRole('button', { name: 'Resume' })).toBeVisible();
    await expect(dialog.getByText('Still not confirmed. Try again in a moment.')).toBeVisible();
    await expect(dialog.queryByText('Your decision wasn’t saved. Try again.')).toBeNull();
    const before = previews;
    await userEvent.click(dialog.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    await expect(sent[1]).toEqual(sent[0]);
    await expect(previews).toBe(before);
    await waitFor(() => expect(within(canvas.getByRole('list', { name: 'Members' })).getAllByText('Community moderators')).toHaveLength(4));
  },
};

export const RoleDefinitionLostResponse: Story = {
  parameters: { route: { pathname: `/en/manage/r/${realm}/roles` } },
  render: () => frame(<RolesView principal="storybook:account-one" realm={realm} actingSubject={acting.iri} list={{ generation: '12', cap: 32, roles }}
    agents={agents} locale="en" messages={messages} api={lostAdmin} />),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'New role' }));
    const element = await body().findByRole('dialog', { name: 'New role' });
    await settleOverlay(element);
    const dialog = within(element);
    await userEvent.type(dialog.getByRole('textbox', { name: 'Role name' }), 'Recovery reviewers');
    await userEvent.click(dialog.getByRole('checkbox', { name: 'Moderate the queue' }));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Share review work.');
    await waitFor(() => expect(dialog.getByRole('button', { name: 'Create role' })).toBeEnabled());
    await userEvent.click(dialog.getByRole('button', { name: 'Create role' }));
    await expect(await dialog.findByRole('button', { name: 'Resume' })).toBeVisible();
    await expect(dialog.getByText('Still not confirmed. Try again in a moment.')).toBeVisible();
    const before = previews;
    await userEvent.click(dialog.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    await expect(sent[1]).toEqual(sent[0]);
    await expect(previews).toBe(before);
    await expect(await canvas.findByRole('heading', { name: 'Recovery reviewers' })).toBeVisible();
  },
};

export const RulePublicationLostResponse: Story = {
  parameters: { route: { pathname: `/en/manage/r/${realm}/settings` } },
  render: () => frame(<SettingsView principal="storybook:account-one" realm={realm} actingSubject={acting.iri} initial={settings}
    locale="en" messages={messages} api={lostAdmin} />),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Edit rules' }));
    const title = () => canvas.getAllByRole('textbox', { name: 'Title in English' })[0]!;
    // Reading-language hydration can replace a controlled field while it is being typed.
    await waitFor(async () => {
      if ((title() as HTMLInputElement).value !== 'Mark spoilers in titles') {
        await userEvent.clear(title());
        await userEvent.type(title(), 'Mark spoilers in titles');
      }
      await expect(title()).toHaveValue('Mark spoilers in titles');
    }, { timeout: 5000 });
    await userEvent.click(canvas.getByRole('button', { name: 'Review changes' }));
    const element = await body().findByRole('dialog', { name: 'Review before publishing' });
    await settleOverlay(element);
    const dialog = within(element);
    await userEvent.type(dialog.getByRole('textbox', { name: 'What changed and why' }), 'Clarify where spoiler warnings belong.');
    await userEvent.click(dialog.getByRole('button', { name: 'Publish' }));
    await expect(await dialog.findByRole('button', { name: 'Resume' })).toBeVisible();
    await expect(dialog.getByText('Still not confirmed. Try again in a moment.')).toBeVisible();
    await userEvent.click(dialog.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    await expect(sent[1]).toEqual(sent[0]);
    await expect(await canvas.findByText('Revision 4 is published.')).toBeVisible();
    await expect(await canvas.findByRole('heading', { name: /Mark spoilers in titles$/ })).toBeVisible();
  },
};

const restoredRole: RoleCommand = { actingSubject: acting.iri, expectedGeneration: '12', reason: 'Share review work.',
  change: { kind: 'role', roleId: '00000000-0000-4000-8000-000000009001', name: 'Recovery reviewers',
    permissions: ['governance.moderate'] } };
export const NewRolePendingAfterReload: Story = {
  parameters: { route: { pathname: `/en/manage/r/${realm}/roles` } },
  async beforeEach() {
    const impact = await admin.preview(restoredRole);
    if (!impact.ok) throw new Error('fixture impact unavailable');
    await retainCommand(`role:role:${restoredRole.change.roleId}`, { realm, actingSubject: acting.iri, key: 'role-original',
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
    await expect(canvas.getByRole('heading', { name: 'Recovery reviewers' })).toBeVisible();
  },
};

async function memberAction(canvas: ReturnType<typeof within>, name: string) {
  await userEvent.click(canvas.getByRole('button', { name: 'Actions for Sophie Li 李素菲' }));
  const menu = await body().findByRole('menu');
  await settleOverlay(menu);
  const choice = within(menu).getByRole('menuitem', { name });
  const highlighted = () => menu.querySelector('[data-highlighted]');
  for (let step = 0; step <= within(menu).getAllByRole('menuitem').length && highlighted() !== choice; step++) {
    const previous = highlighted();
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(highlighted()).not.toBe(previous));
  }
  await expect(choice).toHaveAttribute('data-highlighted');
  await userEvent.keyboard('{Enter}');
}
async function giveWithLostResponse(canvas: ReturnType<typeof within>) {
  await memberAction(canvas, 'Give a role…');
  const element = await body().findByRole('dialog', { name: 'Give Sophie Li 李素菲 a role' });
  await settleOverlay(element);
  const dialog = within(element);
  await expect(await dialog.findByText('1 member gains: Moderate the queue')).toBeVisible();
  await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Share moderation.');
  await userEvent.click(dialog.getByRole('button', { name: 'Give role' }));
  await expect(await dialog.findByRole('button', { name: 'Resume' })).toBeVisible();
  return dialog;
}
function ReloadableMembers() {
  const [version, setVersion] = useState(0);
  const [page, setPage] = useState({ generation: '12', items: members, nextCursor: null as string | null });
  return <>
    <button type="button" onClick={() => void lostAdmin.members('', null).then(result => {
      if (result.ok) { setPage(result.data); setVersion(value => value + 1); }
    })}>Reload members</button>
    <MembersView key={version} principal="storybook:account-one" realm={realm} actingSubject={acting.iri}
      first={page} agents={agents} roles={roles} invitations={{ ok: true, data: outgoingInvitations }}
      now={now} locale="en" messages={messages} api={lostAdmin} />
  </>;
}
export const AssignmentResumeAfterReload: Story = {
  parameters: { route: { pathname: `/en/manage/r/${realm}/members` } },
  render: () => frame(<ReloadableMembers />),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const dialog = await giveWithLostResponse(canvas);
    await userEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Reload members' }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Resume' }));
    await expect(await canvas.findByText('Role saved.')).toBeVisible();
    await expect(sent[1]).toEqual(sent[0]);
    await expect(retainedCommands(realm, acting.iri, 'role', recoveryStore())).toEqual([]);
    await expect(canvas.queryByRole('button', { name: 'Resume' })).toBeNull();
  },
};
export const LostGiveResumedFromTake: Story = {
  ...AssignmentResumeAfterReload,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const first = await giveWithLostResponse(canvas);
    await userEvent.click(first.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Reload members' }));
    await expect(await canvas.findByRole('button', { name: 'Resume' })).toBeVisible();
    await memberAction(canvas, 'Remove role “Community moderators”…');
    const element = await body().findByRole('dialog', { name: 'Give Sophie Li 李素菲 a role' });
    await settleOverlay(element);
    const dialog = within(element);
    await expect(dialog.getByText('Give role · Community moderators · Sophie Li 李素菲')).toBeVisible();
    await userEvent.click(dialog.getByRole('button', { name: 'Resume' }));
    await expect(await canvas.findByText('Sophie Li 李素菲 now holds “Community moderators”.')).toBeVisible();
    await expect(canvas.queryByText('Sophie Li 李素菲 no longer holds “Community moderators”.')).toBeNull();
    await expect(sent[1]).toEqual(sent[0]);
  },
};
function ReloadableSettings({ newer = false }: { newer?: boolean }) {
  const [version, setVersion] = useState(0);
  return <>
    <button type="button" onClick={() => {
      if (newer) latestSettings = { ...settings, generation: '14', ruleBasis: { ...settings.ruleBasis, revision: '5' },
        settings: { ...settings.settings, rules: settings.settings.rules.map((rule, index) => index ? rule : {
          ...rule, title: { ...rule.title, labels: { ...rule.title.labels, en: 'Newer publication' } },
        }) } };
      setVersion(value => value + 1);
    }}>Reload settings</button>
    <SettingsView key={version} principal="storybook:account-one" realm={realm} actingSubject={acting.iri}
      initial={version ? latestSettings : settings} locale="en" messages={messages} api={lostAdmin} />
  </>;
}
const ruleTitle = (canvas: ReturnType<typeof within>) => canvas.getAllByRole('textbox', { name: 'Title in English' })[0]!;
async function reviewDraft(canvas: ReturnType<typeof within>) {
  await userEvent.click(canvas.getByRole('button', { name: 'Edit rules' }));
  const title = () => ruleTitle(canvas);
  await waitFor(async () => {
    if ((title() as HTMLInputElement).value !== 'Mark spoilers in titles') {
      await userEvent.clear(title()); await userEvent.type(title(), 'Mark spoilers in titles');
    }
    await expect(title()).toHaveValue('Mark spoilers in titles');
  }, { timeout: 5000 });
  await userEvent.click(canvas.getByRole('button', { name: 'Review changes' }));
  const element = await body().findByRole('dialog', { name: 'Review before publishing' });
  await settleOverlay(element);
  const dialog = within(element);
  await userEvent.type(dialog.getByRole('textbox', { name: 'What changed and why' }), 'Clarify spoiler warnings.');
  return dialog;
}
async function publishWithLostResponse(canvas: ReturnType<typeof within>) {
  const dialog = await reviewDraft(canvas);
  await userEvent.click(dialog.getByRole('button', { name: 'Publish' }));
  await expect(await dialog.findByRole('button', { name: 'Resume' })).toBeVisible();
  await userEvent.click(dialog.getByRole('button', { name: 'Keep editing' }));
}
export const PublicationResumeAfterReload: Story = {
  parameters: { route: { pathname: `/en/manage/r/${realm}/settings` } },
  render: () => frame(<ReloadableSettings />),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await publishWithLostResponse(canvas);
    await userEvent.click(canvas.getByRole('button', { name: 'Reload settings' }));
    const element = await body().findByRole('dialog', { name: 'Review before publishing' });
    await settleOverlay(element);
    await expect(within(element).queryByText(/Publishing creates revision/)).toBeNull();
    await userEvent.click(within(element).getByRole('button', { name: 'Resume' }));
    await expect(await canvas.findByText('Revision 4 is published.')).toBeVisible();
    await expect(await canvas.findByRole('heading', { name: /Mark spoilers in titles$/ })).toBeVisible();
    await expect(sent[1]).toEqual(sent[0]);
    await expect(readCommand(realm, acting.iri, 'settings', recoveryStore())).toBeNull();
  },
};
export const EditsAfterPublishSurviveTheRead: Story = {
  parameters: { route: { pathname: `/en/manage/r/${realm}/settings` } },
  render: () => frame(<SettingsView principal="storybook:account-one" realm={realm} actingSubject={acting.iri} initial={settings}
    locale="en" messages={messages} api={{ ...lostAdmin, saveSettings: async (...args) => {
      const result = await admin.saveSettings(...args);
      if (result.ok) latestSettings = result.data;
      return result;
    } }} />),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    let release!: () => void;
    settingsRead = new Promise<void>(resolve => { release = resolve; });
    const dialog = await reviewDraft(canvas);
    await userEvent.click(dialog.getByRole('button', { name: 'Publish' }));
    // The publication is accepted; the settings read that follows it is still outstanding.
    await waitFor(() => expect(latestSettings.ruleBasis.revision).toBe('4'));
    await userEvent.click(await dialog.findByRole('button', { name: 'Keep editing' }));
    await userEvent.type(ruleTitle(canvas), ' (after publishing)');
    release();
    await expect(await canvas.findByText('Revision 4 is published.')).toBeVisible();
    await expect(ruleTitle(canvas)).toHaveValue('Mark spoilers in titles (after publishing)');
    await expect(canvas.getByRole('button', { name: 'Review changes' })).toBeEnabled();
  },
};
// Another moderator publishes revision 5, with an added rule, while this moderator keeps editing after publishing 4.
export const NewerRevisionAfterPublishIsAConflict: Story = {
  ...EditsAfterPublishSurviveTheRead,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    let release!: () => void;
    settingsRead = new Promise<void>(resolve => { release = resolve; });
    const dialog = await reviewDraft(canvas);
    await userEvent.click(dialog.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(latestSettings.ruleBasis.revision).toBe('4'));
    await userEvent.click(await dialog.findByRole('button', { name: 'Keep editing' }));
    await userEvent.type(ruleTitle(canvas), ' (after publishing)');
    const added = { ...latestSettings.settings.rules[0]!, id: 'added-by-another-moderator' };
    latestSettings = { ...latestSettings, generation: '14', ruleBasis: { ...latestSettings.ruleBasis, revision: '5' },
      settings: { ...latestSettings.settings, rules: [...latestSettings.settings.rules, { ...added,
        title: { ...added.title, labels: { ...added.title.labels, en: 'Added by another moderator' } } }] } };
    release();
    // Neither version is lost: the newer revision is shown beside the kept draft and nothing publishes silently.
    await expect(await canvas.findByText('Someone else published first')).toBeVisible();
    await expect(canvas.getByText(/Revision 5 was published while you were editing/)).toBeVisible();
    await expect(canvas.getByText('Added by another moderator')).toBeVisible();
    await expect(ruleTitle(canvas)).toHaveValue('Mark spoilers in titles (after publishing)');
    await expect(canvas.getByRole('button', { name: 'Review changes' })).toBeDisabled();
  },
};
// Choosing to publish on top is explicit, and the review names what it would remove.
export const PublishingOnTopNamesTheLostRule: Story = {
  ...NewerRevisionAfterPublishIsAConflict,
  async play(context) {
    await NewerRevisionAfterPublishIsAConflict.play!(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Publish my draft on top' }));
    const review = await body().findByRole('dialog', { name: 'Review before publishing' });
    await settleOverlay(review);
    await expect(within(review).getByText('Removes “Added by another moderator”')).toBeVisible();
  },
};
export const OlderReceiptKeepsNewerPublication: Story = {
  ...PublicationResumeAfterReload,
  render: () => frame(<ReloadableSettings newer />),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await publishWithLostResponse(canvas);
    await userEvent.click(canvas.getByRole('button', { name: 'Reload settings' }));
    const element = await body().findByRole('dialog', { name: 'Review before publishing' });
    await settleOverlay(element);
    await userEvent.click(within(element).getByRole('button', { name: 'Resume' }));
    await expect(await canvas.findByRole('heading', { name: /Newer publication$/ })).toBeVisible();
    await expect(canvas.getByText('Revision 5')).toBeVisible();
    await expect(canvas.queryByText('Revision 4')).toBeNull();
    await expect(sent[1]).toEqual(sent[0]);
  },
};

export const CancelledRestriction: Story = {
  beforeEach: async () => { await seed(report, 'remove'); },
  render: RemovePending.render,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    cancelled = true;
    await userEvent.click(await canvas.findByRole('button', { name: 'Resume' }));
    await expect(await canvas.findByText('Decision cancelled. Effects already confirmed remain applied.')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Resume' })).toBeNull();
    await expect(readReportAttempt(realm, acting.iri, report.id)).toBeNull();
  },
};
function AuthorityQueue() {
  const [authorized, setAuthorized] = useState(true);
  return <>
    <button type="button" onClick={() => setAuthorized(false)}>Revoke moderation</button>
    <QueueView principal="storybook:account-one" realm={realm} actingSubject={acting.iri}
      initial={{ ...queuePage, items: queue.filter(item => item.kind === 'work_submission'), nextCursor: null }} names={names} now={now}
      view={{ state: 'open', type: null }} authority={{ decideReports: authorized, escalate: true }}
      locale="en" messages={messages} api={recoveryApi(report)} />
  </>;
}
export const RevokedAuthorityHidesRecovery: Story = {
  beforeEach: async () => { await seed(report, 'remove'); },
  render: () => frame(<AuthorityQueue />),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Resume' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Revoke moderation' }));
    await expect(canvas.queryByRole('button', { name: 'Resume' })).toBeNull();
    await expect(canvas.queryByText('Edition details')).toBeNull();
    await expect(canvas.getByRole('list', { name: 'Queue items' })).toBeVisible();
    await expect(canvas.queryByText('Copyright infringement')).toBeNull();
  },
};
export const RightsFilterHidesContentRecovery: Story = {
  beforeEach: async () => { await seed(report, 'remove'); },
  render: () => frame(<QueueView principal="storybook:account-one" realm={realm} actingSubject={acting.iri}
    initial={{ ...queuePage, items: [], nextCursor: null }} names={names} now={now}
    view={{ state: 'open', type: 'rights_complaint' }} locale="en" messages={messages} api={recoveryApi(report)} />),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText('Nothing here')).toBeVisible());
    await expect(canvas.queryByRole('button', { name: 'Resume' })).toBeNull();
    await expect(canvas.queryByText('Edition details')).toBeNull();
  },
};
const secondReasonCase = { ...report, reasonCode: 'spam' };
export const ReasonFilterShowsWhatTheApiReturns: Story = {
  render: () => frame(<QueueView principal="storybook:account-one" realm={realm} actingSubject={acting.iri}
    initial={{ ...queuePage, items: [secondReasonCase], nextCursor: null }} names={names} now={now}
    view={{ state: 'open', type: null, reason: 'harassment' }} locale="en" messages={messages} api={recoveryApi(report)} />),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('list', { name: 'Queue items' }).children).toHaveLength(1);
    await expect(canvas.queryByText('Nothing here')).toBeNull();
  },
};
export const ReasonFilterHidesUnrelatedRecovery: Story = {
  ...RightsFilterHidesContentRecovery,
  render: () => frame(<QueueView principal="storybook:account-one" realm={realm} actingSubject={acting.iri}
    initial={{ ...queuePage, items: [], nextCursor: null }} names={names} now={now}
    view={{ state: 'open', type: null, reason: 'harassment' }} locale="en" messages={messages} api={recoveryApi(report)} />),
};
export const SubmissionFilterHidesContentRecovery: Story = {
  ...RightsFilterHidesContentRecovery,
  render: () => frame(<QueueView principal="storybook:account-one" realm={realm} actingSubject={acting.iri}
    initial={{ ...queuePage, items: [], nextCursor: null }} names={names} now={now}
    view={{ state: 'open', type: 'work_submission' }} locale="en" messages={messages} api={recoveryApi(report)} />),
};

const pendingSubmission = queue.find(item => item.kind === 'work_submission')!;
const submissionApi: QueueApi = { ...queueApi(), commit: (item, decision, key) => {
  const main = { v1: { realms: () => ({ 'submitted-publications': { get: async () => ({ data: { items: [] }, error: null }) },
    submissions: () => ({ decisions: { post: async (input: unknown, options: { headers: { 'idempotency-key': string } }) => {
      sent.push({ body: input, key: options.headers['idempotency-key'] });
      return complete ? { data: { replayed: true }, error: null }
        : { data: null, error: { status: 503, value: { code: 'submission_pending' } } };
    } } }),
  }) } } as unknown as MainClient;
  return decideSubmission(main, realm, item, decision, acting.iri, key, recoveryStore());
} };
export const SubmissionResumeAfterReload: Story = {
  render: () => frame(<ReloadableQueue item={pendingSubmission} api={submissionApi} />),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Approve' }));
    await expect(await canvas.findByRole('button', { name: 'Resume' }, { timeout: 5000 })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Reload queue' }));
    await expect(await canvas.findByRole('button', { name: 'Resume' })).toBeVisible();
    complete = true;
    await userEvent.click(canvas.getByRole('button', { name: 'Resume' }));
    await expect(await canvas.findByText('All caught up')).toBeVisible();
    await expect(sent[1]).toEqual(sent[0]);
    await expect(readQueueAttempt(realm, acting.iri, pendingSubmission.id, recoveryStore())).toBeNull();
  },
};

// Another tab completes this tab's decision and retains its own while the first response is in flight.
function otherTabApi(item: ModerationItem): QueueApi {
  let first = true;
  const post = async (input: unknown, options: { headers: { 'idempotency-key': string } }) => {
    sent.push({ body: input, key: options.headers['idempotency-key'] });
    if (first) {
      first = false;
      await forgetCommand(`report:${item.id}`, readReportAttempt(realm, acting.iri, item.id)!, recoveryStore());
      await seed(item, 'remove', 'other-tab-key');
    }
    return { data: decisionReceipt(item, complete ? 'completed' : 'accepted'), error: null };
  };
  const main = { v1: { moderation: { decisions: { post } }, rights: { restrictions: { post } } } } as unknown as MainClient;
  return { ...queueApi(), commit: (target, decision, key) => decideReport(main, realm, target, decision, acting.iri, key, recoveryStore()) };
}
export const OtherTabReplacesDecisionInFlight: Story = {
  beforeEach: async () => { await seed(report, 'remove'); },
  render: () => frame(<ReloadableQueue item={report} api={otherTabApi(report)} />),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    // The item is visible again, with the other tab's decision, without a reload.
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Resume' })).toBeVisible());
    await expect(readReportAttempt(realm, acting.iri, report.id)?.key).toBe('other-tab-key');
    complete = true;
    await userEvent.click(canvas.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    await expect(sent[1]!.key).toBe('other-tab-key');
    await expect(await canvas.findByText('All caught up')).toBeVisible();
  },
};

export const RefusedRoleRestartsPreview: Story = {
  parameters: { route: { pathname: `/en/manage/r/${realm}/roles` } },
  async beforeEach() {
    const command = { ...restoredRole, change: { ...restoredRole.change, roleId: roles[0]!.id } };
    const impact = await admin.preview(command);
    if (!impact.ok) throw new Error('fixture impact unavailable');
    await retainCommand(`role:role:${roles[0]!.id}`, { realm, actingSubject: acting.iri, key: 'stale-role', status: 'recorded',
      input: { command, digest: impact.data.digest, impact: impact.data } });
  },
  render: () => frame(<RolesView principal="storybook:account-one" realm={realm} actingSubject={acting.iri}
    list={{ generation: '12', cap: 32, roles }} agents={agents} locale="en" messages={messages}
    api={{ ...admin, roles: async () => ({ ok: true, data: { generation: '13', cap: 32, roles } }),
      preview: async command => command.expectedGeneration === '12' ? { ok: false, failure: 'stale' } : admin.preview(command),
      changeRole: async (command, digest, key) => {
        sent.push({ body: { command, digest }, key });
        return key === 'stale-role' ? { ok: false, failure: 'stale' } : admin.changeRole(command, digest, key);
      } }} />),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Edit role: Community moderators' }));
    const element = await body().findByRole('dialog', { name: 'Edit role' });
    await settleOverlay(element);
    const dialog = within(element);
    await userEvent.click(await dialog.findByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(dialog.getByRole('button', { name: 'Save role' })).toBeEnabled());
    await userEvent.click(dialog.getByRole('button', { name: 'Save role' }));
    await expect(await canvas.findByText('Role saved.')).toBeVisible();
    await expect(sent).toHaveLength(2);
    await expect(sent[1]?.key).not.toBe('stale-role');
    await expect(sent[1]?.body).toMatchObject({ command: { expectedGeneration: '13' } });
  },
};
