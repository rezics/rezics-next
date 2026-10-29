import { admitFilter, facetProperties, FILTER_LIMITS, type FilterDocument, type FilterRelease } from '@rezics/filter';
import { createServerFn } from '@tanstack/react-start';
import type { KernelClient } from '@rezics/client';
import { Cover, sharedRatio } from '@rezics/ui/cover';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@rezics/ui/shadcn/collapsible';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from '@rezics/ui/shadcn/drawer';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@rezics/ui/shadcn/combobox';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { FieldLegend, FieldSet } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Label } from '@rezics/ui/shadcn/label';
import { Separator } from '@rezics/ui/shadcn/separator';
import { cn } from '@rezics/ui/utils';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { kernelClient } from '../kernel/client.ts';
import { requestLanguages } from '../kernel/languages.ts';
import { coverSrc } from '../media/cover-src';
import { coverOf, coverSubject } from '../media/summary';
import { subjectHref } from '../subject/subject-href';
import { readRelease, type Release } from '../subject/definitions.ts';
import { PageHeading } from '../shell/page-heading';
import { fieldLabel } from '../features/pages/shared';
import { hitYear, localizedLabel, ResultList, SubjectMeta, type Fact, type ResultHit } from './results.tsx';
import type { SuggestionResult } from './suggestions.ts';
type SearchBody = Parameters<KernelClient['subjects']['$search']['post']>[0] & {
  descriptions?: boolean;
  languages?: string[];
  properties?: string[];
};
type SearchData = NonNullable<Awaited<ReturnType<KernelClient['subjects']['$search']['post']>>['data']>;
type SearchResult = Omit<SearchData, 'subjects'> & {
  subjects: (SearchData['subjects'][number] & {
    descriptions?: Record<string, string>;
    facts?: Record<string, Fact[]>;
  } & Pick<ResultHit, 'summary'>)[];
};
type FacetBody = Parameters<KernelClient['subjects']['$facets']['post']>[0] & { languages?: string[] };
type FacetResult = {
  facets: {
    property: string;
    relation: 'exact' | 'lower_bound';
    values: { value: string; count: number; labels: Record<string, string> }[];
  }[];
  total: { value: number; relation: 'exact' | 'lower_bound' };
  as_of: string;
};
type SearchParams = {
  query: string;
  locale: string;
  cursor?: string;
  type?: string;
  facetValues: Record<string, string[]>;
};
type SearchPageData = {
  result?: SearchResult;
  type?: string;
  typeLabels?: Record<string, string>;
  hitTypes: Record<string, Record<string, string>>;
  /** The properties whose time values give a hit its year, in the order the search asked for them. */
  yearProperties: string[];
  typeChoices: { id: string; labels: Record<string, string>; count?: number }[];
  groups: {
    property: string;
    labels: Record<string, string>;
    values: {
      value: string;
      count: number;
      labels: Record<string, string>;
      parentTypeLabels?: Record<string, string>;
    }[];
  }[];
  selectedFacets: Record<string, string[]>;
  selectedFacetLabels: Record<string, Record<string, string>>;
  facetsAvailable: boolean;
};
/** At most this many facet properties are asked for on a single-type search. */
const FACT_PROPERTIES = 2;
/** At most this many time properties are asked for to give hits their year. */
const YEAR_PROPERTIES = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function allowedType(release: Release, type: unknown): type is string {
  return typeof type === 'string' && Object.hasOwn(release.types, type) && isRecord(release.types[type]);
}

function parentTypeLabels(release: Release, type: string): Record<string, string> | undefined {
  if (!allowedType(release, type)) return;
  const bases = release.types[type]?.bases;
  if (!Array.isArray(bases)) return;
  for (const base of bases) {
    if (allowedType(release, base)) return release.types[base]?.labels ?? {};
  }
}

/** Properties whose values a result row can show: items, years, quantities and codes with a declared pattern. */
function factProperties(release: Release, type: string): string[] {
  return facetProperties(release, [type])
    .filter((property) => {
      const definition = Object.hasOwn(release.properties, property) ? release.properties[property] : undefined;
      if (!definition) return false;
      if (['wikibase-item', 'time', 'quantity'].includes(definition.datatype)) return true;
      return definition.datatype === 'string' && !!definition.value?.pattern;
    })
    .slice(0, FACT_PROPERTIES);
}

