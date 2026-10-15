import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import membershipRecord from '../../../../tests/qa/fixtures/outcomes/realm/membership-and-admission.json';
import { date } from '../manage/format.ts';
import { messages as manageMessages } from '../manage/messages.ts';
import { accessMessages } from '../manage/settings-messages.ts';
import { messages as relationshipMessages } from '../relationships/messages.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { RecordedMembershipPage } from './realm-membership-recorded-page.tsx';
import { recordedSample, type MembershipSurface } from './realm-membership-recorded-page.ts';
import { membershipInvitationLabels, membershipRefusalLabels, membershipSelections } from './realm-membership-recorded-samples.ts';
import { materializeData } from 'native-i18n';
import { realmHref } from './route.ts';

const record = membershipRecord as AnswerRecord;
const access = accessMessages.en;
const relationships = relationshipMessages.en;
const phone = { viewport: { value: 'phone' } };

function text(persona: AnswerPersona, label: string, field: string): string {
  const answer = recordedSample(record, persona, label).answer;
  if (!answer || typeof answer !== 'object' || !(field in answer)) throw new Error(`Recorded ${persona}/${label} has no ${field}`);
  const value = (answer as Record<string, unknown>)[field];
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'value' in value && typeof value.value === 'string') return value.value;
  throw new Error(`Recorded ${persona}/${label} ${field} is not text`);
}

function commandText(persona: AnswerPersona, label: string, field: string): string {
  const body = recordedSample(record, persona, label).body;
  if (!body || typeof body !== 'object' || !(field in body)) throw new Error(`Recorded ${persona}/${label} has no ${field}`);
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== 'string') throw new Error(`Recorded ${persona}/${label} ${field} is not text`);
  return value;
}

function itemsOf(label: string): { member: string; reason: string; createdAt: string }[] {
  const answer = recordedSample(record, 'owner', label).answer as { items?: { member: string; reason: string; createdAt: string }[] };
  if (!answer.items) throw new Error(`Recorded owner/${label} has no items`);
  return answer.items;
}

const visitorLanding = [
  { label: 'private-realm-hidden', state: 'error' },
  { label: 'request-landing', state: 'populated' },
] as const satisfies readonly RecordedSelection[];
const joinedFrame = [
  { label: 'frame-session-agent', state: 'populated' },
  { label: 'frame-agent-choices', state: 'populated' },
  { label: 'frame-acting-contexts', state: 'populated' },
  { label: 'frame-acting-agent-profile', state: 'populated' },
  { label: 'frame-person-preferences', state: 'populated' },
  { label: 'frame-address', state: 'populated' },
  { label: 'frame-public-realm', state: 'error' },
  { label: 'frame-realm', state: 'populated' },
  { label: 'frame-realm-zone', state: 'error' },
  { label: 'frame-joining', state: 'populated' },
  { label: 'frame-own-ban', state: 'error' },
  { label: 'frame-follow', state: 'populated' },
  { label: 'frame-platform-access', state: 'populated' },
] as const satisfies readonly RecordedSelection[];
const ownerSession = [
  { label: 'session-agent', state: 'populated' },
  { label: 'agent-choices', state: 'populated' },
  { label: 'acting-contexts', state: 'populated' },
  { label: 'acting-agent-profile', state: 'populated' },
] as const satisfies readonly RecordedSelection[];
const ownerRequests = [
  ...ownerSession,
  { label: 'request-address-space-missing', state: 'error' },
  { label: 'request-inbox', state: 'populated' },
  { label: 'management-realm-header', state: 'populated' },
  { label: 'management-site-absent', state: 'error' },
  { label: 'requester-name-stranger', state: 'populated' },
  { label: 'requester-name-operator', state: 'populated' },
] as const satisfies readonly RecordedSelection[];
const ownerEmpty = [
  ...ownerSession,
  { label: 'request-address-space-missing', state: 'error' },
  { label: 'request-inbox-empty', state: 'empty' },
  { label: 'management-realm-header', state: 'populated' },
  { label: 'management-site-absent', state: 'error' },
] as const satisfies readonly RecordedSelection[];
const ownerSearch = [
  ...ownerRequests,
  { label: 'request-inbox-search-empty', state: 'empty' },
] as const satisfies readonly RecordedSelection[];

