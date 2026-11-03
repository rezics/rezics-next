import type { FakeRoute } from '../fake-modules';
import { storyViewerId } from './identities';
import recording from '../recorded/library-published-logs.json';

/** Opt-in Progress-detail published-log pages. Constructed presentation, not native authorization. */
export type LibraryProgressLogsStory = 'long' | 'empty' | 'later-empty' | 'restart';

export const progressLogsStoryCursors = {
  changes: 'changes/original+?=&二%',
  units: 'units/original+== &三%',
  later: 'logs/later+?=&四%',
  next: 'logs/next+?=&五%',
  stale: 'logs/stale+?=&六%',
} as const;

export const progressLogsStoryNote = `  An original note with preserved spacing.\n\n${'unbroken_note_二'.repeat(50)}\n  <literal text & punctuation>  `;

const privateHeaders = { 'cache-control': 'private, no-store' };
let mode: LibraryProgressLogsStory | undefined;

export function setLibraryProgressLogsStory(value?: LibraryProgressLogsStory) {
  mode = value;
}

function snapshot() {
  return { ...recording.publishedLogs[0]!, accountId: storyViewerId };
}

function page(publishedLogs: unknown[], next: string | null) {
  return { status: 200, publishedLogs, next, headers: privateHeaders };
}

function answer(request: Request) {
  if (!mode) return undefined;
  const query = new URL(request.url).searchParams;
  if (query.get('accountId') !== storyViewerId) return undefined;
  const cursor = query.get('cursor');
  if (mode === 'empty') return cursor ? undefined : page([], null);
  if (mode === 'later-empty')
    return cursor === progressLogsStoryCursors.later ? page([], progressLogsStoryCursors.next) : undefined;
  if (mode === 'restart') {
    if (cursor === progressLogsStoryCursors.stale) return { status: 409, code: 'stale_cursor', headers: privateHeaders };
    return cursor ? undefined : page([snapshot()], null);
  }
  if (cursor) return undefined;
  const recorded = snapshot();
  const longLog = {
    ...recorded,
    account: {
      ...recorded.account,
      displayName: 'A very long account name '.repeat(10),
      handle: 'unbroken_account_handle'.repeat(12),
    },
    note: progressLogsStoryNote,
  };
  return page(
    [
      longLog,
      { ...recorded, id: '01a17a3b-70dd-709a-b040-f4cc8099977e', account: null, subject: null, note: null },
      { ...longLog, id: '01a17a3b-70dd-709a-b040-f4cc8099977f' },
    ],
    progressLogsStoryCursors.next,
  );
}

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: '/v1/publishedLogs',
    story: ({ request }) => answer(request),
  },
];
