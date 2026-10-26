/** How lively a thread is, when the kernel's thread read says so. */
export type ThreadActivity = { replyCount: number | null; lastActivityAt: string | null };

/**
 * The reply count and last activity time of a thread row. The kernel adds them to thread reads as `replyCount` and
 * `lastActivityAt`; a row without them shows neither rather than a guess.
 */
export function threadActivity(thread: object): ThreadActivity {
  const { replyCount, lastActivityAt } = thread as { replyCount?: unknown; lastActivityAt?: unknown };
  return {
    replyCount:
      typeof replyCount === 'number' && Number.isSafeInteger(replyCount) && replyCount >= 0 ? replyCount : null,
    lastActivityAt:
      typeof lastActivityAt === 'string' && !Number.isNaN(Date.parse(lastActivityAt)) ? lastActivityAt : null,
  };
}
