import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import admission from '../../../../../scripts/qa/cases/outcomes/realm/membership-and-admission.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import {
  personaSessions,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

setDefaultTimeout(60_000);
let sessions: PersonaSessions;
const rootOf = (id: string) => `/v1/realms/${id.slice(-36)}`;
const acting = (person: PersonaSession) =>
  `actingSubject=${encodeURIComponent(person.actingSubject ?? sessions.owner.actingSubject!)}`;
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
async function submit(person: PersonaSession, root = rootOf(sessions.realm), key = randomUUID()) {
  const basis = await answer<Basis>(
    person.main('GET', `${root}/join-requests/basis?${acting(person)}`),
  );
  const input = {
    actingSubject: person.actingSubject,
    expectedMembershipGeneration: basis.membershipGeneration,
    expectedPolicyRevision: basis.policyRevision,
    termsRevision: basis.termsRevision,
    reason: 'Read and discuss the original fixture stories',
  };
  const receipt = await answer<RequestReceipt>(
    person.main('POST', `${root}/join-requests`, input, key),
    201,
  );
  return { input, receipt, key };
}
beforeAll(async () => {
  sessions = await personaSessions('private');
  await requestMode(sessions.space);
}, 180_000);
afterAll(async () => {
  await sessions?.close();
});

outcomeTest(admission, 'visitor', async () => {
  const root = rootOf(sessions.realm),
    person = sessions.visitor;
  expect(await answer(person.main('GET', `${root}/join-page`))).toMatchObject({
    profile: 'realm-join-page-v1',
  });
  await answer(person.main('GET', root), 404);
  await answer(person.main('GET', `${root}/join-requests/basis?${acting(person)}`), 401);
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
});

outcomeTest(admission, 'stranger', async () => {
  const person = sessions.stranger,
    root = rootOf(sessions.realm),
    path = `${root}/join-requests`;
  await answer(person.main('GET', `${root}?${acting(person)}`), 404);
  const first = await submit(person);
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
  await answer(person.main('GET', `${path}?${acting(person)}`), 403);
  const mine = await answer<RequestPage>(person.main('GET', `${path}/mine?${acting(person)}`));
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
      person.main('POST', `${path}/${first.receipt.requestId}/withdraw`, input, key),
      201,
    ),
  ).toMatchObject({ state: 'withdrawn' });
  expect(
    await answer(person.main('POST', `${path}/${first.receipt.requestId}/withdraw`, input, key)),
  ).toMatchObject({ state: 'withdrawn', replayed: true });
  await answer(person.main('POST', `${path}/${first.receipt.requestId}/withdraw`, input), 409);
  expect(
    (await answer<RequestPage>(person.main('GET', `${path}/mine?${acting(person)}`))).items[0],
  ).toMatchObject({ state: 'withdrawn', reason: first.input.reason });
  await answer(person.main('GET', `${root}?${acting(person)}`), 404);
});

async function joined(person: PersonaSession) {
  const root = rootOf(sessions.realm);
  expect(await answer(person.main('GET', `${root}?${acting(person)}`))).toMatchObject({
    id: sessions.realm,
  });
  expect(
    await answer<Basis>(person.main('GET', `${root}/join-requests/basis?${acting(person)}`)),
  ).toMatchObject({ state: 'joined' });
  await answer(person.main('GET', `${root}/join-requests?${acting(person)}`), 403);
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
}
outcomeTest(admission, 'member', () => joined(sessions.member));

outcomeTest(admission, 'owner', async () => {
  const owner = sessions.owner;
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
  const first = await submit(sessions.stranger, root),
    second = await submit(sessions.operator, root);
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page: RequestPage = await answer(
      owner.main(
        'GET',
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
      owner.main('GET', `${settingsPath}?${acting(owner)}`),
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
      keys.map((key) => owner.main('POST', `${path}/${id}/decisions`, input, key)),
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
  expect((await answer<RequestPage>(owner.main('GET', `${path}?${acting(owner)}`))).items).toEqual(
    [],
  );
  expect(await answer(owner.main('GET', `${settingsPath}?${acting(owner)}`))).toMatchObject({
    settings: { history: 'from-admission' },
  });
});

outcomeTest(admission, 'moderator', async () => {
  await joined(sessions.moderator);
  await answer(
    sessions.moderator.main(
      'GET',
      `${rootOf(sessions.realm)}/moderation?${acting(sessions.moderator)}`,
    ),
  );
});
outcomeTest(admission, 'operator', async () => {
  const person = sessions.operator,
    root = rootOf(sessions.realm);
  expect(await answer(person.main('GET', '/v1/me/platform-access'))).toMatchObject({
    groups: ['platform-admin'],
  });
  await answer(person.main('GET', `${root}?${acting(person)}`), 404);
  await answer(person.main('GET', `${root}/join-requests?${acting(person)}`), 403);
  const request = await submit(person);
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
    person.main('POST', `${root}/join-requests/${request.receipt.requestId}/withdraw`, {
      actingSubject: person.actingSubject,
      expectedRequestGeneration: '0',
      reason: 'Withdraw operator request',
    }),
    201,
  );
  await answer(person.main('GET', `${root}?${acting(person)}`), 404);
});
