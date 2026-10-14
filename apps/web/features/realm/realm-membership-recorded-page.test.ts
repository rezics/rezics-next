import { expect, test } from 'bun:test';
import '../../tests/support/official-package-fixture.ts';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import membershipRecord from '../../../../tests/qa/fixtures/outcomes/realm/membership-and-admission.json';
import { readSpacePage } from '../address/space-read.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { invite, newKey } from '../manage/commands.ts';
import { readOutgoingInvitations } from '../manage/read.ts';
import { inviteDurations } from '../manage/members-view.tsx';
import { readRequestsAtAddress, spaceAccessApi } from '../manage/settings-api.ts';
import type { JoinDecisionReceipt, JoinPage, RequestPage } from '../manage/settings-api.ts';
import { readCurrentRequest } from '../space-access/request-state.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import type { JoinPolicy } from './membership-state.ts';
import type { RealmHeader } from './types.ts';

// The package reader uses Vite's glob. Load it through the fixture before the Realm page.
const { loadRealmView } = await import('./realm-page.tsx');
const {
  recordedIdentity, recordedManagementAgent, recordedRead, recordedRealmId, recordedReplay, recordedSample,
} = await import('./realm-membership-recorded-page.ts');

const record = membershipRecord as AnswerRecord;

function answerOf<T>(persona: AnswerPersona, label: string): T {
  const answer = recordedSample(record, persona, label).answer;
  if (!answer || typeof answer !== 'object') throw new Error(`Recorded ${persona}/${label} has no object answer`);
  return answer as T;
}

async function withReplay<T>(persona: AnswerPersona, selections: readonly RecordedSelection[],
  run: (main: MainClient, read: (path: string) => Promise<Response>, fetcher: typeof fetch) => Promise<T>, sequence = false): Promise<T> {
  let missed: string | null = null;
  const playback = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX, sequence });
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
  { label: 'frame-realm-zone', state: 'error' },
  { label: 'frame-joining', state: 'populated' },
  { label: 'frame-follow', state: 'populated' },
  { label: 'frame-platform-access', state: 'populated' },
  { label: 'frame-own-ban', state: 'error' },
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
    expect(result.title).toBe(problem.title);
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
    expect(result.title).toBe(problem.title);
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

function commandOf<T extends Record<string, unknown>>(persona: AnswerPersona, label: string): T {
  const body = recordedSample(record, persona, label).body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`Recorded ${persona}/${label} has no command`);
  return body as T;
}

test('the recorded invitation is pending on HTTP 200 and no command is HTTP 202', async () => {
  const posted = recordedSample(record, 'owner', 'invitation-confirm');
  expect(posted.status).toBe(200);
  const body = commandOf<{ actingSubject: string; member: string; expiresInSeconds: number }>('owner', 'invitation-confirm');
  const duration = inviteDurations.find(([label]) => label === 'duration7d');
  if (!duration) throw new Error('The invitation list has no one-week duration');
  expect(body.expiresInSeconds).toBe(duration[1]);
  const samples = Object.values(record.personas).flat();
  expect(samples.some(sample => sample.status === 202)).toBe(false);
  const selections = [
    { label: 'invitation-confirm', state: 'populated' },
    { label: 'outgoing-invitations-after-confirm', state: 'populated' },
  ] as const satisfies readonly RecordedSelection[];
  const result = await withReplay('owner', selections, async main => {
    const realm = recordedRealmId(posted.path);
    if (!realm) throw new Error('Recorded invitation names no Realm');
    const sent = await invite(main, realm, {
      actingSubject: body.actingSubject, member: body.member, expiresInSeconds: duration[1],
    }, newKey());
    const listed = await readOutgoingInvitations(main, realm, body.actingSubject);
    return { sent, listed };
  });
  expect(result.sent.ok).toBe(true);
  if (!result.sent.ok) return;
  const invitation = (posted.answer as { invitation?: { state?: string; id?: string } }).invitation;
  if (invitation?.state !== 'pending' || !invitation.id) throw new Error('Recorded invitation is not pending');
  expect(result.sent.data.invitation.state).toBe(invitation.state);
  expect(result.sent.data.invitation.id).toBe(invitation.id);
  expect(result.listed.ok).toBe(true);
  if (!result.listed.ok) return;
  expect(result.listed.data.items.find(item => item.id === invitation.id)?.state).toBe('pending');
});

