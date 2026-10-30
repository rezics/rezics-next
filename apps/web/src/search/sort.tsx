import type { SearchLoaderDeps } from './search-params';
import { discoverySearchHref, searchFormFields } from './search-params';
import { m } from '../paraglide/messages.js';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';

/** A single search sort selector that preserves the query and filters while starting a fresh cursor. */
export function SearchSort({
  sort,
  locale,
  query,
  type,
  facets,
  state,
  disabled = false,
}: {
  sort: 'relevance' | 'rating';
  locale: string;
  query: string;
  type?: string | undefined;
  facets: Record<string, string[]>;
  state?: SearchLoaderDeps | undefined;
  disabled?: boolean;
}) {
  return (
    <form method="get" action={`/${locale}/search`} className="flex items-center justify-end gap-2">
      <Field className="flex-row items-center gap-2">
        <FieldLabel htmlFor="search-sort" className="text-sm text-muted-foreground">
          {m.search_sort_label()}
        </FieldLabel>
        <NativeSelect
          id="search-sort"
          disabled={disabled}
          value={sort}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          onChange={(event) => {
            const url = state
              ? new URL(
                  discoverySearchHref(locale, {
                    ...state,
                    query,
                    type,
                    facets,
                    cursor: undefined,
                    sort: event.currentTarget.value === 'rating' ? 'rating' : undefined,
                  }),
                  window.location.origin,
                )
              : new URL(window.location.href);
            url.searchParams.delete('cursor');
            if (event.currentTarget.value === 'rating') url.searchParams.set('sort', 'rating');
            else url.searchParams.delete('sort');
            window.location.assign(url);
          }}
        >
          <NativeSelectOption value="relevance">{m.search_sort_relevance()}</NativeSelectOption>
          <NativeSelectOption value="rating">{m.search_sort_rating()}</NativeSelectOption>
        </NativeSelect>
      </Field>
      {state &&
        searchFormFields({
          kinds: state.kinds,
          language: state.languages,
          filter: state.filter,
          condition: state.condition ? JSON.stringify(state.condition) : undefined,
          ...Object.fromEntries(
            Object.entries(state.ranges ?? {}).map(([property, range]) => [`r.${property}`, JSON.stringify(range)]),
          ),
        }).map(([name, value]) => <input key={`${name}:${value}`} type="hidden" name={name} value={value} />)}
      {query && <input type="hidden" name="q" value={query} />}
      {type && <input type="hidden" name="type" value={type} />}
      {Object.entries(facets).flatMap(([property, values]) =>
        values.map((value) => (
          <input key={`${property}:${value}`} type="hidden" name={`f.${property}`} value={value} />
        )),
      )}
    </form>
  );
}
