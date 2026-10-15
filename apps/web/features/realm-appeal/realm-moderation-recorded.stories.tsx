import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { materializeData } from 'native-i18n';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import recordFile from '../../../../tests/qa/fixtures/outcomes/realm/moderation-and-appeal.json';
import { messages as manageMessages } from '../manage/messages.ts';
import { reviewText } from './review-messages.ts';
import type { QueueView } from '../manage/routes.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { recordedSample } from '../realm/realm-membership-recorded-page.ts';
import { RecordedModerationPage, recordedPlatformAccess } from './realm-moderation-recorded-page.tsx';

const record = recordFile as AnswerRecord;
const manage = materializeData(manageMessages, { locale: 'en' });
const review = reviewText.en;
const loadingText = shellMessages.loading;
const phone = { viewport: { value: 'phone' } };
const openView = { state: 'open', type: null, reason: null } as const satisfies QueueView;
const closedView = { state: 'closed', type: null, reason: null } as const satisfies QueueView;

const ownerSession = [
  { label: 'session-agent', state: 'populated' },
  { label: 'agent-choices', state: 'populated' },
  { label: 'acting-contexts', state: 'populated' },
  { label: 'acting-agent-profile', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

const ownerFrame = [
  ...ownerSession,
  { label: 'management-realm-header', state: 'populated' },
  { label: 'management-site', state: 'error' },
  { label: 'owner-before-decision-2', state: 'populated' },
  { label: 'owner-before-decision-7', state: 'error' },
  { label: 'owner-before-decision-8', state: 'populated' },
  { label: 'owner-before-decision-9', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

const ownerQueue = [
  ...ownerFrame,
  { label: 'moderation-queue-appeal', state: 'populated' },
  { label: 'appeal-decision-basis', state: 'populated' },
  { label: 'manager-appeal-open', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

const ownerEmpty = [
  ...ownerFrame,
  { label: 'moderation-queue-empty', state: 'empty' },
] as const satisfies readonly RecordedSelection[];

const moderatorSession = [
  { label: 'frame-session-agent', state: 'populated' },
  { label: 'page-agent-choices', state: 'populated' },
  { label: 'page-acting-contexts', state: 'populated' },
  { label: 'page-acting-agent-profile', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

const moderatorRefused = [
  ...moderatorSession,
  { label: 'moderator-other-realm-1', state: 'error' },
  { label: 'moderator-other-realm-2', state: 'populated' },
  { label: 'moderator-other-realm-3', state: 'error' },
  { label: 'moderator-other-realm-4', state: 'error' },
  { label: 'moderator-other-realm-5', state: 'error' },
  { label: 'moderator-other-realm-6', state: 'error' },
] as const satisfies readonly RecordedSelection[];

const moderatorOpen = [
  ...moderatorSession,
  { label: 'moderator-open-1', state: 'populated' },
  { label: 'moderator-open-2', state: 'populated' },
  { label: 'moderator-open-3', state: 'error' },
  { label: 'moderator-open-4', state: 'populated' },
  { label: 'moderator-open-5', state: 'populated' },
  { label: 'moderator-open-6', state: 'populated' },
  { label: 'moderator-open-7', state: 'error' },
  { label: 'moderator-open-8', state: 'populated' },
  { label: 'moderator-open-9', state: 'error' },
] as const satisfies readonly RecordedSelection[];

const moderatorDecided = [
  ...moderatorSession,
  { label: 'moderator-management-1', state: 'populated' },
  { label: 'moderator-management-2', state: 'populated' },
  { label: 'moderator-management-3', state: 'error' },
  { label: 'moderator-management-4', state: 'populated' },
  { label: 'moderator-management-5', state: 'populated' },
  { label: 'moderator-management-6', state: 'populated' },
  { label: 'moderator-management-7', state: 'error' },
  { label: 'moderator-management-8', state: 'populated' },
  { label: 'moderator-management-9', state: 'error' },
] as const satisfies readonly RecordedSelection[];

const ownerDecided = [
  ...ownerSession,
  { label: 'owner-decided-1', state: 'populated' },
  { label: 'owner-decided-2', state: 'populated' },
  { label: 'owner-decided-3', state: 'error' },
  { label: 'owner-decided-4', state: 'populated' },
  { label: 'owner-decided-6', state: 'populated' },
  { label: 'owner-decided-7', state: 'populated' },
  { label: 'owner-decided-5', state: 'populated' },
  { label: 'owner-decided-8', state: 'populated' },
  { label: 'owner-decided-9', state: 'error' },
  { label: 'owner-decided-10', state: 'populated' },
  { label: 'owner-decided-11', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

function realmOf(persona: AnswerPersona, label: string): string {
  const path = recordedSample(record, persona, label).path;
  return new URL(path, 'https://recorded.invalid').pathname.split('/')[3] ?? '';
}

function Recorded({ persona, selections, realm, view, locale = 'en' }: {
  persona: AnswerPersona; selections: readonly RecordedSelection[]; realm: string; view: QueueView;
  locale?: import('../../i18n/define.ts').UiLocale;
}) {
  return <RecordedModerationPage record={record} persona={persona} selections={selections} realm={realm} view={view}
    platformAccess={recordedPlatformAccess(record, persona)} locale={locale} />;
}

const meta = {
  title: 'Realm/Recorded moderation',
  component: Recorded,
  render: (args, { globals }) => <Recorded {...args} locale={globals.locale as import('../../i18n/define.ts').UiLocale} />,
  args: { persona: 'owner' as const, selections: ownerQueue, realm: realmOf('owner', 'management-realm-header'), view: openView },
  parameters: { controls: { disable: true }, route: { pathname: '/en/manage/r/realm' } },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof Recorded>;
export default meta;
type Story = StoryObj<typeof meta>;

async function fits(canvasElement: HTMLElement) {
  const root = canvasElement.ownerDocument.documentElement;
  await expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
}

async function expectSettings(canvas: ReturnType<typeof within>, allowed: boolean) {
  const name = manage.tabSettings;
  if (allowed) await waitFor(() => expect(canvas.getByRole('link', { name })).toBeVisible());
  else await expect(canvas.queryByRole('link', { name })).toBeNull();
}

async function expectSanction(canvasElement: HTMLElement, persona: AnswerPersona, labels: {
  header: string; agent: string; queue: string; basis: string; receipt: string;
}, commands: 'both' | 'dismiss' | 'none', row = 0, settings = false) {
  const canvas = within(canvasElement);
  const header = recordedSample(record, persona, labels.header).answer as { name: { value: string } };
  const agent = recordedSample(record, persona, labels.agent).answer as { displayName: string };
  const page = recordedSample(record, persona, labels.queue).answer as {
    items: { id: string; state: string; decisionHead: string | null }[];
  };
  const basis = recordedSample(record, persona, labels.basis).answer as {
    caseId: string; state: string; decisionHead: string | null;
  };
  const receipt = recordedSample(record, persona, labels.receipt).answer as {
    reason: string; appeal: { statement: string; state: string; caseId: string; outcome?: string };
  };
  const item = page.items[row];
  if (!item) throw new Error('Recorded queue has no case');
  await expect(item.id).toBe(basis.caseId);
  await expect(item.decisionHead).toBe(basis.decisionHead);
  await expect(receipt.appeal.caseId).toBe(item.id);
  await expect(receipt.appeal.state).toBe(basis.state === 'open' ? 'open' : 'decided');
  if (basis.state === 'open') await expect(basis.decisionHead).toBeNull();
  else await expect(typeof basis.decisionHead).toBe('string');
  await expect(canvas.findByRole('heading', { name: header.name.value })).resolves.toBeVisible();
  await expect(canvas.getByText(agent.displayName)).toBeVisible();
  if (item.state === 'open') await expect(canvas.getByText(manage.waiting(page.items.length))).toBeVisible();
  const rows = await canvas.findAllByRole('button', { name: /Ban appeal/ });
  const chosen = rows[row];
  if (!chosen) throw new Error('Recorded appeal row is not shown');
  await userEvent.click(chosen);
  await expect(chosen).toHaveAttribute('aria-current', 'true');
  await waitFor(async () => {
    await expect(canvas.queryByText(manage.impactChecking)).toBeNull();
    await expect(canvas.getByRole('heading', { name: review.title })).toBeVisible();
  });
  await expect(canvas.getAllByText(receipt.reason).length).toBeGreaterThan(0);
  await expect(canvas.getAllByText(receipt.appeal.statement).length).toBeGreaterThan(0);
  await expect(canvas.getAllByText(manage.reasonLabel).length).toBeGreaterThan(0);
  await expect(canvas.getAllByText(manage.submittedText).length).toBeGreaterThan(0);
  if (item.state === 'closed') await expect(canvas.getAllByText(manage.stateClosedReport).length).toBeGreaterThan(0);
  if (commands === 'none') await expect(canvas.queryByRole('button', { name: review.dismiss })).toBeNull();
  else await expect(canvas.getByRole('button', { name: review.dismiss })).toBeVisible();
  if (commands === 'both') await expect(canvas.getByRole('button', { name: review.restore })).toBeVisible();
  else await expect(canvas.queryByRole('button', { name: review.restore })).toBeNull();
  await expect(canvas.queryByRole('button', { name: manage.loadMore })).toBeNull();
  await expect(canvas.queryByRole('link', { name: manage.editSite })).toBeNull();
  await expectSettings(canvas, settings);
  await fits(canvasElement);
}

async function expectOwnerQueue(canvasElement: HTMLElement) {
  await expectSanction(canvasElement, 'owner', {
    header: 'management-realm-header', agent: 'acting-agent-profile', queue: 'moderation-queue-appeal',
    basis: 'appeal-decision-basis', receipt: 'manager-appeal-open',
  }, 'both', 0, true);
}

async function expectLoading(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const header = recordedSample(record, 'owner', 'management-realm-header').answer as { name: { value: string } };
  await expect(canvas.getByRole('status')).toHaveTextContent(loadingText);
  await expect(canvas.queryByRole('heading', { name: header.name.value })).toBeNull();
  await expect(canvas.queryByRole('heading', { name: manage.emptyOpenTitle })).toBeNull();
}

async function expectEmpty(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const header = recordedSample(record, 'owner', 'management-realm-header').answer as { name: { value: string } };
  const page = recordedSample(record, 'owner', 'moderation-queue-empty').answer as { items: unknown[]; nextCursor: null };
  await expect(page.items).toHaveLength(0);
  await expect(page.nextCursor).toBeNull();
  await expect(canvas.findByRole('heading', { name: header.name.value })).resolves.toBeVisible();
  await expect(canvas.findByRole('heading', { name: manage.emptyOpenTitle })).resolves.toBeVisible();
  await expect(canvas.getByText(manage.nothingWaiting)).toBeVisible();
  await expect(canvas.queryByRole('heading', { name: review.title })).toBeNull();
  await expect(canvas.queryByRole('button', { name: manage.loadMore })).toBeNull();
  await expectSettings(canvas, true);
  await fits(canvasElement);
}

async function expectModeratorRefused(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const agent = recordedSample(record, 'moderator', 'page-acting-agent-profile').answer as { displayName: string };
  const refused = recordedSample(record, 'moderator', 'moderator-other-realm-4').answer as { title: string; code: string };
  await expect(refused.code).toBe('not_found');
  await expect(canvas.findByRole('heading', { name: manage.deniedTitle })).resolves.toBeVisible();
  await expect(canvas.getByText(manage.deniedHelp)).toBeVisible();
  await expect(canvas.getByText(agent.displayName)).toBeVisible();
  await expect(canvas.queryByRole('heading', { name: review.title })).toBeNull();
  await expect(canvas.queryByRole('link', { name: manage.editSite })).toBeNull();
  await expect(canvas.queryByText(refused.title)).toBeNull();
  await expectSettings(canvas, false);
  await fits(canvasElement);
}

/** Owner: the open sanction appeal, its basis and the appellant's statement. */
export const OwnerPopulated: Story = { play: async ({ canvasElement }) => { await expectOwnerQueue(canvasElement); } };
export const OwnerPopulatedPhone: Story = { globals: phone, play: async ({ canvasElement }) => { await expectOwnerQueue(canvasElement); } };

/** Owner: the queue read is held unanswered. */
export const OwnerLoading: Story = {
  args: { selections: ownerQueue.map(item => item.label === 'moderation-queue-appeal' ? { ...item, state: 'loading' as const } : item) },
  play: async ({ canvasElement }) => { await expectLoading(canvasElement); },
};
export const OwnerLoadingPhone: Story = { ...OwnerLoading, globals: phone };

/** Owner: the recorded open queue has no items. */
export const OwnerEmpty: Story = {
  args: { selections: ownerEmpty },
  play: async ({ canvasElement }) => { await expectEmpty(canvasElement); },
};
export const OwnerEmptyPhone: Story = { ...OwnerEmpty, globals: phone };

/** Moderator of another Realm: the queue refuses, and the frame still asks for the Zone. */
export const ModeratorRefused: Story = {
  args: {
    persona: 'moderator', selections: moderatorRefused,
    realm: realmOf('moderator', 'moderator-other-realm-1'),
  },
  play: async ({ canvasElement }) => { await expectModeratorRefused(canvasElement); },
};
export const ModeratorRefusedPhone: Story = { ...ModeratorRefused, globals: phone };

/** Moderator: the open sanction appeal, its basis and the appellant's statement. Dismiss only. */
export const ModeratorOpen: Story = {
  args: {
    persona: 'moderator', selections: moderatorOpen, realm: realmOf('moderator', 'moderator-open-1'), view: openView,
  },
  play: async ({ canvasElement }) => {
    await expectSanction(canvasElement, 'moderator', {
      header: 'moderator-open-1', agent: 'page-acting-agent-profile', queue: 'moderator-open-4',
      basis: 'moderator-open-5', receipt: 'moderator-open-6',
    }, 'dismiss');
  },
};
export const ModeratorOpenPhone: Story = { ...ModeratorOpen, globals: phone };

/** Moderator: the closed appeal keeps its recorded decision and shows no command. */
export const ModeratorDecided: Story = {
  args: {
    persona: 'moderator', selections: moderatorDecided, realm: realmOf('moderator', 'moderator-management-1'),
    view: closedView,
  },
  play: async ({ canvasElement }) => {
    await expectSanction(canvasElement, 'moderator', {
      header: 'moderator-management-1', agent: 'page-acting-agent-profile', queue: 'moderator-management-4',
      basis: 'moderator-management-5', receipt: 'moderator-management-6',
    }, 'none');
  },
};
export const ModeratorDecidedPhone: Story = { ...ModeratorDecided, globals: phone };

/** Owner: the closed queue's decided case, selected after the first closed case paints. */
export const OwnerDecided: Story = {
  args: {
    persona: 'owner', selections: ownerDecided, realm: realmOf('owner', 'owner-decided-1'), view: closedView,
  },
  play: async ({ canvasElement }) => {
    await expectSanction(canvasElement, 'owner', {
      header: 'owner-decided-1', agent: 'acting-agent-profile', queue: 'owner-decided-4',
      basis: 'owner-decided-5', receipt: 'owner-decided-8',
    }, 'none', 1, true);
  },
};
export const OwnerDecidedPhone: Story = { ...OwnerDecided, globals: phone };
