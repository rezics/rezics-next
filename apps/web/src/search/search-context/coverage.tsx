import { useMemo } from 'react';
import { conditionPresetCatalogue } from '../condition-preset-model';
import { ConditionPresetName, ConditionPresetInspection } from '../condition-preset';
import { FilterError, parseDiscoveryFilter } from '@rezics/filter';
import { requestLanguages } from '../../kernel/languages';
import { PredicateDescription, rangeDescription, type PredicatePresentation } from './predicate';
import type { Ref } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';
import type { SearchPageData } from '../search';
import type { SearchLoaderDeps } from '../search-params';
import { localizedLabel } from '../results';
import { resultFreshness } from './observation';
import { removeSearchResourceScope } from '../advanced-scope';
import { searchQuantityUnitText } from '../condition-quantity';

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
  data: Pick<SearchPageData, 'conditionMetadata' | 'hitTypes' | 'typeLabels' | 'typeChoices' | 'selectedFacetLabels'>;
  observation: { as_of: string; freshness?: unknown };
  locale: string;
  refreshHref: string;
  onRefresh?: (() => void) | undefined;
  refreshRef?: Ref<HTMLButtonElement> | undefined;
  onFocus?: ((button: HTMLButtonElement) => void) | undefined;
}) {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const unitMessages = {
    missing: () => m.search_quantity_unit_missing({}, options),
    unitless: () => m.search_quantity_unitless_count({}, options),
    marker: (unit: string) => m.search_quantity_unit_marker({ unit }, options),
    notAdmitted: (unit: string) => m.search_quantity_unit_not_admitted({ unit }, options),
    unavailable: (unit: string) => m.search_quantity_unit_label_unavailable({ unit }, options),
  };
  const freshness = resultFreshness(observation.freshness, observation.as_of);
  const scope = state.resourceScope;
  const localized = (labels: Record<string, string> | undefined, id: string) => {
    const label = localizedLabel(labels ?? {}, locale);
    return <span lang={label.lang}>{label.text.trim() || id}</span>;
  };
  const propertyName = (id: string) => localized(data.conditionMetadata?.properties[id]?.labels, id);
  const unitText = (property: string, unit: string | undefined) => {
    const definition = data.conditionMetadata?.properties[property];
    return definition?.datatype === 'quantity'
      ? searchQuantityUnitText(unit, definition.units ?? [], locale, unitMessages)
      : unit;
  };
  const catalogueType = (id: string) => {
    const labels = data.conditionMetadata?.types[id]?.labels ?? (state.type === id ? data.typeLabels : undefined);
    return localized(labels, id);
  };
  const discoveryType = (id: string) => {
    const labels = data.hitTypes[id] ?? data.typeChoices.find((choice) => choice.id === id)?.labels;
    return localized(labels, id);
  };
  const value = (propertyId: string, id: string) => {
    const label = data.selectedFacetLabels[propertyId]?.[id];
    return label?.text.trim() ? <span lang={label.lang}>{label.text}</span> : <span>{id}</span>;
  };
  const presentation: PredicatePresentation = {
    property: propertyName,
    catalogueType,
    discoveryType,
    value,
    conceptScheme: (id) => <span>{id}</span>,
  };
  const technicalPresentation: PredicatePresentation = {
    property: (id) => <code className="break-all">{id}</code>,
    catalogueType: (id) => <code className="break-all">{id}</code>,
    discoveryType: (id) => <code className="break-all">{id}</code>,
    value: (_propertyId, id) => <code className="break-all">{id}</code>,
    conceptScheme: (id) => <code className="break-all">{id}</code>,
  };
  const invalidPredicateInput =
    state.invalidInput?.key === 'filter' ||
    state.invalidInput?.key === 'condition' ||
    state.invalidInput?.key.startsWith('r.') === true;
  const presets = useMemo(
    () => (data.conditionMetadata ? conditionPresetCatalogue(data.conditionMetadata, locale) : undefined),
    [data.conditionMetadata, locale],
  );
  const saved = (id: string) => (
    <div key={JSON.stringify([id, locale, data.conditionMetadata?.digest, state])}>
      {m.condition_saved_filter_reference({}, options)}:{' '}
      {presets ? (
        <>
          <ConditionPresetName id={id} catalogue={presets} />
          <ConditionPresetInspection key={id} id={id} catalogue={presets} locale={locale} />
        </>
      ) : (
        m.condition_saved_filter_unavailable_reference({ id }, options)
      )}
    </div>
  );
  const languages = state.languages ?? requestLanguages(locale);
  const remainingFilter = invalidPredicateInput ? undefined : removeSearchResourceScope(state.filter);
  let resourcePredicate: ReturnType<typeof parseDiscoveryFilter> | undefined;
  let unsupportedFilter = false;
  if (remainingFilter) {
    try {
      resourcePredicate = parseDiscoveryFilter(JSON.parse(remainingFilter));
    } catch (error) {
      if (!(error instanceof FilterError)) throw error;
      unsupportedFilter = true;
    }
  }
  const invalidPredicate = invalidPredicateInput || unsupportedFilter;
  const scopeText = scope
    ? scope.kind === 'realm'
      ? m.search_context_scope_realm({ id: scope.id }, options)
      : m.search_context_scope_collection({ id: scope.id }, options)
    : state.invalidInput || unsupportedFilter
      ? m.search_context_scope_unavailable({}, options)
      : state.filter || state.condition
        ? m.search_context_scope_filtered({}, options)
        : m.header_search_global({}, options);
  const technicalLanguages = languages.join(', ');
  const languageName = (tag: string) => {
    try {
      return new Intl.DisplayNames([locale], { type: 'language' }).of(tag) ?? tag;
    } catch {
      return tag;
    }
  };
  return (
    <div data-search-coverage className="min-w-0 space-y-2 text-sm text-muted-foreground [overflow-wrap:anywhere]">
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
        <div className="mt-2 min-w-0 space-y-2 [overflow-wrap:anywhere]">
          <p>{m.search_context_query({ query: state.query }, options)}</p>
          <p>{m.search_context_scope({ scope: scopeText }, options)}</p>
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
          {state.type && (
            <p>
              {m.search_context_catalogue_type({}, options)} {catalogueType(state.type)}
            </p>
          )}
          {!!state.kinds?.length && (
            <p>
              {m.search_context_exact_type({}, options)}{' '}
              {state.kinds.map((id, index) => (
                <span key={id}>
                  {index ? ', ' : ''}
                  {discoveryType(id)}
                </span>
              ))}
            </p>
          )}
          <ul className="min-w-0 break-words">
            {Object.entries(state.facets).map(([propertyId, values]) => (
              <li key={propertyId}>
                {propertyName(propertyId)}:{' '}
                {values.map((item, index) => (
                  <span key={index}>
                    {index ? ', ' : ''}
                    {value(propertyId, item)}
                  </span>
                ))}
              </li>
            ))}
            {Object.entries(state.ranges ?? {}).map(([propertyId, range]) => (
              <li key={propertyId}>
                {propertyName(propertyId)}: {rangeDescription(range, locale, (unit) => unitText(propertyId, unit))}
              </li>
            ))}
          </ul>
          {state.condition && (
            <PredicateDescription
              value={state.condition}
              locale={locale}
              presentation={presentation}
              unitText={unitText}
              saved={saved}
            />
          )}
          {resourcePredicate && (
            <PredicateDescription
              value={resourcePredicate}
              locale={locale}
              presentation={presentation}
              unitText={unitText}
              saved={saved}
            />
          )}
          {invalidPredicate && <p>{m.search_context_predicate_unavailable({}, options)}</p>}
          {(state.condition || state.filter) && <p>{m.search_context_predicates({}, options)}</p>}
          <p>{m.search_context_limits({}, options)}</p>
          <p>{m.search_context_refresh_help({}, options)}</p>
          <details className="min-w-0 pt-1">
            <summary className="cursor-pointer rounded-sm underline underline-offset-4 focus-visible:ring-2">
              {m.search_context_technical_details({}, options)}
            </summary>
            <div className="mt-2 min-w-0 space-y-2 [overflow-wrap:anywhere]">
              <p>
                <code className="break-all">{state.query}</code>
              </p>
              {state.type && (
                <p>
                  {m.search_context_catalogue_type({}, options)} <code className="break-all">{state.type}</code>
                </p>
              )}
              {!!state.kinds?.length && (
                <p>
                  {m.search_context_exact_type({}, options)}{' '}
                  {state.kinds.map((id) => (
                    <code key={id} className="mr-1 break-all">
                      {id}
                    </code>
                  ))}
                </p>
              )}
              <p>
                {m.search_context_languages({}, options)}: <code className="break-all">{technicalLanguages}</code>
              </p>
              <ul className="min-w-0 space-y-1">
                {Object.entries(state.facets).map(([propertyId, values]) => (
                  <li key={propertyId}>
                    <code className="break-all">{propertyId}</code>:{' '}
                    {values.map((id) => (
                      <code key={id} className="mr-1 break-all">
                        {id}
                      </code>
                    ))}
                  </li>
                ))}
                {Object.entries(state.ranges ?? {}).map(([propertyId, range]) => (
                  <li key={propertyId}>
                    <code className="break-all">{propertyId}</code>:{' '}
                    <code className="break-all">{JSON.stringify(range)}</code>
                  </li>
                ))}
              </ul>
              {state.condition && (
                <PredicateDescription value={state.condition} locale={locale} presentation={technicalPresentation} />
              )}
              {resourcePredicate && (
                <PredicateDescription value={resourcePredicate} locale={locale} presentation={technicalPresentation} />
              )}
              {invalidPredicate && <p>{m.search_context_predicate_unavailable({}, options)}</p>}
            </div>
          </details>
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
