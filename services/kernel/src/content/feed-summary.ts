import { documentText } from '@rezics/document';
import type { PostEntry } from './reads.ts';
import type { AccountDiscoverySummary } from '../search/index.ts';
import type { FeedAuthor } from './feed-contract.ts';

export const FEED_EXCERPT_LIMIT = 160;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Only native disclosed bytes enter the projection. Mentions use the native text fallback. */
export function feedExcerpt(entry: Pick<PostEntry, 'availability' | 'body'>): string | undefined {
  if (entry.availability !== 'available' || !entry.body) return;
  const text = documentText(entry.body).replace(/\s+/gu, ' ').trim();
  let excerpt = '';
  let length = 0;
  for (const { segment } of graphemes.segment(text)) {
    const width = [...segment].length;
    if (length + width > FEED_EXCERPT_LIMIT) break;
    excerpt += segment;
    length += width;
  }
  return excerpt || undefined;
}

/** Account IDs and absent owner summaries never become identity labels. */
export function feedAuthor(account: AccountDiscoverySummary | null | undefined): FeedAuthor | undefined {
  if (!account) return;
  return { displayName: account.displayName, handle: account.handle, avatar: account.avatar };
}
