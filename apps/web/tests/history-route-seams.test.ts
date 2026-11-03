import { afterEach, expect, test } from 'bun:test';
import { isNotFound } from '@tanstack/react-router';
import { createKernelClient } from '@rezics/client';
import { routes, setMyLogsStory } from '../src/kernel/fake/my-logs';
import { storyViewerId } from '../src/kernel/fake/identities';
import recording from '../src/kernel/recorded/library-published-log.json';
import { loadMyPublishedLogs, loadPublishedLogCurrent } from '../src/library/logs-read';
import { loadProgressSession } from '../src/library/progress-reads';
import {
  routes as progressRoutes, originalHistoryCursors, originalHistoryUnit, setLibraryProgressStoryMode,
} from '../src/kernel/fake/library-progress-story';
import sessionRecording from '../src/kernel/recorded/library-progress-session.json';
import type { SessionEnv } from '../src/session/client';

afterEach(() => { setMyLogsStory(); setLibraryProgressStoryMode('recorded'); });
const env = {
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({ credential: async () => ({ status: 'active', subject: storyViewerId, accessToken: 'owner' }) }),
  },
} as unknown as Partial<SessionEnv>;
const ownerRequest = () => new Request('https://site.example.test/en/library/logs', {
  headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
});

function consumer() {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    async fetch(input, init) {
      const request = new Request(input, init);
      calls.push(request);
      const path = new URL(request.url).pathname;
      // Declining opt-in handlers fall through just as they do in the story transport.
      let answer;
      for (const route of [...progressRoutes, ...routes]) {
        if (typeof route.path === 'string' ? route.path !== path : !route.path.test(path)) continue;
        answer = await route.story?.({
          request,
          recordings: {},
          match: route.path instanceof RegExp ? path.match(route.path) : null,
        });
        if (answer) break;
      }
      if (!answer) throw new Error(`Unexpected request: ${request.method} ${path}`);
      const { status = 200, headers, ...body } = answer;
      return Response.json(body, { status, headers: headers as HeadersInit });
    },
  });
  return { client, calls };
}

test('owner history can restart from a stale position into an honestly empty newest page', async () => {
  setMyLogsStory('restart-empty');
  const { client, calls } = consumer();
  expect(await loadMyPublishedLogs(client, ownerRequest(), env, { cursor: 'expired-epoch' })).toEqual({
    signedIn: true, logs: [], next: null, restarted: true,
  });
  expect(calls.map((call) => new URL(call.url).searchParams.get('cursor'))).toEqual(['expired-epoch', null]);
});

test('original history retains exact sparse keys and independently requested empty pages', async () => {
  setLibraryProgressStoryMode('original-history');
  const { client, calls } = consumer();
  const id = sessionRecording.progressSession.id;
  const first = await loadProgressSession(client, ownerRequest(), env, { id });
  expect(first.signedIn).toBe(true);
  if (!first.signedIn) throw new Error('Owner history did not load');
  expect(first.session).toMatchObject({
    meaning: 'unknown', recordingState: 'unavailable', completedUnitCount: 3,
    units: [originalHistoryUnit, 'original-3', 'original-7'],
    changesNext: originalHistoryCursors.changes, unitsNext: originalHistoryCursors.units,
  });
  expect(first.session.changes).toHaveLength(12);
  const later = await loadProgressSession(client, ownerRequest(), env, { id, ...originalHistoryCursors });
  expect(later).toMatchObject({ changesCursor: originalHistoryCursors.changes, unitsCursor: originalHistoryCursors.units,
    session: { changes: [], units: [], changesNext: null, unitsNext: null } });
  expect(calls.slice(-2).map((call) => new URL(call.url).searchParams.get('cursor'))).toEqual([
    originalHistoryCursors.changes, originalHistoryCursors.units,
  ]);
  expect(await loadMyPublishedLogs(client, ownerRequest(), env, { cursor: originalHistoryCursors.logs }))
    .toMatchObject({ logs: [], next: null });
  expect(new URL(calls.at(-1)!.url).searchParams.get('cursor')).toBe(originalHistoryCursors.logs);
});

test('public refusal and withdrawal expose no snapshot; an explicit reread can recover without owner controls', async () => {
  const request = () => new Request('https://site.example.test/en/logs/' + recording.publishedLog.id);
  for (const scenario of ['public-refused', 'public-withdrawn', 'public-recovery'] as const) {
    setMyLogsStory(scenario);
    const { client, calls } = consumer();
    const read = () => loadPublishedLogCurrent(client, request(), {}, { id: recording.publishedLog.id });
    const failure = await read().then(() => null, (error: unknown) => error);
    expect(failure).not.toBeNull();
    expect(isNotFound(failure)).toBe(scenario === 'public-withdrawn');
    expect(calls).toHaveLength(1);
    if (scenario === 'public-recovery') {
      expect(await read()).toMatchObject({ isOwner: false, owner: null, log: { id: recording.publishedLog.id } });
      expect(calls).toHaveLength(2);
    }
    expect(calls.every((call) => call.method === 'GET' && !call.headers.has('authorization'))).toBe(true);
  }
});