/**
 * Time properties that give a hit its year: the type's own first one, or on a search across types the first of
 * every returnable type, so each result can show a year without more than four properties in the request.
 */
function yearProperties(release: Release, type?: string): string[] {
  const candidates = type
    ? facetProperties(release, [type])
    : Object.keys(release.types).flatMap((id) => facetProperties(release, [id]));
  const found = new Set<string>();
  for (const property of candidates) {
    if (found.size >= (type ? 1 : YEAR_PROPERTIES)) break;
    const definition = Object.hasOwn(release.properties, property) ? release.properties[property] : undefined;
    if (definition?.datatype === 'time') found.add(property);
  }
  return [...found];
}

function selectedFilters(
  release: Release,
  type: string,
  requested: Record<string, string[]>,
): { selected: Record<string, string[]>; filter: FilterDocument } {
  const allowedProperties = facetProperties(release, [type]);
  const selected: Record<string, string[]> = {};
  const clauses: FilterDocument[] = [{ type: { in: [type] } }];

  for (const property of allowedProperties) {
    if (clauses.length >= FILTER_LIMITS.leaves) break;
    if (!Object.hasOwn(requested, property) || !Object.hasOwn(release.properties, property)) continue;
    const values = requested[property];
    if (!Array.isArray(values)) continue;
    const accepted: string[] = [];
    for (const value of values.slice(0, FILTER_LIMITS.in)) {
      if (typeof value !== 'string' || accepted.includes(value)) continue;
      try {
        admitFilter(
          {
            and: [{ type: { in: [type] } }, { statement: { property, in: [value] } }],
          },
          release,
          { saved: false },
        );
        accepted.push(value);
      } catch {
        // Only values accepted by the definitions release can enter the kernel filter.
      }
    }
    if (accepted.length === 0) continue;
    selected[property] = accepted;
    clauses.push({ statement: { property, in: accepted } });
  }

  const filter: FilterDocument = { and: clauses };
  return { selected, filter: admitFilter(filter, release, { saved: false }) };
}

