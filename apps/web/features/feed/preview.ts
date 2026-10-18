import type { FeedItem } from './types.ts';

// Only recognize a repeated heading. A sentence such as "Middlemarch explores
// provincial life" is body text and must keep its subject. Imported previews
// can flatten the title and an Ingredients heading onto a single line.
function withoutHeading(excerpt: string | null, title: string): string | null {
  const text = excerpt?.trim();
  const heading = title.trim();
  if (!text || /^Ingredients\s*:?$/u.test(text)) return null;
  if (!heading || !text.startsWith(heading)) return text;
  const rest = text.slice(heading.length);
  if (!rest.trim()) return null;
  if (!/^(?:\s*\n|\s*[:：|—–]|\s+Ingredients(?:\s|:|$))/u.test(rest)) return text;
  const body = rest.replace(/^[\s:：|—–]+/u, '')
    .replace(/^Ingredients(?:[\t ]*:\s*|[\t ]*\r?\n\s*|\s+(?=[\p{Lu}\p{N}•-])|$)/u, '').trim();
  return body || null;
}

export function feedExcerpt(item: FeedItem): string | null {
  const { card } = item;
  if (card.kind === 'chapter' && card.excerpt) return card.excerpt;
  if (card.kind === 'release' && card.changelogExcerpt) return card.changelogExcerpt;
  return withoutHeading(item.target.excerpt, item.target.title.value);
}
