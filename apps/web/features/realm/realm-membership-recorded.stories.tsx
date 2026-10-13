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
  { label: 'frame-joining', state: 'populated' },
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

function Recorded({ persona, selections, surface }: {
  persona: AnswerPersona; selections: readonly RecordedSelection[]; surface: MembershipSurface;
}) {
  return <RecordedMembershipPage record={record} persona={persona} selections={selections} surface={surface} />;
}

const meta = {
  title: 'Realm/Recorded membership',
  component: Recorded,
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
