import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { materializeData } from 'native-i18n';
import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import recordFile from '../../../../tests/qa/fixtures/outcomes/realm/moderation-and-appeal.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { kindLabel } from '../manage/labels.ts';
import { messages as manageMessages } from '../manage/messages.ts';
import type { ModerationItem } from '../manage/types.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { messages as appealMessages } from './messages.ts';
import { RealmModerationRecordedPage } from './realm-moderation-recorded-page.tsx';
import { readRealmModerationRecorded, type RealmModerationMapped } from './realm-moderation-recorded-page.ts';

const record = recordFile as AnswerRecord;
const manage = materializeData(manageMessages, { locale: 'en' });
const appeal = materializeData(appealMessages, { locale: 'en' });
const loadingText = materializeData(shellMessages, { locale: 'en' }).loading;

function sample(persona: AnswerPersona, label: string): AnswerSample {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`Missing ${record.row}/${persona}/${label}`);
  return found;
}

function titleOf(value: unknown): string {
  if (!value || typeof value !== 'object' || !('title' in value) || typeof value.title !== 'string') {
    throw new Error('Recorded answer has no title');
  }
  return value.title;
}

function when(value: string): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value));
}

const ownerQueue = [
  { label: 'management-realm-header', state: 'populated' },
  { label: 'acting-agent-profile', state: 'populated' },
  { label: 'moderation-queue-appeal', state: 'populated' },
  { label: 'appeal-decision-basis', state: 'populated' },
  { label: 'manager-appeal-open', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

interface Ready { mapped: RealmModerationMapped; client: ReturnType<typeof browserMainApi> }

function RecordedModeration({ persona, selections }: {
  persona: AnswerPersona; selections: readonly RecordedSelection[];
}) {
  const [ready, setReady] = useState<Ready | null>(null);
  const key = selections.map(item => `${item.label}:${item.state}`).join('|');
  useEffect(() => {
    setReady(null);
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
    const client = browserMainApi(window.location.origin, { fetcher: replay.fetcher });
    let mounted = true;
    void readRealmModerationRecorded(client, record, persona, selections).then(mapped => {
      if (!mounted) return;
      if (mapped.kind === 'discrepancy') throw new Error(mapped.detail);
      setReady({ mapped, client });
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
    });
    return () => { mounted = false; replay.dispose(); };
  }, [persona, key, selections]);
  if (!ready) return <p role="status">{loadingText}</p>;
  return <RealmModerationRecordedPage mapped={ready.mapped} client={ready.client} locale="en" />;
}

const meta = {
  title: 'Realm/Recorded moderation', component: RecordedModeration,
  args: { persona: 'owner' as const, selections: ownerQueue },
  parameters: { controls: { disable: true }, route: { pathname: '/en/manage/r/realm' } },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof RecordedModeration>;
export default meta;
type Story = StoryObj<typeof meta>;

const phone = { viewport: { value: 'phone' } };

async function fits(canvasElement: HTMLElement) {
  const root = canvasElement.ownerDocument.documentElement;
  await expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
}

async function expectOwnerQueue(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const header = sample('owner', 'management-realm-header').answer as { name: { value: string } };
  const agent = sample('owner', 'acting-agent-profile').answer as { displayName: string };
  const page = sample('owner', 'moderation-queue-appeal').answer as { items: { id: string; kind: ModerationItem['kind'];
    state: string; generation: string; submission: null }[]; nextCursor: null };
  const basis = sample('owner', 'appeal-decision-basis').answer as { caseId: string; generation: string;
    decisionHead: null; nextCursor: null; state: string };
  const receipt = sample('owner', 'manager-appeal-open').answer as { reason: string;
    appeal: { statement: string } };
  const item = page.items[0];
  if (!item) throw new Error('Recorded queue has no case');
  await expect(item.state).toBe('open');
  await expect(item.submission).toBeNull();
  await expect(basis.decisionHead).toBeNull();
  await expect(basis.nextCursor).toBeNull();
  await expect(page.nextCursor).toBeNull();
  await expect(canvas.findByRole('heading', { name: header.name.value })).resolves.toBeVisible();
  await expect(canvas.getByText(agent.displayName)).toBeVisible();
  await expect(canvas.findAllByText(kindLabel(item.kind, manage))).resolves.not.toHaveLength(0);
  await expect(canvas.getByText(manage.waiting(page.items.length))).toBeVisible();
  await expect(canvas.getByRole('heading', { name: manage.decisionEntry({
    outcome: manage.statePending, generation: basis.generation }) })).toBeVisible();
  await expect(canvas.getByText(basis.caseId)).toBeVisible();
  await expect(canvas.getAllByText(receipt.reason)[0]).toBeVisible();
  await expect(canvas.getAllByText(receipt.appeal.statement)[0]).toBeVisible();
  await expect(canvas.getAllByText(manage.reasonLabel)[0]).toBeVisible();
  await expect(canvas.getAllByText(manage.submittedText)[0]).toBeVisible();
  await expect(canvas.queryByRole('button', { name: manage.loadMore })).toBeNull();
  if (canvasElement.ownerDocument.documentElement.clientWidth >= 1024) {
    await expect(canvas.getByRole('button', { name: 'Uphold ban' })).toBeVisible();
  }
  await fits(canvasElement);
}

async function expectLoading(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const header = sample('owner', 'management-realm-header').answer as { name: { value: string } };
  const page = sample('owner', 'moderation-queue-appeal').answer as { items: { id: string }[] };
  await expect(canvas.getByRole('status')).toHaveTextContent(loadingText);
  await expect(canvas.queryByRole('heading', { name: header.name.value })).toBeNull();
  await expect(canvas.queryByText(page.items[0]?.id ?? 'missing-case')).toBeNull();
  await expect(canvas.queryByRole('heading', { name: manage.emptyOpenTitle })).toBeNull();
}

async function expectEmpty(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const page = sample('owner', 'moderation-queue-empty').answer as { items: unknown[]; nextCursor: null };
  const populated = sample('owner', 'moderation-queue-appeal').answer as { items: { id: string }[] };
  await expect(page.items).toHaveLength(0);
  await expect(page.nextCursor).toBeNull();
  await expect(canvas.findByRole('heading', { name: manage.emptyOpenTitle })).resolves.toBeVisible();
  await expect(canvas.getByText(manage.nothingWaiting)).toBeVisible();
  await expect(canvas.queryByText(populated.items[0]?.id ?? 'missing-case')).toBeNull();
  await expect(canvas.queryByRole('button', { name: manage.loadMore })).toBeNull();
  await fits(canvasElement);
}

async function expectRefusal(canvasElement: HTMLElement, persona: AnswerPersona, label: string) {
  const canvas = within(canvasElement);
  const title = titleOf(sample(persona, label).answer);
  await expect(canvas.findByRole('alert')).resolves.toHaveTextContent(title);
  await expect(canvas.getByRole('heading', { name: title })).toBeVisible();
  await fits(canvasElement);
}

async function expectReceipt(canvasElement: HTMLElement, persona: AnswerPersona, label: string, received: boolean) {
  const canvas = within(canvasElement);
  const body = sample(persona, label).answer as { reason: string; permanent: boolean;
    appeal: { state: string; statement?: string } };
  await expect(canvas.findByRole('heading', { name: appeal.title })).resolves.toBeVisible();
  await expect(canvas.getByText(body.reason)).toBeVisible();
  if (body.permanent) await expect(canvas.getByText(appeal.permanent)).toBeVisible();
  if (received) {
    const statement = body.appeal.statement;
    if (!statement) throw new Error('Recorded open appeal has no statement');
    await expect(canvas.getByRole('heading', { name: appeal.receivedTitle })).toBeVisible();
    await expect(canvas.getByText(statement)).toBeVisible();
    await expect(canvas.queryByRole('button', { name: appeal.send })).toBeNull();
  } else {
    await expect(canvas.getByRole('button', { name: appeal.send })).toBeVisible();
    await expect(canvas.queryByRole('heading', { name: appeal.receivedTitle })).toBeNull();
  }
  await fits(canvasElement);
}

/** Owner, realm/moderation-and-appeal: the open sanction appeal, its basis and the recorded statement. */
export const OwnerPopulated: Story = {
  async play({ canvasElement }) { await expectOwnerQueue(canvasElement); },
};

export const OwnerPopulatedPhone: Story = {
  globals: phone,
  async play({ canvasElement }) { await expectOwnerQueue(canvasElement); },
};

/** Owner, realm/moderation-and-appeal: the queue read is held unanswered. */
export const OwnerLoading: Story = {
  args: { selections: [{ label: 'moderation-queue-appeal', state: 'loading' }] },
  async play({ canvasElement }) { await expectLoading(canvasElement); },
};

export const OwnerLoadingPhone: Story = {
  args: { selections: [{ label: 'moderation-queue-appeal', state: 'loading' }] },
  globals: phone,
  async play({ canvasElement }) { await expectLoading(canvasElement); },
};

/** Owner, realm/moderation-and-appeal: the recorded open queue has no cases. */
export const OwnerEmpty: Story = {
  args: { selections: [
    { label: 'management-realm-header', state: 'populated' },
    { label: 'acting-agent-profile', state: 'populated' },
    { label: 'moderation-queue-empty', state: 'empty' },
  ] },
  async play({ canvasElement }) { await expectEmpty(canvasElement); },
};

export const OwnerEmptyPhone: Story = {
  ...OwnerEmpty,
  globals: phone,
};

/** Member, realm/moderation-and-appeal: their own ban, before an appeal. The empty platform-access sample is not applied. */
export const MemberReceipt: Story = {
  args: { persona: 'member', selections: [{ label: 'own-ban', state: 'populated' }] },
  async play({ canvasElement }) { await expectReceipt(canvasElement, 'member', 'own-ban', false); },
};

export const MemberReceiptPhone: Story = {
  ...MemberReceipt,
  globals: phone,
};

/** Member, realm/moderation-and-appeal: the open appeal receipt and the statement they sent. */
export const MemberAppeal: Story = {
  args: { persona: 'member', selections: [{ label: 'appeal-open', state: 'populated' }] },
  async play({ canvasElement }) { await expectReceipt(canvasElement, 'member', 'appeal-open', true); },
};

export const MemberAppealPhone: Story = {
  ...MemberAppeal,
  globals: phone,
};

/** Member, realm/moderation-and-appeal: the ban was lifted. The lift receipt id stays off the page. */
export const MemberRestored: Story = {
  args: { persona: 'member', selections: [{ label: 'own-ban-restored', state: 'populated' }] },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const body = sample('member', 'own-ban-restored').answer as { reason: string;
      appeal: { statement: string; rationale: string; liftedAt: string; liftReceiptId: string } };
    await expect(canvas.findByRole('heading', { name: appeal.lifted({ date: when(body.appeal.liftedAt) }) }))
      .resolves.toBeVisible();
    await expect(canvas.getByText(body.reason)).toBeVisible();
    await expect(canvas.getByText(body.appeal.statement)).toBeVisible();
    await expect(canvas.getByText(body.appeal.rationale)).toBeVisible();
    await expect(canvasElement.textContent).not.toContain(body.appeal.liftReceiptId);
    await expect(canvas.queryByRole('button', { name: appeal.send })).toBeNull();
    await fits(canvasElement);
  },
};

export const MemberRestoredPhone: Story = {
  ...MemberRestored,
  globals: phone,
};

/** Member, realm/moderation-and-appeal: the same key already binds another statement. */
export const MemberConflict: Story = {
  args: { persona: 'member', selections: [{ label: 'appeal-intent-conflict', state: 'error' }] },
  async play({ canvasElement }) { await expectRefusal(canvasElement, 'member', 'appeal-intent-conflict'); },
};

export const MemberConflictPhone: Story = {
  ...MemberConflict,
  globals: phone,
};

/** Stranger, realm/moderation-and-appeal: another member's ban stays hidden. */
export const StrangerRefused: Story = {
  args: { persona: 'stranger', selections: [{ label: 'another-members-ban-hidden', state: 'error' }] },
  async play({ canvasElement }) { await expectRefusal(canvasElement, 'stranger', 'another-members-ban-hidden'); },
};

export const StrangerRefusedPhone: Story = {
  ...StrangerRefused,
  globals: phone,
};

/** Stranger, realm/moderation-and-appeal: their own unjoined sanction, already appealed. */
export const StrangerAppeal: Story = {
  args: { persona: 'stranger', selections: [{ label: 'unjoined-appellant-open', state: 'populated' }] },
  async play({ canvasElement }) { await expectReceipt(canvasElement, 'stranger', 'unjoined-appellant-open', true); },
};

export const StrangerAppealPhone: Story = {
  ...StrangerAppeal,
  globals: phone,
};

/** Operator, realm/moderation-and-appeal: an appeal outside the Realm stays unavailable. */
export const OperatorRefused: Story = {
  args: { persona: 'operator', selections: [{ label: 'appeal-hidden', state: 'error' }] },
  async play({ canvasElement }) { await expectRefusal(canvasElement, 'operator', 'appeal-hidden'); },
};

export const OperatorRefusedPhone: Story = {
  ...OperatorRefused,
  globals: phone,
};

/** Visitor, realm/moderation-and-appeal: no account assertion, so the ban read is refused. */
export const VisitorRefused: Story = {
  args: { persona: 'visitor', selections: [{ label: 'ban-sign-in-required', state: 'error' }] },
  async play({ canvasElement }) { await expectRefusal(canvasElement, 'visitor', 'ban-sign-in-required'); },
};

export const VisitorRefusedPhone: Story = {
  ...VisitorRefused,
  globals: phone,
};

/** Moderator, realm/moderation-and-appeal: the recorded decision upheld the ban. The open appeal shares this path. */
export const ModeratorDismissed: Story = {
  args: { persona: 'moderator', selections: [{ label: 'appeal-dismissed-private', state: 'populated' }] },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const body = sample('moderator', 'appeal-dismissed-private').answer as { reason: string;
      appeal: { statement: string; rationale: null; outcome: string } };
    await expect(body.appeal.outcome).toBe('dismiss');
    await expect(body.appeal.rationale).toBeNull();
    await expect(canvas.findByRole('heading', { name: appeal.upheldUndated })).resolves.toBeVisible();
    await expect(canvas.getByText(body.reason)).toBeVisible();
    await expect(canvas.getByText(body.appeal.statement)).toBeVisible();
    await expect(canvas.queryByText(appeal.sharedLabel)).toBeNull();
    await expect(canvas.queryByRole('button', { name: appeal.send })).toBeNull();
    await fits(canvasElement);
  },
};

export const ModeratorDismissedPhone: Story = {
  ...ModeratorDismissed,
  globals: phone,
};
