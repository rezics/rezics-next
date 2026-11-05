import type { KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';

function record<T extends Record<string, unknown>>(value: KernelRecording | undefined, key: string): T | undefined {
  const resource = value?.[key];
  return resource && typeof resource === 'object' && !Array.isArray(resource) ? (resource as T) : undefined;
}

function historyRecords(recordings: Record<string, KernelRecording>) {
  const thread = record(recordings['thread-history-thread'], 'thread');
  const post = (recordings['thread-history-posts']?.posts as Record<string, unknown>[] | undefined)?.[0];
  const board = record(recordings['thread-history-board'], 'board');
  const realm = record(recordings['thread-history-realm'], 'realm');
  const authorIds = new Set(
    (recordings['thread-history-revisions']?.revisions as Record<string, unknown>[] | undefined)?.flatMap((revision) =>
      typeof revision.authorId === 'string' ? [revision.authorId] : [],
    ) ?? [],
  );
  return {
    threadId: typeof thread?.id === 'string' ? thread.id : undefined,
    postId: typeof post?.id === 'string' ? post.id : undefined,
    boardId: typeof board?.id === 'string' ? board.id : undefined,
    realmId: typeof realm?.realmId === 'string' ? realm.realmId : undefined,
    authorIds,
  };
}

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: /^\/v1\/threads\/([^/]+)$/,
    story: ({ recordings, match }) => {
      const { threadId } = historyRecords(recordings);
      return match?.[1] === threadId ? recordings['thread-history-thread'] : undefined;
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/threads\/([^/]+)\/posts$/,
    story: ({ recordings, match }) => {
      const { threadId } = historyRecords(recordings);
      return match?.[1] === threadId ? recordings['thread-history-posts'] : undefined;
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/posts\/([^/]+)\/revisions$/,
    story: ({ recordings, match }) => {
      const { postId } = historyRecords(recordings);
      return match?.[1] === postId ? recordings['thread-history-revisions'] : undefined;
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/boards\/([^/]+)$/,
    story: ({ recordings, match }) => {
      const { boardId } = historyRecords(recordings);
      return match?.[1] === boardId ? recordings['thread-history-board'] : undefined;
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/realms\/([^/]+)$/,
    story: ({ recordings, match }) => {
      const { realmId } = historyRecords(recordings);
      return match?.[1] === realmId ? recordings['thread-history-realm'] : undefined;
    },
  },
  {
    method: 'GET',
    path: '/v1/accounts',
    story: ({ recordings, request }) => {
      const accounts = recordings['thread-history-accounts']?.accounts;
      if (!Array.isArray(accounts)) return undefined;
      const query = new URL(request.url).searchParams;
      const ids = query.get('ids')?.split(',');
      if (!ids) return undefined;
      const { authorIds } = historyRecords(recordings);
      if (!ids.some((id) => authorIds.has(id))) return undefined;
      return {
        ...recordings['thread-history-accounts']!,
        accounts: (accounts as Record<string, unknown>[]).filter(
          (account) => typeof account.id === 'string' && ids.includes(account.id),
        ),
      };
    },
  },
];
