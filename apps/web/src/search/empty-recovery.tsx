import { useEffect, useId, useRef, useState } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import { localizedLabel } from './results.tsx';
import { discoverySearchHref, type SearchLoaderDeps } from './search-params';
import { QueryTextRecovery } from './query-text-recovery';
import type { EmptyRecovery } from './discovery';

type Labels = Pick<SearchPageDataLike, 'typeLabels' | 'typeChoices' | 'selectedFacetLabels' | 'groups'>;
type SearchPageDataLike = {
  typeLabels?: Record<string, string>;
  typeChoices: { id: string; labels: Record<string, string> }[];
  selectedFacetLabels: Record<string, Record<string, string>>;
  groups: { property: string; labels: Record<string, string> }[];
};
type Action = EmptyRecovery['actions'][number];
type ActionLink = { key: string; label: string; href: string };
type RecoveryOwner = { key: string; observation: object; recovery: EmptyRecovery };
type RecoveryVisit = { owner: RecoveryOwner; revision: number; retrying: boolean };

function sameOwner(left: RecoveryOwner, right: RecoveryOwner): boolean {
  return left.key === right.key && left.observation === right.observation && left.recovery === right.recovery;
}

function messageOptions(locale: string) {
  return { locale: locales.find((value) => value === locale) ?? 'en' };
}

function focused(href: string, target: string): string {
  return `${href}#${target}`;
}

/** Project only URL-owned selectors; opaque filters, scope, rating population and ordered languages stay intact. */
export function emptyRecoveryActionLinks(
  locale: string,
  state: SearchLoaderDeps,
  actions: readonly Action[],
  labels: Labels,
  queryTarget = 'empty-recovery-query',
): ActionLink[] {
  const options = messageOptions(locale);
  const firstPage = { ...state, cursor: undefined };
  const typeLabel = state.type ? localizedLabel(labels.typeLabels ?? {}, locale).text || state.type : '';
  const propertyLabel = (property: string) =>
    localizedLabel(labels.groups.find((group) => group.property === property)?.labels ?? {}, locale).text || property;
  const result: ActionLink[] = [];
  for (const action of actions) {
    if (action.kind === 'edit-query') {
      result.push({
        key: action.kind,
        label: m.search_empty_edit_phrase({}, options),
        href: focused(discoverySearchHref(locale, firstPage), queryTarget),
      });
      continue;
    }
    if (action.kind === 'remove-type' && state.type) {
      result.push({
        key: action.kind,
        label: m.search_empty_remove_type({ type: typeLabel }, options),
        href: focused(discoverySearchHref(locale, { ...firstPage, type: undefined }), 'search-filter-entry'),
      });
      continue;
    }
    if (action.kind === 'remove-kind' && state.kinds?.includes(action.value)) {
      const selected = labels.typeChoices.find((item) => item.id === action.value);
      const label = localizedLabel(selected?.labels ?? {}, locale).text || action.value;
      const kinds = state.kinds.filter((value) => value !== action.value);
      result.push({
        key: JSON.stringify(action),
        label: m.search_empty_remove_kind({ kind: label }, options),
        href: focused(
          discoverySearchHref(locale, { ...firstPage, kinds: kinds.length ? kinds : undefined }),
          'search-filter-entry',
        ),
      });
      continue;
    }
    if (action.kind === 'remove-facet' && state.facets[action.property]?.includes(action.value)) {
      const facets = { ...state.facets };
      const remaining = facets[action.property]!.filter((value) => value !== action.value);
      if (remaining.length) facets[action.property] = remaining;
      else delete facets[action.property];
      const value = labels.selectedFacetLabels[action.property]?.[action.value] ?? action.value;
      result.push({
        key: JSON.stringify(action),
        label: m.search_empty_remove_facet({ value }, options),
        href: focused(discoverySearchHref(locale, { ...firstPage, facets }), 'search-filter-entry'),
      });
      continue;
    }
    if (action.kind === 'remove-range' && state.ranges?.[action.property]) {
      const ranges = { ...state.ranges };
      delete ranges[action.property];
      const { ranges: _ranges, ...withoutRanges } = firstPage;
      const nextPage = Object.keys(ranges).length ? { ...withoutRanges, ranges } : withoutRanges;
      result.push({
        key: JSON.stringify(action),
        label: m.search_empty_remove_range({ property: propertyLabel(action.property) }, options),
        href: focused(discoverySearchHref(locale, nextPage), 'search-filter-entry'),
      });
    }
  }
  return result;
}

export function emptyRecoveryAlternativeHref(locale: string, state: SearchLoaderDeps, query: string): string {
  return discoverySearchHref(locale, { ...state, query, cursor: undefined });
}