test('a stranger or operator withdraws with the recorded confirm body', async () => {
  for (const persona of ['stranger', 'operator'] as const) {
    const landing = answerOf<JoinPage>(persona, 'join-landing');
    const posted = recordedSample(record, persona, 'withdraw-confirm');
    expect(posted.status).toBe(201);
    const body = commandOf<{ actingSubject: string; expectedRequestGeneration: string; reason: string }>(persona, 'withdraw-confirm');
    const selections = [
      { label: 'withdraw-confirm-own-request', state: 'populated' },
      { label: 'withdraw-confirm', state: 'populated' },
    ] as const satisfies readonly RecordedSelection[];
    const result = await withReplay(persona, selections, async main => {
      const api = spaceAccessApi(() => main, landing.space, landing.id, body.actingSubject);
      const current = await readCurrentRequest(api);
      if (!current.ok || !current.data.entry || current.data.state !== 'pending') {
        throw new Error(`Recorded ${persona} request is not pending`);
      }
      const command = {
        actingSubject: body.actingSubject,
        expectedRequestGeneration: current.data.entry.requestGeneration,
        reason: body.reason,
      };
      expect(command).toEqual(body);
      return api.withdraw(current.data.entry.id, command, newKey());
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const answer = posted.answer as JoinDecisionReceipt;
    expect(result.data.state).toBe('withdrawn');
    expect(result.data.state).toBe(answer.state);
    expect(result.data.generation).toBe(answer.generation);
    expect(result.data.requestId).toBe(answer.requestId);
  }
});

test('the owner accepts and declines with the recorded confirm bodies', async () => {
  for (const [inboxLabel, postLabel] of [
    ['decision-confirm-inbox-declined', 'decision-confirm-declined'],
    ['decision-confirm-inbox-accepted', 'decision-confirm-accepted'],
  ] as const) {
    const posted = recordedSample(record, 'owner', postLabel);
    expect(posted.status).toBe(201);
    const body = commandOf<{
      actingSubject: string; expectedGeneration: string; expectedRequestGeneration: string;
      decision: 'accepted' | 'declined'; reason: string;
    }>('owner', postLabel);
    const selections = [
      { label: 'request-address-space-missing', state: 'error' },
      { label: inboxLabel, state: 'populated' },
      { label: postLabel, state: 'populated' },
    ] as const satisfies readonly RecordedSelection[];
    const result = await withReplay('owner', selections, async main => {
      const identity = recordedIdentity(record, 'owner', selections);
      const requests = await readRequestsAtAddress(main, identity.realm, body.actingSubject);
      if (!requests.ok) throw new Error(`Recorded ${inboxLabel} was not read`);
      const item = requests.data.page.items[0];
      if (!item) throw new Error(`Recorded ${inboxLabel} has no request`);
      const command = {
        actingSubject: body.actingSubject,
        expectedGeneration: requests.data.page.generation,
        expectedRequestGeneration: item.requestGeneration,
        decision: body.decision,
        reason: body.reason,
      };
      expect(command).toEqual(body);
      return spaceAccessApi(() => main, requests.data.space, requests.data.realm, body.actingSubject)
        .decide(item.id, command, newKey());
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const answer = posted.answer as JoinDecisionReceipt;
    expect(result.data.state).toBe(answer.state);
    expect(result.data.generation).toBe(answer.generation);
    expect(result.data.requestId).toBe(answer.requestId);
  }
});

test('a confirm refresh repeats the request the page just read', () => {
  for (const persona of ['stranger', 'operator'] as const) {
    const before = recordedSample(record, persona, 'withdraw-confirm-own-request');
    const after = recordedSample(record, persona, 'withdraw-confirm-own-request-after');
    expect(before.method).toBe(after.method);
    expect(before.path).toBe(after.path);
    expect(before.body ?? null).toEqual(after.body ?? null);
    expect(before.answer).not.toEqual(after.answer);
  }
  for (const [beforeLabel, afterLabel] of [
    ['decision-confirm-inbox-declined', 'decision-confirm-inbox-after-declined'],
    ['decision-confirm-inbox-accepted', 'decision-confirm-inbox-after-accepted'],
  ] as const) {
    const before = recordedSample(record, 'owner', beforeLabel);
    const after = recordedSample(record, 'owner', afterLabel);
    expect(before.method).toBe(after.method);
    expect(before.path).toBe(after.path);
    expect(before.body ?? null).toEqual(after.body ?? null);
    expect(before.answer).not.toEqual(after.answer);
  }
});

test('each refused requests route includes the recorded persona and management frame reads', async () => {
  const { recordedRequestsRoute } = await import('./realm-membership-recorded-page.ts');
  const { membershipRefusalLabels, membershipSelections } = await import('./realm-membership-recorded-samples.ts');
  const { ManageFailure } = await import('../manage/parts.tsx');
  for (const persona of ['member', 'moderator', 'stranger', 'operator'] as const) {
    const selections = membershipSelections(record, persona, membershipRefusalLabels(persona));
    const identity = recordedIdentity(record, persona, selections);
    const frame = await withReplay(persona, selections, (main, _read, fetcher) =>
      recordedRequestsRoute(main, fetcher, identity.realm, 'en')) as import('react').ReactElement<{
        header: RealmHeader | null; agent: { iri: string; label: string }; children: import('react').ReactElement<{ failure: string }>;
      }>;
    const joined = persona === 'member' || persona === 'moderator';
    const profile = answerOf<{ id: string; displayName: string }>(persona,
      `${joined ? 'frame' : 'join'}-acting-agent-profile`);
    expect(frame.props.agent.iri).toBe(profile.id);
    expect(frame.props.agent.label).toBe(profile.displayName);
    expect(frame.props.header).toEqual(joined ? answerOf<RealmHeader>(persona, 'management-refused-realm-header') : null);
    expect(frame.props.children.type).toBe(ManageFailure);
    expect(frame.props.children.props.failure).toBe(joined ? 'denied' : 'missing');
  }
});

test('the withdrawal control confirms its retained intent, receipt and subsequent production status', async () => {
  const { confirmWithdrawal } = await import('../manage/admission-controls.ts');
  const { recordedRealmRoute } = await import('./realm-membership-recorded-page.ts');
  const { membershipSelections, membershipSessionLabels } = await import('./realm-membership-recorded-samples.ts');
  for (const persona of ['stranger', 'operator'] as const) {
    const labels = [...membershipSessionLabels(persona), 'join-address', 'join-public-realm', 'join-realm', 'join-landing',
      'withdraw-confirm-own-request', 'withdraw-confirm', 'withdraw-confirm-own-request-after'];
    const selections = membershipSelections(record, persona, labels);
    await withReplay(persona, selections, async (_main, _read, fetcher) => {
      const identity = recordedIdentity(record, persona, selections);
      const page = await recordedRealmRoute(recordedReplay(fetcher, true), identity.realm, 'en') as
        import('react').ReactElement<{ api: import('../manage/settings-api.ts').SpaceAccessApi; actingSubject: string }>;
      const api = page.props.api;
      const current = await readCurrentRequest(api);
      expect(current.ok).toBe(true);
      if (!current.ok || !current.data.entry) throw new Error('The reached withdrawal has no request');
      expect(current.data.state).toBe('pending');
      const body = commandOf<import('../manage/settings-api.ts').JoinWithdraw>(persona, 'withdraw-confirm');
      const intent = { request: current.data.entry.id, key: newKey(), command: {
        actingSubject: page.props.actingSubject, expectedRequestGeneration: current.data.entry.requestGeneration, reason: body.reason,
      } };
      expect(intent.command).toEqual(body);
      const events: string[] = [];
      const result = await confirmWithdrawal(api, intent, receipt => {
        events.push('receipt');
        expect(receipt).toEqual(answerOf<JoinDecisionReceipt>(persona, 'withdraw-confirm'));
      }, async () => {
        events.push('refresh');
        const after = await readCurrentRequest(api);
        expect(after.ok).toBe(true);
        if (!after.ok) return;
        const recorded = answerOf<import('../manage/settings-api.ts').OwnRequestPage>(persona, 'withdraw-confirm-own-request-after');
        const recordedEntry = recorded.items.find(item => item.id === intent.request);
        if (!recordedEntry) throw new Error('Recorded withdrawal refresh has no matching request');
        expect(after.data.entry).toEqual(recordedEntry);
        expect(after.data.state).toBe('withdrawn');
      });
      expect(result.ok).toBe(true);
      expect(events).toEqual(['receipt', 'refresh']);
    }, true);
  }
});

test('the decision control keeps the receipt, reads the restored selection, then reaches the final inbox', async () => {
  const { confirmAdmissionDecision } = await import('../manage/admission-controls.ts');
  const { recordedRequestsRoute } = await import('./realm-membership-recorded-page.ts');
  const { membershipSelections, membershipSessionLabels } = await import('./realm-membership-recorded-samples.ts');
  for (const state of ['declined', 'accepted'] as const) {
    const selections = membershipSelections(record, 'owner', [...membershipSessionLabels('owner'),
      'request-address-space-missing', `decision-confirm-inbox-${state}`, `decision-confirm-selected-refreshed-${state}`,
      `decision-confirm-inbox-after-${state}`, `decision-confirm-${state}`,
      'management-realm-header', 'management-site-absent', 'requester-name-stranger']);
    await withReplay('owner', selections, async (main, _read, fetcher) => {
      const identity = recordedIdentity(record, 'owner', selections);
      const frame = await recordedRequestsRoute(main, fetcher, identity.realm, 'en') as
        import('react').ReactElement<{ children: import('react').ReactElement<{
          initial: RequestPage; api: import('../manage/settings-api.ts').SpaceAccessApi; actingSubject: string;
        }> }>;
      const { initial, api, actingSubject } = frame.props.children.props;
      const selected = initial.items[0];
      if (!selected) throw new Error('The reached decision has no selected request');
      const body = commandOf<import('../manage/settings-api.ts').JoinDecision>('owner', `decision-confirm-${state}`);
      const intent = { request: selected.id, key: newKey(), command: {
        actingSubject, expectedGeneration: initial.generation, expectedRequestGeneration: selected.requestGeneration,
        decision: state, reason: body.reason,
      } };
      expect(intent.command).toEqual(body);
      const events: string[] = [];
      const result = await confirmAdmissionDecision(api, intent, '', receipt => {
        events.push('receipt');
        expect(receipt).toEqual(answerOf<JoinDecisionReceipt>('owner', `decision-confirm-${state}`));
        expect(receipt.requestId).toBe(selected.id);
      }, restored => {
        events.push('refresh');
        expect(restored.ok).toBe(true);
        if (!restored.ok) return;
        expect(restored.data).toEqual(answerOf<RequestPage>('owner', `decision-confirm-selected-refreshed-${state}`));
        expect(restored.data.items.find(item => item.id === selected.id)).toEqual(selected);
      });
      expect(result.ok).toBe(true);
      expect(events).toEqual(['receipt', 'refresh']);
      const final = await api.requests(null, '');
      expect(final.ok).toBe(true);
      if (!final.ok) return;
      expect(final.data).toEqual(answerOf<RequestPage>('owner', `decision-confirm-inbox-after-${state}`));
      expect(final.data.items).toHaveLength(0);
      expect(final.data.complete).toBe(true);
    }, true);
  }
});

test('the reached members route invites with HTTP 200 and refreshes the production page and browser lists', async () => {
  const { recordedMembersRoute } = await import('./realm-membership-recorded-page.ts');
  const { membershipInvitationLabels, membershipSelections } = await import('./realm-membership-recorded-samples.ts');
  const selections = membershipSelections(record, 'owner', membershipInvitationLabels);
  await withReplay('owner', selections, async (main, _read, fetcher) => {
    const identity = recordedIdentity(record, 'owner', selections);
    type Frame = import('react').ReactElement<{ children: import('react').ReactElement<{
      api: import('../manage/admin-api.ts').AdminApi; agents: Record<string, import('../manage/types.ts').AgentSummary>;
      first: import('../manage/types.ts').MemberPage; invitations: import('../manage/types.ts').Loaded<import('../manage/types.ts').InvitationPage>;
    }> }>;
    const frame = await recordedMembersRoute(main, fetcher, identity.realm, 'en') as Frame;
    const { api, first, invitations } = frame.props.children.props;
    expect(first).toEqual(answerOf('owner', 'members-before-invitation'));
    expect(invitations).toEqual({ ok: true, data: answerOf('owner', 'outgoing-invitations-before-confirm') });
    const body = commandOf<import('../manage/types.ts').InvitationCommand>('owner', 'invitation-confirm');
    const found = await api.lookup(body.member);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    const roster = await api.members(found.data.iri, null);
    expect(roster.ok).toBe(true);
    if (roster.ok) expect(roster.data).toEqual(answerOf('owner', 'invitation-confirm-roster'));
    const sent = await api.invite({ actingSubject: identity.actingSubject!, member: found.data.iri,
      expiresInSeconds: inviteDurations.find(([label]) => label === 'duration7d')![1] }, newKey());
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(recordedSample(record, 'owner', 'invitation-confirm').status).toBe(200);
    expect(sent.data).toEqual(answerOf<import('../manage/types.ts').InvitationResult>('owner', 'invitation-confirm'));
    expect(sent.data.invitation.state).toBe('pending');
    const refreshed = await recordedMembersRoute(main, fetcher, identity.realm, 'en') as Frame;
    expect(refreshed.props.children.props.first).toEqual(answerOf('owner', 'members-after-invitation'));
    expect(refreshed.props.children.props.agents[body.member]?.label).toBe(
      answerOf<{ displayName: string }>('owner', 'members-after-invitation-name-member').displayName);
    const members = await api.members('', null);
    expect(members.ok).toBe(true);
    if (!members.ok) return;
    expect(members.data).toEqual(answerOf('owner', 'invitation-refresh-members'));
    await api.names(members.data.items.map(item => item.member));
    const outgoing = await api.invitations(null);
    expect(outgoing.ok).toBe(true);
    if (!outgoing.ok) return;
    expect(outgoing.data).toEqual(answerOf('owner', 'outgoing-invitations-after-confirm'));
    expect(outgoing.data.items.find(item => item.id === sent.data.invitation.id)?.state).toBe('pending');
  }, true);
});