/** The signed-in join route. Pending and withdrawn are the same mine read, so one story selects one of them. */
function joinRead(stateLabel: 'withdraw-confirm-own-request' | 'withdraw-confirm-own-request-after'): readonly RecordedSelection[] {
  return [
    { label: 'join-session-agent', state: 'populated' },
    { label: 'join-agent-choices', state: 'populated' },
    { label: 'join-acting-contexts', state: 'populated' },
    { label: 'join-acting-agent-profile', state: 'populated' },
    { label: 'join-address', state: 'populated' },
    { label: 'join-public-realm', state: 'error' },
    { label: 'join-realm', state: 'error' },
    { label: 'join-landing', state: 'populated' },
    { label: stateLabel, state: 'populated' },
  ];
}

/** One recorded decision inbox, plus the confirm the button sends. The later empty inbox is the same read. */
function ownerDecision(inbox: 'decision-confirm-inbox-declined' | 'decision-confirm-inbox-accepted',
  confirm: 'decision-confirm-declined' | 'decision-confirm-accepted'): readonly RecordedSelection[] {
  return [
    ...ownerSession,
    { label: 'request-address-space-missing', state: 'error' },
    { label: inbox, state: 'populated' },
    { label: confirm, state: 'populated' },
    { label: 'management-realm-header', state: 'populated' },
    { label: 'management-site-absent', state: 'error' },
    { label: 'requester-name-stranger', state: 'populated' },
  ];
}

function Recorded({ persona, selections, surface, sequence = false, locale = 'en' }: {
  persona: AnswerPersona; selections: readonly RecordedSelection[]; surface: MembershipSurface; sequence?: boolean;
  locale?: import('../../i18n/define.ts').UiLocale;
}) {
  return <RecordedMembershipPage record={record} persona={persona} selections={selections} surface={surface} sequence={sequence} locale={locale} />;
}

const meta = {
  title: 'Realm/Recorded membership',
  component: Recorded,
  render: (args, { globals }) => <Recorded {...args} locale={globals.locale as import('../../i18n/define.ts').UiLocale} />,
  args: { persona: 'visitor', selections: visitorLanding, surface: 'landing' },
  parameters: { controls: { disable: true }, route: { pathname: realmHref('en', 'recorded') } },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof Recorded>;
export default meta;
type Story = StoryObj<typeof meta>;

async function expectNoOverflow(canvasElement: HTMLElement) {
  const root = canvasElement.ownerDocument.documentElement;
  await expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
}

async function expectLanding(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const name = text('visitor', 'request-landing', 'name');
  await expect(canvas.findByRole('heading', { level: 1, name })).resolves.toBeVisible();
  const link = canvas.getByRole('link', { name: access.signIn });
  await expect(link.getAttribute('href') ?? '').toContain('/auth/start');
  await expect(canvas.queryByRole('button', { name: access.requestJoin })).toBeNull();
  await expectNoOverflow(canvasElement);
}

async function expectLoading(canvasElement: HTMLElement, name: string) {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole('status')).toHaveTextContent(shellMessages.loading);
  await expect(canvas.queryByRole('heading', { name })).toBeNull();
  await expectNoOverflow(canvasElement);
}

async function expectJoined(canvasElement: HTMLElement, persona: 'member' | 'moderator') {
  const canvas = within(canvasElement);
  const name = text(persona, 'frame-realm', 'name');
  await expect(canvas.findByRole('heading', { level: 1, name })).resolves.toBeVisible();
  await expect(canvas.getByRole('button', { name: new RegExp(`${relationships.joined}.*${name}.*${relationships.leave}`) })).toBeVisible();
  await expect(canvas.getByRole('button', { name: `${relationships.notifications}: ${relationships.highlights}` })).toBeVisible();
  await expect(canvas.queryByText(relationships.leaveUnavailable)).toBeNull();
  await expectNoOverflow(canvasElement);
}

