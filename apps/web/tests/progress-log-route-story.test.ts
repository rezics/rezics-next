import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createKernelClient } from '@rezics/client';
import { createStoryRecordedKernelFetch, storyViewerId } from '../src/kernel/fake';
import {
  progressLogsStoryCursors as cursors,
  progressLogsStoryNote,
  setLibraryProgressLogsStory,
} from '../src/kernel/fake/library-progress-logs-story';
import recording from '../src/kernel/recorded/library-published-logs.json';
import { loadMyPublishedLogs } from '../src/library/logs-read';
import type { SessionEnv } from '../src/session/client';
import type { SessionStore } from '../src/session/store';

afterEach(() => setLibraryProgressLogsStory());

const story = readFileSync(new URL('../src/stories/progress-log-route.stories.tsx', import.meta.url), 'utf8');
const recordedNote = recording.publishedLogs[0]!.note;

function sessionEnv() {
  return {
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
          accessToken: 'story-owner-token',
          csrfToken: 'A'.repeat(22),
        }),
      }),
    } as unknown as DurableObjectNamespace<SessionStore>,
  } as Partial<SessionEnv>;
}

function pageRequest() {
  return new Request('https://site.example.test/en/library/progress/01a17a3b-70a2-712a-bae6-f4cc72cd9182', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
}

function listed(accountId: string, cursor?: string) {
  const url = new URL('http://kernel.local/v1/publishedLogs');
  url.searchParams.set('accountId', accountId);
  url.searchParams.set('view', 'FULL');
  url.searchParams.set('limit', '100');
  if (cursor) url.searchParams.set('cursor', cursor);
  return createStoryRecordedKernelFetch()(url);
}

async function body(accountId: string, cursor?: string) {
  return (await listed(accountId, cursor)).json() as Promise<{
    publishedLogs: Array<{ note: string | null; account: unknown; subject: unknown }>;
    next: string | null;
    code?: string;
  }>;
}

test('Progress log route stories enter the actual detail route and reset the opt-in fake', () => {
  expect(story).toContain("pagePaths['library-progress-session']");
  expect(story).toContain('<PageStory visitor="Signed In" path={path(logs)} />');
  expect(story).not.toContain('PatternStory');
  expect([...story.matchAll(/export const (\w+): Story/g)].map((match) => match[1])).toEqual([
    'LongUnavailableSummaries',
    'FirstEmpty',
    'LaterEmptyWithContinuation',
    'StaleCursorRestart',
  ]);
});

test('opt-in published log pages stay on the story account and cursors, then decline', async () => {
  setLibraryProgressLogsStory('long');
  const ours = await listed(storyViewerId);
  expect(ours.headers.get('cache-control')).toBe('private, no-store');
  const longPage = await ours.json();
  expect(longPage.publishedLogs[0]!.note).toBe(progressLogsStoryNote);
  expect(longPage.publishedLogs[1]).toMatchObject({ account: null, subject: null, note: null });
  expect(longPage.next).toBe(cursors.next);
  expect((await body('someone-else')).publishedLogs[0]!.note).toBe(recordedNote);
  expect((await body(storyViewerId, cursors.later)).publishedLogs[0]!.note).toBe(recordedNote);
  setLibraryProgressLogsStory();
  expect((await body(storyViewerId)).publishedLogs[0]!.note).toBe(recordedNote);
});

test('the viewer reader keeps exact notes, null summaries, empty continuation and stale-cursor restart', async () => {
  const client = createKernelClient('http://kernel.local', { fetch: createStoryRecordedKernelFetch() });
  const env = sessionEnv();
  setLibraryProgressLogsStory('empty');
  expect(await loadMyPublishedLogs(client, pageRequest(), env, {})).toMatchObject({
    signedIn: true,
    logs: [],
    next: null,
  });
  setLibraryProgressLogsStory('later-empty');
  const later = await loadMyPublishedLogs(client, pageRequest(), env, { cursor: cursors.later });
  expect(later).toMatchObject({ signedIn: true, logs: [], next: cursors.next });
  expect(later).not.toHaveProperty('restarted');
  setLibraryProgressLogsStory('long');
  const long = await loadMyPublishedLogs(client, pageRequest(), env, {});
  expect(long.logs[0]!.note).toBe(progressLogsStoryNote);
  expect(long.logs[1]).toMatchObject({ account: null, subject: null, note: null });
  expect(long.next).toBe(cursors.next);
  setLibraryProgressLogsStory('restart');
  const stale = await listed(storyViewerId, cursors.stale);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: 'stale_cursor' });
  const restarted = await loadMyPublishedLogs(client, pageRequest(), env, { cursor: cursors.stale });
  expect(restarted.restarted).toBe(true);
  expect(restarted.logs[0]!.note).toBe(recordedNote);
  expect(restarted.next).toBeNull();
});
