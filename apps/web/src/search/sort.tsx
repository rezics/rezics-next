import { m } from '../paraglide/messages.js';

/** A single search sort selector that preserves the query and filters while starting a fresh cursor. */
export function SearchSort({
  sort,
  locale,
  query,
  type,
  facets,
}: {
  sort: 'relevance' | 'rating';
  locale: string;
  query: string;
  type?: string | undefined;
  facets: Record<string, string[]>;
}) {
  return (
    <form method="get" action={`/${locale}/search`} className="flex items-center justify-end gap-2">
      <label htmlFor="search-sort" className="text-sm text-muted-foreground">
        {m.search_sort_label()}
      </label>
      {query && <input type="hidden" name="q" value={query} />}
      {type && <input type="hidden" name="type" value={type} />}
      {Object.entries(facets).flatMap(([property, values]) =>
        values.map((value) => (
          <input key={`${property}:${value}`} type="hidden" name={`f.${property}`} value={value} />
        )),
      )}
      <select
        id="search-sort"
        value={sort}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        onChange={(event) => {
          const url = new URL(window.location.href);
          url.searchParams.delete('cursor');
          if (event.currentTarget.value === 'rating') url.searchParams.set('sort', 'rating');
          else url.searchParams.delete('sort');
          window.location.assign(url);
        }}
      >
        <option value="relevance">{m.search_sort_relevance()}</option>
        <option value="rating">{m.search_sort_rating()}</option>
      </select>
    </form>
  );
}
