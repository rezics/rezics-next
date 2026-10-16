import { expect, test } from 'bun:test';
import { isValidElement } from 'react';
import '../../tests/support/official-package-fixture.ts';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import membershipRecord from '../../../../tests/qa/fixtures/outcomes/realm/membership-and-admission.json';
import { browserMainApi } from '../api/browser.ts';
import { adminApi } from '../manage/admin-api.ts';
import { readRequestsAtAddress, spaceAccessApi, type JoinDecision, type JoinPage, type JoinWithdraw } from '../manage/settings-api.ts';
import { readCurrentRequest } from '../space-access/request-state.ts';
import { membershipRecordedTransition } from './membership-recorded-transition.ts';
import { decisionPhases, invitationPhases, refusedSelections, withdrawalPhases } from './membership-recorded-paths.ts';
import { recordedIdentity, recordedManagementAgent, recordedMembersRoute, recordedRealmRoute, recordedReplay,
  recordedRequestsRoute, recordedSample } from './realm-membership-recorded-page.ts';

const record = membershipRecord as AnswerRecord;
const origin = 'https://recorded.invalid';

test('every refused request route reaches the production management frame with the recorded problem', async () => {
  for (const persona of ['member', 'moderator', 'stranger', 'operator'] as const) {
    const selections = refusedSelections(record, persona);
    const playback = membershipRecordedTransition(record, persona, [{ selections }]);
    try {
      const main = browserMainApi(origin, { fetcher: playback.fetcher });
      const identity = recordedIdentity(record, persona, selections);
      const session = await recordedManagementAgent(playback.fetcher, 'en');
      const failure = await readRequestsAtAddress(main, identity.realm, session.actingSubject);
      expect(failure.ok).toBe(false);
      const sample = recordedSample(record, persona, persona === 'member' || persona === 'moderator'
        ? 'requests-access-settings-refused' : 'requests-access-realm');
      if (failure.ok) throw new Error('Refused inbox was admitted');
      expect(failure.problem).toEqual(sample.answer);
      expect(failure).toMatchObject({ code: (sample.answer as { code: string }).code, title: (sample.answer as { title: string }).title, status: sample.status });
      expect(sample.status).toBe(persona === 'member' || persona === 'moderator' ? 403 : 404);
      const frame = await recordedRequestsRoute(main, playback.fetcher, identity.realm, 'en', session);
      if (!isValidElement<{ agent: typeof session.agent; header: unknown; children: unknown }>(frame)) throw new Error('Missing management frame');
      expect(frame.props.agent.iri).toBe(session.actingSubject);
      expect(Boolean(frame.props.header)).toBe(persona === 'member' || persona === 'moderator');
      if (!isValidElement<{ failure: string }>(frame.props.children)) throw new Error('Missing refusal body');
      expect(frame.props.children.props.failure).toBe(failure.failure);
      expect(playback.calls.some(call => call.path.includes('/zone?'))).toBe(true);
      expect(playback.calls.every(call => call.method === 'GET')).toBe(true);
    } finally { playback.dispose(); }
  }
});

test('withdrawal uses the production join reader and refreshes the same request to withdrawn for both outsiders', async () => {
  for (const persona of ['stranger', 'operator'] as const) {
    const phases = withdrawalPhases(record, persona);
    const playback = membershipRecordedTransition(record, persona, phases);
    try {
      const identity = recordedIdentity(record, persona, phases[0]!.selections);
      await recordedRealmRoute(recordedReplay(playback.fetcher, true), identity.realm, 'en');
      const landing = recordedSample(record, persona, 'join-landing').answer as JoinPage;
      const main = browserMainApi(origin, { fetcher: playback.fetcher });
      const posted = recordedSample(record, persona, 'withdraw-confirm');
      const body = posted.body as unknown as JoinWithdraw;
      const api = spaceAccessApi(() => main, landing.space, landing.id, body.actingSubject);
      const before = await readCurrentRequest(api);
      if (!before.ok || !before.data.entry) throw new Error('Missing own pending request');
      expect(before.data.state).toBe('pending');
      const command = { actingSubject: body.actingSubject, expectedRequestGeneration: before.data.entry.requestGeneration, reason: body.reason };
      expect(command).toEqual(body);
      const key = `withdraw:${persona}`;
      const result = await api.withdraw(before.data.entry.id, command, key);
      expect(posted.status).toBe(201);
      expect(result).toMatchObject({ ok: true, data: posted.answer });
      const after = await readCurrentRequest(api);
      expect(after.ok).toBe(true);
      if (!after.ok || !after.data.entry) throw new Error('Missing refreshed own request');
      expect(after.data.state).toBe('withdrawn');
      expect(after.data.entry.id).toBe(before.data.entry.id);
      expect(after.data.entry.requestGeneration).not.toBe(before.data.entry.requestGeneration);
      expect(playback.phase()).toBe(1);
      expect(playback.calls.find(call => call.method === 'POST')).toMatchObject({ body, key });
      expect(playback.calls.find(call => call.path.endsWith('/join-page'))?.credentials).toBe('omit');
      expect(playback.calls.filter(call => call.path.includes('/mine?')).every(call => call.credentials === 'same-origin')).toBe(true);
      const reads = playback.calls.filter(call => call.path.includes('/mine?'));
      expect(reads[0]!.path).toBe(reads[1]!.path);
      const repeated = await readCurrentRequest(api);
      expect(repeated).toEqual(after);
    } finally { playback.dispose(); }
  }
});

