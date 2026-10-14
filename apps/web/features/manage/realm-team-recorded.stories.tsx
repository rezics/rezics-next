import type { Meta, StoryObj } from '@storybook/react-vite';
import { materializeData } from 'native-i18n';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { chooseMenuItem, chooseOption } from '../stories/choose-option.ts';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import team from '../../../../tests/qa/fixtures/outcomes/realm/roles-and-team.json';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { date } from './format.ts';
import { messages } from './messages.ts';
import { roleDurations } from './members-view.tsx';
import { RealmTeamRecordedPage } from './realm-team-recorded-page.tsx';
import { realmHref } from './routes.ts';
import type { InvitationPage, MemberPage, RealmHeader, RoleList } from './types.ts';

const record = team as AnswerRecord;
const locale = 'en' as const;
const origin = 'https://recorded.invalid';
const t = materializeData(messages, { locale });

function sample(persona: AnswerPersona, label: string) {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`Missing ${persona} sample ${label}`);
  return found;
}

function selection(persona: AnswerPersona, label: string, empty = false): RecordedSelection {
  const status = sample(persona, label).status;
  if (status >= 400 && status <= 599) return { label, state: 'error' };
  if (empty) return { label, state: 'empty' };
  if (status === 200 || status === 201 || status === 204) return { label, state: 'populated' };
  throw new Error(`Recorded ${persona}/${label} (${status}) has no page state`);
}

function realmId(persona: AnswerPersona, label: string): string {
  const id = new URL(sample(persona, label).path, origin).pathname.split('/')[3];
  if (!id) throw new Error(`Recorded ${label} has no realm`);
  return id;
}

function actingSubject(persona: AnswerPersona, label: string): string {
  const subject = new URL(sample(persona, label).path, origin).searchParams.get('actingSubject');
  if (!subject) throw new Error(`Recorded ${label} has no acting Subject`);
  return subject;
}

function routeIdentity(persona: AnswerPersona): { realm: string; actingSubject: string } {
  const session = sample(persona, 'session-agent').answer as { sessionAgent: { actingSubject: string } };
  const header = persona === 'owner' ? 'management-realm-header' : 'frame-realm';
  return { realm: realmId(persona, header), actingSubject: session.sessionAgent.actingSubject };
}

function actorSelections(persona: AnswerPersona): RecordedSelection[] {
  return ['acting-contexts', 'agent-choices', 'session-agent', 'acting-agent-profile'].map(label => selection(persona, label));
}

/** The management layout's Realm header and Zone read. A 404 Zone does not continue into the editor. */
function frameSelections(persona: AnswerPersona): RecordedSelection[] {
  if (persona === 'owner') return [selection(persona, 'management-realm-header'), selection(persona, 'management-site')];
  return [selection(persona, 'frame-realm'), selection(persona, 'frame-site')];
}

function pageSelections(persona: AnswerPersona, labels: readonly string[]): RecordedSelection[] {
  return [
    ...actorSelections(persona),
    ...frameSelections(persona),
    ...labels.map(label => selection(persona, label, label === 'member-search-empty')),
  ];
}

const populatedRoles = pageSelections('owner', ['roles-initial', 'holder-name-moderator']);
const populatedMembers = pageSelections('owner', [
  'member-roster', 'outgoing-invitations-empty', 'roles-initial', 'holder-name-moderator', 'member-profile',
]);
const emptyMembers = pageSelections('owner', [
  'member-roster', 'member-search-empty', 'outgoing-invitations-empty', 'roles-initial', 'holder-name-moderator', 'member-profile',
]);
const assignedRoles = pageSelections('owner', ['roles-assigned', 'holder-name-moderator', 'holder-name-stranger']);
const loadingRoles = [
  ...actorSelections('owner'),
  ...frameSelections('owner'),
  { label: 'roles-initial', state: 'loading' },
] as const satisfies readonly RecordedSelection[];

const ownerRoute = routeIdentity('owner');
const ownerRealm = () => (sample('owner', 'management-realm-header').answer as RealmHeader).name.value;
const ownerName = () => (sample('owner', 'acting-agent-profile').answer as { displayName: string }).displayName;
const moderatorName = () => (sample('owner', 'holder-name-moderator').answer as { displayName: string }).displayName;
const memberName = () => (sample('owner', 'member-profile').answer as { displayName: string }).displayName;
const strangerName = () => (sample('owner', 'holder-name-stranger').answer as { displayName: string }).displayName;