async function expectRequests(canvasElement: HTMLElement, label: string) {
  const canvas = within(canvasElement);
  const realm = text('owner', 'management-realm-header', 'name');
  const actor = text('owner', 'acting-agent-profile', 'displayName');
  await expect(canvas.findByRole('heading', { level: 1, name: realm })).resolves.toBeVisible();
  await expect(within(canvas.getByRole('region', { name: manageMessages.actingAs })).getByText(actor)).toBeVisible();
  const items = itemsOf(label);
  for (const item of items) {
    const named = record.personas.owner.find(sample => sample.path.includes(`/v1/agents/${item.member.slice(-36)}`));
    const displayName = (named?.answer as { displayName?: unknown } | undefined)?.displayName;
    if (typeof displayName !== 'string') throw new Error('Recorded requester has no display name');
    await expect(canvas.findByText(displayName)).resolves.toBeVisible();
    await expect(canvas.getAllByText(item.reason).length).toBeGreaterThan(0);
    await expect(canvas.getAllByText(date(item.createdAt, 'en')).length).toBeGreaterThan(0);
  }
  await expect(canvas.queryByRole('button', { name: access.more })).toBeNull();
  await expectNoOverflow(canvasElement);
}

/** Visitor: the hidden Realm opens the recorded request landing, and sign-in is the only continuation. */
export const VisitorLanding: Story = { play: async ({ canvasElement }) => { await expectLanding(canvasElement); } };
export const VisitorLandingPhone: Story = { globals: phone, play: async ({ canvasElement }) => { await expectLanding(canvasElement); } };

/** Visitor: the Realm header is held unanswered. The route does not read admission basis before sign-in. */
export const VisitorLoading: Story = {
  args: { selections: [{ label: 'private-realm-hidden', state: 'loading' }] },
  play: async ({ canvasElement }) => { await expectLoading(canvasElement, text('visitor', 'request-landing', 'name')); },
};
export const VisitorLoadingPhone: Story = { ...VisitorLoading, globals: phone };

/** Member: the recorded joined Realm, with its follow level. */
export const MemberJoined: Story = {
  args: { persona: 'member', selections: joinedFrame, surface: 'joined' },
  play: async ({ canvasElement }) => { await expectJoined(canvasElement, 'member'); },
};
export const MemberJoinedPhone: Story = { ...MemberJoined, globals: phone };

/** Moderator: joined access, without admission administration. */
export const ModeratorJoined: Story = {
  args: { persona: 'moderator', selections: joinedFrame, surface: 'joined' },
  play: async ({ canvasElement }) => { await expectJoined(canvasElement, 'moderator'); },
};
export const ModeratorJoinedPhone: Story = { ...ModeratorJoined, globals: phone };

/** Owner: the recorded pending requests, named and dated, with no further page. */
export const OwnerRequests: Story = {
  args: { persona: 'owner', selections: ownerRequests, surface: 'requests' },
  parameters: { route: { pathname: '/en/manage/r/recorded/requests' } },
  play: async ({ canvasElement }) => { await expectRequests(canvasElement, 'request-inbox'); },
};
export const OwnerRequestsPhone: Story = { ...OwnerRequests, globals: phone };

/** Owner: the recorded inbox has no pending requests. */
export const OwnerEmpty: Story = {
  args: { persona: 'owner', selections: ownerEmpty, surface: 'requests' },
  parameters: { route: { pathname: '/en/manage/r/recorded/requests' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByRole('heading', { level: 1, name: text('owner', 'management-realm-header', 'name') })).resolves.toBeVisible();
    await expect(canvas.findByText(access.empty)).resolves.toBeVisible();
    await expect(canvas.queryByRole('list')).toBeNull();
    await expect(canvas.queryByRole('button', { name: access.approve })).toBeNull();
    await expectNoOverflow(canvasElement);
  },
};
export const OwnerEmptyPhone: Story = { ...OwnerEmpty, globals: phone };

