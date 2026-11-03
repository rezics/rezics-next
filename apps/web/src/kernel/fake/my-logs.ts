import type { FakeRoute } from '../fake-modules';
import { storyViewerId } from '../fake';
import recording from '../recorded/library-published-logs.json';

export type MyLogsScenario =
  | 'ready'
  | 'empty'
  | 'long'
  | 'unknown'
  | 'denied'
  | 'unavailable'
  | 'preparing'
  | 'restart'
  | 'restart-empty'
  | 'public-refused'
  | 'public-withdrawn'
  | 'public-recovery';
let scenario: MyLogsScenario | undefined;
let listReads = 0;
let detailReads = 0;
let detailId: string | undefined;

const noteEnding = '\n<em>Original note ending</em>';
export const longPublishedLogNote =
  `${'AnUnbrokenPublishedNote'.repeat(20)}\n${'長い読書記録沒有空格'.repeat(40)}`.padEnd(
    1000 - noteEnding.length,
    '記',
  ) + noteEnding;

/** Consumer fixture observations, not authorization evidence. */
export function myLogsStoryActivity() {
  return { listReads, detailReads, detailId };
}

function firstLog() {
  const log = { ...recording.publishedLogs[0]!, accountId: storyViewerId };
  return scenario === 'long'
    ? {
        ...log,
        subject: {
          ...log.subject,
          label:
            'A very long published reading snapshot title with many words about an unexpectedly lengthy journey through a summer of books and memories',
        },
        note: longPublishedLogNote,
      }
    : log;
}

/** Opt-in consumer examples derived from the existing FULL recording; no native authorization claims.
 * `restart-empty` is a constructed stale-cursor then empty first-page example for route presentation. */
export function setMyLogsStory(value?: MyLogsScenario) {
  scenario = value;
  listReads = 0;
  detailReads = 0;
  detailId = undefined;
}

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: '/v1/publishedLogs',
    story: ({ request }) => {
      if (!scenario) return undefined;
      listReads += 1;
      const query = new URL(request.url).searchParams;
      if (query.get('accountId') !== storyViewerId) return { status: 403, code: 'forbidden' };
      const headers = { 'cache-control': 'private, no-store' };
      if (scenario === 'denied') return { status: 403, code: 'forbidden', headers };
      if (scenario === 'unavailable') return { status: 503, code: 'dependency_unavailable', headers };
      if (scenario === 'preparing') return { status: 202, preparing: true, headers };
      if ((scenario === 'restart' || scenario === 'restart-empty') && query.has('cursor'))
        return { status: 409, code: 'stale_cursor', headers };
      if (scenario === 'empty' || scenario === 'restart-empty')
        return { status: 200, publishedLogs: [], next: null, headers };
      const log = firstLog();
      const logs = [
        log,
        {
          ...log,
          id: '01a17a3b-70dd-709a-b040-f4cc8099977c',
          sessionState: 'completed',
          completedAt: log.startedAt,
          note: scenario === 'long' ? 'Another published note.\n'.repeat(30) : null,
          subject: null,
        },
        {
          ...log,
          id: '01a17a3b-70dd-709a-b040-f4cc8099977d',
          sessionState: 'abandoned',
          subject: { ...log.subject, cover: null },
        },
      ];
      if (scenario === 'unknown') for (const item of logs) item.subject = null;
      const older = query.get('cursor') === 'story-older-page';
      return {
        status: 200,
        publishedLogs: older ? [logs[2]!] : logs.slice(0, 2),
        next: older || scenario === 'restart' ? null : 'story-older-page',
        headers,
      };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/publishedLogs\/([^/]+)$/,
    story: ({ match }) => {
      if ((!scenario?.startsWith('public-') && scenario !== 'long') || match?.[1] !== firstLog().id) return undefined;
      detailReads += 1;
      detailId = match[1];
      const headers = { 'cache-control': 'private, no-store' };
      if (scenario === 'public-refused') return { status: 403, code: 'forbidden', headers };
      if (scenario === 'public-withdrawn')
        return { status: 200, publishedLog: { id: detailId, deleted: true }, headers };
      if (scenario === 'public-recovery' && detailReads === 1)
        return { status: 503, code: 'dependency_unavailable', headers };
      return {
        status: 200,
        publishedLog: firstLog(),
        headers: { 'cache-control': 'private, no-store', 'Library-Published-Log-Revision': '1' },
      };
    },
  },
];