test('each owner decision refreshes the selected request then removes it from the production inbox', async () => {
  for (const decision of ['accepted', 'declined'] as const) {
    const phases = decisionPhases(record, decision);
    const playback = membershipRecordedTransition(record, 'owner', phases);
    try {
      const identity = recordedIdentity(record, 'owner', phases[0]!.selections);
      const main = browserMainApi(origin, { fetcher: playback.fetcher });
      const frame = await recordedRequestsRoute(main, playback.fetcher, identity.realm, 'en');
      if (!isValidElement<{ children: unknown }>(frame) || !isValidElement<{ initial: { items: { id: string; member: string }[] }; api: ReturnType<typeof spaceAccessApi> }>(frame.props.children)) throw new Error('Missing production inbox');
      const { initial, api } = frame.props.children.props;
      const names = await api.names(initial.items.map(item => item.member));
      expect(Object.keys(names)).toHaveLength(1);
      const selected = await api.requests(null, '');
      expect(selected).toMatchObject({ ok: true, data: recordedSample(record, 'owner', `decision-confirm-selected-refreshed-${decision}`).answer });
      if (!selected.ok || !selected.data.items[0]) throw new Error('Missing selected request');
      const item = selected.data.items[0];
      expect(item.id).toBe(initial.items[0]!.id);
      const posted = recordedSample(record, 'owner', `decision-confirm-${decision}`);
      const body = posted.body as unknown as JoinDecision;
      const command = { actingSubject: body.actingSubject, expectedGeneration: selected.data.generation,
        expectedRequestGeneration: item.requestGeneration, decision, reason: body.reason };
      expect(command).toEqual(body);
      const key = `decision:${decision}`;
      const result = await api.decide(item.id, command, key);
      expect(posted.status).toBe(201);
      expect(result).toMatchObject({ ok: true, data: posted.answer });
      const refreshed = await api.requests(null, '');
      expect(refreshed).toMatchObject({ ok: true, data: recordedSample(record, 'owner', `decision-confirm-inbox-after-${decision}`).answer });
      if (!refreshed.ok) throw new Error('Missing refreshed inbox');
      expect(refreshed.data.items.some(request => request.id === item.id)).toBe(false);
      expect(refreshed.data.generation).not.toBe(selected.data.generation);
      expect(playback.calls.find(call => call.method === 'POST')).toMatchObject({ body, key });
      expect(await api.requests(null, '')).toEqual(refreshed);
      expect(playback.calls.filter(call => call.method === 'GET' && call.path.includes('/join-requests?'))).toHaveLength(4);
    } finally { playback.dispose(); }
  }
});