/** Owner: the recorded search matches nothing. */
export const OwnerSearchEmpty: Story = {
  args: { persona: 'owner', selections: ownerSearch, surface: 'requests' },
  parameters: { route: { pathname: '/en/manage/r/recorded/requests' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const stranger = text('owner', 'requester-name-stranger', 'displayName');
    await expect(canvas.findByText(stranger)).resolves.toBeVisible();
    const q = new URL(recordedSample(record, 'owner', 'request-inbox-search-empty').path, 'https://recorded.invalid').searchParams.get('q');
    if (!q) throw new Error('Recorded search names no query');
    await waitFor(() => expect(canvas.getByRole('button', { name: access.searchSubmit })).toBeEnabled());
    await userEvent.type(canvas.getByRole('searchbox', { name: access.search }), q);
    await userEvent.click(canvas.getByRole('button', { name: access.searchSubmit }));
    await expect(canvas.findByText(access.noMatch)).resolves.toBeVisible();
    await expect(canvas.queryByText(stranger)).toBeNull();
    await expect(canvas.getByText(q)).toBeVisible();
    await expectNoOverflow(canvasElement);
  },
};
export const OwnerSearchEmptyPhone: Story = { ...OwnerSearchEmpty, globals: phone };

async function expectJoin(canvasElement: HTMLElement, persona: 'stranger' | 'operator', pending: boolean) {
  const canvas = within(canvasElement);
  const name = text(persona, 'join-landing', 'name');
  await expect(canvas.findByRole('heading', { level: 1, name })).resolves.toBeVisible();
  await expect(canvas.findByText(pending ? access.pending : access.withdrawn)).resolves.toBeVisible();
  if (pending) {
    await expect(canvas.getByRole('button', { name: access.withdraw })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: access.requestJoin })).toBeNull();
  } else {
    await expect(canvas.queryByRole('button', { name: access.withdraw })).toBeNull();
    await expect(canvas.getByRole('button', { name: access.requestJoin })).toBeVisible();
  }
  await expect(canvas.queryByRole('link', { name: access.signIn })).toBeNull();
  await expect(canvas.getByRole('button', { name: access.refreshStatus })).toBeVisible();
  await expectNoOverflow(canvasElement);
}

/** Stranger: the recorded pending request and its withdrawal continuation. */
export const StrangerRequestPending: Story = {
  args: { persona: 'stranger', selections: joinRead('withdraw-confirm-own-request'), surface: 'join' },
  play: async ({ canvasElement }) => { await expectJoin(canvasElement, 'stranger', true); },
};
export const StrangerRequestPendingPhone: Story = { ...StrangerRequestPending, globals: phone };

/** Stranger: the recorded withdrawn request. This mine answer cannot share a story with the pending one. */
export const StrangerRequestWithdrawn: Story = {
  args: { persona: 'stranger', selections: joinRead('withdraw-confirm-own-request-after'), surface: 'join' },
  play: async ({ canvasElement }) => { await expectJoin(canvasElement, 'stranger', false); },
};
export const StrangerRequestWithdrawnPhone: Story = { ...StrangerRequestWithdrawn, globals: phone };

/** Operator: the recorded pending request and its withdrawal continuation. */
export const OperatorRequestPending: Story = {
  args: { persona: 'operator', selections: joinRead('withdraw-confirm-own-request'), surface: 'join' },
  play: async ({ canvasElement }) => { await expectJoin(canvasElement, 'operator', true); },
};
export const OperatorRequestPendingPhone: Story = { ...OperatorRequestPending, globals: phone };

/** Operator: the recorded withdrawn request. */
export const OperatorRequestWithdrawn: Story = {
  args: { persona: 'operator', selections: joinRead('withdraw-confirm-own-request-after'), surface: 'join' },
  play: async ({ canvasElement }) => { await expectJoin(canvasElement, 'operator', false); },
};
export const OperatorRequestWithdrawnPhone: Story = { ...OperatorRequestWithdrawn, globals: phone };

async function expectDecision(canvasElement: HTMLElement, decline: boolean) {
  const inbox = decline ? 'decision-confirm-inbox-declined' : 'decision-confirm-inbox-accepted';
  const confirmLabel = decline ? 'decision-confirm-declined' : 'decision-confirm-accepted';
  await expectRequests(canvasElement, inbox);
  const canvas = within(canvasElement);
  const label = decline ? access.decline : access.approve;
  const reason = commandText('owner', confirmLabel, 'reason');
  await waitFor(() => expect(canvas.getByRole('button', { name: label })).toBeEnabled());
  await userEvent.click(canvas.getByRole('button', { name: label }));
  const content = await within(canvasElement.ownerDocument.body).findByRole('dialog', { name: label });
  const dialog = within(content);
  const input = dialog.getByRole('textbox', { name: access.reason });
  await waitFor(async () => {
    await expect(content).toBeVisible();
    await expect(input).toHaveFocus();
  });
  await userEvent.type(input, reason);
  const confirm = dialog.getByRole('button', { name: label });
  await waitFor(() => expect(confirm).toBeEnabled());
  await userEvent.click(confirm);
  await expect(canvas.findByText(decline ? access.decisionDeclined : access.approved)).resolves.toBeVisible();
  await waitFor(() => expect(within(canvasElement.ownerDocument.body).queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(canvas.getByRole('button', { name: label })).toBeEnabled());
  await expect(canvas.getByText(text('owner', 'requester-name-stranger', 'displayName'))).toBeVisible();
  await expect(canvas.getByText(itemsOf(inbox)[0]!.reason)).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: access.refresh }));
  await expect(canvas.findByText(access.empty)).resolves.toBeVisible();
  await expect(canvas.queryByText(text('owner', 'requester-name-stranger', 'displayName'))).toBeNull();
  await expect(canvas.queryByRole('button', { name: label })).toBeNull();
  await expect(canvas.getByText(decline ? access.decisionDeclined : access.approved)).toBeVisible();
  await expectNoOverflow(canvasElement);
}