const readSearchWithLocale = createServerFn({ method: 'GET' })
  .validator((input: unknown): SearchParams => {
    if (!isRecord(input) || typeof input.query !== 'string' || input.query.length > 256)
      throw new Error('Invalid search');
    if (typeof input.locale !== 'string' || input.locale.length === 0 || input.locale.length > 35)
      throw new Error('Invalid locale');
    if (input.cursor !== undefined && typeof input.cursor !== 'string') throw new Error('Invalid cursor');
    if (input.type !== undefined && typeof input.type !== 'string') throw new Error('Invalid type');
    const facetValues: Record<string, string[]> = Object.create(null);
    if (isRecord(input.facetValues)) {
      for (const [property, values] of Object.entries(input.facetValues).slice(0, FILTER_LIMITS.leaves)) {
        if (typeof values === 'string') facetValues[property] = [values];
        else if (Array.isArray(values))
          facetValues[property] = values
            .slice(0, FILTER_LIMITS.in)
            .filter((value): value is string => typeof value === 'string');
      }
    }
    return {
      query: input.query,
      locale: input.locale,
      ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
      ...(typeof input.type === 'string' ? { type: input.type } : {}),
      facetValues,
    };
  })
  .handler(async ({ data }): Promise<SearchPageData> => {
    let release: Release | undefined;
    try {
      release = await readRelease();
    } catch {
      release = undefined;
    }

    const type = release && allowedType(release, data.type) ? data.type : undefined;
    const selected = release && type ? selectedFilters(release, type, data.facetValues) : undefined;
    const filter = selected?.filter;
    const hasSearch = data.query.length > 0 || type !== undefined;
    const languages = requestLanguages(data.locale);
    const years = release ? yearProperties(release, type) : [];
    const properties = release ? [...new Set([...(type ? factProperties(release, type) : []), ...years])] : [];
    const searchPromise: Promise<SearchResult | undefined> = hasSearch
      ? (async () => {
          const body: SearchBody = {
            ...(data.query ? { text: data.query } : {}),
            limit: 100,
            descriptions: true,
            languages,
            ...(properties.length > 0 ? { properties } : {}),
            ...(data.cursor ? { cursor: data.cursor } : {}),
            ...(filter ? { filter } : {}),
          };
          const response = await kernelClient(data.locale).subjects.$search.post(body);
          if (response.error) throw new Error('Search failed');
          return response.data as SearchResult;
        })()
      : Promise.resolve(undefined);

    const facetPropertiesForType = release && type ? facetProperties(release, [type]).slice(0, 8) : [];
    const facetBody: FacetBody = {
      ...(data.query ? { text: data.query } : {}),
      ...(filter ? { filter } : {}),
      languages,
      facets: facetPropertiesForType.map((property) => ({ property, size: 10 })),
    };
    const facetsPromise: Promise<FacetResult | null | undefined> =
      release && type && facetPropertiesForType.length > 0
        ? kernelClient(data.locale)
            .subjects.$facets.post(facetBody)
            .then((response) => {
              if (response.error) return null;
              return response.data as FacetResult;
            })
            .catch(() => null)
        : Promise.resolve(undefined);

    const typeChoices = release
      ? Object.entries(release.types)
          .filter(
            ([, definition]) =>
              isRecord(definition) && Array.isArray(definition.facets) && definition.facets.length > 0,
          )
          .map(([id, definition]) => ({ id, labels: definition.labels ?? {} }))
      : [];
    const typeBody: FacetBody = { text: data.query, languages, facets: [{ property: 'type', size: 20 }] };
    // The count of each type among the matches, when the facets read has one; without it the types are listed by name.
    const typeFacetPromise: Promise<Map<string, { count: number; labels: Record<string, string> }> | null> =
      release && !type && data.query && typeChoices.length > 0
        ? kernelClient(data.locale)
            .subjects.$facets.post(typeBody)
            .then((response) => {
              if (response.error) return null;
              return new Map(
                (response.data as FacetResult).facets
                  .find((facet) => facet.property === 'type')
                  ?.values.map((entry): [string, { count: number; labels: Record<string, string> }] => [
                    entry.value,
                    { count: entry.count, labels: entry.labels },
                  ]) ?? [],
              );
            })
            .catch(() => null)
        : Promise.resolve(null);

    const [result, facetResult, typeFacets] = await Promise.all([searchPromise, facetsPromise, typeFacetPromise]);
    const facetsAvailable = !release || !type || facetResult !== null;
    const valuesByProperty = new Map((facetResult?.facets ?? []).map((facet) => [facet.property, facet.values]));
    const groups =
      release && type && facetResult
        ? facetPropertiesForType.map((property) => ({
            property,
            labels: release!.properties[property]?.labels ?? {},
            values: (valuesByProperty.get(property) ?? []).map((entry) => {
              const parentLabels = parentTypeLabels(release!, entry.value);
              return { ...entry, ...(parentLabels ? { parentTypeLabels: parentLabels } : {}) };
            }),
          }))
        : [];
    const hitTypes: Record<string, Record<string, string>> = {};
    if (release)
      for (const subject of result?.subjects ?? [])
        if (allowedType(release, subject.type)) hitTypes[subject.type] = release.types[subject.type]?.labels ?? {};
    // One entry per type term, never merged by name: the most matches first, then by name in the reader's language.
    const collator = new Intl.Collator(data.locale);
    const orderedTypes = typeChoices
      .map((choice) => {
        const facet = typeFacets?.get(choice.id);
        const labels = facet && Object.keys(facet.labels).length > 0 ? facet.labels : choice.labels;
        return { ...choice, labels, ...(facet ? { count: facet.count } : {}) };
      })
      .sort(
        (left, right) =>
          (right.count ?? 0) - (left.count ?? 0) ||
          collator.compare(
            localizedLabel(left.labels, data.locale).text || left.id,
            localizedLabel(right.labels, data.locale).text || right.id,
          ) ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      );

    return {
      ...(result ? { result } : {}),
      ...(type ? { type } : {}),
      ...(type && release ? { typeLabels: release.types[type]?.labels ?? {} } : {}),
      hitTypes,
      yearProperties: years,
      typeChoices: orderedTypes,
      groups,
      selectedFacets: selected?.selected ?? {},
      selectedFacetLabels: Object.fromEntries(
        Object.keys(selected?.selected ?? {}).map((property) => [
          property,
          release?.properties[property]?.labels ?? {},
        ]),
      ),
      facetsAvailable: release !== undefined && facetsAvailable,
    };
  });