/** The dialog's recorded assignment: a roster member, a role the dialog can choose, and its 7-day duration. */
function dialogSave() {
  const roles = (sample('owner', 'dialog-roles').answer as RoleList).roles;
  const roster = sample('owner', 'dialog-member-roster').answer as MemberPage;
  const preview = sample('owner', 'role-dialog-opened-at').body as {
    expectedGeneration: string; reason: string;
    change: { roleId: string; member: string; assigned: boolean; validUntil: string };
  };
  const member = roster.items.find(item => item.member === preview.change.member);
  if (!member) throw new Error('Recorded dialog target is not on the roster');
  const held = new Set(member.roles.map(role => role.id));
  const choices = roles.filter(role => !held.has(role.id));
  const chosen = choices.find(role => role.permissions.includes('governance.moderate'));
  if (!chosen || chosen.id !== preview.change.roleId) {
    throw new Error('Recorded preview is not the dialog’s first moderation role for that member');
  }
  const days = roleDurations.find(([, value]) => value === 7)?.[1];
  if (days === undefined) throw new Error('Role dialog has no 7-day duration');
  const openedAt = Date.parse(preview.change.validUntil) - days * 86_400_000;
  if (new Date(openedAt + days * 86_400_000).toISOString() !== preview.change.validUntil) {
    throw new Error('Recorded validity is not the dialog’s 7-day duration');
  }
  const reason = (sample('owner', 'dialog-role-save-preview').body as { reason: string }).reason;
  if (!reason || reason === preview.reason) throw new Error('Recorded save has no reason of its own');
  return { roleName: chosen.name, memberName: memberName(), reason, openedAt, defaultRole: choices[0]?.id === chosen.id };
}

const savedMembers = [
  ...actorSelections('owner'),
  ...frameSelections('owner'),
  selection('owner', 'dialog-member-roster'),
  selection('owner', 'dialog-roles'),
  selection('owner', 'outgoing-invitations-empty'),
  selection('owner', 'member-profile'),
  selection('owner', 'holder-name-moderator'),
  selection('owner', 'role-dialog-opened-at'),
  selection('owner', 'dialog-impact-member-name'),
  selection('owner', 'dialog-role-save-preview'),
  selection('owner', 'dialog-role-assignment-receipt'),
  selection('owner', 'dialog-members-assigned'),
  selection('owner', 'dialog-refreshed-name-member'),
  selection('owner', 'dialog-refreshed-name-moderator'),
  selection('owner', 'dialog-invitations-refreshed'),
] as const satisfies readonly RecordedSelection[];

/**
 * The dialog previews 350ms after a change. Holding that one delay lets the story
 * select the recorded role before the default choice asks for an unrecorded preview.
 */
