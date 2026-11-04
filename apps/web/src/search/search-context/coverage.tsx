import { parseDiscoveryFilter } from '@rezics/filter';
import { requestLanguages } from '../../kernel/languages';
import { PredicateDescription, rangeDescription } from './predicate';
import type { Ref } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';
import type { SearchPageData } from '../search';
import type { SearchLoaderDeps } from '../search-params';
import { localizedLabel } from '../results';
import { resultFreshness } from './observation';

/** Result context always consumes the executed state, independently of the editable form. */
export function SearchCoverage({
  state,
  data,
  observation,
  locale,
  refreshHref,
  onRefresh,
  refreshRef,
  onFocus,
}: {
  state: SearchLoaderDeps;
  data: SearchPageData;
  observation: { as_of: string; freshness?: unknown };
  locale: string;
  refreshHref: string;
  onRefresh?: (() => void) | undefined;
  refreshRef?: Ref<HTMLButtonElement> | undefined;
  onFocus?: ((button: HTMLButtonElement) => void) | undefined;
}) {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const freshness = resultFreshness(observation.freshness, observation.as_of);
  const scope = state.resourceScope;
  const label = (id: string) => localizedLabel(data.conditionMetadata?.properties[id]?.labels ?? {}, locale).text || id;
  const languages = state.languages ?? requestLanguages(locale);
  const resourcePredicate = (() => {
    try {
      return state.filter ? parseDiscoveryFilter(JSON.parse(state.filter)) : undefined;
    } catch {
      return undefined;
    }
  })();
  const languageName = (tag: string) => {
    try {
      return new Intl.DisplayNames([locale], { type: 'language' }).of(tag) ?? tag;
    } catch {
      return tag;
    }
  };
  return (
    <div data-search-coverage className="space-y-2 text-sm text-muted-foreground">
      <p role="status">
        {freshness.state === 'current'
          ? m.search_context_current({}, options)
          : freshness.state === 'catching-up'
            ? m.search_context_catching_up({}, options)
            : m.search_context_unavailable({}, options)}
      </p>
      <details>
        <summary className="cursor-pointer rounded-sm underline underline-offset-4 focus-visible:ring-2">
          {m.search_context_about({}, options)}
        </summary>
        <div className="mt-2 space-y-2">
          <p>{m.search_context_query({ query: state.query }, options)}</p>
          <p>
            {m.search_context_scope(
              {
                scope: scope
                  ? `${scope.kind}: ${scope.id}`
                  : state.filter
                    ? m.search_context_filtered_scope({}, options)
                    : m.header_search_global({}, options),
              },
              options,
            )}
          </p>
          <p>
            {m.search_context_languages(
              {
                languages: languages.length
                  ? languages.map(languageName).join(', ')
                  : m.search_context_default_languages({}, options),
              },
              options,
            )}
          </p>
          {(state.type || state.kinds?.length) && (
            <p>
              {m.search_context_kinds(
                {
                  kinds: [state.type, ...(state.kinds ?? [])]
                    .filter(Boolean)
                    .map((id) => id && (localizedLabel(data.hitTypes[id] ?? {}, locale).text || id))
                    .join(', '),
                },
                options,
              )}
            </p>
          )}
          <ul>
            {Object.entries(state.facets).map(([property, values]) => (
              <li key={property}>
                {label(property)}:{' '}
                {values.map((value) => data.selectedFacetLabels[property]?.[value] ?? value).join(', ')}
              </li>
            ))}
            {Object.entries(state.ranges ?? {}).map(([property, range]) => (
              <li key={property}>
                {label(property)}: {rangeDescription(range)}
              </li>
            ))}
          </ul>
          {state.condition && <PredicateDescription value={state.condition} locale={locale} label={label} />}
          {resourcePredicate && <PredicateDescription value={resourcePredicate} locale={locale} label={label} />}
          {(state.condition || state.filter) && <p>{m.search_context_predicates({}, options)}</p>}
          <p>{m.search_context_limits({}, options)}</p>
          <p>{m.search_context_refresh_help({}, options)}</p>
        </div>
      </details>
      {onRefresh && !state.cursor ? (
        <Button
          type="button"
          variant="outline"
          ref={refreshRef}
          onClick={(event) => {
            onFocus?.(event.currentTarget);
            onRefresh();
          }}
        >
          {m.search_context_refresh({}, options)}
        </Button>
      ) : (
        <a href={refreshHref} className={buttonVariants({ variant: 'outline' })}>
          {m.search_context_refresh({}, options)}
        </a>
      )}
    </div>
  );
}
