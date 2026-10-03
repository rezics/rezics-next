import { expect, test } from 'bun:test';
import { AGENT_COOKIE, SESSION_KEY_COOKIE } from '../features/auth/cookies.ts';
import { selectedSessionAgent, type PublicRequest } from './direction-9-fixture.ts';

const sessionKey = '00000000-0000-4000-8000-000000000001';
const selected = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const fallback = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
const cookies = [{ name: SESSION_KEY_COOKIE, value: sessionKey }];

test('G-988: authenticated address reads use Main selection, including a changed Agent', async () => {
  const calls: unknown[] = [];
  let actor = selected;
  const request: Pick<PublicRequest, 'get'> = {
    get: async (path, options) => {
      calls.push([path, options]);
      return {
        status: () => 200,
        json: async () => ({
          sessionAgent: { actingSubject: actor, eligible: true },
          mainAgent: { actingSubject: fallback, eligible: true },
          initialActingSubject: fallback,
        }),
      };
    },
  };
  expect(await selectedSessionAgent(request, cookies)).toBe(selected);
  actor = fallback;
  expect(
    await selectedSessionAgent(request, [...cookies, { name: AGENT_COOKIE, value: selected }]),
  ).toBe(fallback);
  expect(calls).toEqual(
    Array.from({ length: 2 }, () => [
      '/api/main/v1/me/session-agent',
      { headers: { 'x-session-key': sessionKey } },
    ]),
  );
});

test('G-988: a legacy subject cookie cannot replace a missing or invalid session key', async () => {
  let reads = 0;
  const request = {
    get: async () => {
      reads++;
      throw new Error('Must not read without a session key');
    },
  };
  for (const jar of [
    [],
    [{ name: AGENT_COOKIE, value: selected }],
    [{ name: SESSION_KEY_COOKIE, value: 'invalid' }],
  ]) {
    await expect(selectedSessionAgent(request, jar)).rejects.toThrow('needs a web session key');
  }
  expect(reads).toBe(0);
});

test('G-988: unavailable or ineligible selection never falls back to the Account Agent', async () => {
  const unavailable = { get: async () => ({ status: () => 503, json: async () => ({}) }) };
  await expect(selectedSessionAgent(unavailable, cookies)).rejects.toThrow('HTTP 503');
  for (const sessionAgent of [
    { actingSubject: null, eligible: false },
    { actingSubject: selected, eligible: false },
    { actingSubject: null, eligible: true },
  ]) {
    const request = {
      get: async () => ({
        status: () => 200,
        json: async () => ({
          sessionAgent,
          mainAgent: { actingSubject: fallback, eligible: true },
        }),
      }),
    };
    await expect(selectedSessionAgent(request, cookies)).rejects.toThrow(
      'needs an eligible selected Agent',
    );
  }
});