function holdPreviewDelay() {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const held = new Map<number, () => void>();
  let next = 1;
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (typeof handler === 'function' && delay === 350) {
      const id = next++;
      held.set(id, () => { handler(...args); });
      return id;
    }
    return realSet(handler, delay, ...args);
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((id?: number) => {
    if (typeof id === 'number' && held.delete(id)) return;
    realClear(id);
  }) as typeof globalThis.clearTimeout;
  return {
    flush() {
      const runs = [...held.values()];
      held.clear();
      for (const run of runs) run();
    },
    restore() {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}

const meta = {
  title: 'Manage/Recorded realm team',
  component: RealmTeamRecordedPage,
  args: {
    record, persona: 'owner' as const, selections: populatedRoles, surface: 'roles' as const, locale,
    realm: ownerRoute.realm, actingSubject: ownerRoute.actingSubject,
  },
  render: (args, { globals }) => (
    <RealmTeamRecordedPage {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />
  ),
} satisfies Meta<typeof RealmTeamRecordedPage>;
export default meta;
type Story = StoryObj<typeof meta>;

async function populatedRolesPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const roles = sample('owner', 'roles-initial').answer as RoleList;
  const role = roles.roles[0]!;
  await expect(canvas.findByRole('heading', { level: 1, name: ownerRealm() })).resolves.toBeVisible();
  await expect(canvas.getByRole('heading', { level: 3, name: role.name })).toBeVisible();
  await expect(canvas.getByText(messages.permModerate)).toBeVisible();
  await expect(canvas.getByText(moderatorName())).toBeVisible();
  await expect(canvas.getByText(ownerName())).toBeVisible();
  await expect(canvas.queryByRole('link', { name: messages.editSite })).toBeNull();
  await expect(canvas.queryByRole('button', { name: messages.loadMore })).toBeNull();
}

async function expectCopies(canvas: ReturnType<typeof within>, lines: readonly string[]) {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  for (const [line, count] of counts) {
    const found = canvas.getAllByText(line);
    await expect(found).toHaveLength(count);
    for (const element of found) await expect(element).toBeVisible();
  }
}

async function populatedMembersPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const roster = sample('owner', 'member-roster').answer as MemberPage;
  const invitations = sample('owner', 'outgoing-invitations-empty').answer as InvitationPage;
  await expect(canvas.findByRole('heading', { level: 1, name: ownerRealm() })).resolves.toBeVisible();
  await expect(canvas.getByRole('heading', { name: messages.membersTitle })).toBeVisible();
  await expect(canvas.getAllByText(moderatorName()).length).toBeGreaterThan(0);
  await expect(canvas.getAllByText(memberName()).length).toBeGreaterThan(0);
  await expect(canvas.getByText(roster.items.find(item => item.roles.length)?.roles[0]?.name ?? '')).toBeVisible();
  await expect(canvas.queryByRole('link', { name: messages.editSite })).toBeNull();
  const joined = roster.items.map(item => item.state === 'joined'
    ? item.joinedAt ? `${messages.memberJoined} · ${date(item.joinedAt, locale)}` : messages.memberJoined
    : item.state === 'not_joined' ? messages.memberNotJoined : messages.memberLeft);
  await expectCopies(canvas, joined);
  const invitationCopy: Record<string, string> = {
    pending: messages.invitationPending, expired: messages.invitationExpired, accepted: messages.invitationAccepted,
    declined: messages.invitationDeclined, revoked: messages.invitationRevoked,
  };
  const invitationLines = invitations.items.map(invitation => {
    const state = invitationCopy[invitation.state];
    if (!state) throw new Error(`Recorded invitation state has no copy: ${invitation.state}`);
    return `${state} · ${t.invitationExpiry({ date: date(invitation.expiresAt, locale) })}`;
  });
  await expectCopies(canvas, invitationLines);
  await expect(canvas.queryByRole('button', { name: messages.loadMore })).toBeNull();
}

async function emptyMembersPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const query = new URL(sample('owner', 'member-search-empty').path, origin).searchParams.get('search')!;
  await expect(canvas.findByRole('heading', { level: 1, name: ownerRealm() })).resolves.toBeVisible();
  await userEvent.type(canvas.getByRole('searchbox', { name: messages.searchMembers }), query);
  await userEvent.click(canvas.getByRole('button', { name: messages.search }));
  await expect(canvas.findByRole('heading', { name: t.noMemberMatches({ query }) })).resolves.toBeVisible();
  await expect(canvas.queryByRole('link', { name: messages.editSite })).toBeNull();
  await expect(canvas.queryByRole('button', { name: messages.loadMore })).toBeNull();
}

async function assignedRolesPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const roles = sample('owner', 'roles-assigned').answer as RoleList;
  await expect(canvas.findByRole('heading', { level: 1, name: ownerRealm() })).resolves.toBeVisible();
  for (const role of roles.roles) await expect(canvas.getByRole('heading', { level: 3, name: role.name })).toBeVisible();
  await expect(canvas.getByText(messages.permRoles)).toBeVisible();
  await expect(canvas.getByText(strangerName())).toBeVisible();
  await expect(canvas.getByText(moderatorName())).toBeVisible();
  await expect(canvas.queryByRole('link', { name: messages.editSite })).toBeNull();
}

async function loadingPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const role = (sample('owner', 'roles-initial').answer as RoleList).roles[0]!.name;
  await expect(canvas.findByRole('status')).resolves.toHaveTextContent(shellMessages.loading);
  await expect(canvas.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  await expect(canvas.queryByRole('heading', { name: role })).toBeNull();
  await expect(canvas.queryByRole('heading', { name: ownerRealm() })).toBeNull();
}

