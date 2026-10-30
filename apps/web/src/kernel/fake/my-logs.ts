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
  | 'restart';
let scenario: MyLogsScenario | undefined;

/** Opt-in consumer examples derived from the existing FULL recording; no native authorization claims. */
export function setMyLogsStory(value?: MyLogsScenario) {
  scenario = value;
}

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: '/v1/publishedLogs',
    story: ({ request }) => {
      if (!scenario) return undefined;
      const query = new URL(request.url).searchParams;
      if (query.get('accountId') !== storyViewerId) return { status: 403, code: 'forbidden' };
      const headers = { 'cache-control': 'private, no-store' };
      if (scenario === 'denied') return { status: 403, code: 'forbidden', headers };
      if (scenario === 'unavailable') return { status: 503, code: 'dependency_unavailable', headers };
      if (scenario === 'preparing') return { status: 202, preparing: true, headers };
      if (scenario === 'restart' && query.has('cursor')) return { status: 409, code: 'stale_cursor', headers };
      if (scenario === 'empty') return { status: 200, publishedLogs: [], next: null, headers };
      const log = { ...recording.publishedLogs[0]!, accountId: storyViewerId };
      const logs = [
        log,
        {
          ...log,
          id: '01a17a3b-70dd-709a-b040-f4cc8099977c',
          sessionState: 'completed',
          completedAt: log.startedAt,
          note: null,
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
      if (scenario === 'long') {
        logs[0] = {
          ...log,
          subject: {
            ...log.subject,
            label:
              'A very long published reading snapshot title with many words about an unexpectedly lengthy journey through a summer of books and memories',
          },
          note: 'AnUnbrokenPublishedNote'.repeat(45),
        };
      }
      const older = query.get('cursor') === 'story-older-page';
      return {
        status: 200,
        publishedLogs: older ? [logs[2]!] : logs.slice(0, 2),
        next: older || scenario === 'restart' ? null : 'story-older-page',
        headers,
      };
    },
  },
];