export function EmptySearchRecovery({
  recovery,
  state,
  locale,
  labels,
  ownerKey,
  observation,
  onNavigate,
  onRetry,
  retryRef,
  onRetryFocus,
}: {
  recovery: EmptyRecovery;
  state: SearchLoaderDeps;
  locale: string;
  labels: Labels;
  ownerKey?: string | undefined;
  observation?: object | undefined;
  onNavigate?: ((href: string) => void) | undefined;
  onRetry?: (() => PromiseLike<unknown> | void) | undefined;
  retryRef?: { current: HTMLButtonElement | null } | undefined;
  onRetryFocus?: ((source: HTMLButtonElement) => void) | undefined;
}) {
  const options = messageOptions(locale);
  const ids = useId().replaceAll(':', '');
  const queryId = `empty-recovery-query-${ids}`;
  const headingId = `search-empty-recovery-title-${ids}`;
  const currentOwner: RecoveryOwner = {
    key: ownerKey ?? JSON.stringify([locale, state]),
    observation: observation ?? recovery,
    recovery,
  };
  const [visit, setVisit] = useState<RecoveryVisit>(() => ({ owner: currentOwner, revision: 0, retrying: false }));
  const retryLock = useRef<{ owner: RecoveryOwner; active: boolean }>({ owner: currentOwner, active: false });
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (!sameOwner(visit.owner, currentOwner)) {
    retryLock.current = { owner: currentOwner, active: false };
    setVisit({ owner: currentOwner, revision: visit.revision + 1, retrying: false });
  }
  const currentVisit = sameOwner(visit.owner, currentOwner)
    ? visit
    : { owner: currentOwner, revision: visit.revision + 1, retrying: false };
  const actions = emptyRecoveryActionLinks(locale, state, recovery.actions, labels, queryId);
  const suggestions = recovery.alternatives.map((alternative) => ({
    ...alternative,
    href: emptyRecoveryAlternativeHref(locale, state, alternative.query),
  }));
  function retry() {
    const owner = retryLock.current.owner;
    if (!onRetry || retryLock.current.active) return;
    retryLock.current.active = true;
    setVisit((previous) => (sameOwner(previous.owner, owner) ? { ...previous, retrying: true } : previous));
    const completion = onRetry();
    if (completion !== undefined)
      void Promise.resolve(completion).finally(() => {
        if (!mounted.current || !sameOwner(retryLock.current.owner, owner) || !retryLock.current.active) return;
        retryLock.current.active = false;
        setVisit((previous) => (sameOwner(previous.owner, owner) ? { ...previous, retrying: false } : previous));
      });
  }

  return (
    <section aria-labelledby={headingId} className="mt-4">
      <Empty className="border" role="status">
        <EmptyHeader>
          <EmptyTitle id={headingId} className="text-base font-medium">
            {m.search_empty_recovery_heading({}, options)}
          </EmptyTitle>
          <EmptyDescription>{m.search_empty_recovery_help({}, options)}</EmptyDescription>
        </EmptyHeader>
        {actions.some((action) => action.key === 'edit-query') ? (
          <QueryTextRecovery
            key={currentVisit.revision}
            value={state.query}
            locale={locale}
            control="search"
            controlId={queryId}
            compact
            label={m.search_empty_edit_phrase({}, options)}
            applyLabel={m.search_empty_search({}, options)}
            onApply={(query) => onNavigate?.(emptyRecoveryAlternativeHref(locale, state, query))}
          />
        ) : null}
        {actions.some((action) => action.key !== 'edit-query') ? (
          <ul aria-label={m.search_empty_remove_actions({}, options)} className="flex w-full flex-wrap gap-2">
            {actions
              .filter((action) => action.key !== 'edit-query')
              .map((action) => (
                <li key={action.key}>
                  <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={action.href}>
                    {action.label}
                  </a>
                </li>
              ))}
          </ul>
        ) : null}
        {recovery.status !== 'ready' ? (
          <p role="status" className="w-full text-sm text-muted-foreground">
            {recovery.status === 'preparing'
              ? m.search_empty_alternatives_preparing({}, options)
              : m.search_empty_alternatives_unavailable({}, options)}
          </p>
        ) : suggestions.length ? (
          <div className="w-full">
            <h3 className="mb-2 font-medium text-sm">{m.search_empty_nearby_titles({}, options)}</h3>
            <ul className="grid gap-2">
              {suggestions.map((suggestion) => (
                <li key={`${suggestion.query}:${suggestion.label}`}>
                  <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={suggestion.href}>
                    {m.search_empty_try_query({ query: suggestion.label }, options)}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="w-full text-sm text-muted-foreground">{m.search_empty_no_alternatives({}, options)}</p>
        )}
        {recovery.status !== 'ready' && onRetry ? (
          <Button
            ref={retryRef}
            type="button"
            variant="outline"
            size="sm"
            disabled={currentVisit.retrying}
            onClick={(event) => {
              onRetryFocus?.(event.currentTarget);
              retry();
            }}
          >
            {m.search_facet_retry({}, options)}
          </Button>
        ) : null}
      </Empty>
    </section>
  );
}
