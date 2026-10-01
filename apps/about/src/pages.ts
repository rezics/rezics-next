/** Every page of the site, in header order. `home` lives at the locale root. */
export const pageIds = [
  'home',
  'reading',
  'light-novels',
  'serial-fiction',
  'acgn',
  'wikis',
  'agents',
  'communities',
  'distribution',
  'developers',
  'trust',
  'roadmap',
] as const;
export type PageId = (typeof pageIds)[number];

/** The product lines the header lists, before Developers, Trust and Roadmap. */
export const productLineIds = [
  'reading',
  'light-novels',
  'serial-fiction',
  'acgn',
  'wikis',
  'agents',
  'communities',
  'distribution',
] as const satisfies readonly PageId[];

export const infoPageIds = ['developers', 'trust', 'roadmap'] as const satisfies readonly PageId[];

/** A policy page, `legal/<slug>` (see `src/legal/policies.ts`); not a product page, so not in `pageIds`. */
export type LegalPageId = `legal/${string}`;
/** Anything with a locale-prefixed path. */
export type RoutePage = PageId | LegalPageId;

/** The path segment of a page under its locale prefix; empty for Home. */
export function pageSlug(page: RoutePage): string {
  return page === 'home' ? '' : page;
}

export function pagePath(locale: string, page: RoutePage): string {
  return `/${locale}/${pageSlug(page)}${page === 'home' ? '' : '/'}`;
}

/** Locale-independent link targets. */
export const links = {
  source: 'https://github.com/rezics/rezics-next',
} as const;
