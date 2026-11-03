import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createKernelClient } from '@rezics/client';
import { storyViewerId } from '../src/kernel/fake';
import { myLogsStoryActivity, routes, setMyLogsStory } from '../src/kernel/fake/my-logs';
import { loadMyPublishedLogs } from '../src/library/logs-read';
import type { SessionEnv } from '../src/session/client';
import type { SessionStore } from '../src/session/store';

const authorization = 'Bearer current-owner-token';
const env = {
  AUTH_ISSUER: 'https://auth.example.test',
  API_RESOURCE: 'https://api.rezics.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: 'unused',
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({
      credential: async () => ({
        status: 'active',
        subject: storyViewerId,
        accessToken: 'current-owner-token',
        csrfToken: 'A'.repeat(22),
      }),
    }),
  } as unknown as DurableObjectNamespace<SessionStore>,
} as Partial<SessionEnv>;
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const privateHeaders = { 'cache-control': 'private, no-store' };

function request(signedIn = true) {
  return new Request(
    'https://site.example.test/en/library/logs',
    signedIn ? { headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` } } : {},
  );
}

async function listAnswer(url: string) {
  const answer = await routes[0]!.story!({ request: new Request(url), recordings: {}, match: null });
  if (!answer) throw new Error('My Logs story declined');
  return answer;
}

function transport() {
  const calls: URL[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (input, init) => {
      const call = new Request(input, init);
      expect(call.headers.get('authorization')).toBe(authorization);
      const url = new URL(call.url);
      calls.push(url);
      const answer = await routes[0]!.story!({ request: call, recordings: {}, match: null });
      if (!answer) throw new Error('My Logs story declined');
      const { status, headers, ...body } = answer;
      return Response.json(body, { status, headers: headers as HeadersInit });
    },
  });
  return { client, calls };
}

test('signed-out and restarted-empty stories enter the actual history route', () => {
  const logs = source('../src/stories/library-my-logs.stories.tsx');
  const phone = source('../src/stories/published-log-history-phone.stories.tsx');
  const signedOut = logs.slice(logs.indexOf('export const SignedOut'));
  expect(signedOut).toContain('<PageStory visitor="Signed Out" path="/library/logs" />');
  expect(signedOut).toContain('myLogsStoryActivity().listReads');
  expect(signedOut).toContain("`/auth/sign-in?return_to=${encodeURIComponent(`/${getLocale()}/library/logs`)}`");
  expect(signedOut).not.toContain('MyLogsPageView');
  expect(source('../src/session/guard.ts')).toContain(
    'href: `/auth/sign-in?return_to=${encodeURIComponent(url.pathname + url.search)}`',
  );
  const restartedEmpty = phone.slice(
    phone.indexOf('export const RestartedEmpty'),
    phone.indexOf('export const SignedOutRecovery'),
  );
  const signedOutRecovery = phone.slice(phone.indexOf('export const SignedOutRecovery'));
  expect(restartedEmpty).toContain("beforeEach: scenario('restart-empty')");
  expect(restartedEmpty).toContain('<PageStory visitor="Signed In" path="/library/logs?cursor=expired-epoch" />');
  expect(restartedEmpty).toContain('library_my_logs_restarted');
  expect(restartedEmpty).toContain('library_logs_empty');
  expect(restartedEmpty).toContain('library_my_logs_newest');
  expect(restartedEmpty).not.toContain('MyLogsPageView');
  expect(signedOutRecovery).toContain('supplemental view');
  expect(signedOutRecovery).toContain('<PatternStory visitor="Signed Out"');
  expect(signedOutRecovery).toContain("page={{ state: 'signed-out' }}");
});

test('restart-empty is a constructed FULL-recording consumer example: stale cursor then empty first page', async () => {
  setMyLogsStory('restart-empty');
  try {
    const stale = await listAnswer(
      `https://kernel.example.test/v1/publishedLogs?accountId=${storyViewerId}&cursor=expired-epoch`,
    );
    const first = await listAnswer(`https://kernel.example.test/v1/publishedLogs?accountId=${storyViewerId}`);
    expect(stale).toMatchObject({ status: 409, code: 'stale_cursor', headers: privateHeaders });
    expect(first).toEqual({ status: 200, publishedLogs: [], next: null, headers: privateHeaders });
    expect(myLogsStoryActivity()).toEqual({ listReads: 2, detailReads: 0, detailId: undefined });
    const { client, calls } = transport();
    expect(await loadMyPublishedLogs(client, request(), env, { cursor: 'expired-epoch' })).toEqual({
      signedIn: true,
      logs: [],
      next: null,
      restarted: true,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.searchParams.get('cursor')).toBe('expired-epoch');
    expect(calls[1]!.searchParams.has('cursor')).toBe(false);
    expect(JSON.stringify(calls.map((url) => url.searchParams.get('accountId')))).toBe(
      JSON.stringify([storyViewerId, storyViewerId]),
    );
  } finally {
    setMyLogsStory();
  }
});

test('a signed-out reader does not issue a published-log list when the ready example would return owner rows', async () => {
  setMyLogsStory('ready');
  try {
    const { client, calls } = transport();
    expect(await loadMyPublishedLogs(client, request(false), env, { cursor: 'expired-epoch' })).toEqual({
      signedIn: false,
      logs: [],
      next: null,
    });
    expect(calls).toHaveLength(0);
    expect(myLogsStoryActivity()).toEqual({ listReads: 0, detailReads: 0, detailId: undefined });
  } finally {
    setMyLogsStory();
  }
});
