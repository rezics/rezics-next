import { afterEach, expect, test } from 'bun:test';
import { readMainSessionAgent, sessionReadSubject, type MainSessionAgentState } from '../features/auth/session.ts';

const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const revision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const sessionKey = '00000000-0000-4000-8000-000000000003';
const selected: MainSessionAgentState = {
  sessionAgent: { actingSubject: actor, eligible: true, revision },
  mainAgent: { actingSubject: actor, eligible: true, revision },
  initialActingSubject: null,
};
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('a saved session selection remains the page reader when Main returns no initialization suggestion', async () => {
  globalThis.fetch = (async (input, init) => {
    expect(new URL(String(input)).pathname).toBe('/v1/me/session-agent');
    expect(new Headers(init?.headers).get('x-session-key')).toBe(sessionKey);
    return Response.json(selected);
  }) as typeof fetch;
  const state = await readMainSessionAgent('reader-token', sessionKey);
  expect(state).toEqual(selected);
  expect(state?.initialActingSubject).toBeNull();
  expect(sessionReadSubject(state)).toBe(actor);
});

test('missing, cleared and ineligible session selections read publicly without selecting another identity', () => {
  expect(sessionReadSubject(null)).toBeNull();
  expect(sessionReadSubject({ ...selected, sessionAgent: { actingSubject: null, eligible: false, revision } })).toBeNull();
  expect(sessionReadSubject({ ...selected, sessionAgent: { actingSubject: actor, eligible: false, revision } })).toBeNull();
  expect(sessionReadSubject({ ...selected, initialActingSubject: actor,
    sessionAgent: { actingSubject: null, eligible: false, revision: null } })).toBeNull();
});
