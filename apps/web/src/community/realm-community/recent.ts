import * as v from 'valibot';

const id = v.pipe(v.string(), v.uuid());

const comments = v.union([
  v.strictObject({
    state: v.literal('current'),
    cohort: v.picklist(['public', 'viewer']),
    count: v.strictObject({
      kind: v.picklist(['exact', 'lower-bound']),
      value: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
    lastActivityAt: v.nullable(v.string()),
    source: v.strictObject({
      epoch: v.pipe(v.number(), v.integer(), v.minValue(1)),
      position: v.pipe(v.string(), v.minLength(1)),
    }),
  }),
  v.strictObject({ state: v.literal('unavailable') }),
]);

const thread = v.object({
  id,
  title: v.nullable(v.string()),
});

const recentPage = v.union([
  v.strictObject({
    state: v.literal('current'),
    complete: v.boolean(),
    threads: v.pipe(
      v.array(
        v.strictObject({
          thread,
          target: v.strictObject({ kind: v.literal('thread'), id, boardId: id }),
          comments,
        }),
      ),
      v.maxLength(3),
    ),
  }),
  v.strictObject({ state: v.literal('unavailable') }),
]);

export type RealmBoardRecentThread = {
  id: string;
  title: string | null;
  comments:
    | { state: 'current'; kind: 'exact' | 'lower-bound'; value: number }
    | { state: 'unavailable' };
};

export type RealmBoardRecent =
  | { state: 'current'; threads: readonly RealmBoardRecentThread[]; complete: boolean }
  | { state: 'unavailable' };

/** Native home/shelf recent prefix. Missing or mismatched fields stay unavailable, never an empty invention. */
export function presentRealmBoardRecent(value: unknown, boardId: string): RealmBoardRecent {
  const parsed = v.safeParse(recentPage, value);
  if (!parsed.success) return { state: 'unavailable' };
  if (parsed.output.state === 'unavailable') return { state: 'unavailable' };
  const threads = parsed.output.threads.flatMap((item) =>
    item.target.boardId === boardId && item.target.id === item.thread.id
      ? [
          {
            id: item.thread.id,
            title: item.thread.title,
            comments:
              item.comments.state === 'current'
                ? { state: 'current' as const, kind: item.comments.count.kind, value: item.comments.count.value }
                : { state: 'unavailable' as const },
          },
        ]
      : [],
  );
  if (threads.length !== parsed.output.threads.length) return { state: 'unavailable' };
  return { state: 'current', threads, complete: parsed.output.complete };
}
