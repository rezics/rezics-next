import { expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import recordFile from '../../../../tests/qa/fixtures/outcomes/realm/moderation-and-appeal.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { readDecisionBasis, readQueue, readRealmHeader, settle } from '../manage/read.ts';
import { readManagementAccess } from '../manage/settings-api.ts';
import { realmEditSite } from '../manage/realm-site.ts';
import { permissionsIn } from '../manage/server.ts';
import { realmFrameReads } from '../realm/zone-presentation-read.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { recordedIdentity, recordedManagementAgent, recordedSample } from '../realm/realm-membership-recorded-page.ts';
import { readAppealReceipt } from './ban-read.ts';

// Record gaps, not drawn:
// - No HTTP 202, so there is no pending appeal or decision.
// - The member's zone address has no realm capability and its presentation names no realm,
//   so the realm page stops at missing and does not read the ban or the appeal.
// - Join requests are a different page.
// - These sanction items name no author and no work, so the queue's name read does not
//   call moderation context.

const record = recordFile as AnswerRecord;

function answerOf<T>(persona: AnswerPersona, label: string): T {
  const answer = recordedSample(record, persona, label).answer;
  if (!answer || typeof answer !== 'object') throw new Error(`Recorded ${persona}/${label} has no object answer`);
  return answer as T;
}

async function withReplay<T>(persona: AnswerPersona, selections: readonly RecordedSelection[],
  run: (main: MainClient, fetcher: typeof fetch) => Promise<T>): Promise<T> {
  let missed: string | null = null;
  const playback = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try { return await playback.fetcher(input, init); }
    catch (error) {
      missed = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }) as typeof fetch;
  try {
    const result = await run(browserMainApi('https://recorded.invalid', { fetcher }), fetcher);
    if (missed) throw new Error(missed);
    return result;
  } finally { playback.dispose(); }
}

