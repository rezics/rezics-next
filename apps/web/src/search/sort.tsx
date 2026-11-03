import type { SearchLoaderDeps } from './search-params';
import { discoverySearchHref, searchFormFields } from './search-params';
import { useRouter } from '@tanstack/react-router';
import { useId } from 'react';
import { m } from '../paraglide/messages.js';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { RatingPopulationControl } from './rating-population-control';
import type { RealmRatingPopulationOption, RealmRatingReadiness } from './rating-population';
import { changeRatingOrder } from './rating-order-state';

/** Reuse the public GET representation; changing order starts a fresh hit traversal. */
export function searchSortHref(
  locale: string,
  state: SearchLoaderDeps & { ratingPopulation?: string | undefined },
  sort: 'relevance' | 'rating',
  ratingPopulation?: string | null,
): string {
  const next = changeRatingOrder(state, sort, ratingPopulation);
  const [path, search] = discoverySearchHref(locale, { ...state, ...next }).split('?');
  const searchParams = new URLSearchParams(search);
  searchParams.delete('ratingPopulation');
  if (next.ratingPopulation) searchParams.set('ratingPopulation', next.ratingPopulation);
  return `${path}${searchParams.size ? `?${searchParams}` : ''}`;
}

/** A single search sort selector that preserves the query and filters while starting a fresh cursor. */
export function SearchSort({
  sort,
  locale,
  query,
  type,
  facets,
  state,
  ratingPopulations,
  ratingPopulation,
  ratingReadiness,
  disabled = false,
}: {
  sort: 'relevance' | 'rating';
  locale: string;
  query: string;
  type?: string | undefined;
  facets: Record<string, string[]>;
  state?: SearchLoaderDeps | undefined;
  /** Authorized choices supplied by the native Search owner; never inferred from resource membership. */
  ratingPopulations?: readonly RealmRatingPopulationOption[] | undefined;
  /** The committed canonical population query value, independent of state.filter. */
  ratingPopulation?: string | undefined;
  /** The authentic native Search outcome for the committed Realm rating basis. */
  ratingReadiness?: RealmRatingReadiness | undefined;
  disabled?: boolean;
}) {
  // The selector also supports static form rendering outside the connected application.
  const router = useRouter({ warn: false });
  const sortId = useId();
  const messageLocale = { locale: locale as never };
  return (
    <form
      method="get"
      action={`/${locale}/search`}
      className="flex max-w-full flex-wrap items-center justify-end gap-2"
    >
      <Field orientation="horizontal" className="w-auto flex-wrap justify-end gap-2">
        <FieldLabel htmlFor={sortId} className="text-sm text-muted-foreground">
          {m.search_sort_label({}, messageLocale)}
        </FieldLabel>
        <NativeSelect
          id={sortId}
          name={disabled ? undefined : 'sort'}
          disabled={disabled}
          value={sort === 'rating' ? 'rating' : ''}
          className="h-9 shrink-0 rounded-md border border-input bg-background px-2 text-sm [&_select]:w-auto"
          onChange={(event) => {
            void router?.navigate({
              href: searchSortHref(
                locale,
                {
                  ...state,
                  query,
                  type,
                  facets,
                  cursor: state?.cursor,
                  sort: sort === 'rating' ? 'rating' : undefined,
                  ratingPopulation,
                },
                event.currentTarget.value === 'rating' ? 'rating' : 'relevance',
                ratingPopulation,
              ),
            });
          }}
        >
          <NativeSelectOption value="">{m.search_sort_relevance({}, messageLocale)}</NativeSelectOption>
          <NativeSelectOption value="rating">{m.search_sort_rating({}, messageLocale)}</NativeSelectOption>
        </NativeSelect>
      </Field>
      <details className="min-w-0 max-w-full text-sm text-muted-foreground">
        <summary className="min-h-10 cursor-pointer content-center rounded-lg px-2 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
          {m.search_reader_rating_help_title({}, messageLocale)}
        </summary>
        <p className="mt-1 px-2 text-muted-foreground">
          {ratingPopulation
            ? 'When Rating is selected, native Search uses the Realm’s published score for the standard question within one subject partition. It intersects the query and filters together; it does not rank a loaded preview.'
            : m.rating_public_ordering({}, messageLocale)}
        </p>
      </details>
      <RatingPopulationControl
        populations={ratingPopulations}
        selectedPopulationId={ratingPopulation}
        readiness={ratingReadiness}
        restartHref={searchSortHref(
          locale,
          {
            ...state,
            query,
            type,
            facets,
            cursor: undefined,
            sort: sort === 'rating' ? 'rating' : undefined,
            ratingPopulation,
          },
          sort,
          ratingPopulation,
        )}
        disabled={disabled}
      />
      {disabled && sort === 'rating' && <input type="hidden" name="sort" value="rating" />}
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
      <button
        type="submit"
        disabled={disabled}
        className="h-9 shrink-0 rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50"
      >
        {m.search_sort_submit_button({}, messageLocale)}
      </button>
    </form>
  );
}
