import { expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import membershipRecord from '../../../../tests/qa/fixtures/outcomes/realm/membership-and-admission.json';
import { readSpacePage } from '../address/space-read.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { readAgents } from '../manage/read.ts';
import type { JoinPage, RequestPage } from '../manage/settings-api.ts';
import { spaceAccessApi } from '../manage/settings-api.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import type { JoinPolicy } from './membership-state.ts';
import { loadRecordedMembership, recordedIdentity, recordedSample, recordedSubject, type MembershipSurface } from './realm-membership-recorded-page.ts';
import type { RealmHeader } from './types.ts';

const record = membershipRecord as AnswerRecord;

function answerOf<T>(persona: AnswerPersona, label: string): T {
  const answer = recordedSample(record, persona, label).answer;
  if (!answer || typeof answer !== 'object') throw new Error(`Recorded ${persona}/${label} has no object answer`);
  return answer as T;
}

async function withReplay<T>(persona: AnswerPersona, selections: readonly RecordedSelection[],
  run: (main: MainClient, read: (path: string) => Promise<Response>, fetcher: typeof fetch) => Promise<T>): Promise<T> {
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
    const main = browserMainApi('https://recorded.invalid', { fetcher });
    const read = (path: string) => fetcher(new URL(`${BFF_PREFIX}${path}`, 'https://recorded.invalid'));
    const result = await run(main, read, fetcher);
    if (missed) throw new Error(missed);
    return result;
  } finally {
    playback.dispose();
  }
}

function load(persona: AnswerPersona, selections: readonly RecordedSelection[], surface: MembershipSurface) {
  const identity = recordedIdentity(record, persona, selections);
  return withReplay(persona, selections, (main, _read, fetcher) =>
    loadRecordedMembership(main, { surface, ...identity, locale: 'en', fetcher }));
}