function refusalPlay(persona: AnswerPersona, surface: 'roles' | 'members') {
  const label = surface === 'roles' ? 'roles-denied' : 'members-denied';
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);
    const denied = sample(persona, label);
    const signIn = denied.status === 401;
    const title = signIn ? messages.signInTitle : messages.deniedTitle;
    const help = signIn ? messages.signInHelp : messages.deniedHelp;
    const role = (sample('owner', 'roles-initial').answer as RoleList).roles[0]!.name;
    const header = sample(persona, persona === 'owner' ? 'management-realm-header' : 'frame-realm');
    const realm = realmId(persona, header.label);
    await expect(canvas.findByRole('heading', { name: title })).resolves.toBeVisible();
    await expect(canvas.getByText(help)).toBeVisible();
    await expect(canvas.queryByRole('heading', { name: role })).toBeNull();
    await expect(canvas.queryByRole('button', { name: messages.newRole })).toBeNull();
    await expect(canvas.queryByRole('link', { name: messages.editSite })).toBeNull();
    if (header.status === 200) {
      await expect(canvas.getByRole('heading', { level: 1, name: (header.answer as RealmHeader).name.value })).toBeVisible();
    } else {
      await expect(canvas.getByRole('heading', { level: 1, name: t.realmFallback({ id: realm.slice(0, 8) }) })).toBeVisible();
      await expect(canvas.queryByRole('heading', { name: ownerRealm() })).toBeNull();
    }
    const back = localizedPath(realmHref(realm, surface), 'en');
    if (signIn) await expect(canvas.getByRole('link', { name: title })).toHaveAttribute('href', signInPath(back));
    const name = (sample(persona, 'acting-agent-profile').answer as { displayName: string }).displayName;
    await expect(canvas.getByText(name)).toBeVisible();
  };
}

const body = () => within(document.body);

async function savedMembersPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const { roleName, memberName: person, reason, defaultRole } = dialogSave();
  const gain = t.impactGain({ count: 1, permission: messages.permModerate });
  await expect(canvas.findByRole('heading', { level: 1, name: ownerRealm() })).resolves.toBeVisible();
  await expect(canvas.getByText(person)).toBeVisible();
  const clock = holdPreviewDelay();
  try {
    await userEvent.click(canvas.getByRole('button', { name: t.memberActions({ name: person }) }));
    await chooseMenuItem(body(), 'menuitem', messages.giveRoleAction);
    const dialog = within(await body().findByRole('dialog', { name: t.giveRoleTitle({ name: person }) }));
    await expect(dialog.getByRole('combobox', { name: messages.validForLabel })).toHaveTextContent(messages.validFor7);
    const roleBox = dialog.getByRole('combobox', { name: messages.roleLabel });
    if (!defaultRole) {
      await userEvent.click(roleBox);
      await chooseOption(body(), roleName);
      await waitFor(() => expect(roleBox).toHaveTextContent(roleName));
    }
    clock.flush();
    const impact = within(dialog.getByRole('region', { name: messages.impactTitle }));
    await waitFor(() => expect(impact.getAllByText(gain).length).toBeGreaterThan(0));
    await expect(impact.getAllByText(person).length).toBeGreaterThan(0);
    await expect(dialog.getByRole('button', { name: messages.giveRole })).toBeEnabled();
    await userEvent.type(dialog.getByRole('textbox', { name: messages.changeReasonLabel }), reason);
    await userEvent.click(dialog.getByRole('button', { name: messages.giveRole }));
  } finally {
    clock.restore();
  }
  await expect(canvas.findByText(t.roleGiven({ name: person, role: roleName }))).resolves.toBeVisible();
  await expect(canvas.getByText(roleName)).toBeVisible();
  await expect(canvas.getByText(moderatorName())).toBeVisible();
  await expect(canvas.queryByRole('link', { name: messages.editSite })).toBeNull();
  await expect(body().queryByRole('dialog')).toBeNull();
}

function at(story: Story, viewport: 'phone' | 'desktop'): Story {
  return { ...story, globals: { viewport: { value: viewport } } };
}

