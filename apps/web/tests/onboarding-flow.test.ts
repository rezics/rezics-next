import { expect, test } from 'bun:test';
import { ensureOnboarding, onboardingDestination, type OnboardingResult } from '../features/onboarding/ensure.ts';
import { currentVanityHandle, normalizedHandle, suggestedHandle } from '../features/onboarding/handle.ts';
import { changeHandle } from '../features/onboarding/change-handle.ts';

const person: OnboardingResult = { agent: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
  state: 'active', suggestedHandle: 'ada', sessionAgent: null, replayed: false };

test('G-431: a new Person Agent chooses a handle, then sets up Home; returning and selected sessions keep their destination', () => {
  const created = { kind: 'active' as const, person, firstVisit: true };
  const destination = onboardingDestination(created, false, '/zh-Hans/studio', 'zh-Hans');
  expect(destination).toBe(`/zh-Hans/onboarding?next=${encodeURIComponent('/zh-Hans/welcome?next=%2Fzh-Hans%2Fstudio')}`);
  expect(new URL(destination, 'https://rezics.test').searchParams.get('next')).toBe('/zh-Hans/welcome?next=%2Fzh-Hans%2Fstudio');
  expect(onboardingDestination({ ...created, firstVisit: false }, false, '/en/studio', 'en'))
    .toBe('/en/studio');
  expect(onboardingDestination(created, true, '/en/studio', 'en')).toBe('/en/studio');
  expect(onboardingDestination({ kind: 'unavailable' }, true, '/en/studio', 'en')).toBe('/en/studio');
});

test('G-537: without a Person the name comes first, even for a session that already has a choice', () => {
  const noName = { kind: 'name-required' as const };
  expect(onboardingDestination(noName, false, '/en/studio', 'en'))
    .toBe(`/en/onboarding?next=${encodeURIComponent('/en/welcome?next=%2Fen%2Fstudio')}`);
  // An Organization held by control may already be the session choice; the Person is still missing.
  expect(onboardingDestination(noName, true, '/en/studio', 'en'))
    .toBe(`/en/onboarding?next=${encodeURIComponent('/en/welcome?next=%2Fen%2Fstudio')}`);
});

test('G-537: Main asking for a public name is an outcome, not a failure, and the typed name is sent once', async () => {
  const sent: (string | undefined)[] = [];
  expect(await ensureOnboarding('token', 'session', async () => {},
    async (_token, _key, name) => { sent.push(name); return 'name-required'; }))
    .toEqual({ kind: 'name-required' });
  expect(await ensureOnboarding('token', 'session', async () => {},
    async () => 'invalid-name', '林梅')).toEqual({ kind: 'invalid-name' });
  const created = await ensureOnboarding('token', 'session', async () => {},
    async (_token, _key, name) => { sent.push(name); return { ...person, suggestedHandle: 'reader' }; }, '林梅');
  expect(created).toEqual({ kind: 'active', person: { ...person, suggestedHandle: 'reader' }, firstVisit: true });
  expect(sent).toEqual([undefined, '林梅']);
});

test('G-537: a handle is suggested from the typed name only, and a name without Latin letters suggests none', () => {
  expect(suggestedHandle('Ada Lovelace')).toBe('ada_lovelace');
  expect(suggestedHandle('Zoë  Ünal!')).toBe('zoe_unal');
  expect(suggestedHandle('林梅')).toBe('');
  expect(suggestedHandle('ab')).toBe('');
  expect(suggestedHandle('x'.repeat(40))).toBe('x'.repeat(30));
  expect(suggestedHandle('')).toBe('');
});

test('202 provisioning retries without losing the first-visit decision', async () => {
  let calls = 0;
  const pauses: number[] = [];
  const outcome = await ensureOnboarding('token', 'session', async ms => { pauses.push(ms); },
    async () => { calls++; return calls === 1 ? { ...person, state: 'pending' }
      : { ...person, replayed: true }; });
  expect(outcome).toEqual({ kind: 'active', person: { ...person, replayed: true }, firstVisit: true });
  expect(calls).toBe(2);
  expect(pauses).toEqual([300]);
});

test('a stalled or unavailable onboarding operation remains recoverable', async () => {
  const pending = await ensureOnboarding('token', 'session', async () => {},
    async () => ({ ...person, state: 'pending' }));
  expect(pending).toEqual({ kind: 'pending' });
  expect(await ensureOnboarding('token', 'session', async () => {}, async () => null))
    .toEqual({ kind: 'unavailable' });
});

test('handle entry normalizes case and preserves the explicit absent handle', () => {
  expect(normalizedHandle(' Ada_1 ')).toBe('ada_1');
  expect(normalizedHandle('ab')).toBeNull();
  expect(normalizedHandle('bad-handle')).toBe('bad-handle');
  expect(currentVanityHandle(null)).toBeNull();
  expect(currentVanityHandle('ada_1')).toBe('ada_1');
});

test('handle change sends the expected prior handle and preserves Main conflict outcomes', async () => {
  const captured: { request: Request | null } = { request: null };
  const send = async (input: URL, init: RequestInit) => {
    if (init.method === 'GET') return Response.json({ holder: person.agent,key: 'ada',revision: person.agent.slice(-36) });
    captured.request = new Request(input, init);
    return Response.json({ code: 'alias_cooldown' }, { status: 409 });
  };
  const key = '00000000-0000-4000-8000-000000000002';
  expect(await changeHandle('secret', person.agent, 'Ada_New', 'ada', key, send)).toBe('cooldown');
  expect(captured.request?.url).toBe('http://127.0.0.1:3001/v1/addresses/renames');
  expect(captured.request?.headers.get('authorization')).toBe('Bearer secret');
  expect(captured.request?.headers.get('idempotency-key')).toBe(key);
  expect(await captured.request?.json()).toEqual({ profile: 'alias-write-v1',scope: 'agent',holder: person.agent,actingSubject: person.agent,operation: 'rename',alias: 'ada_new',expectedRevision: person.agent.slice(-36) });
  const conflict = async (_url: URL,init: RequestInit) => init.method === 'GET' ? Response.json({ holder: person.agent,key: 'ada',revision: person.agent.slice(-36) }) : Response.json({ code: 'alias_conflict' }, { status: 409 });
  expect(await changeHandle('secret', person.agent, 'ada_new', 'ada', key, conflict)).toBe('conflict');
  const invalid = async () => { throw new Error('should not send'); };
  expect(await changeHandle('secret', person.agent, 'a', 'ada', key, invalid)).toBe('invalid');
});