const visitorLanding = [
  { label: 'private-realm-hidden', state: 'error' },
  { label: 'request-landing', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

const memberJoined = [
  { label: 'joined-realm-header', state: 'populated' },
  { label: 'joining-policy', state: 'populated' },
  { label: 'realm-follow', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

const ownerRequests = [
  { label: 'request-address-space-missing', state: 'error' },
  { label: 'request-inbox', state: 'populated' },
  { label: 'management-realm-header', state: 'populated' },
  { label: 'management-site-absent', state: 'error' },
  { label: 'acting-agent-profile', state: 'populated' },
  { label: 'requester-name-stranger', state: 'populated' },
  { label: 'requester-name-operator', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

test('the visitor landing is the recorded request page after the hidden Realm', async () => {
  const landing = answerOf<JoinPage>('visitor', 'request-landing');
  const view = await load('visitor', visitorLanding, 'landing');
  expect(view.kind).toBe('join');
  if (view.kind !== 'join') return;
  expect(view.page).toEqual(landing);
  const routed = await withReplay('visitor', visitorLanding, (_main, read) =>
    readSpacePage(recordedIdentity(record, 'visitor', visitorLanding).realm, 'en', { read }));
  expect(routed.kind).toBe('join');
  if (routed.kind === 'join') expect(routed.page).toEqual(landing);
});

test('a joined member keeps the recorded Realm, policy and follow', async () => {
  await expectJoined('member');
});

test('a joined moderator keeps the recorded Realm, policy and follow', async () => {
  await expectJoined('moderator');
});

async function expectJoined(persona: 'member' | 'moderator') {
  const policy = answerOf<JoinPolicy & { realm: string }>(persona, 'joining-policy');
  const follow = answerOf<{ following: boolean; revision: string; level: 'highlights'; source: 'join'; pinPosition: number | null }>(persona, 'realm-follow');
  const header = answerOf<RealmHeader>(persona, 'joined-realm-header');
  const { realm: _realm, ...policyFields } = policy;
  const view = await load(persona, memberJoined, 'joined');
  expect(view.kind).toBe('joined');
  if (view.kind !== 'joined') return;
  expect(view.header.name).toEqual(header.name);
  expect(view.membership.policy).toEqual(policyFields);
  expect(view.membership.following).toBe(follow.following);
  expect(view.membership.followRevision).toBe(follow.revision);
  expect(view.membership.level).toBe(follow.level);
  expect(view.membership.source).toBe(follow.source);
  expect(view.membership.pinPosition).toBe(follow.pinPosition);
  const subject = recordedSubject(recordedSample(record, persona, 'joined-realm-header').path);
  if (!subject) throw new Error(`Recorded ${persona} header names no acting Person`);
  expect(view.actingSubject).toBe(subject);
  const routed = await withReplay(persona, memberJoined, (_main, read) =>
    readSpacePage(recordedIdentity(record, persona, memberJoined).realm, 'en', { token: 'recorded', actingSubject: subject, read }));
  expect(routed.kind).toBe('realm');
  if (routed.kind === 'realm') expect(routed.header.name).toEqual(header.name);
}

test('the owner inbox keeps the recorded requests, names and Realm', async () => {
  const inbox = answerOf<RequestPage>('owner', 'request-inbox');
  const header = answerOf<RealmHeader>('owner', 'management-realm-header');
  const profile = answerOf<{ displayName: string }>('owner', 'acting-agent-profile');
  const view = await withReplay('owner', ownerRequests, async main => {
    const loaded = await loadRecordedMembership(main, { surface: 'requests', ...recordedIdentity(record, 'owner', ownerRequests), locale: 'en' });
    if (loaded.kind !== 'requests') throw new Error(`Recorded requests resolved to ${loaded.kind}`);
    const names = await readAgents(main, loaded.page.items.map(item => item.member), loaded.agent.iri);
    return { loaded, names };
  });
  expect(view.loaded.page).toEqual(inbox);
  expect(view.loaded.header.name).toEqual(header.name);
  expect(view.loaded.agent.label).toBe(profile.displayName);
  expect(view.loaded.siteHref).toBeNull();
  expect(view.loaded.page.items.length).toBeGreaterThan(0);
  for (const item of view.loaded.page.items) {
    const named = Object.values(record.personas.owner).find(sample => sample.path.includes(`/v1/agents/${item.member.slice(-36)}`));
    const displayName = (named?.answer as { displayName?: string | null } | undefined)?.displayName;
    if (typeof displayName !== 'string' && displayName !== null) throw new Error('Recorded requester has no display name');
    expect(view.names[item.member]?.label).toBe(displayName);
  }
});

test('the owner empty inbox is the recorded page with no requests', async () => {
  const selections = [
    { label: 'request-address-space-missing', state: 'error' },
    { label: 'request-inbox-empty', state: 'empty' },
    { label: 'management-realm-header', state: 'populated' },
    { label: 'management-site-absent', state: 'error' },
    { label: 'acting-agent-profile', state: 'populated' },
  ] as const satisfies readonly RecordedSelection[];
  const inbox = answerOf<RequestPage>('owner', 'request-inbox-empty');
  const view = await load('owner', selections, 'requests');
  expect(view.kind).toBe('requests');
  if (view.kind !== 'requests') return;
  expect(view.page).toEqual(inbox);
  expect(view.page.items).toHaveLength(0);
});

test('the visitor basis refusal keeps the recorded problem', async () => {
  const selections = [{ label: 'join-basis-sign-in-required', state: 'error' }] as const satisfies readonly RecordedSelection[];
  const problem = answerOf<{ title: string; code: string; status: number }>('visitor', 'join-basis-sign-in-required');
  const view = await load('visitor', selections, 'basis');
  expect(view.kind).toBe('refusal');
  if (view.kind !== 'refusal') return;
  expect(problem.status).toBe(401);
  expect(view.failure).toBe('sign-in');
  expect(view.code).toBe(problem.code);
  expect(view.problemTitle).toBe(problem.title);
});

test('the request inbox refusal omits the limit and query the reader sends', async () => {
  for (const persona of ['stranger', 'member', 'moderator', 'operator'] as const) {
    const path = recordedSample(record, persona, 'request-inbox-denied').path;
    expect(path.includes('limit=')).toBe(false);
    expect(path.includes('q=')).toBe(false);
  }
  const sample = recordedSample(record, 'stranger', 'request-inbox-denied');
  const realm = recordedIdentity(record, 'stranger', [{ label: sample.label, state: 'error' }]).realm;
  const actor = recordedSubject(sample.path);
  if (!actor) throw new Error('Recorded inbox refusal names no acting Person');
  const missed = await unmatched('stranger', [{ label: sample.label, state: 'error' }], main =>
    spaceAccessApi(() => main, realm, realm, actor).requests(null));
  expect(missed).toContain('Unmatched recorded request');
  expect(missed).toContain('limit=50');
  expect(missed).toContain('q=');
});

test('an own pending or withdrawn request omits the limit the reader sends', async () => {
  for (const label of ['own-request-pending', 'own-request-withdrawn'] as const) {
    const sample = recordedSample(record, 'stranger', label);
    expect(sample.path.includes('limit=')).toBe(false);
    const realm = recordedIdentity(record, 'stranger', [{ label, state: 'populated' }]).realm;
    const actor = recordedSubject(sample.path);
    if (!actor) throw new Error(`Recorded ${label} names no acting Person`);
    const missed = await unmatched('stranger', [{ label, state: 'populated' }], main =>
      spaceAccessApi(() => main, realm, realm, actor).mine(null));
    expect(missed).toContain('Unmatched recorded request');
    expect(missed).toContain('limit=50');
  }
});

test('owner request pages use a limit the reader does not send', async () => {
  const sample = recordedSample(record, 'owner', 'request-inbox-page-0');
  expect(sample.path).toContain('limit=1');
  expect(sample.path.includes('q=')).toBe(false);
  const realm = recordedIdentity(record, 'owner', [{ label: sample.label, state: 'populated' }]).realm;
  const actor = recordedSubject(sample.path);
  if (!actor) throw new Error('Recorded request page names no acting Person');
  const missed = await unmatched('owner', [{ label: sample.label, state: 'populated' }], main =>
    spaceAccessApi(() => main, realm, realm, actor).requests(null));
  expect(missed).toContain('limit=50');
  expect(missed).toContain('q=');
  expect(recordedSample(record, 'owner', 'request-inbox-page-1').path.includes('limit=1')).toBe(true);
});

test('the row has no invitation, accepted command or withdrawal to show', () => {
  const samples = Object.values(record.personas).flat();
  expect(samples.some(sample => sample.path.includes('/invitations'))).toBe(false);
  expect(samples.some(sample => sample.status === 202)).toBe(false);
  expect(samples.some(sample => sample.method === 'POST' && /\/(?:withdraw|decisions)$/.test(sample.path.split('?')[0] ?? ''))).toBe(false);
});

async function unmatched(persona: AnswerPersona, selections: readonly RecordedSelection[],
  run: (main: MainClient) => Promise<unknown>): Promise<string> {
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
    await run(browserMainApi('https://recorded.invalid', { fetcher }));
  } finally {
    playback.dispose();
  }
  if (!missed) throw new Error('Expected the recorded request to stay unmatched');
  return missed;
}