/** Owner: decline receipt, the recorded restored request, then the final refreshed inbox. */
export const OwnerDecline: Story = {
  args: {
    persona: 'owner',
    selections: [...ownerDecision('decision-confirm-inbox-declined', 'decision-confirm-declined'),
      { label: 'decision-confirm-selected-refreshed-declined', state: 'populated' },
      { label: 'decision-confirm-inbox-after-declined', state: 'empty' }],
    sequence: true,
    surface: 'requests',
  },
  parameters: { route: { pathname: '/en/manage/r/recorded/requests' } },
  play: async ({ canvasElement }) => { await expectDecision(canvasElement, true); },
};
export const OwnerDeclinePhone: Story = { ...OwnerDecline, globals: phone };

/** Owner: acceptance receipt, the recorded restored request, then the final refreshed inbox. */
export const OwnerAccept: Story = {
  args: {
    persona: 'owner',
    selections: [...ownerDecision('decision-confirm-inbox-accepted', 'decision-confirm-accepted'),
      { label: 'decision-confirm-selected-refreshed-accepted', state: 'populated' },
      { label: 'decision-confirm-inbox-after-accepted', state: 'empty' }],
    sequence: true,
    surface: 'requests',
  },
  parameters: { route: { pathname: '/en/manage/r/recorded/requests' } },
  play: async ({ canvasElement }) => { await expectDecision(canvasElement, false); },
};
export const OwnerAcceptPhone: Story = { ...OwnerAccept, globals: phone };

/** Owner: the address read is held unanswered. The session reads name the acting Person before that hold. */
export const OwnerLoading: Story = {
  args: { persona: 'owner', selections: [
    ...ownerSession,
    { label: 'request-address-space-missing', state: 'loading' },
  ], surface: 'requests' },
  parameters: { route: { pathname: '/en/manage/r/recorded/requests' } },
  play: async ({ canvasElement }) => { await expectLoading(canvasElement, text('owner', 'management-realm-header', 'name')); },
};
export const OwnerLoadingPhone: Story = { ...OwnerLoading, globals: phone };


async function expectWithdrawal(canvasElement: HTMLElement, persona: 'stranger' | 'operator') {
  await expectJoin(canvasElement, persona, true);
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: access.withdraw }));
  const content = await within(canvasElement.ownerDocument.body).findByRole('dialog', { name: access.withdraw });
  const dialog = within(content);
  await userEvent.type(dialog.getByRole('textbox', { name: access.reason }), commandText(persona, 'withdraw-confirm', 'reason'));
  await userEvent.click(dialog.getByRole('button', { name: access.withdraw }));
  await waitFor(() => expect(within(canvasElement.ownerDocument.body).queryByRole('dialog')).toBeNull());
  await expectJoin(canvasElement, persona, false);
  await userEvent.click(canvas.getByRole('button', { name: access.refreshStatus }));
  await expectJoin(canvasElement, persona, false);
}

/** Stranger: one real withdrawal control, receipt and owner-status refresh. */
export const StrangerWithdraw: Story = {
  args: { persona: 'stranger', surface: 'join', sequence: true, selections: [
    ...joinRead('withdraw-confirm-own-request'),
    { label: 'withdraw-confirm', state: 'populated' },
    { label: 'withdraw-confirm-own-request-after', state: 'populated' },
  ] },
  play: async ({ canvasElement }) => { await expectWithdrawal(canvasElement, 'stranger'); },
};
export const StrangerWithdrawPhone: Story = { ...StrangerWithdraw, globals: phone };
export const OperatorWithdraw: Story = {
  ...StrangerWithdraw, args: { ...StrangerWithdraw.args, persona: 'operator' },
  play: async ({ canvasElement }) => { await expectWithdrawal(canvasElement, 'operator'); },
};
export const OperatorWithdrawPhone: Story = { ...OperatorWithdraw, globals: phone };

