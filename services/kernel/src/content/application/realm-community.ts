import type {
  RealmCommunityBoard,
  RealmCommunityThread,
  RealmCommunitySelection,
  RealmCommunityPorts,
  RealmRecent,
} from '../contract/index.ts';

export function createRealmCommunity<
  D,
  C,
  B extends RealmCommunityBoard,
  T extends RealmCommunityThread,
  M,
  S extends RealmCommunitySelection,
>(ports: RealmCommunityPorts<D, C, B, T, M, S>) {
  return { observe };
  async function observe(deps: D, boards: readonly B[], context: C) {
    if (boards.length > 20) throw new RangeError('Realm community accepts at most twenty Boards');
    const observations = new Map<string, Awaited<ReturnType<typeof ports.recent>>>();
    for (const board of boards) {
      if (board.availability !== 'available') continue;
      observations.set(board.id, await ports.recent(deps, board.id, context));
    }
    const threads = [...observations.values()].flatMap((observation) => observation.threads);
    const activity = ports.activity(deps);
    const selected = await activity.select(
      threads.map((thread) => thread.id),
      context,
    );
    const boardById = new Map(boards.map((board) => [board.id, board]));
    const threadById = new Map(threads.map((thread) => [thread.id, thread]));
    for (const item of selected) {
      if (item.status !== 'current') continue;
      const thread = threadById.get(item.threadId);
      const board = thread && boardById.get(thread.boardId);
      if (
        !thread ||
        !board ||
        item.witness.boardId !== board.id ||
        item.witness.realmId !== board.realmId ||
        item.witness.threadSecurityRevision !== thread.securityRevision ||
        item.witness.boardSecurityRevision !== board.securityRevision
      )
        ports.unavailable();
    }
    const threadIds = threads.map((thread) => thread.id);
    const comments = ports.comments(threadIds, selected, context);
    const recent = new Map<string, RealmRecent<T, M>>();
    for (const [boardId, observation] of observations) {
      recent.set(boardId, {
        state: 'current',
        complete: observation.complete,
        threads: observation.threads.map((thread) => ({
          thread,
          target: { kind: 'thread', id: thread.id, boardId },
          comments: comments.get(thread.id) ?? { state: 'unavailable' },
        })),
      });
    }
    return {
      recent,
      async current() {
        for (const observation of observations.values()) if (!(await observation.current())) return false;
        const confirmed = await activity.confirm(selected, context);
        if (confirmed.some((item) => item.status === 'withheld' && item.reason === 'stale')) return false;
        return ports.same(comments, ports.comments(threadIds, confirmed, context));
      },
    };
  }
}