test('the invitation reaches the production members page and every server and BFF refresh', async () => {
  const phases = invitationPhases(record);
  const playback = membershipRecordedTransition(record, 'owner', phases);
  try {
    const main = browserMainApi(origin, { fetcher: playback.fetcher });
    const identity = recordedIdentity(record, 'owner', phases[0]!.selections);
    const session = await recordedManagementAgent(playback.fetcher, 'en');
    const initial = await recordedMembersRoute(main, playback.fetcher, identity.realm, 'en', undefined, undefined, session);
    expect(isValidElement(initial)).toBe(true);
    const api = adminApi(() => main, identity.realm, session.actingSubject);
    const posted = recordedSample(record, 'owner', 'invitation-confirm');
    const body = posted.body as { actingSubject: string; member: string; expiresInSeconds: number };
    const lookup = await api.lookup(body.member);
    expect(lookup).toMatchObject({ ok: true, data: { iri: body.member } });
    expect((await api.members(body.member, null)).ok).toBe(true);
    const result = await api.invite(body, 'invite:one-week');
    expect(posted.status).toBe(200);
    expect(result).toMatchObject({ ok: true, data: posted.answer });
    const refreshed = await recordedMembersRoute(main, playback.fetcher, identity.realm, 'en', undefined, undefined, session);
    if (!isValidElement<{ children: unknown }>(refreshed) || !isValidElement<{ agents: Record<string, { label: string }>; invitations: { ok: true; data: { items: { state: string }[] } } }>(refreshed.props.children)) throw new Error('Missing refreshed members page');
    expect(refreshed.props.children.props.agents[body.member]?.label).toBe(
      (recordedSample(record, 'owner', 'members-after-invitation-name-member').answer as { displayName: string }).displayName);
    expect(refreshed.props.children.props.invitations.data.items[0]?.state).toBe('pending');
    const members = await api.members('', null);
    if (!members.ok) throw new Error('Missing local roster refresh');
    await api.names(members.data.items.map(item => item.member));
    expect(await api.invitations(null)).toMatchObject({ ok: true, data: recordedSample(record, 'owner', 'outgoing-invitations-after-confirm').answer });
    expect(playback.phase()).toBe(2);
    expect(playback.calls.filter(call => call.path.startsWith('/v1/me/session-agent')).length).toBe(1);
    const publicNames = playback.calls.filter(call => call.path.startsWith('/v1/agents/') && !call.path.includes('?'));
    expect(publicNames).toHaveLength(5);
    expect(publicNames.every(call => call.credentials === 'omit')).toBe(true);
    const personalizedNames = playback.calls.filter(call => call.path.startsWith('/v1/agents/') && call.path.includes('?'));
    expect(personalizedNames).toHaveLength(3);
    expect(personalizedNames.every(call => call.path.includes(encodeURIComponent(session.actingSubject)))).toBe(true);
    expect(playback.calls.filter(call => call.method === 'GET' && call.path.includes('/members?') && !call.path.includes('search='))).toHaveLength(3);
    expect(playback.calls.filter(call => call.method === 'GET' && call.path.includes('/invitations?'))).toHaveLength(3);
    expect(playback.calls.filter(call => call.path.includes('/roles?'))).toHaveLength(2);
    expect(playback.calls.filter(call => call.path.includes('/zone?'))).toHaveLength(2);
    expect(playback.calls.find(call => call.method === 'POST')).toMatchObject({ body, key: 'invite:one-week' });
  } finally { playback.dispose(); }
});

test('a mismatched confirmation keeps the pending answer and a recorded refusal never advances the replay', async () => {
  const phases = withdrawalPhases(record, 'stranger');
  const playback = membershipRecordedTransition(record, 'stranger', phases);
  try {
    const posted = recordedSample(record, 'stranger', 'withdraw-confirm');
    const body = posted.body as unknown as JoinWithdraw;
    await expect(playback.fetcher(`${origin}${posted.path}`, {
      method: posted.method, body: JSON.stringify({ ...body, expectedRequestGeneration: '999999' }),
    })).rejects.toThrow('Unmatched recorded request');
    expect(playback.phase()).toBe(0);
    const own = recordedSample(record, 'stranger', 'withdraw-confirm-own-request');
    expect(await (await playback.fetcher(`${origin}${own.path}`)).json()).toEqual(own.answer);
  } finally { playback.dispose(); }
  const label = 'request-decision-accepted-0';
  const refusal = recordedSample(record, 'owner', label);
  expect(refusal.status).toBe(409);
  const refused = membershipRecordedTransition(record, 'owner', [
    { selections: [{ label, state: 'error' }], advanceOn: label },
    { selections: [{ label: 'request-inbox-after-decisions', state: 'empty' }] },
  ]);
  try {
    const response = await refused.fetcher(`${origin}${refusal.path}`, { method: refusal.method, body: JSON.stringify(refusal.body) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(refusal.answer);
    expect(refused.phase()).toBe(0);
  } finally { refused.dispose(); }
});
