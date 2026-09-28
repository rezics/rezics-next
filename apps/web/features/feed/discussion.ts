// How a discussion reads. Main keeps no thread title or spoiler flag: people
// write the title as the first line, and announce spoilers there ("【剧透】…",
// "Spoilers (chapter 35): …"), as on forums. These functions only read that
// convention; they never invent a title, flair or flag the author did not write.

/** The longest title a card or thread heading shows; the rest stays in the body. */
const TITLE_CHARS = 300;

/** The author's first line as the title and the rest as the body. */
export function discussionText(text: string): { title: string; body: string } {
  const trimmed = text.trim();
  const end = trimmed.indexOf('\n');
  const first = (end < 0 ? trimmed : trimmed.slice(0, end)).trim();
  const rest = end < 0 ? '' : trimmed.slice(end + 1).trim();
  const chars = Array.from(first);
  if (chars.length <= TITLE_CHARS) return { title: first, body: rest };
  // A first line too long for a title keeps its opening as the title and loses nothing.
  return { title: `${chars.slice(0, TITLE_CHARS).join('')}…`, body: [chars.slice(TITLE_CHARS).join(''), rest]
    .filter(Boolean).join('\n') };
}

// A spoiler announcement at the start of the title, bracketed or not.
const spoilerMark = /^\s*[【[(（「『]?\s*(?:剧透|劇透|ネタバレ|스포일러|spoilers?\b|spoiler alert\b)/iu;

/** Whether the author announced spoilers in the title, so the body stays veiled until the reader asks. */
export function announcesSpoilers(title: string): boolean {
  return spoilerMark.test(title);
}

/** A thread's page: `/r/{realm}/discussions/{reply}`, under the Realm's Zone segment when it has one. */
export function threadPath(realmPath: string, reply: string): string {
  return `${realmPath}/discussions/${reply.slice(-36)}`;
}
