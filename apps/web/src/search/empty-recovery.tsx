import { useState, type FormEvent } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import { localizedLabel } from './results.tsx';
import { discoverySearchHref, type SearchLoaderDeps } from './search-params';
import type { EmptyRecovery } from './discovery';

type Labels = Pick<SearchPageDataLike, 'typeLabels' | 'typeChoices' | 'selectedFacetLabels' | 'groups'>;
type SearchPageDataLike = {
  typeLabels?: Record<string, string>;
  typeChoices: { id: string; labels: Record<string, string> }[];
  selectedFacetLabels: Record<string, Record<string, { text: string; lang?: string }>>;
  groups: { property: string; labels: Record<string, string> }[];
};
type Action = EmptyRecovery['actions'][number];
type ActionLink = { key: string; label: string; href: string };

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
        href: focused(discoverySearchHref(locale, firstPage), 'empty-recovery-query'),
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
      const value = labels.selectedFacetLabels[action.property]?.[action.value]?.text ?? action.value;
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
  onRetry,
}: {
  recovery: EmptyRecovery;
  state: SearchLoaderDeps;
  locale: string;
  labels: Labels;
  onRetry?: (() => void) | undefined;
}) {
  const options = messageOptions(locale);
  const [query, setQuery] = useState(state.query);
  const actions = emptyRecoveryActionLinks(locale, state, recovery.actions, labels);
  const suggestions = recovery.alternatives.map((alternative) => ({
    ...alternative,
    href: emptyRecoveryAlternativeHref(locale, state, alternative.query),
  }));
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    window.location.assign(discoverySearchHref(locale, { ...state, query, cursor: undefined }));
  }

  return (
    <section aria-labelledby="search-empty-recovery-title" className="mt-4">
      <Empty className="border" role="status">
        <EmptyHeader>
          <EmptyTitle id="search-empty-recovery-title" className="text-base font-medium">
            {m.search_empty_recovery_heading({}, options)}
          </EmptyTitle>
          <EmptyDescription>{m.search_empty_recovery_help({}, options)}</EmptyDescription>
        </EmptyHeader>
        {actions.some((action) => action.key === 'edit-query') ? (
          <form className="flex w-full flex-wrap gap-2" onSubmit={submit}>
            <label className="sr-only" htmlFor="empty-recovery-query">
              {m.search_empty_edit_phrase({}, options)}
            </label>
            <input
              id="empty-recovery-query"
              className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
            <Button type="submit" size="sm">
              {m.search_empty_search({}, options)}
            </Button>
          </form>
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
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {m.search_facet_retry({}, options)}
          </Button>
        ) : null}
      </Empty>
    </section>
  );
}