const ownerSession = [
  { label: 'session-agent', state: 'populated' },
  { label: 'agent-choices', state: 'populated' },
  { label: 'acting-contexts', state: 'populated' },
  { label: 'acting-agent-profile', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

const ownerQueue = [
  ...ownerSession,
  { label: 'management-realm-header', state: 'populated' },
  { label: 'management-site', state: 'error' },
  { label: 'owner-before-decision-2', state: 'populated' },
  { label: 'moderation-queue-appeal', state: 'populated' },
  { label: 'appeal-decision-basis', state: 'populated' },
  { label: 'manager-appeal-open', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

const ownerEmpty = [
  ...ownerSession,
  { label: 'management-realm-header', state: 'populated' },
  { label: 'management-site', state: 'error' },
  { label: 'owner-before-decision-2', state: 'populated' },
  { label: 'moderation-queue-empty', state: 'empty' },
] as const satisfies readonly RecordedSelection[];

const moderatorRefused = [
  { label: 'frame-session-agent', state: 'populated' },
  { label: 'page-agent-choices', state: 'populated' },
  { label: 'page-acting-contexts', state: 'populated' },
  { label: 'page-acting-agent-profile', state: 'populated' },
  { label: 'moderator-other-realm-1', state: 'error' },
  { label: 'moderator-other-realm-2', state: 'populated' },
  { label: 'moderator-other-realm-3', state: 'error' },
  { label: 'moderator-other-realm-4', state: 'error' },
] as const satisfies readonly RecordedSelection[];

const memberHome = [
  { label: 'frame-address', state: 'populated' },
  { label: 'frame-presentation', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

const moderatorOpen = [
  { label: 'frame-session-agent', state: 'populated' },
  { label: 'page-agent-choices', state: 'populated' },
  { label: 'page-acting-contexts', state: 'populated' },
  { label: 'page-acting-agent-profile', state: 'populated' },
  { label: 'moderator-open-1', state: 'populated' },
  { label: 'moderator-open-2', state: 'populated' },
  { label: 'moderator-open-3', state: 'error' },
  { label: 'moderator-open-4', state: 'populated' },
  { label: 'moderator-open-5', state: 'populated' },
  { label: 'moderator-open-6', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

const moderatorDecided = [
  { label: 'frame-session-agent', state: 'populated' },
  { label: 'page-agent-choices', state: 'populated' },
  { label: 'page-acting-contexts', state: 'populated' },
  { label: 'page-acting-agent-profile', state: 'populated' },
  { label: 'moderator-management-1', state: 'populated' },
  { label: 'moderator-management-2', state: 'populated' },
  { label: 'moderator-management-3', state: 'error' },
  { label: 'moderator-management-4', state: 'populated' },
  { label: 'moderator-management-5', state: 'populated' },
  { label: 'moderator-management-6', state: 'populated' },
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
] as const satisfies readonly RecordedSelection[];

test('the owner queue keeps the recorded open case, basis and appeal statement', async () => {
  const header = answerOf<{ name: { value: string } }>('owner', 'management-realm-header');
  const page = answerOf<{ items: { id: string; state: string; generation: string; decisionHead: null;
    target: { resource: string } }[]; nextCursor: string | null }>('owner', 'moderation-queue-appeal');
  const basis = answerOf<{ caseId: string; generation: string; decisionHead: null; state: string;
    nextCursor: string | null }>('owner', 'appeal-decision-basis');
  const appeal = answerOf<{ reason: string; receiptId: string; appeal: { state: string; statement: string; caseId: string } }>(
    'owner', 'manager-appeal-open');
  const agent = answerOf<{ displayName: string }>('owner', 'acting-agent-profile');
  const identity = recordedIdentity(record, 'owner', ownerQueue);
  const loaded = await withReplay('owner', ownerQueue, async (main, fetcher) => {
    const session = await recordedManagementAgent(fetcher, 'en');
    const [readHeader, queue, permissions, site] = await Promise.all([
      readRealmHeader(main, identity.realm, 'en', session.actingSubject),
      readQueue(main, identity.realm, { actingSubject: session.actingSubject, state: 'open', type: null }),
      permissionsIn(main, session.actingSubject, identity.realm),
      realmEditSite({
        zone: () => settle(() => main.v1.realms({ realm: identity.realm }).zone.get({ query: { actingSubject: session.actingSubject } })),
        editor: () => Promise.resolve({ ok: false, failure: 'missing' }),
      }),
    ]);
    const item = queue.ok ? queue.data.items[0] : null;
    const [decision, receipt] = item ? await Promise.all([
      readDecisionBasis(main, identity.realm, item.id, session.actingSubject),
      readAppealReceipt(main, identity.realm, item.target.resource),
    ]) : [null, null];
    return { session, readHeader, queue, permissions, site, decision, receipt };
  });
  expect(loaded.session.agent.label).toBe(agent.displayName);
  expect(loaded.site).toBeNull();
  expect(loaded.readHeader.ok).toBe(true);
  if (!loaded.readHeader.ok || !loaded.queue.ok || !loaded.decision?.ok || !loaded.receipt?.ok) {
    throw new Error('owner queue read failed');
  }
  expect(loaded.readHeader.data.name.value).toBe(header.name.value);
  expect(loaded.permissions).toEqual(expect.arrayContaining(['governance.moderate', 'realm.members.manage']));
  expect(loaded.queue.data.nextCursor).toBe(page.nextCursor);
  expect(loaded.queue.data.items[0]).toMatchObject({
    id: page.items[0]?.id, state: page.items[0]?.state, generation: page.items[0]?.generation,
    decisionHead: page.items[0]?.decisionHead,
  });
  expect(loaded.decision.data).toMatchObject({
    caseId: basis.caseId, generation: basis.generation, decisionHead: basis.decisionHead,
    state: basis.state, nextCursor: basis.nextCursor,
  });
  expect(loaded.receipt.reading.reason).toBe(appeal.reason);
  expect(loaded.receipt.reading.receiptId).toBe(appeal.receiptId);
  expect(loaded.receipt.reading.appeal).toMatchObject(appeal.appeal);
});

test('the owner empty queue is the recorded empty page and still reads the Zone', async () => {
  const page = answerOf<{ items: unknown[]; nextCursor: string | null }>('owner', 'moderation-queue-empty');
  const identity = recordedIdentity(record, 'owner', ownerEmpty);
  const loaded = await withReplay('owner', ownerEmpty, async (main, fetcher) => {
    const session = await recordedManagementAgent(fetcher, 'en');
    const [queue, site] = await Promise.all([
      readQueue(main, identity.realm, { actingSubject: session.actingSubject, state: 'open', type: null }),
      realmEditSite({
        zone: () => settle(() => main.v1.realms({ realm: identity.realm }).zone.get({ query: { actingSubject: session.actingSubject } })),
        editor: () => Promise.resolve({ ok: false, failure: 'missing' }),
      }),
    ]);
    return { queue, site };
  });
  expect(page.items).toHaveLength(0);
  expect(loaded.site).toBeNull();
  expect(loaded.queue.ok).toBe(true);
  if (!loaded.queue.ok) return;
  expect(loaded.queue.data.items).toEqual([]);
  expect(loaded.queue.data.nextCursor).toBe(page.nextCursor);
});

test('an out-of-realm moderator keeps the recorded refusal and the Zone failure', async () => {
  const queueProblem = answerOf<{ title: string; code: string; status: number }>('moderator', 'moderator-other-realm-4');
  const headerProblem = answerOf<{ title: string; code: string }>('moderator', 'moderator-other-realm-1');
  const identity = recordedIdentity(record, 'moderator', moderatorRefused);
  const loaded = await withReplay('moderator', moderatorRefused, async (main, fetcher) => {
    const session = await recordedManagementAgent(fetcher, 'en');
    const [header, queue, permissions, site] = await Promise.all([
      readRealmHeader(main, identity.realm, 'en', session.actingSubject),
      readQueue(main, identity.realm, { actingSubject: session.actingSubject, state: 'open', type: null }),
      permissionsIn(main, session.actingSubject, identity.realm),
      realmEditSite({
        zone: () => settle(() => main.v1.realms({ realm: identity.realm }).zone.get({ query: { actingSubject: session.actingSubject } })),
        editor: () => Promise.resolve({ ok: false, failure: 'missing' }),
      }),
    ]);
    return { header, queue, permissions, site };
  });
  expect(loaded.site).toBeNull();
  expect(loaded.permissions).toEqual([]);
  expect(loaded.header.ok).toBe(false);
  expect(loaded.queue.ok).toBe(false);
  if (loaded.header.ok || loaded.queue.ok) return;
  expect(loaded.header.problem).toMatchObject({ title: headerProblem.title, code: headerProblem.code });
  expect(loaded.queue.failure).toBe('denied');
  expect(loaded.queue.problem).toMatchObject({ title: queueProblem.title, status: queueProblem.status, code: queueProblem.code });
});

async function loadSanction(persona: AnswerPersona, selections: readonly RecordedSelection[],
  state: 'open' | 'closed', basisLabel: string) {
  const identity = recordedIdentity(record, persona, selections);
  const basis = answerOf<{ caseId: string }>(persona, basisLabel);
  return withReplay(persona, selections, async (main, fetcher) => {
    const session = await recordedManagementAgent(fetcher, 'en');
    const [header, queue, permissions, site] = await Promise.all([
      readRealmHeader(main, identity.realm, 'en', session.actingSubject),
      readQueue(main, identity.realm, { actingSubject: session.actingSubject, state, type: null }),
      permissionsIn(main, session.actingSubject, identity.realm),
      realmEditSite({
        zone: () => settle(() => main.v1.realms({ realm: identity.realm }).zone.get({
          query: { actingSubject: session.actingSubject },
        })),
        editor: () => Promise.resolve({ ok: false, failure: 'missing' as const }),
      }),
    ]);
    if (!queue.ok) return { session, header, queue, permissions, site, panels: [] };
    const appeals = queue.data.items.filter(item => item.kind === 'realm_sanction_appeal');
    const initial = appeals[0];
    const chosen = appeals.find(item => item.id === basis.caseId) ?? initial;
    const seen = new Set<string>();
    const panels = [];
    for (const item of [initial, chosen]) {
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      panels.push({
        item,
        decision: await readDecisionBasis(main, identity.realm, item.id, session.actingSubject),
        receipt: await readAppealReceipt(main, identity.realm, item.target.resource),
      });
    }
    return { session, header, queue, permissions, site, panels };
  });
}

test('the moderator open queue keeps the recorded case, basis and appeal statement', async () => {
  const page = answerOf<{ items: { id: string; state: string; generation: string; decisionHead: null }[] }>(
    'moderator', 'moderator-open-4');
  const basis = answerOf<{ caseId: string; generation: string; decisionHead: null; state: string }>(
    'moderator', 'moderator-open-5');
  const appeal = answerOf<{ reason: string; receiptId: string; appeal: { state: string; caseId: string; statement: string } }>(
    'moderator', 'moderator-open-6');
  const loaded = await loadSanction('moderator', moderatorOpen, 'open', 'moderator-open-5');
  expect(loaded.site).toBeNull();
  expect(loaded.permissions).toEqual(['governance.moderate']);
  expect(loaded.header.ok).toBe(true);
  expect(loaded.queue.ok).toBe(true);
  const panel = loaded.panels[0];
  if (!loaded.header.ok || !loaded.queue.ok || !panel?.decision.ok || !panel.receipt.ok) throw new Error('moderator open read failed');
  expect(loaded.queue.data.items[0]).toMatchObject({
    id: page.items[0]?.id, state: 'open', generation: page.items[0]?.generation, decisionHead: null,
  });
  expect(panel.decision.data).toMatchObject({
    caseId: basis.caseId, generation: basis.generation, decisionHead: null, state: 'open',
  });
  expect(panel.receipt.reading.reason).toBe(appeal.reason);
  expect(panel.receipt.reading.receiptId).toBe(appeal.receiptId);
  expect(panel.receipt.reading.appeal).toMatchObject(appeal.appeal);
  expect(panel.item.id).toBe(appeal.appeal.caseId);
});

test('the moderator closed queue keeps the recorded decision and receipt', async () => {
  const basis = answerOf<{ caseId: string; generation: string; decisionHead: string; state: string }>(
    'moderator', 'moderator-management-5');
  const appeal = answerOf<{ reason: string; appeal: { state: string; caseId: string; statement: string; outcome: string } }>(
    'moderator', 'moderator-management-6');
  const loaded = await loadSanction('moderator', moderatorDecided, 'closed', 'moderator-management-5');
  expect(loaded.site).toBeNull();
  expect(loaded.permissions).toEqual(['governance.moderate']);
  const panel = loaded.panels[0];
  if (!loaded.queue.ok || !panel?.decision.ok || !panel.receipt.ok) throw new Error('moderator closed read failed');
  expect(panel.item).toMatchObject({ id: basis.caseId, state: 'closed', decisionHead: basis.decisionHead });
  expect(panel.decision.data).toMatchObject({
    caseId: basis.caseId, generation: basis.generation, decisionHead: basis.decisionHead, state: 'closed',
  });
  expect(panel.receipt.reading.reason).toBe(appeal.reason);
  expect(panel.receipt.reading.appeal).toMatchObject({
    state: 'decided', caseId: appeal.appeal.caseId, statement: appeal.appeal.statement, outcome: 'dismiss',
  });
});

test('the owner closed queue keeps the first case and the selected decided case', async () => {
  const selected = answerOf<{ caseId: string; generation: string; decisionHead: string; state: string }>(
    'owner', 'owner-decided-5');
  const selectedAppeal = answerOf<{ appeal: { state: string; caseId: string; statement: string; outcome: string } }>(
    'owner', 'owner-decided-8');
  const first = answerOf<{ caseId: string; decisionHead: string; state: string }>('owner', 'owner-decided-6');
  const firstAppeal = answerOf<{ appeal: { caseId: string; outcome: string; state: string } }>('owner', 'owner-decided-7');
  const loaded = await loadSanction('owner', ownerDecided, 'closed', 'owner-decided-5');
  expect(loaded.site).toBeNull();
  expect(loaded.permissions).toEqual(expect.arrayContaining(['governance.moderate', 'realm.members.manage']));
  if (!loaded.queue.ok || loaded.panels.length !== 2) throw new Error('owner decided read failed');
  const [opened, decided] = loaded.panels;
  if (!opened?.decision.ok || !opened.receipt.ok || !decided?.decision.ok || !decided.receipt.ok) {
    throw new Error('owner decided panel read failed');
  }
  expect(opened.item.id).toBe(first.caseId);
  expect(opened.decision.data).toMatchObject({ caseId: first.caseId, decisionHead: first.decisionHead, state: 'closed' });
  expect(opened.receipt.reading.appeal).toMatchObject({
    state: 'decided', caseId: firstAppeal.appeal.caseId, outcome: 'reversed',
  });
  expect(decided.item.id).toBe(selected.caseId);
  expect(decided.decision.data).toMatchObject({
    caseId: selected.caseId, generation: selected.generation, decisionHead: selected.decisionHead, state: 'closed',
  });
  expect(decided.receipt.reading.appeal).toMatchObject({
    state: 'decided', caseId: selectedAppeal.appeal.caseId, statement: selectedAppeal.appeal.statement, outcome: 'dismiss',
  });
});

function accessTarget(persona: AnswerPersona, label: string): { realm: string; actingSubject: string } {
  const url = new URL(recordedSample(record, persona, label).path, 'https://recorded.invalid');
  const realm = url.pathname.split('/')[3] ?? '';
  const actingSubject = url.searchParams.get('actingSubject') ?? '';
  if (!realm || !actingSubject) throw new Error(`Recorded ${persona}/${label} has no realm actor`);
  return { realm, actingSubject };
}

test('section tabs follow the recorded settings authority', async () => {
  const owner = accessTarget('owner', 'owner-before-decision-8');
  const ownerAccess = await withReplay('owner', [
    { label: 'owner-before-decision-7', state: 'error' },
    { label: 'owner-before-decision-8', state: 'populated' },
    { label: 'owner-before-decision-9', state: 'populated' },
  ], main => readManagementAccess(main, owner.realm, owner.actingSubject));
  expect(ownerAccess.ok).toBe(true);

  const moderator = accessTarget('moderator', 'moderator-open-8');
  const moderatorAccess = await withReplay('moderator', [
    { label: 'moderator-open-7', state: 'error' },
    { label: 'moderator-open-8', state: 'populated' },
    { label: 'moderator-open-9', state: 'error' },
  ], main => readManagementAccess(main, moderator.realm, moderator.actingSubject));
  expect(moderatorAccess.ok).toBe(false);

  const outsider = accessTarget('moderator', 'moderator-other-realm-6');
  const outsiderAccess = await withReplay('moderator', [
    { label: 'moderator-other-realm-5', state: 'error' },
    { label: 'moderator-other-realm-6', state: 'error' },
  ], main => readManagementAccess(main, outsider.realm, outsider.actingSubject));
  expect(outsiderAccess.ok).toBe(false);
});

test('the member realm page stops when the recorded presentation names no realm', async () => {
  const address = recordedSample(record, 'member', 'frame-address');
  const key = new URL(address.path, 'https://recorded.invalid').searchParams.get('key');
  const subject = new URL(recordedSample(record, 'member', 'frame-presentation').path, 'https://recorded.invalid')
    .searchParams.get('actingSubject');
  if (!key || !subject) throw new Error('Recorded member address has no key');
  const resolved = await withReplay('member', memberHome, async main => {
    const reads = realmFrameReads({ main, personal: main, actingSubject: subject, keepProblem: false });
    return reads.resolveRealm(key, 'en', 'community');
  });
  expect(resolved).toEqual({ kind: 'missing' });
});
