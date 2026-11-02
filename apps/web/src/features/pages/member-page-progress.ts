/** Match the paged Members native cap; history never grows with the traversal. */
export const MEMBER_CURSOR_HISTORY_LIMIT = 12;

export function memberPageCursor(body: Record<string, unknown>): string | undefined {
  return typeof body.next === 'string' && body.next.length > 0 ? body.next : undefined;
}

/** Recent repeats are immediate; a Brent checkpoint also detects cycles longer than the recent history. */
export function createMemberPageProgress(initial?: string) {
  const recent = initial ? [initial] : [];
  let checkpoint = initial;
  let span = 1;
  let distance = 0;
  return {
    accept(next?: string): boolean {
      if (!next) return true;
      if (next === checkpoint || recent.includes(next)) return false;
      distance++;
      if (!checkpoint || distance === span) {
        checkpoint = next;
        // Bound both counters even for an indefinitely advancing stream.
        span = Math.min(span * 2, Number.MAX_SAFE_INTEGER);
        distance = 0;
      }
      recent.push(next);
      if (recent.length > MEMBER_CURSOR_HISTORY_LIMIT) recent.shift();
      return true;
    },
    get retainedCursors() {
      return recent.length + (checkpoint && !recent.includes(checkpoint) ? 1 : 0);
    },
  };
}
