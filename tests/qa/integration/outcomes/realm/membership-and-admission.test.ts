import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import admission from '../../../../../scripts/qa/cases/outcomes/realm/membership-and-admission.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

setDefaultTimeout(180_000);
let sessions: PersonaSessions;
const recording = new OutcomeRecorder(admission);
const rootOf = (id: string) => `/v1/realms/${id.slice(-36)}`;
const acting = (person: PersonaSession) =>
  `actingSubject=${encodeURIComponent(person.actingSubject ?? sessions.owner.actingSubject!)}`;
async function phase<T>(name: string, milliseconds: number, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([run(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${name} reached ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
function personaProof(name: PersonaName, proof: () => Promise<() => Promise<void>>) {
  return async () => {
    // The first 60 seconds belong to the outcome proof; supporting records have their own budget.
    const reads = await phase(`${name} proof`, 60_000, proof);
    await phase(`${name} supporting records`, 120_000, reads);
  };
}
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request,
    raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
type Basis = {
  membershipGeneration: string;
  policyRevision: string;
  termsRevision: string;
  state: string;
};
type RequestReceipt = {
  requestId: string;
  requestGeneration: string;
  state: string;
  replayed: boolean;
};
type RequestPage = {
  items: { id: string; member: string; reason: string; state: string }[];
  nextCursor: string | null;
  complete: boolean;
};
type MemberPage = { items: { member: string }[] };
async function memberNames(page: MemberPage, prefix: string, anonymous: boolean) {
  const owner = sessions.owner;
  const sample = recording.session('owner', anonymous ? sessions.visitor : owner);
  for (const member of new Set(page.items.map(item => item.member))) {
    const name = (Object.keys(sessions) as PersonaName[]).find(name => sessions[name]?.actingSubject === member);
    await answer(sample(`${prefix}-${name}`, 'GET', `/v1/agents/${member.slice(-36)}${anonymous ? '' : `?${acting(owner)}`}`));
  }
}
async function requestMode(space: string) {
  const path = `/v1/spaces/${space.slice(-36)}/settings`,
    owner = sessions.owner;
  const basis = await answer<{ generation: string }>(owner.main('GET', `${path}?${acting(owner)}`));
  await answer(
    owner.main('PUT', path, {
      actingSubject: owner.actingSubject,
      expectedGeneration: basis.generation,
      reason: 'Require an admission request and preserve the admission history boundary',
      settings: {
        visibility: 'private',
        listing: 'listed',
        history: 'from-admission',
        admission: 'request',
      },
    }),
    201,
  );
}
async function submit(person: PersonaSession, root = rootOf(sessions.realm), key = randomUUID(),
  sample?: ReturnType<OutcomeRecorder['session']>) {
  const basis = await answer<Basis>(
    sample ? sample('join-request-basis', 'GET', `${root}/join-requests/basis?${acting(person)}`)
      : person.main('GET', `${root}/join-requests/basis?${acting(person)}`),
  );
  const input = {
    actingSubject: person.actingSubject,
    expectedMembershipGeneration: basis.membershipGeneration,
    expectedPolicyRevision: basis.policyRevision,
    termsRevision: basis.termsRevision,
    reason: 'Read and discuss the original fixture stories',
  };
  const receipt = await answer<RequestReceipt>(
    sample ? sample('join-request-submitted', 'POST', `${root}/join-requests`, input, key)
      : person.main('POST', `${root}/join-requests`, input, key),
    201,
  );
  return { input, receipt, key };
}
// The signed-in shell and authenticated Eden reads share these session reads.
async function pageSession(name: PersonaName, prefix: string) {
  const person = sessions[name], sample = recording.session(name, person);
  for (const [label, path] of [
    ['session-agent', '/v1/me/session-agent'],
    ['person-preferences', `/v1/me/person-preferences?${acting(person)}`],
    ['agent-choices', '/v1/me/agents?languages=en'],
    ['acting-contexts', '/v1/me/acting-contexts?task=work.create'],
    ['acting-agent-profile', `/v1/agents/${person.actingSubject!.slice(-36)}?${acting(person)}`],
  ] as const) await answer(sample(`${prefix}-${label}`, 'GET', path));
}
// readRequestsAtAddress tries the legacy Realm address as a Space, then
// readManagementAccess resolves the settings only if the Realm header opens.
async function refusedInboxReads(name: 'stranger' | 'member' | 'moderator' | 'operator') {
  const person = sessions[name], sample = recording.session(name, person);
  const root = rootOf(sessions.realm), id = sessions.realm.slice(-36);
  await answer(sample('requests-address-space-missing', 'GET', `/v1/spaces/${id}`), 404);
  await answer(sample('requests-address-settings-refused', 'GET', `/v1/spaces/${id}/settings?${acting(person)}`), 403);
  await answer(sample('management-refused-realm-header', 'GET', `${root}?${acting(person)}&language=en`),
    name === 'member' || name === 'moderator' ? 200 : 404);
  await answer(sample('management-refused-realm-zone', 'GET', `${root}/zone?${acting(person)}`), 404);
  await answer(sample('requests-access-realm', 'GET', `${root}?${acting(person)}`),
    name === 'member' || name === 'moderator' ? 200 : 404);
  if (name === 'member' || name === 'moderator')
    await answer(sample('requests-access-settings-refused', 'GET', `/v1/spaces/${sessions.space.slice(-36)}/settings?${acting(person)}`), 403);
}
async function joinReads(name: 'stranger' | 'operator') {
  const person = sessions[name], sample = recording.session(name, person);
  const root = rootOf(sessions.realm);
  await pageSession(name, 'join');
  await answer(recording.session(name, sessions.visitor)(
    'join-address', 'GET', `/v1/addresses/resolve?scope=space&key=${sessions.realm.slice(-36)}`,
  ));
  await answer(recording.session(name, sessions.visitor)('join-public-realm', 'GET', root), 404);
  await answer(sample('join-realm', 'GET', `${root}?${acting(person)}`), 404);
  await answer(recording.session(name, sessions.visitor)('join-landing', 'GET', `${root}/join-page`));
  await answer(sample('join-own-requests-before-request', 'GET', `${root}/join-requests/mine?${acting(person)}&limit=50`), 404);
}
beforeAll(async () => {
  sessions = await personaSessions('private');
  await recording.prepare();
  await requestMode(sessions.space);
}, 180_000);
afterAll(async () => {
  try { await recording.publish(); }
  finally { await sessions?.close(); }
});

outcomeTest(admission, 'visitor', personaProof('visitor', async () => {
  const root = rootOf(sessions.realm),
    person = sessions.visitor;
  const sample = recording.session('visitor', person);
  expect(await answer(sample('request-landing', 'GET', `${root}/join-page`))).toMatchObject({
    profile: 'realm-join-page-v1',
  });
  await answer(sample('private-realm-hidden', 'GET', root), 404);
  await answer(sample('join-basis-sign-in-required', 'GET', `${root}/join-requests/basis?${acting(person)}`), 401);
  await answer(person.main('GET', `${root}/join-requests?${acting(person)}`), 401);
  await answer(
    person.main('POST', `${root}/join-requests`, {
      actingSubject: sessions.owner.actingSubject,
      expectedMembershipGeneration: '0',
      expectedPolicyRevision: '1',
      termsRevision: 'fixture-terms',
      reason: 'Request admission',
    }),
    401,
  );
  return async () => {
    await answer(sample('join-address', 'GET', `/v1/addresses/resolve?scope=space&key=${sessions.realm.slice(-36)}`));
  };
}), recording);

outcomeTest(admission, 'stranger', personaProof('stranger', async () => {
  const person = sessions.stranger,
    root = rootOf(sessions.realm),
    path = `${root}/join-requests`;
  const sample = recording.session('stranger', person);
  await answer(recording.session('stranger', sessions.visitor)('request-landing', 'GET', `${root}/join-page`));
  await (await sample('own-requests-before-request', 'GET', `${path}/mine?${acting(person)}&limit=50`)).body?.cancel();
  await answer(person.main('GET', `${root}?${acting(person)}`), 404);
  await joinReads('stranger');
  const first = await submit(person, root, randomUUID(), sample);
  expect(await answer(person.main('POST', path, first.input, first.key))).toMatchObject({
    requestId: first.receipt.requestId,
    state: 'pending',
    replayed: true,
  });
  await answer(
    person.main('POST', path, { ...first.input, reason: 'Changed immutable intent' }, first.key),
    409,
  );
  await answer(person.main('POST', path, first.input), 409);
  await answer(sample('request-inbox-denied', 'GET', `${path}?${acting(person)}`), 403);
  await answer(sample('requests-refused', 'GET', `${path}?${acting(person)}&limit=50&q=`), 403);
  await answer(sample('join-own-request-pending', 'GET', `${path}/mine?${acting(person)}&limit=50`));
  const mine = await answer<RequestPage>(sample('own-request-pending', 'GET', `${path}/mine?${acting(person)}`));
  expect(mine.items).toMatchObject([
    {
      id: first.receipt.requestId,
      member: person.actingSubject,
      reason: first.input.reason,
      state: 'pending',
    },
  ]);
  const input = {
    actingSubject: person.actingSubject,
    expectedRequestGeneration: first.receipt.requestGeneration,
    reason: 'Withdraw my request',
  };
  await answer(
    sessions.operator.main('POST', `${path}/${first.receipt.requestId}/withdraw`, {
      ...input,
      actingSubject: sessions.operator.actingSubject,
    }),
    403,
  );
  const key = randomUUID();
  expect(
    await answer(
      sample('request-withdrawn', 'POST', `${path}/${first.receipt.requestId}/withdraw`, input, key),
      201,
    ),
  ).toMatchObject({ state: 'withdrawn' });
  expect(
    await answer(person.main('POST', `${path}/${first.receipt.requestId}/withdraw`, input, key)),
  ).toMatchObject({ state: 'withdrawn', replayed: true });
  await answer(person.main('POST', `${path}/${first.receipt.requestId}/withdraw`, input), 409);
  expect(
    (await answer<RequestPage>(sample('own-request-withdrawn', 'GET', `${path}/mine?${acting(person)}`))).items[0],
  ).toMatchObject({ state: 'withdrawn', reason: first.input.reason });
  await answer(sample('join-own-request-withdrawn', 'GET', `${path}/mine?${acting(person)}&limit=50`));
  await answer(person.main('GET', `${root}?${acting(person)}`), 404);
  return async () => {
    await refusedInboxReads('stranger');
    // The confirm step takes its generation from mine, and trims the entered reason.
    await submit(person, root);
    const confirmPage = await answer<RequestPage & { items: { id: string; requestGeneration: string }[] }>(
      sample('withdraw-confirm-own-request', 'GET', `${path}/mine?${acting(person)}&limit=50`),
    );
    const pending = confirmPage.items.find(item => item.state === 'pending')!;
    await answer(sample('withdraw-confirm', 'POST', `${path}/${pending.id}/withdraw`, {
      actingSubject: person.actingSubject,
      expectedRequestGeneration: pending.requestGeneration,
      reason: 'I cannot join this month.',
    }, randomUUID()), 201);
    await answer(sample('withdraw-confirm-own-request-after', 'GET', `${path}/mine?${acting(person)}&limit=50`));
  };
}), recording);

async function joined(name: 'member' | 'moderator') {
  const person = sessions[name], sample = recording.session(name, person);
  const root = rootOf(sessions.realm);
  expect(await answer(sample('joined-realm-header', 'GET', `${root}?${acting(person)}`))).toMatchObject({
    id: sessions.realm,
  });
  expect(
    await answer<Basis>(sample('joined-request-basis', 'GET', `${root}/join-requests/basis?${acting(person)}`)),
  ).toMatchObject({ state: 'joined' });
  await answer(sample('request-inbox-denied', 'GET', `${root}/join-requests?${acting(person)}`), 403);
  await answer(sample('requests-refused', 'GET', `${root}/join-requests?${acting(person)}&limit=50&q=`), 403);
  await answer(sample('joining-policy', 'GET', `${root}/joining?${acting(person)}`));
  await answer(sample('realm-follow', 'GET', `/v1/follows/${sessions.realm.slice(-36)}?kind=realm&${acting(person)}`));
  await answer(sample('appeal-access', 'GET', '/v1/me/platform-access'));
  await answer(sample('own-ban-absent', 'GET', `${root}/member-ban?${acting(person)}`), 404);
  await answer(
    person.main('POST', `${root}/join-requests/${randomUUID()}/decisions`, {
      actingSubject: person.actingSubject,
      expectedGeneration: '0',
      expectedRequestGeneration: '0',
      decision: 'accepted',
      reason: 'Unauthorized admission',
    }),
    403,
  );
  await answer(
    person.main('POST', `${root}/invitations`, {
      actingSubject: person.actingSubject,
      member: sessions.stranger.actingSubject,
      expiresInSeconds: 3600,
    }),
    403,
  );
  return async () => {
    await refusedInboxReads(name);
    await pageSession(name, 'frame');
    const publicSample = recording.session(name, sessions.visitor);
    await answer(publicSample('frame-address', 'GET', `/v1/addresses/resolve?scope=space&key=${sessions.realm.slice(-36)}`));
    await answer(publicSample('frame-public-realm', 'GET', root), 404);
    await answer(sample('frame-realm', 'GET', `${root}?${acting(person)}`));
    await answer(sample('frame-realm-zone', 'GET', `${root}/zone?${acting(person)}`), 404);
    await answer(sample('frame-presentation', 'GET', `/v1/zones/${sessions.zone.slice(-36)}/presentation?${acting(person)}`));
    await answer(sample('frame-joining', 'GET', `${root}/joining?${acting(person)}`));
    await answer(sample('frame-follow', 'GET', `/v1/follows/${sessions.realm.slice(-36)}?kind=realm&${acting(person)}`));
    await answer(sample('frame-platform-access', 'GET', '/v1/me/platform-access'));
    await answer(sample('frame-own-ban', 'GET', `${root}/member-ban?${acting(person)}`), 404);
  };
}
outcomeTest(admission, 'member', personaProof('member', () => joined('member')), recording);

outcomeTest(admission, 'owner', personaProof('owner', async () => {
  const owner = sessions.owner;
  const sample = recording.session('owner', owner);
  for (const [label, path] of [
    ['session-agent', '/v1/me/session-agent'],
    ['agent-choices', '/v1/me/agents?languages=en'],
    ['acting-contexts', '/v1/me/acting-contexts?task=work.create'],
    ['acting-agent-profile', `/v1/agents/${owner.actingSubject!.slice(-36)}?${acting(owner)}`],
  ] as const) await (await sample(label, 'GET', path)).body?.cancel();
  // A separate affected Realm keeps these requesters strangers in the six-persona fixture.
  const created = await answer<{ space: string; realm: string }>(
    owner.main('POST', '/v1/spaces', {
      profile: 'space-realm-v2',
      name: 'Original request review circle',
      capabilities: ['realm'],
      actingSubject: owner.actingSubject,
      initialSettings: {
        visibility: 'private',
        reviewRequired: false,
        reviewMode: 'open',
        whoMaySubmit: 'members',
        selfJoin: false,
        rules: [],
      },
    }),
    201,
  );
  const root = rootOf(created.realm),
    path = `${root}/join-requests`;
  await answer(owner.main('POST', `${root}/management`, { actingSubject: owner.actingSubject }));
  await requestMode(created.space);
  await answer(sample('management-realm-header', 'GET', `${root}?${acting(owner)}&language=en`));
  await answer(sample('request-address-space-missing', 'GET', `/v1/spaces/${created.realm.slice(-36)}`), 404);
  await answer(sample('management-site-absent', 'GET', `${root}/zone?${acting(owner)}`), 404);
  await answer(sample('request-inbox-empty', 'GET', `${path}?${acting(owner)}&limit=50&q=`));
  const first = await submit(sessions.stranger, root),
    second = await submit(sessions.operator, root);
  await answer(sample('request-inbox', 'GET', `${path}?${acting(owner)}&limit=50&q=`));
  await answer(sample('requests-first-page', 'GET', `${path}?${acting(owner)}&limit=50&q=`));
  await answer(sample('request-inbox-search-empty', 'GET', `${path}?${acting(owner)}&limit=50&q=nomatch${randomUUID().replaceAll('-', '')}`));
  for (const name of ['stranger', 'operator'] as const)
    await answer(sample(`requester-name-${name}`, 'GET', `/v1/agents/${sessions[name].actingSubject!.slice(-36)}?${acting(owner)}`));
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page: RequestPage = await answer(
      sample(
        `request-inbox-page-${ids.length}`, 'GET',
        `${path}?${acting(owner)}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      ),
    );
    ids.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
    expect(page.complete).toBe(cursor === null);
  } while (cursor);
  expect(new Set(ids)).toEqual(new Set([first.receipt.requestId, second.receipt.requestId]));
  const settingsPath = `/v1/spaces/${created.space.slice(-36)}/settings`;
  const decide = async (id: string, decision: 'accepted' | 'declined') => {
    const basis = await answer<{ generation: string }>(
      sample(`decision-settings-${decision}`, 'GET', `${settingsPath}?${acting(owner)}`),
    );
    const input = {
      actingSubject: owner.actingSubject,
      expectedGeneration: basis.generation,
      expectedRequestGeneration: '0',
      decision,
      reason: 'Review the exact admission request',
    };
    await answer(
      owner.main('POST', `${path}/${id}/decisions`, { ...input, expectedGeneration: '0' }),
      409,
    );
    const keys = [randomUUID(), randomUUID()];
    const replies = await Promise.all(
      keys.map((key, index) => sample(`request-decision-${decision}-${index}`, 'POST', `${path}/${id}/decisions`, input, key)),
    );
    expect(replies.map((reply) => reply.status).sort()).toEqual([201, 409]);
    const index = replies.findIndex((reply) => reply.status === 201);
    const receipt = (await replies[index]!.json()) as {
      receiptId: string;
      membershipId: string | null;
    };
    expect(
      await answer(owner.main('POST', `${path}/${id}/decisions`, input, keys[index])),
    ).toMatchObject({ receiptId: receipt.receiptId, replayed: true });
    return receipt;
  };
  expect((await decide(first.receipt.requestId, 'declined')).membershipId).toBeNull();
  await answer(sessions.stranger.main('GET', `${root}?${acting(sessions.stranger)}`), 404);
  expect((await decide(second.receipt.requestId, 'accepted')).membershipId).not.toBeNull();
  expect(
    await answer(sessions.operator.main('GET', `${root}?${acting(sessions.operator)}`)),
  ).toMatchObject({ id: created.realm });
  expect(
    (
      await answer<RequestPage>(
        sessions.operator.main('GET', `${path}/mine?${acting(sessions.operator)}`),
      )
    ).items[0],
  ).toMatchObject({ state: 'accepted' });
  expect((await answer<RequestPage>(sample('request-inbox-after-decisions', 'GET', `${path}?${acting(owner)}`))).items).toEqual(
    [],
  );
  await answer(sample('requests-after-decisions', 'GET', `${path}?${acting(owner)}&limit=50&q=`));
  expect(await answer(owner.main('GET', `${settingsPath}?${acting(owner)}`))).toMatchObject({
    settings: { history: 'from-admission' },
  });
  return async () => {
    await answer(sample('person-preferences', 'GET', `/v1/me/person-preferences?${acting(owner)}`));
    // RequestsView confirms against the inbox generation and the selected row.
    // Use later requests so the original concurrent-decision samples stay intact.
    for (const decision of ['declined', 'accepted'] as const) {
      const submitted = await submit(sessions.stranger, root);
      const page = await answer<RequestPage & { generation: string; items: { id: string; requestGeneration: string }[] }>(
        sample(`decision-confirm-inbox-${decision}`, 'GET', `${path}?${acting(owner)}&limit=50&q=`),
      );
      const selected = page.items.find(item => item.id === submitted.receipt.requestId)!;
      // The dialog's Refresh reloads the inbox and restores the selected request.
      await answer(sample(`decision-confirm-selected-refreshed-${decision}`, 'GET', `${path}?${acting(owner)}&limit=50&q=`));
      await answer(sample(`decision-confirm-${decision}`, 'POST', `${path}/${selected.id}/decisions`, {
        actingSubject: owner.actingSubject,
        expectedGeneration: page.generation,
        expectedRequestGeneration: selected.requestGeneration,
        decision,
        reason: 'Decision reason.',
      }, randomUUID()), 201);
      await answer(sample(`decision-confirm-inbox-after-${decision}`, 'GET', `${path}?${acting(owner)}&limit=50&q=`));
    }
    // Only the owner reaches MembersView in this private Realm. Its invite
    // dialog defaults to seven days and sends no reason or generation.
    const invitationInput = {
      actingSubject: owner.actingSubject,
      member: sessions.member.actingSubject,
      expiresInSeconds: 604_800,
    };
    const invitationKey = randomUUID();
    const beforeMembers = await answer<MemberPage>(sample('members-before-invitation', 'GET', `${root}/members?${acting(owner)}`));
    await answer(sample('roles-before-invitation', 'GET', `${root}/roles?${acting(owner)}`));
    await answer(sample('outgoing-invitations-before-confirm', 'GET', `${root}/invitations?${acting(owner)}`));
    await memberNames(beforeMembers, 'members-before-invitation-name', true);
    // Entering the Person's IRI resolves locally; the dialog still checks the roster.
    await answer(sample('invitation-confirm-roster', 'GET', `${root}/members?${acting(owner)}&search=${encodeURIComponent(sessions.member.actingSubject!)}`));
    await answer(sample('invitation-confirm', 'POST', `${root}/invitations`, invitationInput, invitationKey));
    // MembersView.done starts a route refresh, then reloads members/names and invitations.
    await answer(sample('invitation-refresh-realm-header', 'GET', `${root}?${acting(owner)}&language=en`));
    await answer(sample('invitation-refresh-realm-zone', 'GET', `${root}/zone?${acting(owner)}`), 404);
    const afterMembers = await answer<MemberPage>(sample('members-after-invitation', 'GET', `${root}/members?${acting(owner)}`));
    await answer(sample('roles-after-invitation', 'GET', `${root}/roles?${acting(owner)}`));
    const afterInvitations = await answer<MemberPage>(sample('members-page-invitations-after-confirm', 'GET', `${root}/invitations?${acting(owner)}`));
    await memberNames({ items: [...afterMembers.items, ...afterInvitations.items] }, 'members-after-invitation-name', true);
    const refreshed = await answer<MemberPage>(sample('invitation-refresh-members', 'GET', `${root}/members?${acting(owner)}`));
    await memberNames(refreshed, 'invitation-refresh-member-name', false);
    await answer(sample('outgoing-invitations-after-confirm', 'GET', `${root}/invitations?${acting(owner)}`));
  };
}), recording);

outcomeTest(admission, 'moderator', personaProof('moderator', async () => {
  const reads = await joined('moderator');
  await answer(
    sessions.moderator.main(
      'GET',
      `${rootOf(sessions.realm)}/moderation?${acting(sessions.moderator)}`,
    ),
  );
  return reads;
}), recording);
outcomeTest(admission, 'operator', personaProof('operator', async () => {
  const person = sessions.operator,
    root = rootOf(sessions.realm);
  const sample = recording.session('operator', person);
  expect(await answer(sample('platform-access', 'GET', '/v1/me/platform-access'))).toMatchObject({
    groups: ['platform-admin'],
  });
  await answer(sample('private-realm-hidden', 'GET', `${root}?${acting(person)}`), 404);
  await answer(sample('request-inbox-denied', 'GET', `${root}/join-requests?${acting(person)}`), 403);
  await answer(sample('requests-refused', 'GET', `${root}/join-requests?${acting(person)}&limit=50&q=`), 403);
  await joinReads('operator');
  const request = await submit(person, root, randomUUID(), sample);
  await answer(sample('own-request-pending', 'GET', `${root}/join-requests/mine?${acting(person)}&limit=50`));
  await answer(
    person.main('POST', `${root}/join-requests/${request.receipt.requestId}/decisions`, {
      actingSubject: person.actingSubject,
      expectedGeneration: '0',
      expectedRequestGeneration: '0',
      decision: 'accepted',
      reason: 'Platform authority is not admission authority',
    }),
    403,
  );
  await answer(
    sample('request-withdrawn', 'POST', `${root}/join-requests/${request.receipt.requestId}/withdraw`, {
      actingSubject: person.actingSubject,
      expectedRequestGeneration: '0',
      reason: 'Withdraw operator request',
    }),
    201,
  );
  await answer(sample('own-request-withdrawn', 'GET', `${root}/join-requests/mine?${acting(person)}&limit=50`));
  await answer(person.main('GET', `${root}?${acting(person)}`), 404);
  return async () => {
    await refusedInboxReads('operator');
    const path = `${root}/join-requests`;
    // The confirm step takes its generation from mine, and trims the entered reason.
    await submit(person, root);
    const confirmPage = await answer<RequestPage & { items: { id: string; requestGeneration: string }[] }>(
      sample('withdraw-confirm-own-request', 'GET', `${path}/mine?${acting(person)}&limit=50`),
    );
    const pending = confirmPage.items.find(item => item.state === 'pending')!;
    await answer(sample('withdraw-confirm', 'POST', `${path}/${pending.id}/withdraw`, {
      actingSubject: person.actingSubject,
      expectedRequestGeneration: pending.requestGeneration,
      reason: 'I cannot join this month.',
    }, randomUUID()), 201);
    await answer(sample('withdraw-confirm-own-request-after', 'GET', `${path}/mine?${acting(person)}&limit=50`));
  };
}), recording);
