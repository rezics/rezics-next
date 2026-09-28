import { expect, test } from 'bun:test';
import { ensureOnboarding, onboardingDestination, type OnboardingResult } from '../features/onboarding/ensure.ts';
import { currentVanityHandle, normalizedHandle } from '../features/onboarding/handle.ts';
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

test('handle entry normalizes case and treats the native address as no chosen handle', () => {
  expect(normalizedHandle(' Ada_1 ')).toBe('ada_1');
  expect(normalizedHandle('ab')).toBeNull();
  expect(normalizedHandle('bad-handle')).toBeNull();
  expect(currentVanityHandle('agent-00000000-0000-4000-8000-000000000001')).toBeNull();
  expect(currentVanityHandle('ada_1')).toBe('ada_1');
});

test('handle change sends the expected prior handle and preserves Main conflict outcomes', async () => {
  const captured: { request: Request | null } = { request: null };
  const send = async (input: URL, init: RequestInit) => {
    captured.request = new Request(input, init);
    return Response.json({ code: 'agent_handle_cooldown' }, { status: 409 });
  };
  const key = '00000000-0000-4000-8000-000000000002';
  expect(await changeHandle('secret', person.agent, 'Ada_New', 'ada', key, send)).toBe('cooldown');
  expect(captured.request?.url).toBe('http://127.0.0.1:3001/v1/agents/00000000-0000-4000-8000-000000000001/handle');
  expect(captured.request?.headers.get('authorization')).toBe('Bearer secret');
  expect(captured.request?.headers.get('idempotency-key')).toBe(key);
  expect(await captured.request?.json()).toEqual({ profile: 'agent-handle-v1', handle: 'ada_new', expectedHandle: 'ada' });
  const conflict = async () => Response.json({ code: 'agent_handle_conflict' }, { status: 409 });
  expect(await changeHandle('secret', person.agent, 'ada_new', 'ada', key, conflict)).toBe('conflict');
  const invalid = async () => { throw new Error('should not send'); };
  expect(await changeHandle('secret', person.agent, 'a', 'ada', key, invalid)).toBe('invalid');
});