function searchHref(
  locale: string,
  query: string,
  type: string | undefined,
  facets: Record<string, string[]>,
  cursor?: string,
): string {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (type) params.set('type', type);
  for (const [property, values] of Object.entries(facets))
    for (const value of values) params.append(`f.${property}`, value);
  if (cursor) params.set('cursor', cursor);
  const search = params.toString();
  return `/${locale}/search${search ? `?${search}` : ''}`;
}

const linkClass = cn(buttonVariants({ variant: 'link' }), 'h-auto justify-start p-0');

export function SearchPage({ query, cursor, data }: { query: string; cursor?: string; data?: SearchPageData }) {
  const [formQuery, setFormQuery] = useState(query);
  const [hydrated, setHydrated] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const locale = getLocale();
  const type = data?.type;
  const result = data?.result;
  const selectedFacets = data?.selectedFacets ?? {};
  const number = new Intl.NumberFormat(locale);
  const activeFilterCount =
    (type ? 1 : 0) + Object.values(selectedFacets).reduce((sum, values) => sum + values.length, 0);
  useEffect(() => setHydrated(true), []);
  useEffect(() => setFormQuery(query), [query]);

  const typeLabel = type
    ? localizedLabel(data?.typeLabels ?? data?.typeChoices.find((choice) => choice.id === type)?.labels ?? {}, locale)
    : undefined;
  const hasFilterPanel = Boolean(
    query && result?.subjects.length && data?.facetsAvailable && (data.typeChoices.length || type),
  );
  const results = renderResults(query, cursor, result, locale, type, selectedFacets, data);

  const filterContents = (surface: 'desktop' | 'mobile') => (
    <div className="space-y-5 pt-3 lg:pt-0">
      <input type="hidden" name="q" value={query} />
      {type && <input type="hidden" name="type" value={type} />}
      {type ? (
        <section className="space-y-3">
          <h2 className="font-medium">
            {m.search_type()}: <span lang={typeLabel?.lang}>{typeLabel?.text || type}</span>
          </h2>
          <a className={linkClass} href={searchHref(locale, query, undefined, {})}>
            {m.search_clear_type()}
          </a>
          {Object.entries(selectedFacets).length > 0 && (
            <>
              <Separator />
              <ul className="space-y-2">
                {Object.entries(selectedFacets).map(([property, values]) => {
                  const label = fieldLabel(localizedLabel(data?.selectedFacetLabels[property] ?? {}, locale), locale);
                  return (
                    <li key={property} className="flex items-baseline justify-between gap-2 text-sm">
                      <span lang={label.lang}>{label.text || property}</span>
                      <a
                        className={linkClass}
                        href={searchHref(
                          locale,
                          query,
                          type,
                          Object.fromEntries(Object.entries(selectedFacets).filter(([key]) => key !== property)),
                        )}
                      >
                        {m.search_clear_facet()}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {data?.groups.map((group) => {
            const propertyLabel = fieldLabel(localizedLabel(group.labels, locale), locale);
            const selected = selectedFacets[group.property] ?? [];
            const unique = [...new Map(group.values.map((entry) => [entry.value, entry])).values()];
            const labelCounts = new Map<string, number>();
            for (const entry of unique) {
              const label = localizedLabel(entry.labels, locale).text || entry.value;
              labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
            }
            if (unique.length === 0) return null;
            return (
              <div key={group.property} className="space-y-3">
                <Separator />
                <FieldSet className="gap-2">
                  <FieldLegend variant="label" className="mb-0" lang={propertyLabel.lang}>
                    {propertyLabel.text || group.property}
                  </FieldLegend>
                  <ul className="space-y-2">
                    {unique.map((entry) => {
                      const valueLabel = localizedLabel(entry.labels, locale);
                      const text = valueLabel.text || entry.value;
                      const parentLabel = localizedLabel(entry.parentTypeLabels ?? {}, locale);
                      const disambiguator = parentLabel.text ? parentLabel : typeLabel;
                      const id = `facet-${surface}-${encodeURIComponent(group.property)}-${encodeURIComponent(entry.value)}`;
                      return (
                        <li key={entry.value}>
                          <Label className="items-start gap-2 text-sm font-normal" htmlFor={id} lang={valueLabel.lang}>
                            <input
                              id={id}
                              form={`${surface}-filter-form`}
                              type="checkbox"
                              name={`f.${group.property}`}
                              value={entry.value}
                              defaultChecked={selected.includes(entry.value)}
                              className="mt-0.5 size-4 shrink-0 accent-primary"
                              onChange={(event) => {
                                if (hydrated) event.currentTarget.form?.requestSubmit();
                              }}
                            />
                            <span>
                              {text}
                              {labelCounts.get(text)! > 1 && (
                                <span lang={disambiguator?.lang}> ({disambiguator?.text || type})</span>
                              )}
                            </span>
                          </Label>
                        </li>
                      );
                    })}
                  </ul>
                </FieldSet>
              </div>
            );
          })}
        </section>
      ) : (
        <section className="space-y-3">
          <h2 className="font-medium">{m.search_types()}</h2>
          <ul className="space-y-2">
            {data?.typeChoices.map((choice) => {
              const label = localizedLabel(choice.labels, locale);
              return (
                <li key={choice.id}>
                  <a className={linkClass} href={searchHref(locale, query, choice.id, {})} lang={label.lang}>
                    {label.text || choice.id}
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <Button type="submit" variant="outline" hidden={hydrated}>
        {m.search_apply()}
      </Button>
    </div>
  );

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <PageHeading>{m.search_heading()}</PageHeading>
      <form id="search-form" method="get" action={`/${locale}/search`} className="space-y-5">
        <div className="flex gap-2">
          <Label className="sr-only" htmlFor="search-query">
            {m.search_label()}
          </Label>
          <Input
            id="search-query"
            name="q"
            value={formQuery}
            onChange={(event) => setFormQuery(event.target.value)}
            className="h-10 min-w-0 flex-1"
          />
          <Button type="submit" size="lg" className="h-10 px-4">
            {m.search_submit()}
          </Button>
        </div>
        {type && <input type="hidden" name="type" value={type} />}
      </form>
      {hasFilterPanel ? (
        <div className="grid items-start gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <form
            id="desktop-filter-form"
            method="get"
            action={`/${locale}/search`}
            className="hidden lg:block lg:col-start-1 lg:row-start-1"
          >
            <Collapsible defaultOpen className="rounded-xl border border-border/60 p-4">
              <CollapsibleTrigger className="hidden">
                {m.search_filters()} ({number.format(activeFilterCount)})
              </CollapsibleTrigger>
              <CollapsibleContent>{filterContents('desktop')}</CollapsibleContent>
            </Collapsible>
          </form>
          <Drawer open={filtersOpen} onOpenChange={setFiltersOpen}>
            <DrawerTrigger className={`${buttonVariants({ variant: 'outline' })} w-full justify-between lg:hidden`}>
              {m.search_filters()} ({number.format(activeFilterCount)})
            </DrawerTrigger>
            <DrawerContent className="lg:hidden">
              <form id="mobile-filter-form" method="get" action={`/${locale}/search`}>
                <DrawerHeader>
                  <DrawerTitle>
                    {m.search_filters()} ({number.format(activeFilterCount)})
                  </DrawerTitle>
                </DrawerHeader>
                <div className="min-h-0 overflow-y-auto p-4">{filterContents('mobile')}</div>
              </form>
            </DrawerContent>
          </Drawer>
          <div className="order-first min-w-0 space-y-4 lg:order-none lg:col-start-2 lg:row-start-1">{results}</div>
        </div>
      ) : (
        results
      )}
    </section>
  );
}

function renderResults(
  query: string,
  cursor: string | undefined,
  result: SearchResult | undefined,
  locale: string,
  type: string | undefined,
  selectedFacets: Record<string, string[]>,
  data: SearchPageData | undefined,
) {
  if (!result) return null;
  if (result.subjects.length === 0)
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle className="text-base font-normal">{m.search_no_results()}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  return (
    <>
      <p className="text-sm text-muted-foreground">{m.search_results()}</p>
      <ResultList
        hits={result.subjects}
        locale={locale}
        hitTypes={data?.hitTypes ?? {}}
        yearProperties={data?.yearProperties ?? []}
      />
      {result.next && (
        <a
          href={searchHref(locale, query, type, selectedFacets, result.next)}
          className={buttonVariants({ variant: 'outline' })}
        >
          {m.search_more()}
        </a>
      )}
    </>
  );
}

/** The route's loader call; the page locale travels with the request so the server asks for the right languages. */
function readSearch({
  data,
  locale = getLocale(),
}: {
  data: Omit<SearchParams, 'locale'>;
  locale?: string;
}): Promise<SearchPageData> {
  return readSearchWithLocale({ data: { ...data, locale } });
}

export { readSearch };

type SuggestionItem = {
  value: string;
  label: string;
  lang: string | undefined;
  suggestion: SuggestionResult['subjects'][number];
};

export function ShellSearch() {
  const locale = getLocale();
  const navigate = useNavigate();
  const [inputValue, setInputValue] = useState('');
  const [items, setItems] = useState<SuggestionItem[]>([]);
  const [types, setTypes] = useState<SuggestionResult['types']>({});
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const value = inputValue.trim();
    setFailed(false);
    if (!value) {
      setItems([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/search/suggestions?q=${encodeURIComponent(value)}&locale=${encodeURIComponent(locale)}`,
          {
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          setItems([]);
          setFailed(true);
          return;
        }
        const result = (await response.json()) as SuggestionResult;
        setTypes(result.types ?? {});
        setItems(
          result.subjects.map((suggestion) => {
            const label = localizedLabel(suggestion.labels, locale);
            return { value: suggestion.id, label: label.text, lang: label.lang, suggestion };
          }),
        );
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setItems([]);
          setFailed(true);
        }
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [inputValue, locale]);
  const submit = () => {
    if (inputValue.trim())
      void navigate({
        to: '/search',
        search: { q: inputValue.trim(), type: undefined, cursor: undefined },
      });
  };
  // One frame for the list, so covers of mixed types line up.
  const ratio = sharedRatio(
    items.map(({ suggestion }) => coverSubject(suggestion.id, '', suggestion.summary, suggestion.type)),
  );
  return (
    // Without JavaScript the box is a plain form to the search page.
    <form method="get" action={`/${locale}/search`}>
      <Combobox
        items={items}
        filter={null}
        value={null}
        inputValue={inputValue}
        onInputValueChange={(value, details) => {
          // Choosing a suggestion would write its title into the box; the box is cleared on choosing instead.
          if (details.reason !== 'item-press') setInputValue(value);
        }}
        onValueChange={(item: SuggestionItem | null) => {
          if (!item) return;
          setInputValue('');
          const target = subjectHref({ id: item.value, label: item.label }, locale);
          void navigate({ to: target.to, params: target.params });
        }}
      >
        <ComboboxInput
          name="q"
          className="h-9 w-28 text-sm sm:w-44"
          aria-label={m.search_label()}
          placeholder={m.search_placeholder()}
          showTrigger={false}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.currentTarget.getAttribute('aria-activedescendant')) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <ComboboxContent className="w-80">
          <ComboboxEmpty>{failed ? m.search_suggestions_failed() : m.search_no_suggestions()}</ComboboxEmpty>
          <ComboboxList>
            {(item: SuggestionItem) => {
              const { suggestion } = item;
              const typeName = localizedLabel(
                Object.hasOwn(types, suggestion.type) ? (types[suggestion.type] ?? {}) : {},
                locale,
              );
              return (
                <ComboboxItem value={item} key={item.value} className="h-auto items-start gap-3 py-2">
                  <Cover
                    subject={coverSubject(suggestion.id, item.label, suggestion.summary, suggestion.type)}
                    cover={coverOf(suggestion.summary)}
                    size="xs"
                    ratio={ratio}
                    src={coverSrc}
                    decorative
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium" lang={item.lang}>
                      {item.label}
                    </span>
                    <SubjectMeta
                      type={typeName}
                      year={hitYear(suggestion.facts)}
                      locale={locale}
                      className="text-xs text-muted-foreground"
                    />
                  </span>
                </ComboboxItem>
              );
            }}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </form>
  );
}
