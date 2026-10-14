import type { Meta, StoryObj } from '@storybook/react-vite';
import { materializeData } from 'native-i18n';
import { expect, userEvent, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import team from '../../../../tests/qa/fixtures/outcomes/realm/roles-and-team.json';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { agentShort, date } from './format.ts';
import { messages } from './messages.ts';
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
  if (persona === 'visitor') {
    return { realm: realmId(persona, 'roles-denied'), actingSubject: actingSubject(persona, 'roles-denied') };
  }
  const session = sample(persona, 'session-agent').answer as { sessionAgent: { actingSubject: string } };
  const header = persona === 'owner' ? 'management-realm-header' : 'frame-realm';
  return { realm: realmId(persona, header), actingSubject: session.sessionAgent.actingSubject };
}

function actorSelections(persona: AnswerPersona): RecordedSelection[] {
  return ['acting-contexts', 'agent-choices', 'session-agent', 'acting-agent-profile'].map(label => selection(persona, label));
}

/** Signed-in frames include the Zone read. An unsigned visitor is redirected before the layout sends it. */
function frameSelections(persona: AnswerPersona): RecordedSelection[] {
  if (persona === 'owner') return [selection(persona, 'management-realm-header'), selection(persona, 'management-site')];
  if (persona === 'visitor') return [selection(persona, 'frame-realm')];
  return [selection(persona, 'frame-realm'), selection(persona, 'frame-site')];
}

function pageSelections(persona: AnswerPersona, labels: readonly string[]): RecordedSelection[] {
  return [
    ...persona === 'visitor' ? [] : actorSelections(persona),
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
    if (persona === 'visitor') {
      await expect(canvas.getByText(t.agentFallback({ id: agentShort(actingSubject(persona, label)) }))).toBeVisible();
    } else {
      const name = (sample(persona, 'acting-agent-profile').answer as { displayName: string }).displayName;
      await expect(canvas.getByText(name)).toBeVisible();
    }
  };
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
export const RefusalVisitorRolesPhone: Story = at(refusalStory('visitor', 'roles'), 'phone');
export const RefusalVisitorRolesDesktop: Story = at(refusalStory('visitor', 'roles'), 'desktop');
export const RefusalVisitorMembersPhone: Story = at(refusalStory('visitor', 'members'), 'phone');
export const RefusalVisitorMembersDesktop: Story = at(refusalStory('visitor', 'members'), 'desktop');
export const RefusalStrangerRolesPhone: Story = at(refusalStory('stranger', 'roles'), 'phone');
export const RefusalStrangerRolesDesktop: Story = at(refusalStory('stranger', 'roles'), 'desktop');
export const RefusalMemberRolesPhone: Story = at(refusalStory('member', 'roles'), 'phone');
export const RefusalMemberRolesDesktop: Story = at(refusalStory('member', 'roles'), 'desktop');
export const RefusalModeratorRolesPhone: Story = at(refusalStory('moderator', 'roles'), 'phone');
export const RefusalModeratorRolesDesktop: Story = at(refusalStory('moderator', 'roles'), 'desktop');
export const RefusalOperatorRolesPhone: Story = at(refusalStory('operator', 'roles'), 'phone');
export const RefusalOperatorRolesDesktop: Story = at(refusalStory('operator', 'roles'), 'desktop');
