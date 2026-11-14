export const BOOK_CATALOGUE_PREDECESSORS = 8;

/** Public discovery operands only; the route binds their Subject, locale and credential lifetime. */
export type BookCatalogueCoordinate = Readonly<{ cursor: string | null }>;
export type BookCatalogueReturn = BookCatalogueCoordinate & Readonly<{ subjectId: string }>;
type Movement = 'next' | 'exact' | 'first';
type Staged = BookCatalogueCoordinate & Readonly<{ movement: Movement; from: BookCatalogueCoordinate | null }>;
type Window = Readonly<{
  pages: readonly BookCatalogueCoordinate[];
  current: BookCatalogueCoordinate | null;
  staged: Staged | null;
}>;

/** Eight predecessors plus the current/staged coordinates. No rows, response cache or inferred cursors. */
export function createBookCatalogueNavigation() {
  let scope: string | null = null;
  let generation = 0;
  let window: Window = { pages: [], current: null, staged: null };
  const retire = () => {
    generation += 1;
    scope = null;
    window = { pages: [], current: null, staged: null };
  };
  return {
    getSnapshot: () => window,
    generation: () => generation,
    retire,
    bind(identity: string) {
      if (scope !== null && scope !== identity) retire();
      scope = identity;
    },
    stage(cursor: string | null, movement: Movement = 'exact') {
      window = { ...window, staged: { cursor, movement, from: window.current } };
    },
    observe(cursor: string | null) {
      const target = { cursor };
      const staged = window.staged?.cursor === cursor ? window.staged : null;
      let pages = window.pages;
      if (staged?.movement === 'first') pages = [target];
      else if (staged?.movement === 'next' && staged.from) {
        const index = pages.findIndex((page) => page.cursor === staged.from!.cursor);
        pages = [...(index >= 0 ? pages.slice(0, index + 1) : [staged.from]), target].slice(
          -(BOOK_CATALOGUE_PREDECESSORS + 1),
        );
      } else if (!pages.some((page) => page.cursor === cursor)) {
        // Reload/direct entry starts here. Browser Back/Forward can reuse an already observed position.
        pages = [target];
      }
      window = { pages, current: target, staged: null };
    },
    previous(cursor: string | null): BookCatalogueCoordinate | null {
      const index = window.pages.findIndex((page) => page.cursor === cursor);
      return index > 0 ? window.pages[index - 1]! : null;
    },
  };
}

/** A first-page return needs its own marker: absence of a cursor alone is not chooser evidence. */
export function bookCatalogueReturn(search: {
  subject?: string | undefined;
  catalogueReturn?: '1' | undefined;
  catalogueCursor?: string | undefined;
}): BookCatalogueReturn | null {
  return search.subject && search.catalogueReturn === '1'
    ? { subjectId: search.subject, cursor: search.catalogueCursor ?? null }
    : null;
}

/** Add independent chooser operands without changing the reader's release, occurrence or contents grammar. */
export function withBookCatalogueReturn(href: string, origin: BookCatalogueReturn | null): string {
  if (!origin) return href;
  const [path, query] = href.split('?');
  const search = new URLSearchParams(query);
  search.set('subject', origin.subjectId);
  search.set('catalogueReturn', '1');
  if (origin.cursor !== null) search.set('catalogueCursor', origin.cursor);
  else search.delete('catalogueCursor');
  return `${path}?${search}`;
}
