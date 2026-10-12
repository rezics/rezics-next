/** One reply posted through the product Realm reply commands. */
export interface PostedRealmReply {
  reply: string;
  revision: string;
  placement?: string;
}

interface TimedRealmThread {
  reply: string;
  placement: string;
  score: number;
  occurred_at: Date;
}

/** Use the replies' recorded build timestamps, rather than assuming a retained
 * backup is still inside Top's seven-day or thirty-day window. */
export function realmTopWindow<T extends TimedRealmThread>(
  rows: readonly T[],
  period: 'week' | 'month' | 'all',
  now: Date,
): T[] {
  const duration = period === 'week' ? 7 * 86_400_000 : 30 * 86_400_000;
  return rows
    .filter((row) => period === 'all' || row.occurred_at.getTime() + duration > now.getTime())
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.occurred_at.getTime() - a.occurred_at.getTime() ||
        a.placement.localeCompare(b.placement),
    );
}

/**
 * Seed replies the way a reader does. `post` runs the Realm reply command
 * (draft, identity, review, and placement). The projector writes the slots,
 * placements, and ranking rows; nothing here inserts them.
 * A chain is serial because each reply names the one before it. Independent
 * replies are serial too: each placement claims the dataset sequence.
 */
export async function growRealmThreads(
  post: (key: string, parent?: { reply: string; revision: string }) => Promise<PostedRealmReply>,
  count: number,
  options: {
    parent?: { reply: string; revision: string; chain: boolean };
    keyPrefix?: string;
    /** Continue a resumed corpus. Keys stay `${prefix}:${startIndex + index}`. */
    startIndex?: number;
  } = {},
): Promise<PostedRealmReply[]> {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid reply seed count');
  const startIndex = options.startIndex ?? 0;
  if (!Number.isSafeInteger(startIndex) || startIndex < 0)
    throw new Error('Invalid reply seed index');
  const started = performance.now();
  const replies: PostedRealmReply[] = [];
  let cursor = options.parent
    ? { reply: options.parent.reply, revision: options.parent.revision }
    : undefined;
  for (let index = 0; index < count; index++) {
    const parent = options.parent
      ? options.parent.chain
        ? cursor
        : { reply: options.parent.reply, revision: options.parent.revision }
      : undefined;
    const posted = await post(
      `${options.keyPrefix ?? 'realm-reply'}:${startIndex + index}`,
      parent,
    );
    replies.push(posted);
    if (options.parent?.chain) cursor = { reply: posted.reply, revision: posted.revision };
    if ((index + 1) % 100 === 0 || index + 1 === count) {
      const elapsedMs = performance.now() - started;
      console.log(
        JSON.stringify({
          realmReplySeed: {
            count: index + 1,
            total: count,
            elapsedMs: Math.round(elapsedMs),
            perReplyMs: Math.round(elapsedMs / (index + 1)),
          },
        }),
      );
    }
  }
  return replies;
}
