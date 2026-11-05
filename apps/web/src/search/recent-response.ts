import * as v from 'valibot';
import { admitsRecentDestination, recentReplayDestination } from './recent-replay';
export { recentScopePath } from './recent-replay';
import type { RecentEntry, RecentItem, RecentPage } from './recent';

const id = v.pipe(v.string(), v.uuid());
const revision = v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(2_147_483_646));
const language = v.pipe(v.string(), v.minLength(1), v.maxLength(35), v.regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/));
const cover = v.nullable(
  v.strictObject({
    media: id,
    width: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    height: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    placeholder: v.strictObject({ thumbhash: v.string(), color: v.string() }),
    variants: v.array(
      v.strictObject({
        format: v.picklist(['avif', 'webp']),
        width: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
      }),
    ),
    focalPoint: v.nullable(v.strictObject({ x: v.pipe(v.number(), v.finite()), y: v.pipe(v.number(), v.finite()) })),
    credit: v.strictObject({
      rightsHolder: v.string(),
      via: v.strictObject({ name: v.string(), url: v.string() }),
      license: v.string(),
      obligations: v.array(v.string()),
    }),
  }),
);
const recentScope = v.variant('kind', [
  v.strictObject({ kind: v.literal('realm'), id }),
  v.strictObject({ kind: v.literal('collection'), id }),
  v.strictObject({ kind: v.literal('route'), route: v.literal('library') }),
]);
const recentEntry = v.variant('kind', [
  v.strictObject({
    kind: v.literal('query'),
    text: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
    languages: v.exactOptional(v.pipe(v.array(language), v.maxLength(8))),
    scope: v.exactOptional(recentScope),
  }),
  v.strictObject({ kind: v.literal('scope'), scope: recentScope }),
]);
const pageSchema = v.strictObject({
  recentSearches: v.array(
    v.strictObject({
      id,
      lastUsed: v.string(),
      revision,
      entry: recentEntry,
      display: v.nullable(v.strictObject({ name: v.string(), href: v.string(), avatar: cover })),
    }),
  ),
  next: v.nullable(v.string()),
  revision,
});

function nativeQuery(entry: RecentEntry): boolean {
  if (entry.kind !== 'query') return true;
  const languages = entry.languages;
  return (
    entry.text.trim() === entry.text &&
    !entry.text.includes('\0') &&
    (!languages || new Set(languages).size === languages.length)
  );
}

/** Admit a complete native Recent page before reconciliation. Partial rows never succeed. */
export function admitRecentPage(value: unknown): RecentPage | undefined {
  const parsed = v.safeParse(pageSchema, value);
  if (!parsed.success) return;
  for (const item of parsed.output.recentSearches) {
    if (
      !Number.isFinite(Date.parse(item.lastUsed)) ||
      !nativeQuery(item.entry) ||
      (item.display !== null && !admitsRecentDestination(item.entry, item.display.href))
    )
      return;
  }
  return parsed.output;
}

export function recentItemAction(item: RecentItem): string | undefined {
  return item.display && admitsRecentDestination(item.entry, item.display.href)
    ? recentReplayDestination(item.entry)
    : undefined;
}
