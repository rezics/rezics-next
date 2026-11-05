import type { SearchLoaderDeps } from './search-params';
import { discoverySearchHref, searchFormFields } from './search-params';
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
  return discoverySearchHref(locale, { ...state, ...next, ratingPopulation: next.ratingPopulation });
}

/** Native GET owns application and recovery, including when JavaScript is available.
 * The form holds a pending pair until deliberate submission; no field change navigates.
 * Replacing the executed observation remounts its controls, permanently retiring old edits.
 */
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
  const sortId = useId();
  const messageLocale = { locale: locale as never };
  return (
    <form
      key={JSON.stringify([
        locale,
        state,
        query,
        type,
        facets,
        sort,
        ratingPopulation,
        ratingPopulations,
        ratingReadiness,
        disabled,
      ])}
      method="get"
      action={`/${locale}/search`}
      className="grid w-full min-w-0 gap-3 sm:grid-cols-[auto_minmax(0,24rem)_auto] sm:justify-end"
    >
      <Field orientation="vertical" className="min-w-0 gap-1">
        <FieldLabel htmlFor={sortId} className="text-sm text-muted-foreground">
          {m.search_sort_label({}, messageLocale)}
        </FieldLabel>
        <NativeSelect
          id={sortId}
          name={disabled ? undefined : 'sort'}
          disabled={disabled}
          defaultValue={sort === 'rating' ? 'rating' : ''}
          className="w-full min-w-0 [&_select]:block [&_select]:min-h-11"
        >
          <NativeSelectOption value="">{m.search_sort_relevance({}, messageLocale)}</NativeSelectOption>
          <NativeSelectOption value="rating">{m.search_sort_rating({}, messageLocale)}</NativeSelectOption>
        </NativeSelect>
      </Field>
      <RatingPopulationControl
        locale={locale}
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
          resourceScope: state.resourceScope,
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
        className="min-h-11 justify-self-end rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 sm:mt-6"
      >
        {m.search_sort_submit_button({}, messageLocale)}
      </button>
      <details className="order-last min-w-0 text-sm text-muted-foreground sm:col-span-3">
        <summary className="min-h-11 cursor-pointer content-center rounded-lg px-2 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
          {m.search_reader_rating_help_title({}, messageLocale)}
        </summary>
        <p className="mt-1 px-2 text-muted-foreground">
          {ratingPopulation
            ? m.search_population_order_help({}, messageLocale)
            : m.rating_public_ordering({}, messageLocale)}
        </p>
      </details>
    </form>
  );
}
