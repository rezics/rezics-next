import type { loadBoardPageWithAuthors } from '../identity/page-loaders';

export type CommunityBoardPage = Awaited<ReturnType<typeof loadBoardPageWithAuthors>>;
export type BoardFeedThread = CommunityBoardPage['threads']['threads'][number];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only the already-disclosed document's text nodes, never attributes, links, media ids or hidden bodies. */
export function boardThreadPreview(thread: BoardFeedThread): string | null {
  if (thread.availability !== 'available' || thread.firstPost.availability !== 'available') return null;
  const body: unknown = thread.firstPost.body;
  if (!record(body) || !record(body.doc)) return null;
  const pending: unknown[] = [body.doc];
  const words: string[] = [];
  let length = 0;
  // The native document is bounded; this smaller window also bounds work for a preview.
  for (let visited = 0; pending.length && visited < 128 && length < 280; visited += 1) {
    const node = pending.pop();
    if (!record(node)) continue;
    if (node.type === 'text' && typeof node.text === 'string') {
      const text = node.text
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 280 - length);
      if (text) {
        words.push(text);
        length += text.length + 1;
      }
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content.slice(0, Math.max(0, 127 - visited - pending.length)).reverse())
        pending.push(child);
    }
  }
  return words.length ? words.join(' ').slice(0, 280) : null;
}

/** An omitted aggregate makes no zero claim. Do not substitute opening-post counts for thread counts. */
export function boardThreadReactionCount(thread: BoardFeedThread): number | null {
  if (thread.availability !== 'available' || thread.reactions === undefined) return null;
  const values = Object.values(thread.reactions);
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : null;
}
