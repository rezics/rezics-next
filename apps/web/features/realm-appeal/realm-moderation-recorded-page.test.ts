import { expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import recordFile from '../../../../tests/qa/fixtures/outcomes/realm/moderation-and-appeal.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { operationOpen, parsePlatformAccess } from '../api/platform-access.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { postMemberAppeal } from './ban-read.ts';
import { readRealmModerationRecorded, recordedAppealKey, type RealmModerationMapped } from './realm-moderation-recorded-page.ts';

// Record gaps, not drawn:
// - No HTTP 202, so there is no pending appeal or decision.
// - Appeal operations are admitted by the production exposure table. Member ban and
//   appeal control still depend on the exact subject behind the authenticated client.
// - No moderation-context sample. This case names no author and no work, so the queue's
//   name read does not call it.
// - No moderator sample refuses another Realm. Operator GET .../appeal 404 is the recorded
//   out-of-realm refusal. Moderator samples are 200, and the two appeal GETs share one path.
// - No join-request records. The queue readers serve /manage/r/{realm}; /requests is a different page.
// - Owner GET .../zone is 503 and is not the queue. The frame does not offer the site editor.
// - The decision basis has decisionHead null. There is no decision command.
// - Moderator GET realm header has no language query. The realm header read always sends one.
// - Member GET realm header 404 is the realm while banned, not an empty ban.

const record = recordFile as AnswerRecord;

function sample(persona: AnswerPersona, label: string): AnswerSample {
  const found = record.personas[persona].filter(item => item.label === label);
  if (found.length !== 1) throw new Error(`Expected one ${record.row}/${persona}/${label}`);
  return found[0]!;
}

function titleOf(value: unknown): string {
  if (!value || typeof value !== 'object' || !('title' in value) || typeof value.title !== 'string') {
    throw new Error('Recorded answer has no title');
  }
  return value.title;
}

async function readMapped(persona: AnswerPersona, selections: readonly RecordedSelection[]): Promise<RealmModerationMapped> {
  const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
  try {
    const client = browserMainApi('https://recorded.invalid', { fetcher: replay.fetcher });
    return await readRealmModerationRecorded(client, record, persona, selections);
  } finally { replay.dispose(); }
}

const ownerQueue = [
  { label: 'management-realm-header', state: 'populated' },
  { label: 'acting-agent-profile', state: 'populated' },
  { label: 'moderation-queue-appeal', state: 'populated' },
  { label: 'appeal-decision-basis', state: 'populated' },
  { label: 'manager-appeal-open', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

function shown(mapped: RealmModerationMapped, kind: RealmModerationMapped['kind']) {
  if (mapped.kind !== kind) throw new Error(mapped.kind === 'discrepancy' ? mapped.detail : mapped.kind);
  return mapped;
}

test('the owner queue keeps the recorded case, the open basis and the appeal statement', async () => {
  const mapped = shown(await readMapped('owner', ownerQueue), 'queue');
  if (mapped.kind !== 'queue') return;
  const page = sample('owner', 'moderation-queue-appeal').answer as { items: { id: string; state: 'open' | 'closed';
    generation: string; decisionHead: null }[]; nextCursor: string | null };
  const basis = sample('owner', 'appeal-decision-basis').answer as { caseId: string; generation: string;
    decisionHead: null; state: string; nextCursor: string | null };
  const header = sample('owner', 'management-realm-header').answer as { name: { value: string } };
  const agent = sample('owner', 'acting-agent-profile').answer as { displayName: string };
  const appeal = sample('owner', 'manager-appeal-open').answer as { reason: string; receiptId: string;
    appeal: { state: string; statement: string; caseId: string } };
  expect(mapped.header.name.value).toBe(header.name.value);
  expect(mapped.agent.label).toBe(agent.displayName);
  expect(mapped.page.nextCursor).toBe(page.nextCursor);
  expect(mapped.page.items).toHaveLength(page.items.length);
  expect(mapped.page.items[0]?.id).toBe(page.items[0]?.id);
  expect(mapped.page.items[0]?.state).toBe(page.items[0]?.state);
  expect(mapped.page.items[0]?.generation).toBe(page.items[0]?.generation);
  expect(mapped.page.items[0]?.decisionHead).toBe(page.items[0]?.decisionHead);
  expect(mapped.basis?.caseId).toBe(basis.caseId);
  expect(mapped.basis?.generation).toBe(basis.generation);
  expect(mapped.basis?.decisionHead).toBe(basis.decisionHead);
  expect(mapped.basis?.state).toBe(basis.state);
  expect(mapped.basis?.nextCursor).toBe(basis.nextCursor);
  expect(mapped.appeal?.reason).toBe(appeal.reason);
  expect(mapped.appeal?.receiptId).toBe(appeal.receiptId);
  expect(mapped.appeal?.appeal).toMatchObject(appeal.appeal);
});

test('the owner empty queue is the recorded empty page', async () => {
  const mapped = shown(await readMapped('owner', [
    { label: 'management-realm-header', state: 'populated' },
    { label: 'acting-agent-profile', state: 'populated' },
    { label: 'moderation-queue-empty', state: 'empty' },
  ]), 'queue');
  if (mapped.kind !== 'queue') return;
  const page = sample('owner', 'moderation-queue-empty').answer as { items: unknown[]; nextCursor: string | null };
  expect(page.items).toHaveLength(0);
  expect(mapped.page.items).toEqual([]);
  expect(mapped.page.nextCursor).toBe(page.nextCursor);
  expect(mapped.basis).toBeNull();
  expect(mapped.appeal).toBeNull();
});

test('a recorded refusal keeps its problem title', async () => {
  const cases = [
    ['stranger', 'another-members-ban-hidden', 'ban'],
    ['stranger', 'another-members-appeal-hidden', 'appeal'],
    ['visitor', 'ban-sign-in-required', 'ban'],
    ['operator', 'appeal-hidden', 'appeal'],
  ] as const;
  for (const [persona, label] of cases) {
    const item = sample(persona, label);
    const mapped = await readMapped(persona, [{ label, state: 'error' }]);
    expect(mapped.kind).toBe('refusal');
    if (mapped.kind !== 'refusal') continue;
    expect(mapped.problem.title).toBe(titleOf(item.answer));
    expect(mapped.problem.status).toBe(item.status);
    expect(mapped.problem.code).toBe((item.answer as { code: string }).code);
  }
});

test('the restored ban keeps the decision and drops the lift receipt', async () => {
  const item = sample('member', 'own-ban-restored');
  const body = item.answer as { reason: string; appeal: { statement: string; rationale: string; liftedAt: string;
    decidedAt: string; liftReceiptId: string; outcome: 'reversed' } };
  const mapped = shown(await readMapped('member', [{ label: 'own-ban-restored', state: 'populated' }]), 'appeal');
  if (mapped.kind !== 'appeal') return;
  expect(mapped.reading.reason).toBe(body.reason);
  expect(mapped.reading.appeal.state).toBe('decided');
  if (mapped.reading.appeal.state !== 'decided') return;
  expect(mapped.reading.appeal.statement).toBe(body.appeal.statement);
  expect(mapped.reading.appeal.rationale).toBe(body.appeal.rationale);
  expect(mapped.reading.appeal.outcome).toBe(body.appeal.outcome);
  if (mapped.reading.appeal.outcome !== 'reversed') return;
  expect(mapped.reading.appeal.liftedAt).toBe(body.appeal.liftedAt);
  expect(mapped.reading.appeal.decidedAt).toBe(body.appeal.decidedAt);
  expect(JSON.stringify(mapped.reading)).not.toContain(body.appeal.liftReceiptId);
});

test('a conflicting appeal command stays the recorded refusal', async () => {
  const item = sample('member', 'appeal-intent-conflict');
  const mapped = await readMapped('member', [{ label: item.label, state: 'error' }]);
  expect(mapped.kind).toBe('refusal');
  if (mapped.kind !== 'refusal') return;
  expect(mapped.problem.title).toBe(titleOf(item.answer));
  expect(mapped.problem.code).toBe('idempotency_conflict');
});

test('the admitted appeal command keeps the recorded case and is not a receipt page', async () => {
  const item = sample('member', 'appeal-opened');
  const body = item.body as { statement: string };
  const answer = item.answer as { state: string; replayed: boolean; caseId: string };
  const replay = recordedFetch(record, 'member', [{ label: item.label, state: 'populated' }], { pathPrefix: BFF_PREFIX });
  try {
    const client = browserMainApi('https://recorded.invalid', { fetcher: replay.fetcher });
    const sent = await postMemberAppeal(client, item.path.split('/')[3]!, item.path.split('/')[5]!, body.statement,
      recordedAppealKey);
    expect(sent.error).toBeNull();
    expect(sent.data).toMatchObject({ state: answer.state, replayed: answer.replayed, caseId: answer.caseId });
  } finally { replay.dispose(); }
  const mapped = await readMapped('member', [{ label: item.label, state: 'populated' }]);
  expect(mapped.kind).toBe('discrepancy');
});

test('the member platform-access sample opens only the admitted appeal operations', async () => {
  const access = parsePlatformAccess(sample('member', 'appeal-access').answer);
  expect(access).not.toBeNull();
  expect(operationOpen('getV1RealmsByRealmMember-ban', access)).toBe(true);
  expect(operationOpen('postV1RealmsByRealmMember-receiptsByReceiptIdAppeal', access)).toBe(true);
  expect(operationOpen('getV1RealmsByRealmMember-receiptsByReceiptIdAppeal', access)).toBe(true);
  expect(sample('member', 'own-ban').status).toBe(200);
  expect(sample('member', 'appeal-opened').status).toBe(201);
  const mapped = await readMapped('member', [{ label: 'appeal-access', state: 'populated' }]);
  expect(mapped.kind).toBe('discrepancy');
  if (mapped.kind === 'discrepancy') expect(mapped.detail).toBe('no recorded page read in the selection');
});