async function expectRefusal(canvasElement: HTMLElement, persona: 'member' | 'moderator' | 'stranger' | 'operator') {
  const canvas = within(canvasElement);
  const joined = persona === 'member' || persona === 'moderator';
  const t = materializeData(manageMessages, { locale: 'en' });
  await expect(canvas.findByRole('heading', { name: joined ? t.deniedTitle : t.missingTitle })).resolves.toBeVisible();
  const prefix = joined ? 'frame-' : 'join-';
  await expect(canvas.getByText(text(persona, prefix + 'acting-agent-profile', 'displayName'))).toBeVisible();
  if (joined) await expect(canvas.getByRole('heading', { level: 1,
    name: text(persona, 'management-refused-realm-header', 'name') })).toBeVisible();
  await expect(canvas.queryByRole('button', { name: access.approve })).toBeNull();
  await expect(canvas.queryByRole('button', { name: access.decline })).toBeNull();
  await expectNoOverflow(canvasElement);
}

function refusal(persona: 'member' | 'moderator' | 'stranger' | 'operator'): Story {
  return {
    args: { persona, surface: 'requests', selections: membershipSelections(record, persona, membershipRefusalLabels(persona)) },
    parameters: { route: { pathname: '/en/manage/r/recorded/requests' } },
    play: async ({ canvasElement }) => { await expectRefusal(canvasElement, persona); },
  };
}
export const MemberRequestsRefused = refusal('member');
export const MemberRequestsRefusedPhone: Story = { ...MemberRequestsRefused, globals: phone };
export const ModeratorRequestsRefused = refusal('moderator');
export const ModeratorRequestsRefusedPhone: Story = { ...ModeratorRequestsRefused, globals: phone };
export const StrangerRequestsRefused = refusal('stranger');
export const StrangerRequestsRefusedPhone: Story = { ...StrangerRequestsRefused, globals: phone };
export const OperatorRequestsRefused = refusal('operator');
export const OperatorRequestsRefusedPhone: Story = { ...OperatorRequestsRefused, globals: phone };

/** Owner: the reached members page, invitation confirm (HTTP 200) and both refresh paths. */
export const OwnerInvite: Story = {
  args: { persona: 'owner', surface: 'members', sequence: true,
    selections: membershipSelections(record, 'owner', membershipInvitationLabels) },
  parameters: { route: { pathname: '/en/manage/r/recorded/members' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const t = materializeData(manageMessages, { locale: 'en' });
    await expect(canvas.findByRole('heading', { level: 1, name: text('owner', 'management-realm-header', 'name') })).resolves.toBeVisible();
    await expect(canvas.getByText(text('owner', 'acting-agent-profile', 'displayName'))).toBeVisible();
    await expect(canvas.getByText(t.noOutgoingInvitations)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: t.inviteMember }));
    const content = await within(canvasElement.ownerDocument.body).findByRole('dialog', { name: t.inviteTitle });
    const dialog = within(content);
    await userEvent.type(dialog.getByRole('textbox', { name: t.whoLabel }), commandText('owner', 'invitation-confirm', 'member'));
    await userEvent.click(dialog.getByRole('button', { name: t.inviteConfirm }));
    await waitFor(() => expect(within(canvasElement.ownerDocument.body).queryByRole('dialog')).toBeNull());
    await expect(canvas.findByText(text('owner', 'members-after-invitation-name-member', 'displayName'))).resolves.toBeVisible();
    await expect(canvas.getByText(t.invitationPending, { exact: false })).toBeVisible();
    await expect(canvas.getByRole('button', { name: t.cancelInvitation })).toBeVisible();
    const answer = recordedSample(record, 'owner', 'invitation-confirm').answer as { invitation: { expiresAt: string } };
    const invitee = commandText('owner', 'invitation-confirm', 'member');
    await expect(canvas.getByRole('status')).toHaveTextContent(t.invitedNow({
      name: t.agentFallback({ id: invitee.slice(-36, -28) }), date: date(answer.invitation.expiresAt, 'en'),
    }));
    await expect(canvas.queryByText(t.noOutgoingInvitations)).toBeNull();
    await expectNoOverflow(canvasElement);
  },
};
export const OwnerInvitePhone: Story = { ...OwnerInvite, globals: phone };
