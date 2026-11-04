/** How lively a thread is, when the kernel's thread read says so. */
export type ThreadActivity = { replyCount: number | null; lastActivityAt: string | null };
export type ConversationReplyCount = { kind: 'exact' | 'lower-bound'; value: number };
export type ConversationActivityDisplay =
  | { state: 'current'; count: ConversationReplyCount; lastActivityAt: string | null }
  | { state: 'withheld' }
  | { state: 'unavailable'; retryable: true };

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

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read the native page field while the complete-input publisher emits its installed client type. */
export function conversationActivity(value: unknown): ConversationActivityDisplay {
  if (!record(value)) return { state: 'withheld' };
  if (value.state === 'withheld') return { state: 'withheld' };
  if (value.state === 'unavailable' && value.retryable === true) return { state: 'unavailable', retryable: true };
  if (value.state !== 'current' || !record(value.count)) return { state: 'withheld' };
  const { kind, value: count } = value.count;
  const lastActivityAt = value.lastActivityAt;
  if (
    (kind !== 'exact' && kind !== 'lower-bound') ||
    (value.cohort !== undefined && value.cohort !== 'public') ||
    !Number.isSafeInteger(count) ||
    (count as number) < 0 ||
    (lastActivityAt !== null && (typeof lastActivityAt !== 'string' || !Number.isFinite(Date.parse(lastActivityAt))))
  )
    return { state: 'withheld' };
  return { state: 'current', count: { kind, value: count as number }, lastActivityAt: lastActivityAt as string | null };
}

/** Minimal adapter for the feed summary emitted by the native source contract. */
export function feedConversationActivity(summary: unknown): ConversationActivityDisplay {
  return conversationActivity(record(summary) ? summary.conversationActivity : undefined);
}

/** Additive activity on the existing native page uses the same closed display rules as Feed. */
export function readingConversationActivity(page: unknown): ConversationActivityDisplay {
  if (!record(page) || !Object.hasOwn(page, 'conversationActivity'))
    return { state: 'unavailable', retryable: true };
  return conversationActivity(page.conversationActivity);
}

export function formatConversationReplyCount(count: ConversationReplyCount, locale: string): string {
  return `${new Intl.NumberFormat(locale).format(count.value)}${count.kind === 'lower-bound' ? '+' : ''}`;
}
