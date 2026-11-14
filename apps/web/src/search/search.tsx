import { QueryTextRecovery } from './query-text-recovery';

export {
  correctSearchInput,
  discoverySearchHref,
  facetValuesFromSearch,
  rangeValuesFromSearch,
  removeSearchInput,
  searchFormFields,
  searchInputDependency,
  searchInputFingerprint,
  searchLoaderDeps,
  searchParams,
  searchUrlIntake,
} from './search-params';
export type {
  SearchInputIssue,
  SearchInputIssueReason,
  SearchLoaderDeps,
  SearchParams,
  SearchUrlIntake,
} from './search-params';
export { SearchInputRecovery } from './search-input-recovery';
import { useSearchWindow } from './search-window';
import { realmCatalogueWindow } from './realm-catalogue-window';
import { SearchResultsRegion } from './search-regions/results';
import { QuerySharePreview } from './query-share-preview';
import { parseQueryShare, shareUnavailable } from './query-share';

import { pickText } from '@rezics/composition';
import { useLocation, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { BottomSheet } from '@rezics/ui/bottom-sheet';

import { SlidersHorizontalIcon, XIcon } from 'lucide-react';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import { cn } from '@rezics/ui/utils';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { getLocale, locales } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { kernelClient } from '../kernel/client.ts';
import { requestLanguages } from '../kernel/languages.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { PageHeading } from '../shell/page-heading';
import { localizedLabel } from './results.tsx';

import { discoveryRequest, realmSearchRequest } from './search-request.ts';
import { applicableRefinementProperties } from './refinement/model';
import { Refinement } from './refinement/refinement';
import { readRefinement } from './refinement/server';
import { createRangeDraftState, rangeFromDraft, updateRangeDraft, type RangeDraft } from './refinement/range-draft';
import { readDiscoveryKinds, type DiscoveryKindsState } from './discovery';
import {
  facetSearchInvalidation,
  readSearchOutcome,
  searchPageForRecovery,
  searchRecoveryFromResponse,
  searchUnavailablePage,
  type SearchRecoveryState,
} from './search-recovery';

import { useSearchRetryFocus } from './search-retry-focus';
import {
  discoverySearchHref,
  realmCatalogueSearchLoaderDeps,
  searchUrlIntake,
  type SearchLoaderDeps,
} from './search-params';
import {
  isSearchResourceScope,
  parseSearchResourceScope,
  removeSearchResourceScope,
  searchFilterWithScope,
  type SearchResourceScope,
} from './advanced-scope';
import { requestParams } from './search-application';
import { validateSearchInput } from './search-query-input';
import type { SearchPageData } from './search-query-contract';
export type { SearchFacetValueLabel, SearchPageData } from './search-query-contract';
import { searchResourceScopeChanged } from './search-scope-restart';
import { DiscoveryKinds, RetainedKindSelections } from './discovery-kinds';

import { useDiscoveryPersonalResults } from './discovery-personal-host';

import { useRegisterHeaderSearchFilters } from './header-search/filter-region';
import { ConditionEditor, conditionEditorHasRawEdits, type ConditionEditorDraftState } from './condition-editor';
import { searchQuantityUnitText } from './condition-quantity';
import type { ConditionEntityContext } from './condition-entity';
import { SearchRealmDiscovery } from './realm-discovery';
import { isRealmDiscoverySearch, type RealmDiscoveryReader } from './realm-discovery-loader';
import { readScopedSearchReader } from './search-reader';
import { RATING_POPULATION_FIELD } from './rating-population';
import {
  RESOURCE_LANGUAGE_PROPERTY,
  RESOURCE_LANGUAGE_SELECTION_LIMIT,
  withoutResourceLanguageSelection,
} from './language-refinement';
import { searchRequiresCurrentReader, searchSessionLifetime } from './scoped-search-lifetime';
import { sessionCsrfToken, useSession } from '../session/query';
import { searchSessionOwner } from './search-session-owner';
import { useSearchQuery } from './use-search-query';
import type { RealmDiscoveryState } from '../community/realm-discovery';
import { conditionAdmission, conditionSearchState } from './condition-editor-model';
import { conditionConceptSuggestionFilter } from './condition-concept-model';
import { createFilterDraft, resetFilterDraft, type FilterDraftBaseline, type FilterScopeDraft } from './filter-draft-reset';
import { filterApplicationCopy } from './filter-application-copy';
import { useFilterSurfaceFocus } from './filter-surface-focus';
import { useConditionComposition } from './condition-composition';
function conditionEntityLookupContext(
  data: SearchPageData | undefined,
  locale: string,
  reader: string | null,
): ConditionEntityContext | undefined {
  if (!data?.conditionMetadata) return undefined;
  const base = {
    locale,
    ...(reader ? { reader } : {}),
    ...(data.conditionMetadata.digest ? { release: data.conditionMetadata.digest } : {}),
  };
  if (!data.queryState) return { ...base, available: false };
  const state = data.queryState;
  const parsedScope = parseSearchResourceScope(state.filter);
  const scope = state.resourceScope ?? parsedScope.scope;
  const scopeMismatch =
    parsedScope.scope !== undefined &&
    scope !== undefined &&
    (parsedScope.scope.kind !== scope.kind || parsedScope.scope.id !== scope.id.toLowerCase());
  const missingScope = parsedScope.scope !== undefined && scope === undefined;
  const otherReaderBound = searchRequiresCurrentReader({
    ...state,
    resourceScope: undefined,
    ratingPopulation: undefined,
  });
  return {
    ...base,
    ...(scope ? { resourceScope: scope } : {}),
    available:
      typeof data.conditionMetadata.digest === 'string' &&
      data.conditionMetadata.digest.length > 0 &&
      !parsedScope.invalidInput &&
      !scopeMismatch &&
      !missingScope &&
      state.ratingPopulation === undefined &&
      !otherReaderBound &&
      (scope === undefined || reader !== null),
  };
}
const readKindsWithLocale = createServerFn({ method: 'GET' })
  .validator(validateSearchInput)
  .handler(async ({ data }) => {
    if (!data.kindCursor) throw new Error('Missing kind cursor');
    const requestContext = getRequest();
    const reader = searchRequiresCurrentReader(data) ? await readScopedSearchReader(requestContext) : undefined;
    if (searchRequiresCurrentReader(data) && (!reader || data.reader !== reader.owner))
      return { status: 'unavailable' as const, recovery: { status: 'session' as const } };
    if (data.resourceScope?.kind === 'realm') {
      const request = {
        ...realmSearchRequest({ ...requestParams(data), cursor: undefined }, requestLanguages(data.locale)),
        kindCursor: data.kindCursor,
        limit: 1,
      };
      const outcome = await readSearchOutcome(
        request,
        (body) =>
          kernelClient(data.locale).subjects.$search.post(body, {
            ...(reader?.authorization ? { headers: { authorization: reader.authorization } } : {}),
            fetch: { signal: requestContext.signal, cache: 'no-store' },
          }),
        requestContext.signal,
        'subjects',
      );
      if (outcome.result?.kinds) {
        const { values, omitted, next } = outcome.result.kinds;
        return {
          status: 'ready' as const,
          kinds: {
            values: values.map(({ count: _count, ...kind }) => kind),
            ...(omitted ? { omitted } : {}),
            next,
          },
          asOf: outcome.result.as_of,
        };
      }
      const recovery = outcome.recovery;
      const status: Exclude<DiscoveryKindsState['status'], 'ready'> =
        recovery.status === 'closed'
          ? 'closed'
          : recovery.status === 'denied' || recovery.status === 'session'
            ? 'denied'
            : recovery.status === 'restart'
              ? 'restart'
              : recovery.status === 'invalid' || recovery.status === 'invalid-cursor'
                ? 'invalid'
                : recovery.status === 'index-not-ready' || recovery.status === 'source-not-ready'
                  ? 'preparing'
                  : 'unavailable';
      return { status, ...(status === 'unavailable' ? { retryable: true } : {}), recovery };
    }
    let recovery: SearchRecoveryState | undefined;
    const state = await readDiscoveryKinds(
      discoveryRequest(requestParams(data), requestLanguages(data.locale)),
      data.kindCursor,
      async (body) => {
        const response = await kernelClient(data.locale).subjects.$search.post(body, {
          ...(reader?.authorization ? { headers: { authorization: reader.authorization } } : {}),
          fetch: { signal: getRequest().signal, cache: 'no-store' },
        });
        if (response.error || response.status !== 200)
          recovery = searchRecoveryFromResponse(response, Date.now(), data.kindCursor);
        return response;
      },
    );
    if (state.status === 'closed') recovery = { status: 'closed' };
    return { ...state, ...(recovery ? { recovery } : {}) };
  });

const prepareShareWithLocale = createServerFn({ method: 'GET' })
  .validator(validateSearchInput)
  .handler(async ({ data }) => {
    const reader = await readScopedSearchReader(getRequest());
    if ((data.reader ?? undefined) !== reader?.owner) return shareUnavailable();
    const body = discoveryRequest({ ...requestParams(data), cursor: undefined }, requestLanguages(data.locale));
    const response = await kernelClient(data.locale).subjects.$search.post(
      { ...body, prepareShare: true },
      {
        ...(reader?.authorization ? { headers: { authorization: reader.authorization } } : {}),
        fetch: { signal: getRequest().signal, cache: 'no-store' },
      },
    );
    return response.status === 200 ? parseQueryShare(response.data) : shareUnavailable();
  });

function languageDisplayName(tag: string, locale: string) {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

const linkClass = cn(buttonVariants({ variant: 'link' }), 'h-auto justify-start p-0');
type MessageOptions = { locale: (typeof locales)[number] };

function messageOptions(locale: string): MessageOptions {
  return { locale: locales.find((value) => value === locale) ?? 'en' };
}

/** Search filters author a native request-only resource leaf; the server remains the access authority. */
function AdvancedScope({
  scope,
  locale,
  onChange,
}: {
  scope: FilterScopeDraft;
  locale: string;
  onChange: (scope: FilterScopeDraft) => void;
}) {
  const typeId = useId();
  const resourceId = useId();
  const options = messageOptions(locale);
  const { kind, id } = scope;
  const selected = kind && isSearchResourceScope({ kind, id }) ? { kind, id: id.toLowerCase() } : undefined;
  return (
    <fieldset className="space-y-3 rounded-lg border border-border/60 p-3">
      <legend className="px-1 text-sm font-medium">{m.access_resource({}, options)}</legend>
      <Field>
        <FieldLabel htmlFor={typeId}>{m.library_follow_count_context_select_type({}, options)}</FieldLabel>
        <Select
          value={kind === '' ? null : kind}
          onValueChange={(nextSelectValue) => {
            const next = (nextSelectValue ?? '') as SearchResourceScope['kind'] | '';
            onChange({ kind: next, id: next ? id : '' });
          }}
        >
          <SelectTrigger id={typeId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={null}>{m.header_search_global({}, options)}</SelectItem>
              <SelectItem value="realm">Realm</SelectItem>
              <SelectItem value="collection">Collection</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      {kind && (
        <Field>
          <FieldLabel htmlFor={resourceId}>{m.access_identity_resource_id({}, options)}</FieldLabel>
          <input
            id={resourceId}
            type="text"
            value={id}
            required
            pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
            autoComplete="off"
            aria-invalid={(id.length > 0 && !selected) || undefined}
            aria-describedby={id.length > 0 && !selected ? `${resourceId}-error` : undefined}
            onChange={(event) => onChange({ kind, id: event.currentTarget.value })}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {id.length > 0 && !selected && (
            <p id={`${resourceId}-error`} className="text-sm text-destructive">
              {m.search_reader_condition_format({ field: m.access_identity_resource_id({}, options) }, options)}
            </p>
          )}
        </Field>
      )}
      {kind && (
        <Button type="button" variant="ghost" onClick={() => onChange({ kind: '', id: '' })} className="max-w-full whitespace-normal wrap-anywhere">
          {m.header_search_remove_scope({ scope: `${kind} ${id}` }, options)}
        </Button>
      )}
      {kind && <p className="text-xs text-muted-foreground">{`${kind} ${id}`}</p>}
    </fieldset>
  );
}

export function SearchPage({
  query,
  cursor,
  data,
  filtersOnly = false,
  initiallyOpen = false,
  realmDiscovery,
  realmDiscoveryRead,
  onRetry,
  locale: localeProp,
  session = null,
  readerOwner,
  searchHref,
  fixedResourceScope,
  hrefForState,
  formAction,
  heading,
  embedded = false,
  isCurrent = () => true,
}: {
  query: string;
  cursor?: string;
  data?: SearchPageData;
  filtersOnly?: boolean;
  initiallyOpen?: boolean;
  realmDiscovery?: RealmDiscoveryState;
  realmDiscoveryRead?: RealmDiscoveryReader;
  onRetry?: (() => PromiseLike<unknown> | void) | undefined;
  locale?: string;
  session?: string | null;
  readerOwner?: string | undefined;
  searchHref?: string | undefined;
  /** Embedded scope owners keep the native resource fixed while sharing Search controls. */
  fixedResourceScope?: SearchResourceScope | undefined;
  hrefForState?: ((state: SearchLoaderDeps) => string) | undefined;
  formAction?: string | undefined;
  heading?: ReactNode;
  embedded?: boolean;
  isCurrent?: (() => boolean) | undefined;
}) {
  const sourceData = data;
  const currentData = useRef(data);
  currentData.current = data;
  const [invalidation, setInvalidation] = useState<{ owner: SearchPageData; state: SearchRecoveryState }>();
  if (data) data = searchPageForRecovery(data, invalidation?.owner === data ? invalidation.state : data.recovery);
  const [hydrated, setHydrated] = useState(false);
  const [filterSurface, setFilterSurface] = useState<'desktop' | 'mobile' | undefined>();
  const router = useRouter({ warn: false });
  const typeControlId = useId();
  const applyDescriptionId = useId();
  const locale = localeProp ?? getLocale();
  const filterCopy = filterApplicationCopy(locale);
  const personal = useDiscoveryPersonalResults({
    source: data?.discovery,
    request: data?.queryState ? discoveryRequest(data.queryState, requestLanguages(locale)) : undefined,
    locale,
    returnTo:
      searchHref ??
      discoverySearchHref(
        locale,
        data?.queryState ?? { query, facets: {}, type: undefined, cursor: undefined, sort: undefined },
      ),
    enabled:
      !!data?.discovery &&
      !!data.queryState &&
      !filtersOnly &&
      !(data.discovery.status === 'restart' && searchRequiresCurrentReader(data.queryState)),
  });
  if (data?.discovery && personal.state) data = { ...data, discovery: personal.state };
  const options = messageOptions(locale);
  const unitMessages = {
    missing: () => m.search_quantity_unit_missing({}, options),
    unitless: () => m.search_quantity_unitless_count({}, options),
    marker: (unit: string) => m.search_quantity_unit_marker({ unit }, options),
    notAdmitted: (unit: string) => m.search_quantity_unit_not_admitted({ unit }, options),
    unavailable: (unit: string) => m.search_quantity_unit_label_unavailable({ unit }, options),
  };
  const type = data?.type;
  const result = data?.result;
  const discovery = data?.discovery;
  const selectedFacets = data?.selectedFacets ?? {};
  const resourceLanguage = data?.resourceLanguage;
  const committedInput: SearchLoaderDeps = data?.queryState ?? {
    query,
    type,
    facets: selectedFacets,
    cursor,
    sort: data?.sort === 'rating' ? 'rating' : undefined,
    ratingPopulation: data?.ratingPopulation,
  };
  const committedState: SearchLoaderDeps = fixedResourceScope
    ? {
        ...committedInput,
        resourceScope: fixedResourceScope,
        filter: searchFilterWithScope(committedInput.filter, fixedResourceScope),
      }
    : committedInput;
  const currentScope = committedState.resourceScope ?? parseSearchResourceScope(committedState.filter).scope;
  const hrefFor = (state: SearchLoaderDeps) => {
    const fixed = fixedResourceScope
      ? {
          ...state,
          resourceScope: fixedResourceScope,
          filter: searchFilterWithScope(state.filter, fixedResourceScope),
        }
      : state;
    return hrefForState?.(fixed) ?? discoverySearchHref(locale, fixed);
  };
  const windowNavigation = useSearchWindow({
    cursor: committedState.cursor,
    href: (cursor) => hrefFor({ ...committedState, cursor }),
    locale,
    session,
    ready: data?.recovery?.status === 'ready',
    settled: data?.recovery?.status !== 'loading',
    recoverable: ['unavailable', 'index-not-ready', 'source-not-ready'].includes(data?.recovery?.status ?? ''),
    checkpoint: discovery?.status === 'ready' ? discovery.page.as_of : result?.as_of,
    enabled: !filtersOnly && isCurrent(),
  });
  const stateKey = JSON.stringify([committedState, locale]);
  const composition = useConditionComposition(stateKey);
  const latestStateKey = useRef(stateKey);
  latestStateKey.current = stateKey;
  const filterFocus = useFilterSurfaceFocus(stateKey);
  const [rangeDraftState, setRangeDraftState] = useState(() => createRangeDraftState(stateKey));
  if (rangeDraftState.key !== stateKey) setRangeDraftState(createRangeDraftState(stateKey));
  const baseline: FilterDraftBaseline = {
    condition: data?.condition,
    languages: committedState.languages,
    type: committedState.type,
    kinds: committedState.kinds,
    facets: committedState.facets,
    scope: { kind: currentScope?.kind ?? '', id: currentScope?.id ?? '' },
  };
  const [draft, setDraft] = useState(() => createFilterDraft(stateKey, baseline));
  const [revertedKey, setRevertedKey] = useState<string>();
  const [revertVersion, setRevertVersion] = useState(0);
  const conditionDraftState = useRef<ConditionEditorDraftState | undefined>(undefined);
  const conditionDraftOwner = JSON.stringify([stateKey, session, data?.conditionMetadata?.digest]);
  const retainedConditionOwner = useRef(conditionDraftOwner);
  if (retainedConditionOwner.current !== conditionDraftOwner) {
    retainedConditionOwner.current = conditionDraftOwner;
    conditionDraftState.current = undefined;
  }
  if (draft.key !== stateKey) {
    setDraft(createFilterDraft(stateKey, baseline));
  }
  const draftScope = draft.scope ?? { kind: '', id: '' };
  const draftResourceScope = isSearchResourceScope(draftScope)
    ? { ...draftScope, id: draftScope.id.toLowerCase() }
    : undefined;
  const invalidScope = Boolean(draftScope.kind && !draftResourceScope);
  const scopeChanged = invalidScope || searchResourceScopeChanged(currentScope, draftResourceScope);
  const draftFacets = draft.facets ?? {};
  const draftRanges = { ...committedState.ranges };
  const invalidRanges: string[] = [];
  for (const [property, rangeDraft] of Object.entries(rangeDraftState.key === stateKey ? rangeDraftState.properties : {})) {
    if (rangeDraft.removed) {
      delete draftRanges[property];
      continue;
    }
    const definition = data?.refinement?.properties.find((entry) => entry.property === property && entry.mode === 'range');
    const range = definition ? rangeFromDraft(rangeDraft, definition) : undefined;
    if (range) draftRanges[property] = range;
    else invalidRanges.push(property);
  }
  const editedState: SearchLoaderDeps = {
    ...conditionSearchState(committedState, draft.condition, draft.languages),
    type: draft.type,
    kinds: draft.kinds,
    facets: draftFacets,
    ranges: draftRanges,
    filter: draftResourceScope
      ? searchFilterWithScope(committedState.filter, draftResourceScope)
      : draftScope.kind
        ? committedState.filter
        : removeSearchResourceScope(committedState.filter),
    resourceScope: draftResourceScope,
  };
  const admit = useMemo(
    () => (data?.conditionMetadata ? conditionAdmission(data.conditionMetadata) : undefined),
    [data?.conditionMetadata],
  );
  const localIssues = admit?.(draft.condition, editedState) ?? [];
  const issues = [
    ...(data?.problem?.errors ?? []),
    ...(draft.attempted || draft.condition !== data?.condition ? localIssues : []),
  ];
  const advancedDetails = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (issues.length > 0 && advancedDetails.current) advancedDetails.current.open = true;
  }, [issues.length, data?.problem, filterSurface]);
  const editing =
    discoverySearchHref(locale, editedState) !== discoverySearchHref(locale, { ...committedState, cursor: undefined }) ||
    JSON.stringify(draftScope) !== JSON.stringify(baseline.scope) ||
    Object.keys(rangeDraftState.properties).length > 0 ||
    conditionEditorHasRawEdits(conditionDraftState.current);
  const changeScope = (scope: FilterScopeDraft) => {
    setDraft((previous) => ({
      ...previous,
      scope,
      facets:
        previous.scope?.kind === scope.kind && previous.scope?.id.toLowerCase() === scope.id.toLowerCase()
          ? previous.facets
          : {},
    }));
  };
  const conceptFilter = data?.conditionMetadata ? conditionConceptSuggestionFilter(data.conditionMetadata) : undefined;
  const conceptRequiresReader = !!data?.queryState && searchRequiresCurrentReader(data.queryState);
  const conceptLookup = {
    enabled: !!conceptFilter && !!data?.conditionMetadata?.digest && !conceptRequiresReader,
    ...(conceptFilter ? { filter: conceptFilter } : {}),
    ...(data?.conditionMetadata?.digest ? { releaseDigest: data.conditionMetadata.digest } : {}),
    lifetimeKey: JSON.stringify([locale, session, data?.conditionMetadata?.digest, committedState]),
    key: JSON.stringify([locale, session, data?.conditionMetadata?.digest, committedState, draft.condition]),
    ...(!conceptFilter || !data?.conditionMetadata?.digest
      ? { blocked: 'metadata' as const }
      : committedState.resourceScope
        ? { blocked: 'scope' as const }
        : conceptRequiresReader
          ? { blocked: 'private' as const }
          : {}),
  };
  const number = new Intl.NumberFormat(locale);
  const label = (labels: Record<string, string> | undefined, fallback: string) =>
    localizedLabel(labels ?? {}, locale).text.trim() || fallback;
  const constraints: {
    key: string;
    text: string;
    state: SearchLoaderDeps;
    details?: unknown;
    lang?: string;
    description?: string;
    descriptionLang?: string;
  }[] = [];
  const add = (
    key: string,
    text: string,
    state: SearchLoaderDeps,
    details?: unknown,
    lang?: string,
    description?: string,
    descriptionLang?: string,
  ) =>
    constraints.push({
      key,
      text,
      state: { ...state, cursor: undefined },
      details,
      ...(lang ? { lang } : {}),
      ...(description ? { description } : {}),
      ...(descriptionLang ? { descriptionLang } : {}),
    });
  if (type)
    add(
      'type',
      `${m.search_subject_type({}, options)}: ${label(data?.typeLabels, m.search_constraint_identity_kind_unavailable({}, options))}`,
      {
        ...committedState,
        type: undefined,
      },
      { type },
    );
  for (const kind of committedState.kinds ?? []) {
    const choice =
      discovery?.status === 'ready' ? discovery.page.kinds.values.find((entry) => entry.id === kind) : undefined;
    const kindLabel = choice ? localizedLabel(choice.labels, locale) : undefined;
    const description = pickText(bundledRelease.types[kind]?.descriptions ?? {}, locale);
    add(
      `kind:${kind}`,
      `${m.home_kind_label({}, options)}: ${label(
        choice?.labels,
        m.search_constraint_identity_kind_unavailable({}, options),
      )}`,
      { ...committedState, kinds: committedState.kinds?.filter((value) => value !== kind) },
      { kind },
      kindLabel?.lang,
      description.text,
      description.lang ?? undefined,
    );
  }
  for (const [property, values] of Object.entries(selectedFacets))
    for (const value of values) {
      const page = data?.refinement?.initial;
      const valueLabels =
        property === RESOURCE_LANGUAGE_PROPERTY
          ? page?.status === 'ready'
            ? page.page.facets
                .find((entry) => entry.property === RESOURCE_LANGUAGE_PROPERTY)
                ?.values.find((entry) => entry.value === value)?.labels
            : undefined
          : page?.status === 'ready'
            ? page.page.facets
                .find((entry) => entry.property === property)
                ?.values.find((entry) => entry.value === value)?.labels
            : undefined;
      const selectedLanguage =
        property === RESOURCE_LANGUAGE_PROPERTY
          ? resourceLanguage?.selected.find((entry) => entry.value === value)
          : undefined;
      const languageLabel =
        property === RESOURCE_LANGUAGE_PROPERTY ? localizedLabel(valueLabels ?? {}, locale) : undefined;
      const fallbackValue =
        property === RESOURCE_LANGUAGE_PROPERTY
          ? selectedLanguage?.needsRepair
            ? m.search_resource_language_repair({ value }, options)
            : (selectedLanguage?.canonical ?? value)
          : m.search_constraint_identity_value_unavailable({}, options);
      add(
        `facet:${property}:${value}`,
        `${
          property === 'type'
            ? m.search_subject_types({}, options)
            : property === RESOURCE_LANGUAGE_PROPERTY
              ? m.search_resource_language({}, options)
              : label(
                  data?.conditionMetadata?.properties[property]?.labels,
                  m.search_constraint_identity_property_unavailable({}, options),
                )
        }: ${
          property === RESOURCE_LANGUAGE_PROPERTY
            ? languageLabel?.text.trim() || fallbackValue
            : label(valueLabels, fallbackValue)
        }`,
        {
          ...committedState,
          facets: { ...selectedFacets, [property]: values.filter((entry) => entry !== value) },
        },
        { property, value },
        property === RESOURCE_LANGUAGE_PROPERTY ? languageLabel?.lang : undefined,
      );
    }
  for (const [property, range] of Object.entries(data?.ranges ?? {}))
    add(
      `range:${property}`,
      `${label(data?.conditionMetadata?.properties[property]?.labels, m.search_constraint_identity_property_unavailable({}, options))}: ${
        range.gte === undefined ? '…' : `≥ ${range.gte}`
      } – ${range.lte === undefined ? '…' : `≤ ${range.lte}`}${
        data?.conditionMetadata?.properties[property]?.datatype === 'quantity'
          ? ` (${searchQuantityUnitText(
              range.unit,
              data.conditionMetadata.properties[property]?.units ?? [],
              locale,
              unitMessages,
            )})`
          : range.unit
            ? ` (${range.unit})`
            : ''
      }`,
      {
        ...committedState,
        ranges: Object.fromEntries(Object.entries(data?.ranges ?? {}).filter(([key]) => key !== property)),
      },
      { property, range },
    );
  for (const tag of committedState.languages ?? [])
    add(`language:${tag}`, `${m.condition_language({}, options)}: ${languageDisplayName(tag, locale)}`, {
      ...committedState,
      languages: committedState.languages?.filter((entry) => entry !== tag),
    });
  if (committedState.condition) add('condition', m.condition_heading({}, options), { ...committedState, condition: undefined });
  const filterWithoutScope = committedState.resourceScope
    ? removeSearchResourceScope(committedState.filter)
    : committedState.filter;
  if (filterWithoutScope)
    add('filter', m.search_existing_filter({}, options), {
      ...committedState,
      filter: committedState.resourceScope
        ? searchFilterWithScope(undefined, committedState.resourceScope)
        : undefined,
    });
  const activeFilterCount = constraints.length;
  useEffect(() => setHydrated(true), []);
  const desktopPanel = useRef<HTMLDivElement>(null);
  const openFilters = useCallback(() => {
    const owner = latestStateKey.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const desktop = window.matchMedia('(min-width: 1024px)').matches;
    const surface = desktop ? 'desktop' : 'mobile';
    const id = filterFocus.begin({
      owner,
      kind: 'open',
      surface,
      opener,
      document,
      ...(desktop ? { resolveDestination: () => desktopPanel.current } : {}),
    });
    setFilterSurface(surface);
    if (desktop) filterFocus.schedule(id, owner);
  }, [filterFocus]);
  const closeFilters = useCallback(() => {
    const owner = latestStateKey.current;
    const surfaceRoot = desktopPanel.current ?? document.querySelector<HTMLElement>('[role="dialog"]');
    const id = filterFocus.begin({
      owner,
      kind: 'close',
      document,
      ...(surfaceRoot ? { surfaceRoot } : {}),
    });
    setFilterSurface(undefined);
    filterFocus.schedule(id, owner);
  }, [filterFocus]);
  useEffect(() => {
    if (filterSurface === 'desktop') filterFocus.restoreOpen(latestStateKey.current, 'desktop');
    if (!filterSurface) return;
    const media = window.matchMedia('(min-width: 1024px)');
    const resize = () => {
      const next = media.matches ? 'desktop' : 'mobile';
      if (next === filterSurface) return;
      filterFocus.retire();
      setFilterSurface(next);
    };
    media.addEventListener('change', resize);
    return () => media.removeEventListener('change', resize);
  }, [filterFocus, filterSurface]);
  useEffect(() => {
    if (initiallyOpen) openFilters();
  }, [initiallyOpen, openFilters]);
  useEffect(() => {
    if (data?.problem?.errors?.some(({ pointer }) => pointer !== '/text')) openFilters();
  }, [data?.problem, openFilters]);

  const hasFilterPanel = data !== undefined;
  const filterRegion = useMemo(
    () => ({ activeCount: activeFilterCount, open: openFilters }),
    [activeFilterCount, openFilters],
  );
  useRegisterHeaderSearchFilters(hasFilterPanel, filterRegion);
  const revertStatus = useRef<HTMLParagraphElement>(null);
  const nativeObservation = discovery?.status === 'ready' ? discovery.page : result;
  const checkpoint = nativeObservation?.as_of;
  const requestOwnerKey = JSON.stringify([stateKey, locale, session]);
  const recoveryOwnerKey = JSON.stringify([requestOwnerKey, readerOwner, checkpoint]);
  const retryFocus = useSearchRetryFocus(
    {
      scope: requestOwnerKey,
      locale,
      session,
      checkpoint,
      ...(nativeObservation ? { observation: nativeObservation } : {}),
      reader: readerOwner,
    },
    data?.recovery?.status !== 'loading',
  );
  const results = (
    <SearchResultsRegion
      key={JSON.stringify([stateKey, locale, session, readerOwner])}
      query={query}
      result={result}
      locale={locale}
      type={type}
      selectedFacets={selectedFacets}
      data={data}
      onRetry={onRetry}
      retryState={committedState}
      recoveryOwnerKey={recoveryOwnerKey}
      onNavigate={(href) => {
        void router?.navigate({ href });
      }}
      retryFocus={retryFocus}
      currentSearchHref={searchHref}
      personal={personal}
      windowNavigation={windowNavigation}
      hrefForState={hrefFor}
      formAction={formAction}
    />
  );
  const navigate = (href: string) => {
    if (!isCurrent()) return;
    void router?.navigate({ href });
  };
  const clearResourceLanguage = () =>
    setDraft((previous) => ({
      ...previous,
      facets: Object.fromEntries(
        Object.entries(previous.facets ?? {}).filter(([property]) => property !== RESOURCE_LANGUAGE_PROPERTY),
      ),
    }));
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    if (!isCurrent()) {
      event.preventDefault();
      return;
    }
    if (composition.isComposing()) {
      event.preventDefault();
      return;
    }
    setDraft((previous) => ({ ...previous, attempted: true }));
    setRevertedKey(undefined);
    if (localIssues.length || invalidRanges.length || invalidScope || router) event.preventDefault();
    if (invalidRanges.length) {
      setRangeDraftState((previous) => ({
        ...previous,
        properties: Object.fromEntries(
          Object.entries(previous.properties).map(([property, range]) => [
            property,
            { ...range, invalid: invalidRanges.includes(property) },
          ]),
        ),
      }));
    }
    if (localIssues.length || invalidRanges.length || invalidScope) {
      const form = event.currentTarget;
      if (advancedDetails.current) advancedDetails.current.open = true;
      requestAnimationFrame(() =>
        form.querySelector<HTMLElement>('[data-condition-errors], [data-search-range-error], [aria-invalid="true"]')?.focus(),
      );
      return;
    }
    if (router) {
      const nextHref = discoverySearchHref(locale, editedState);
      const params = new URL(nextHref, 'https://rezics.invalid').searchParams;
      const action = new URL(formAction ?? `/${locale}/search`, 'https://rezics.invalid');
      for (const [key, value] of params) action.searchParams.append(key, value);
      // Applying equivalent values also finishes raw edits when the URL owner does not change.
      if (nextHref === discoverySearchHref(locale, committedState)) {
        setDraft(createFilterDraft(stateKey, baseline));
        setRangeDraftState(createRangeDraftState(stateKey));
        conditionDraftState.current = undefined;
        setRevertVersion((previous) => previous + 1);
      }
      navigate(`${action.pathname}${action.search}`);
    }
  };
  const invalidInput = (event: React.FormEvent<HTMLFormElement>) => {
    setDraft((previous) => ({ ...previous, attempted: true }));
    if (!(event.target instanceof HTMLElement)) return;
    for (
      let ancestor = event.target.parentElement;
      ancestor && ancestor !== event.currentTarget;
      ancestor = ancestor.parentElement
    )
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
  };
  const revertDraft = () => {
    const expectedKey = stateKey;
    if (latestStateKey.current !== expectedKey) return;
    setDraft((previous) => resetFilterDraft(previous, expectedKey, latestStateKey.current, baseline));
    setRangeDraftState(createRangeDraftState(expectedKey));
    conditionDraftState.current = undefined;
    setRevertVersion((previous) => previous + 1);
    setRevertedKey(expectedKey);
    requestAnimationFrame(() => {
      if (latestStateKey.current === expectedKey) revertStatus.current?.focus();
    });
  };
  const follow = (event: React.MouseEvent<HTMLElement>) => {
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
    if (
      !router ||
      !anchor ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    navigate(anchor.getAttribute('href')!);
  };
  const filterEntrance = (
    <div className="min-w-0 space-y-4 rounded-xl border border-border/60 p-4" onClick={follow}>
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{m.search_heading({}, options)}</p>
          {query && <p className="text-base font-medium wrap-anywhere"><bdi>{query}</bdi></p>}
          <p className="text-sm text-muted-foreground wrap-anywhere">
            {m.access_resource({}, options)}:{' '}
            {currentScope ? (
              <bdi>{`${currentScope.kind} ${currentScope.id}`}</bdi>
            ) : (
              m.header_search_global({}, options)
            )}
          </p>
        </div>
        <Button
          id="search-filter-entry"
          type="button"
          variant="outline"
          className="min-h-11 shrink-0 self-start"
          aria-controls="search-filters"
          aria-expanded={!hydrated || filterSurface !== undefined}
          onClick={openFilters}
        >
          <SlidersHorizontalIcon aria-hidden="true" className="size-4" />
          {m.search_filters({}, options)} ({number.format(activeFilterCount)})
        </Button>
      </div>
      {editing && <p role="status" className="text-sm text-muted-foreground">{filterCopy.pending}</p>}
      {draft.attempted && localIssues.length > 0 && !filterSurface && (
        <p
          role="alert"
          tabIndex={-1}
          data-search-composition-errors
          className="rounded-sm text-sm text-destructive focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {m.search_reader_condition_filter_review({}, options)}
        </p>
      )}
      {constraints.length > 0 && (
        <ul aria-label={filterCopy.current} data-search-constraints className="flex flex-wrap gap-2 border-t border-border/60 pt-3">
          {constraints.map(({ key, text, state, lang, description, descriptionLang }, index) => (
            <li key={key} className="min-w-0 max-w-full">
              <a
                className={cn(
                  buttonVariants({ variant: 'outline', size: 'sm' }),
                  'h-auto min-h-11 max-w-full whitespace-normal py-2',
                )}
                aria-label={m.refinement_remove(
                  {
                    value: m.search_constraint_identity_filter(
                      { number: number.format(index + 1), label: text },
                      options,
                    ),
                  },
                  options,
                )}
                href={hrefFor(state)}
              >
                <span lang={lang} className="min-w-0 text-start wrap-anywhere">
                  <span className="block">
                    {m.search_constraint_identity_filter({ number: number.format(index + 1), label: text }, options)}
                  </span>
                  {description && (
                    <span lang={descriptionLang} className="block pt-1 text-xs text-muted-foreground">
                      {description}
                    </span>
                  )}
                </span>
                <XIcon aria-hidden="true" className="size-3" />
              </a>
            </li>
          ))}
        </ul>
      )}
      {constraints.some(({ details }) => details !== undefined) && (
        <details className="min-w-0 text-sm" data-search-constraint-details>
          <summary className="min-h-11 w-fit max-w-full cursor-pointer rounded-sm py-2 wrap-anywhere focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {m.search_constraint_identity_details({}, options)}
          </summary>
          <dl className="space-y-3 pt-2">
            {constraints.map(({ key, text, details }, index) =>
              details !== undefined ? (
                <div key={key} className="min-w-0 space-y-1">
                  <dt className="font-medium wrap-anywhere">
                    {m.search_constraint_identity_filter({ number: number.format(index + 1), label: text }, options)}
                  </dt>
                  <dd className="min-w-0">
                    <code
                      tabIndex={0}
                      className="block max-w-full rounded-sm select-text whitespace-pre-wrap wrap-anywhere focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      {JSON.stringify(details, null, 2)}
                    </code>
                  </dd>
                </div>
              ) : null,
            )}
          </dl>
        </details>
      )}
    </div>
  );

  const resourceLanguageCurrentness = resourceLanguage?.asOf
    ? m.search_resource_language_current(
        {
          date: new Intl.DateTimeFormat(locale, {
            dateStyle: 'medium',
            timeStyle: 'short',
            timeZone: 'UTC',
          }).format(new Date(resourceLanguage.asOf)),
        },
        options,
      )
    : undefined;
  const filterApplicability =
    data?.refinementApplicability ??
    (data?.discovery?.status === 'ready' ? data.discovery.page.applicability : undefined);
  const kindDirectory =
    data?.discovery?.status === 'ready'
      ? { initial: data.discovery.page.kinds, checkpoint: data.discovery.page.as_of }
      : data?.queryState?.resourceScope?.kind === 'realm' && data.result?.kinds
        ? { initial: data.result.kinds, checkpoint: data.result.as_of }
        : undefined;
  const typeApplicability = filterApplicability?.type ?? 'unknown';
  const statementApplicability = filterApplicability?.statement ?? 'unknown';
  const typeRefinementAvailable = typeApplicability === 'all' || typeApplicability === 'partial';
  const statementRefinementAvailable = statementApplicability === 'all' || statementApplicability === 'partial';
  const selectedTypeCondition = Boolean(type || selectedFacets.type?.length);
  const selectedStatementCondition =
    Object.keys(selectedFacets).some((property) => property !== 'type') ||
    Object.keys(data?.ranges ?? {}).length > 0 ||
    Boolean(draft.condition);
  const ownerOnlyPopulation = typeApplicability === 'none' && statementApplicability === 'none';
  const retainedFilterCondition = ownerOnlyPopulation && Boolean(removeSearchResourceScope(data?.queryState?.filter));
  const retainedUnavailableCondition =
    (selectedTypeCondition && typeApplicability === 'none') ||
    (selectedStatementCondition && statementApplicability === 'none') ||
    retainedFilterCondition;
  const partialRefinement = typeApplicability === 'partial' || statementApplicability === 'partial';
  const unavailableSemanticCondition =
    (selectedTypeCondition && typeApplicability === 'unknown') ||
    (selectedStatementCondition && statementApplicability === 'unknown');
  const filterRefinementProperties = applicableRefinementProperties(
    data?.refinement?.properties ?? [],
    filterApplicability,
  )
    .filter(
      (entry) =>
        (entry.property === 'type' ? typeRefinementAvailable : statementRefinementAvailable) &&
        (entry.mode !== 'types' || selectedFacets.type?.length) &&
        !(
          entry.property === RESOURCE_LANGUAGE_PROPERTY &&
          resourceLanguage?.applicability !== 'applicable' &&
          resourceLanguage?.applicability !== 'partial'
        ),
    )
    .map((entry) =>
      entry.property === RESOURCE_LANGUAGE_PROPERTY
        ? {
            ...entry,
            labels: { ...entry.labels, [locale]: m.search_resource_language({}, options) },
            help: [m.search_resource_language_help({}, options), resourceLanguageCurrentness].filter(Boolean).join(' '),
          }
        : entry,
    )
    .sort((left, right) =>
      left.property === RESOURCE_LANGUAGE_PROPERTY ? -1 : right.property === RESOURCE_LANGUAGE_PROPERTY ? 1 : 0,
    );

  const filterContents = (surface: 'desktop' | 'mobile') => (
    <div className="min-w-0 space-y-5 pt-4">
      <p id={`${applyDescriptionId}-${surface}`} className="text-sm text-muted-foreground">{filterCopy.help}</p>
      <input type="hidden" name="q" value={query} />
      {data?.sort === 'rating' && <input type="hidden" name="sort" value="rating" />}
      {committedState.ratingPopulation && (
        <input type="hidden" name={RATING_POPULATION_FIELD} value={committedState.ratingPopulation} />
      )}
      <div className="space-y-1 rounded-lg bg-muted/40 p-3 lg:hidden">
        <p className="text-xs font-medium text-muted-foreground">{m.search_heading({}, options)}</p>
        {query && <p className="font-medium wrap-anywhere"><bdi>{query}</bdi></p>}
      </div>
      {constraints.length > 0 && (
        <details className="min-w-0 rounded-lg border border-border/60 p-3 lg:hidden">
          <summary className="min-h-10 cursor-pointer content-center font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {filterCopy.current} ({number.format(activeFilterCount)})
          </summary>
          <ul className="space-y-2 pt-2 text-sm text-muted-foreground">
            {constraints.map(({ key, text, lang }) => (
              <li key={key} lang={lang} className="wrap-anywhere">{text}</li>
            ))}
          </ul>
        </details>
      )}
      <section aria-label={m.access_resource({}, options)} className="min-w-0 space-y-4">
        <input type="hidden" name="filter" value={editedState.filter ?? ''} />
        {!fixedResourceScope && (
          <AdvancedScope
            scope={draftScope}
            locale={locale}
            onChange={changeScope}
          />
        )}
        {fixedResourceScope && (
          <p className="text-sm text-muted-foreground wrap-anywhere">
            {m.access_resource({}, options)}: <bdi>{`${fixedResourceScope.kind} ${fixedResourceScope.id}`}</bdi>
          </p>
        )}
        {scopeChanged && <p role="status" className="text-sm text-muted-foreground">{filterCopy.scope}</p>}
      </section>
      {resourceLanguage?.applicability === 'not-applicable' && (type || resourceLanguage.selected.length > 0) && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.search_resource_language_not_applicable({}, options)}
        </p>
      )}
      {resourceLanguage?.applicability === 'unknown' && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.search_resource_language_metadata_unavailable({}, options)}
        </p>
      )}
      {partialRefinement && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.search_refinement_partial({}, options)}
        </p>
      )}
      {ownerOnlyPopulation && !retainedUnavailableCondition && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.search_refinement_owner_only({}, options)}
        </p>
      )}
      {retainedUnavailableCondition && (
        <div role="status" className="space-y-2 text-sm text-muted-foreground">
          <p>{m.search_refinement_not_applicable({}, options)}</p>
          {data?.queryState && (
            <a className={linkClass} href={hrefFor({ ...data.queryState, kinds: undefined, cursor: undefined })}>
              {m.search_kind_navigation_all({}, options)}
            </a>
          )}
        </div>
      )}
      {unavailableSemanticCondition && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.search_refinement_metadata_unavailable({}, options)}
        </p>
      )}
      {resourceLanguage?.applicability !== 'applicable' &&
        resourceLanguage?.applicability !== 'partial' &&
        resourceLanguage?.actions.clear && (
          <Button type="button" variant="outline" size="sm" onClick={clearResourceLanguage}>
            {m.search_resource_language_clear({}, options)}
          </Button>
        )}
      {(draft.languages ?? []).map((tag) => (
        <input key={tag} type="hidden" name="language" value={tag} />
      ))}
      {(!kindDirectory || !data?.queryState) && (
        <RetainedKindSelections
          selected={draft.kinds ?? []}
          loaded={[]}
          known={[
            ...(kindDirectory?.initial.values ?? []),
            ...(kindDirectory?.initial.omitted ?? []),
            ...(result?.kinds?.values ?? []),
            ...(result?.kinds?.omitted ?? []),
          ]}
          locale={locale}
          hydrated={hydrated}
          onRemove={(kind) =>
            setDraft((previous) => ({
              ...previous,
              kinds: previous.kinds?.filter((value) => value !== kind),
            }))
          }
        />
      )}
      {(!data?.refinement || scopeChanged ||
        Object.entries(draftFacets).some(
          ([property]) => !filterRefinementProperties.some((entry) => entry.property === property),
        )) &&
        Object.entries(draftFacets).flatMap(([property, values]) =>
          !data?.refinement || scopeChanged || !filterRefinementProperties.some((entry) => entry.property === property)
            ? values.map((value) => (
                <input key={`${property}:${value}`} type="hidden" name={`f.${property}`} value={value} />
              ))
            : [],
        )}
      {!typeRefinementAvailable && draft.type && <input type="hidden" name="type" value={draft.type} />}
      {(kindDirectory || typeRefinementAvailable) && (
        <section aria-label={m.home_kind_label({}, options)} className="min-w-0 space-y-4 border-t border-border/60 pt-5">
          {kindDirectory && data?.queryState && (
            <DiscoveryKinds
              key={JSON.stringify([data.queryState, locale, session, readerOwner, kindDirectory])}
              initial={kindDirectory.initial}
              checkpoint={kindDirectory.checkpoint}
              locale={locale}
              selected={draft.kinds ?? []}
              onSelectionChange={(kinds) => setDraft((previous) => ({ ...previous, kinds }))}
              hydrated={hydrated}
              onRefresh={onRetry ? () => void onRetry() : undefined}
              onRefreshFocus={retryFocus.captureRetryFocus}
              onRefusalFocus={(source) => retryFocus.captureRetryFocus(source, true)}
              onRefusal={(state) => {
                if (sourceData && currentData.current === sourceData) setInvalidation({ owner: sourceData, state });
              }}
              load={async (kindCursor, signal) => {
                const response = await readKindsWithLocale({
                  data: {
                    ...data.queryState!,
                    facetValues: selectedFacets,
                    locale,
                    kindCursor,
                    ...(searchRequiresCurrentReader(data.queryState!) && session ? { reader: session } : {}),
                  },
                  signal,
                  ...(searchRequiresCurrentReader(data.queryState!)
                    ? { headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' } }
                    : {}),
                });
                return response;
              }}
            />
          )}
          {typeRefinementAvailable && (
            <Field>
              <FieldLabel htmlFor={`${typeControlId}-${surface}`}>{m.search_subject_type({}, options)}</FieldLabel>
              <p className="text-sm text-muted-foreground">{m.search_subject_type_help({}, options)}</p>
              <Select
                name="type"
                value={draft.type || null}
                onValueChange={(nextSelectValue) => {
                  setDraft((previous) => ({ ...previous, type: nextSelectValue || undefined }));
                }}
              >
                <SelectTrigger id={`${typeControlId}-${surface}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={null}>{m.search_all_subject_types({}, options)}</SelectItem>
                    {draft.type && !data?.conditionMetadata?.types[draft.type] && (
                      <SelectItem value={draft.type}>
                        {label(data?.typeLabels, m.search_constraint_identity_kind_unavailable({}, options))}
                      </SelectItem>
                    )}
                    {Object.entries(data?.conditionMetadata?.types ?? {}).map(([id, definition]) => (
                      <SelectItem key={id} value={id}>
                        {label(definition.labels, m.search_constraint_identity_kind_unavailable({}, options))}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          )}
        </section>
      )}
      {data?.refinement && filterRefinementProperties.length > 0 && (
        <section
          aria-label={m.refinement_property({}, options)}
          className="min-w-0 border-t border-border/60 pt-5"
        >
          <h2 className="mb-3 text-sm font-medium">{m.refinement_property({}, options)}</h2>
          <Refinement
            key={`${surface}-${data.refinement.key}`}
            rangeDraftKey={stateKey}
            rangeDraftState={rangeDraftState}
            onRangeDraftChange={(property: string, draft: RangeDraft) =>
              setRangeDraftState((previous) => updateRangeDraft(previous, stateKey, property, draft))
            }
            data={{
              ...data.refinement,
              key: JSON.stringify([data.refinement.key, scopeChanged]),
              properties: scopeChanged
                ? filterRefinementProperties.filter((entry) => entry.mode === 'range')
                : filterRefinementProperties,
            }}
            showSummary={false}
            deferNavigation
            onConditionsChange={(next) => setDraft((previous) => ({ ...previous, facets: next.facetValues }))}
            onNavigate={navigate}
            hrefForConditions={() => hrefFor({ ...committedState, cursor: undefined })}
            clearActions={
              resourceLanguage?.actions.clear
                ? { [RESOURCE_LANGUAGE_PROPERTY]: m.search_resource_language_clear({}, options) }
                : {}
            }
            preserveSelectedWhenUnavailable={[RESOURCE_LANGUAGE_PROPERTY]}
            selectedValueFallbacks={[RESOURCE_LANGUAGE_PROPERTY]}
            selectionLimits={{ [RESOURCE_LANGUAGE_PROPERTY]: RESOURCE_LANGUAGE_SELECTION_LIMIT }}
            conditions={{
              ...(draft.type ? { type: draft.type } : {}),
              facetValues: draftFacets,
              ...(draft.kinds ? { kinds: draft.kinds } : {}),
              ...(draft.languages ? { languages: draft.languages } : {}),
              ...(data.queryState?.filter ? { filter: data.queryState.filter } : {}),
              ...(data.queryState?.resourceScope ? { resourceScope: data.queryState.resourceScope } : {}),
              ...(data.queryState?.ratingPopulation ? { ratingPopulation: data.queryState.ratingPopulation } : {}),
              ranges: draftRanges,
              ...(draft.condition ? { condition: draft.condition } : {}),
            }}
            query={query}
            locale={locale}
            load={async (facets, signal) => {
              const response = await readRefinement({
                data: {
                  query,
                  locale,
                  ...(searchRequiresCurrentReader(data.queryState!) && session ? { reader: session } : {}),
                  conditions: {
                    ...(type ? { type } : {}),
                    facetValues: withoutResourceLanguageSelection({
                      ...committedState,
                      facets: selectedFacets,
                    }).facets,
                    ...(data.queryState?.kinds ? { kinds: data.queryState.kinds } : {}),
                    ...(data.queryState?.languages ? { languages: data.queryState.languages } : {}),
                    ...(data.queryState?.filter ? { filter: data.queryState.filter } : {}),
                    ...(data.queryState?.resourceScope ? { resourceScope: data.queryState.resourceScope } : {}),
                    ...(data.queryState?.ratingPopulation ? { ratingPopulation: data.queryState.ratingPopulation } : {}),
                    ...(data.ranges ? { ranges: data.ranges } : {}),
                    ...(data.condition ? { condition: data.condition } : {}),
                  },
                  facets,
                },
                signal,
                ...(searchRequiresCurrentReader(data.queryState!)
                  ? { headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' } }
                  : {}),
              });
              const state = facetSearchInvalidation(response);
              if (!signal.aborted && sourceData && currentData.current === sourceData && state)
                setInvalidation({ owner: sourceData, state });
              return response;
            }}
            {...(data.sort === 'rating' ? { sort: 'rating' as const } : {})}
          />
        </section>
      )}
      {statementRefinementAvailable ? (
        <details
          ref={advancedDetails}
          open={
            surface === 'desktop' ||
            Boolean(draft.condition) ||
            Boolean(draft.languages?.length) ||
            issues.length > 0 ||
            !data?.conditionMetadata
          }
          className="min-w-0 border-t border-border/60 pt-5"
        >
          <summary className="min-h-11 cursor-pointer content-center rounded-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {m.condition_heading({}, options)}
          </summary>
          <div className="pt-3">
            <ConditionEditor
              key={`${stateKey}-${revertVersion}`}
              draftState={conditionDraftState}
              onDraftInput={() => setDraft((previous) => ({ ...previous }))}
              requestIdentity={JSON.stringify([stateKey, session])}
              value={draft.condition}
              onChange={(condition) => setDraft((previous) => ({ ...previous, condition }))}
              metadata={data?.conditionMetadata}
              conceptLookup={conceptLookup}
              preventImplicitSubmit={composition.preventImplicitSubmit}
              locale={locale}
              entityLookup={conditionEntityLookupContext(data, locale, session)}
              issues={issues}
              values={Object.fromEntries(
                data?.refinement?.initial?.status === 'ready'
                  ? data.refinement.initial.page.facets.map(({ property, values }) => [property, values])
                  : [],
              )}
              languages={draft.languages}
              onLanguages={(languages) => setDraft((previous) => ({ ...previous, languages }))}
              showApply={false}
              framed={false}
              showHeading={false}
            />
          </div>
        </details>
      ) : draft.condition ? (
        <input type="hidden" name="condition" value={JSON.stringify(draft.condition)} />
      ) : null}
      {!data?.conditionMetadata && (
        <a className={linkClass} href={hrefFor(committedState)}>
          {m.search_facet_retry({}, options)}
        </a>
      )}
      {data?.queryState?.filter && <p className="text-sm text-muted-foreground">{m.condition_retained({}, options)}</p>}
      {Object.entries(draftRanges).map(([property, range]) => (
        <input key={property} type="hidden" name={`r.${property}`} value={JSON.stringify(range)} />
      ))}
      {draft.attempted && invalidRanges.length > 0 && (
        <div role="alert" tabIndex={-1} data-search-range-error className="text-sm text-destructive">
          <p>{m.refinement_invalid_range({}, options)}</p>
          <ul>
            {invalidRanges.map((property) => (
              <li key={property}>
                {label(data?.conditionMetadata?.properties[property]?.labels, property)}{' '}
                <code className="break-all">{property}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div
        role="group"
        aria-label={filterCopy.apply}
        className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-2 border-t border-border/60 bg-background/95 px-4 py-3 backdrop-blur lg:static lg:mx-0 lg:px-0"
      >
        <Button type="submit" aria-describedby={`${applyDescriptionId}-${surface}`}>{filterCopy.apply}</Button>
        {(editing || draft.attempted) && (
          <Button type="button" variant="outline" onClick={revertDraft}>
            {m.search_filter_revert_action({}, options)}
          </Button>
        )}
      </div>
      <p
        ref={revertStatus}
        role="status"
        aria-live="polite"
        tabIndex={-1}
        className="rounded-sm text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {!editing && revertedKey === stateKey ? m.search_filter_revert_status({}, options) : ''}
      </p>
    </div>
  );

  const desktopOpen = !hydrated || filterSurface === 'desktop';
  const filterControls = (
    <>
      {desktopOpen && (
        <div
          id="search-filters"
          ref={desktopPanel}
          role="region"
          aria-label={m.search_filters({}, options)}
          tabIndex={-1}
          className="min-w-0 rounded-xl border border-border/60 p-4"
          onKeyDown={(event) => {
            if (event.defaultPrevented || composition.isComposing(event)) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              closeFilters();
            }
          }}
          onClick={follow}
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-medium">{m.search_filters({}, options)}</h2>
            <Button type="button" variant="ghost" hidden={!hydrated} onClick={closeFilters}>
              {m.search_close_filters({}, options)}
            </Button>
          </div>
          <form
            key={stateKey}
            {...composition.handlers}
            id="desktop-filter-form"
            method="get"
            onSubmit={submit}
            onInvalidCapture={invalidInput}
            action={formAction ?? `/${locale}/search`}
          >
            {filterContents('desktop')}
          </form>
        </div>
      )}
      {filterSurface === 'mobile' && (
        <BottomSheet
          open
          onOpenChange={(open) => {
            if (!open) closeFilters();
          }}
          closeLabel={m.search_close_filters({}, options)}
          title={`${m.search_filters({}, options)} (${number.format(activeFilterCount)})`}
        >
          <form
            key={stateKey}
            {...composition.handlers}
            id="search-filters"
            method="get"
            action={formAction ?? `/${locale}/search`}
            onSubmit={submit}
            onInvalidCapture={invalidInput}
            onClick={follow}
          >
            {filterContents('mobile')}
          </form>
        </BottomSheet>
      )}
    </>
  );

  if (filtersOnly) {
    if (!hasFilterPanel) return null;
    return (
      <div className="w-full space-y-4">
        {filterEntrance}
        {filterControls}
      </div>
    );
  }

  const browsing = isRealmDiscoverySearch(committedState) && !result && !discovery && !data?.recovery;
  const textError = data?.recovery?.status === 'invalid' ? data.recovery.textError : undefined;
  const content =
    textError && textError.query === query && committedState.query === query ? (
      <QueryTextRecovery
        key={JSON.stringify([stateKey, locale, session])}
        value={query}
        diagnostic={textError.diagnostic}
        locale={locale}
        retryAt={data?.recovery && 'retryAt' in data.recovery ? data.recovery.retryAt : undefined}
        onApply={(value) => {
          void router?.navigate({
            href: hrefFor({ ...committedState, query: value, cursor: undefined }),
          });
        }}
      />
    ) : browsing ? (
      <SearchRealmDiscovery
        key={JSON.stringify([locale, stateKey, realmDiscovery])}
        initial={realmDiscovery ?? { kind: 'loading' }}
        locale={locale}
        {...(realmDiscoveryRead ? { read: realmDiscoveryRead } : {})}
      />
    ) : (
      results
    );

  return (
    <section className="mx-auto max-w-7xl space-y-6">
      {heading ?? <PageHeading>{m.search_heading({}, options)}</PageHeading>}
      {hasFilterPanel ? (
        <>
          {filterEntrance}
          <div className={cn('grid min-w-0 items-start gap-6', desktopOpen && 'lg:grid-cols-[minmax(20rem,24rem)_minmax(0,1fr)]')}>
            {filterControls}
            <div className="min-w-0 space-y-4">
              {!embedded && data?.recovery?.status === 'ready' && data.queryState && (
                <QuerySharePreview
                  key={JSON.stringify([stateKey, locale, session])}
                  locale={locale}
                  changed={editing}
                  prepare={(signal) =>
                    prepareShareWithLocale({
                      signal,
                      data: {
                        query: committedState.query,
                        locale,
                        facetValues: committedState.facets,
                        type: committedState.type,
                        kinds: committedState.kinds,
                        languages: committedState.languages,
                        condition: committedState.condition,
                        ranges: committedState.ranges,
                        filter: committedState.filter,
                        sort: committedState.sort,
                        resourceScope: committedState.resourceScope,
                        ratingPopulation: committedState.ratingPopulation,
                        reader: session ?? undefined,
                      },
                    })
                  }
                />
              )}
              {content}
            </div>
          </div>
        </>
      ) : (
        content
      )}
    </section>
  );
}

/** Search-owned Realm catalogue section mounted by the existing Realm page composition. */
export function RealmCatalogueSearch({
  realmId,
  locale,
  isCurrent,
}: {
  realmId: string;
  locale: string;
  isCurrent: () => boolean;
}) {
  const location = useLocation();
  const browserSession = useSession();
  const reader = searchSessionOwner(browserSession);
  const search = location.search as Record<string, unknown>;
  const queryState = realmCatalogueSearchLoaderDeps(search, realmId);
  const resourceScope = queryState.resourceScope!;
  const pathname = location.pathname;
  const publicPathname = new URL(location.publicHref, 'https://rezics.invalid').pathname;
  const pageSearch = new URLSearchParams();
  if (search.node === 'boards' || search.node === 'publications') pageSearch.set('node', search.node);
  if (typeof search.cursor === 'string' && search.cursor) pageSearch.set('cursor', search.cursor);
  const action = `${publicPathname}${pageSearch.size ? `?${pageSearch}` : ''}`;
  const hrefForState = (state: SearchLoaderDeps) => {
    const url = new URL(
      discoverySearchHref(locale, state, { pathname: publicPathname, cursorParam: 'searchCursor' }),
      'https://rezics.invalid',
    );
    if (search.node === 'boards' || search.node === 'publications') url.searchParams.set('node', search.node);
    if (typeof search.cursor === 'string' && search.cursor) url.searchParams.set('cursor', search.cursor);
    url.hash = 'search-results';
    return `${url.pathname}${url.search}${url.hash}`;
  };
  const currentHref = hrefForState(queryState);
  const heading = (
    <h2 className="text-xl font-semibold">{m.realm_catalogue_works_heading({}, messageOptions(locale))}</h2>
  );
  if (searchRequiresCurrentReader(queryState) && !reader)
    return (
      <SearchPage
        query={queryState.query}
        data={{ ...searchUnavailablePage(queryState), recovery: { status: 'session' } }}
        locale={locale}
        session={null}
        searchHref={currentHref}
        fixedResourceScope={resourceScope}
        hrefForState={hrefForState}
        formAction={action}
        heading={heading}
        embedded
        isCurrent={isCurrent}
      />
    );
  return (
    <LoadedRealmCatalogueSearch
      key={searchSessionLifetime(locale, { ...queryState, cursor: undefined }, reader ?? undefined)}
      queryState={queryState}
      locale={locale}
      {...(reader ? { reader } : {})}
      pathname={pathname}
      searchHref={currentHref}
      hrefForState={hrefForState}
      formAction={action}
      heading={heading}
      isCurrent={isCurrent}
    />
  );
}

function LoadedRealmCatalogueSearch({
  queryState,
  locale,
  reader,
  pathname,
  searchHref,
  hrefForState,
  formAction,
  heading,
  isCurrent,
}: {
  queryState: SearchLoaderDeps;
  locale: string;
  reader?: string;
  pathname: string;
  searchHref: string;
  hrefForState: (state: SearchLoaderDeps) => string;
  formAction: string;
  heading: ReactNode;
  isCurrent: () => boolean;
}) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    setActive(isCurrent());
  }, [isCurrent]);
  const { data, readerOwner, retry } = useSearchQuery(
    locale,
    queryState,
    reader,
    {
      pathname,
      cursorParam: 'searchCursor',
      realmId: queryState.resourceScope!.id,
    },
    active,
  );
  const retained = useRef<{ owner: string; page: SearchPageData } | undefined>(undefined);
  if (retained.current?.owner !== readerOwner) retained.current = undefined;
  if (data.recovery?.status === 'ready') retained.current = { owner: readerOwner, page: data };
  else if (!['loading', 'unavailable', 'index-not-ready', 'source-not-ready'].includes(data.recovery?.status ?? ''))
    retained.current = undefined;
  const visible = realmCatalogueWindow(data, retained.current?.page);
  return (
    <SearchPage
      query={queryState.query}
      data={visible}
      locale={locale}
      session={reader ?? null}
      readerOwner={readerOwner}
      searchHref={searchHref}
      onRetry={() => {
        if (isCurrent()) retry();
      }}
      fixedResourceScope={queryState.resourceScope}
      hrefForState={hrefForState}
      formAction={formAction}
      heading={heading}
      embedded
      isCurrent={isCurrent}
    />
  );
}

// Retain current callers while the reusable region owns the only query implementation.
export { ShellSearch } from './header-search/shell-search';
export { ScopeChip } from './header-search/scope-chip';
export type { SearchScope, SearchScopeKind } from './header-search/types';
