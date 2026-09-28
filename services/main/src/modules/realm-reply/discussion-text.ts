// A discussion is a reply that answers no other, and Main keeps no separate
// thread title: people write the title as its first line, as on forums. Every
// read that shows a discussion splits it here, so Home, a Realm's list and the
// thread agree on what its title is.

/** The longest title a discussion shows; a longer first line continues in the body. */
export const DISCUSSION_TITLE_CHARS = 300;

/** The author's first line as the title and the rest as the body, losing no word. */
export function discussionParts(text: string): { title: string; body: string } {
  const trimmed = text.trim();
  const end = trimmed.indexOf('\n');
  const first = (end < 0 ? trimmed : trimmed.slice(0, end)).trim();
  const rest = end < 0 ? '' : trimmed.slice(end + 1).trim();
  const chars = Array.from(first);
  if (chars.length <= DISCUSSION_TITLE_CHARS) return { title: first, body: rest };
  return { title: `${chars.slice(0, DISCUSSION_TITLE_CHARS).join('')}…`,
    body: [chars.slice(DISCUSSION_TITLE_CHARS).join(''), rest].filter(Boolean).join('\n') };
}

/** At most `limit` characters, counted as people read them rather than as UTF-16 units. */
export function clip(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length <= limit ? text : chars.slice(0, limit).join('');
}
