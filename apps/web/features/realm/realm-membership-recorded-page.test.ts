import { expect, test } from 'bun:test';
import '../../tests/support/official-package-fixture.ts';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import membershipRecord from '../../../../tests/qa/fixtures/outcomes/realm/membership-and-admission.json';
import { readSpacePage } from '../address/space-read.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { readRequestsAtAddress } from '../manage/settings-api.ts';
import type { JoinPage, RequestPage } from '../manage/settings-api.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import type { JoinPolicy } from './membership-state.ts';
import type { RealmHeader } from './types.ts';

// The package reader uses Vite's glob. Load it through the fixture before the Realm page.
const { loadRealmView } = await import('./realm-page.tsx');
const {
  recordedIdentity, recordedManagementAgent, recordedRead, recordedReplay, recordedSample,
} = await import('./realm-membership-recorded-page.ts');

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
    const result = await run(main, recordedRead(fetcher), fetcher);
    if (missed) throw new Error(missed);
    return result;
  } finally {
    playback.dispose();
  }
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

test('the visitor landing is the recorded request page after the hidden Realm', async () => {
  const landing = answerOf<JoinPage>('visitor', 'request-landing');
  const identity = recordedIdentity(record, 'visitor', visitorLanding);
  const view = await withReplay('visitor', visitorLanding, (_main, _read, fetcher) =>
    loadRealmView(identity.realm, 'en', {}, 'community', recordedReplay(fetcher, false)));
  expect(view.kind).toBe('join');
  if (view.kind !== 'join') return;
  expect(view.page).toEqual(landing);
  const routed = await withReplay('visitor', visitorLanding, (_main, read) =>
    readSpacePage(identity.realm, 'en', { read, origin: 'https://recorded.invalid' }));
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
  const policy = answerOf<JoinPolicy & { realm: string }>(persona, 'frame-joining');
  const follow = answerOf<{ following: boolean; revision: string; level: 'highlights'; source: 'join'; pinPosition: number | null }>(
    persona, 'frame-follow');
  const header = answerOf<RealmHeader>(persona, 'frame-realm');
  const { realm: _realm, ...policyFields } = policy;
  const identity = recordedIdentity(record, persona, joinedFrame);
  const view = await withReplay(persona, joinedFrame, async (_main, _read, fetcher) => {
    await recordedManagementAgent(fetcher, 'en');
    return loadRealmView(identity.realm, 'en', {}, 'community', recordedReplay(fetcher, true));
  });
  expect(view.kind).toBe('view');
  if (view.kind !== 'view') return;
  expect(view.realm.header.name).toEqual(header.name);
  expect(view.membership?.policy).toEqual(policyFields);
  expect(view.membership?.following).toBe(follow.following);
  expect(view.membership?.followRevision).toBe(follow.revision);
  expect(view.membership?.level).toBe(follow.level);
  expect(view.membership?.source).toBe(follow.source);
  expect(view.membership?.pinPosition).toBe(follow.pinPosition);
  const subject = recordedSubject(recordedSample(record, persona, 'frame-realm').path);
  if (!subject) throw new Error(`Recorded ${persona} header names no acting Person`);
  expect(view.reader.actingSubject).toBe(subject);
  expect(view.ban).toBeNull();
}

function recordedSubject(path: string): string | null {
  return new URL(path, 'https://recorded.invalid').searchParams.get('actingSubject');
}

test('the owner inbox keeps the recorded requests and acting Person', async () => {
  const selections = [
    ...ownerSession,
    { label: 'request-address-space-missing', state: 'error' },
    { label: 'request-inbox', state: 'populated' },
  ] as const satisfies readonly RecordedSelection[];
  const inbox = answerOf<RequestPage>('owner', 'request-inbox');
  const profile = answerOf<{ displayName: string; id: string }>('owner', 'acting-agent-profile');
  const view = await withReplay('owner', selections, async (main, _read, fetcher) => {
    const identity = recordedIdentity(record, 'owner', selections);
    const { agent, actingSubject } = await recordedManagementAgent(fetcher, 'en');
    const requests = await readRequestsAtAddress(main, identity.realm, actingSubject);
    return { agent, requests };
  });
  expect(view.requests.ok).toBe(true);
  if (!view.requests.ok) return;
  expect(view.requests.data.page).toEqual(inbox);
  expect(view.requests.data.page.items.length).toBeGreaterThan(0);
  expect(view.agent.label).toBe(profile.displayName);
  expect(view.agent.iri).toBe(profile.id);
});

test('the request refusal keeps the recorded problem code', async () => {
  for (const persona of ['member', 'moderator'] as const) {
    const problem = answerOf<{ title: string; code: string; status: number }>(persona, 'requests-access-settings-refused');
    const selections = [
      { label: 'requests-address-space-missing', state: 'error' },
      { label: 'requests-refused', state: 'error' },
      { label: 'requests-address-settings-refused', state: 'error' },
      { label: 'requests-access-realm', state: 'populated' },
      { label: 'requests-access-settings-refused', state: 'error' },
    ] as const satisfies readonly RecordedSelection[];
    const result = await refused(persona, selections);
    expect(problem.status).toBe(403);
    expect(result.failure).toBe('denied');
    expect(result.code).toBe(problem.code);
    expect('title' in result).toBe(false);
  }
  for (const persona of ['stranger', 'operator'] as const) {
    const problem = answerOf<{ title: string; code: string; status: number }>(persona, 'requests-access-realm');
    const selections = [
      { label: 'requests-address-space-missing', state: 'error' },
      { label: 'requests-refused', state: 'error' },
      { label: 'requests-address-settings-refused', state: 'error' },
      { label: 'requests-access-realm', state: 'error' },
    ] as const satisfies readonly RecordedSelection[];
    const result = await refused(persona, selections);
    expect(problem.status).toBe(404);
    expect(result.failure).toBe('missing');
    expect(result.code).toBe(problem.code);
    expect('title' in result).toBe(false);
  }
});

async function refused(persona: AnswerPersona, selections: readonly RecordedSelection[]) {
  const result = await withReplay(persona, selections, (main, _read, _fetcher) => {
    const identity = recordedIdentity(record, persona, selections);
    const actor = recordedSubject(recordedSample(record, persona, 'requests-refused').path);
    if (!actor) throw new Error(`Recorded ${persona} refusal names no acting Person`);
    return readRequestsAtAddress(main, identity.realm, actor);
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error(`Recorded ${persona} refusal was admitted`);
  return result;
}

test('the signed-out route does not read the recorded admission basis', () => {
  const basis = recordedSample(record, 'visitor', 'join-basis-sign-in-required');
  expect(basis.status).toBe(401);
  expect(visitorLanding.some(item => item.label === basis.label)).toBe(false);
});

test('invitation and a pending acceptance are not recorded', () => {
  const samples = Object.values(record.personas).flat();
  expect(samples.some(sample => sample.path.includes('/invitations'))).toBe(false);
  expect(samples.some(sample => sample.status === 202)).toBe(false);
});