const populatedRolesStory = {
  parameters: { route: { pathname: localizedPath(realmHref(realmId('owner', 'roles-initial'), 'roles'), locale) } },
  play: populatedRolesPlay,
} satisfies Story;
const populatedMembersStory = {
  args: { selections: populatedMembers, surface: 'members' as const },
  parameters: { route: { pathname: localizedPath(realmHref(realmId('owner', 'member-roster'), 'members'), locale) } },
  play: populatedMembersPlay,
} satisfies Story;
const emptyMembersStory = {
  args: { selections: emptyMembers, surface: 'members' as const },
  parameters: { route: { pathname: localizedPath(realmHref(realmId('owner', 'member-roster'), 'members'), locale) } },
  play: emptyMembersPlay,
} satisfies Story;
const assignedRolesStory = {
  args: { selections: assignedRoles },
  parameters: { route: { pathname: localizedPath(realmHref(realmId('owner', 'roles-assigned'), 'roles'), locale) } },
  play: assignedRolesPlay,
} satisfies Story;
const loadingRolesStory = {
  args: { selections: loadingRoles },
  parameters: { route: { pathname: localizedPath(realmHref(realmId('owner', 'roles-initial'), 'roles'), locale) } },
  play: loadingPlay,
} satisfies Story;
const savedMembersStory = {
  args: {
    selections: savedMembers, surface: 'members' as const, sequence: true, now: dialogSave().openedAt,
  },
  parameters: { route: { pathname: localizedPath(realmHref(realmId('owner', 'dialog-member-roster'), 'members'), locale) } },
  play: savedMembersPlay,
} satisfies Story;

function refusalStory(persona: AnswerPersona, surface: 'roles' | 'members'): Story {
  const label = surface === 'roles' ? 'roles-denied' : 'members-denied';
  const route = routeIdentity(persona);
  const labels = surface === 'roles'
    ? ['roles-denied']
    : ['members-denied', 'roles-denied', 'members-invitations'];
  return {
    args: { persona, selections: pageSelections(persona, labels), surface, ...route },
    parameters: { route: { pathname: localizedPath(realmHref(realmId(persona, label), surface), locale) } },
    play: refusalPlay(persona, surface),
  };
}

export const PopulatedOwnerRolesPhone: Story = at(populatedRolesStory, 'phone');
export const PopulatedOwnerRolesDesktop: Story = at(populatedRolesStory, 'desktop');
export const PopulatedOwnerMembersPhone: Story = at(populatedMembersStory, 'phone');
export const PopulatedOwnerMembersDesktop: Story = at(populatedMembersStory, 'desktop');
export const EmptyOwnerMembersPhone: Story = at(emptyMembersStory, 'phone');
export const EmptyOwnerMembersDesktop: Story = at(emptyMembersStory, 'desktop');
export const AssignedOwnerRolesPhone: Story = at(assignedRolesStory, 'phone');
export const AssignedOwnerRolesDesktop: Story = at(assignedRolesStory, 'desktop');
export const LoadingOwnerRolesPhone: Story = at(loadingRolesStory, 'phone');
export const LoadingOwnerRolesDesktop: Story = at(loadingRolesStory, 'desktop');
export const SavedOwnerMembersPhone: Story = at(savedMembersStory, 'phone');
export const SavedOwnerMembersDesktop: Story = at(savedMembersStory, 'desktop');
export const RefusalStrangerRolesPhone: Story = at(refusalStory('stranger', 'roles'), 'phone');
export const RefusalStrangerRolesDesktop: Story = at(refusalStory('stranger', 'roles'), 'desktop');
export const RefusalStrangerMembersPhone: Story = at(refusalStory('stranger', 'members'), 'phone');
export const RefusalStrangerMembersDesktop: Story = at(refusalStory('stranger', 'members'), 'desktop');
export const RefusalMemberRolesPhone: Story = at(refusalStory('member', 'roles'), 'phone');
export const RefusalMemberRolesDesktop: Story = at(refusalStory('member', 'roles'), 'desktop');
export const RefusalMemberMembersPhone: Story = at(refusalStory('member', 'members'), 'phone');
export const RefusalMemberMembersDesktop: Story = at(refusalStory('member', 'members'), 'desktop');
export const RefusalModeratorRolesPhone: Story = at(refusalStory('moderator', 'roles'), 'phone');
export const RefusalModeratorRolesDesktop: Story = at(refusalStory('moderator', 'roles'), 'desktop');
export const RefusalModeratorMembersPhone: Story = at(refusalStory('moderator', 'members'), 'phone');
export const RefusalModeratorMembersDesktop: Story = at(refusalStory('moderator', 'members'), 'desktop');
export const RefusalOperatorRolesPhone: Story = at(refusalStory('operator', 'roles'), 'phone');
export const RefusalOperatorRolesDesktop: Story = at(refusalStory('operator', 'roles'), 'desktop');
export const RefusalOperatorMembersPhone: Story = at(refusalStory('operator', 'members'), 'phone');
export const RefusalOperatorMembersDesktop: Story = at(refusalStory('operator', 'members'), 'desktop');
