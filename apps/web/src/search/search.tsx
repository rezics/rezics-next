import { pickText } from '@rezics/composition';
import { admitFilter, facetProperties, FILTER_LIMITS, type FilterDocument, type FilterRelease } from '@rezics/filter';
import { createServerFn } from '@tanstack/react-start';
import type { KernelClient } from '@rezics/client';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  useListCollection,
} from '@rezics/ui/combobox';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client.ts';
import { PageHeading } from '../shell/page-heading';

type Fact =
  | { kind: 'item'; id: string; labels: Record<string, string> }
  | { kind: 'time'; year: number }
  | { kind: 'quantity'; amount: number; unit: string }
  | { kind: 'code'; value: string };
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
  })[];
};
type SuggestResult = NonNullable<Awaited<ReturnType<KernelClient['subjects']['$suggest']['get']>>['data']>;
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
  typeChoices: { id: string; labels: Record<string, string> }[];
  groups: {
    property: string;
    labels: Record<string, string>;
    values: { value: string; count: number; labels: Record<string, string> }[];
  }[];
  selectedFacets: Record<string, string[]>;
  selectedFacetLabels: Record<string, Record<string, string>>;
  facetsAvailable: boolean;
};
type Release = FilterRelease & {
  types: Record<string, { labels?: Record<string, string>; bases?: readonly string[]; facets?: readonly string[] }>;
  properties: Record<string, { labels?: Record<string, string>; datatype: string; value?: { pattern?: string } }>;
};

/** At most this many facet properties are asked for on a single-type search. */
const FACT_PROPERTIES = 2;
/** At most this many values of one property are shown on a result. */
const FACT_VALUES = 3;

const definitionMemory = new Map<string, { storedAt: number; value: unknown }>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function cachedDefinition<T>(url: string, ttl?: number): Promise<T> {
  const now = Date.now();
  const remembered = definitionMemory.get(url);
  const cache = typeof caches === 'undefined' ? undefined : (caches as unknown as { default?: Cache }).default;
  const request = new Request(url, { method: 'GET' });

  if (cache) {
    try {
      const cached = await cache.match(request);
      if (cached) {
        const storedAt = Number(cached.headers.get('x-rezics-definition-stored-at'));
        if (ttl === undefined || (Number.isFinite(storedAt) && now - storedAt < ttl)) {
          const value = (await cached.json()) as T;
          definitionMemory.set(url, { storedAt: Number.isFinite(storedAt) ? storedAt : now, value });
          return value;
        }
        await cache.delete(request);
      }
    } catch {
      // The memory copy below keeps local development working if the Cache API is unavailable.
    }
  }

  if (remembered && (ttl === undefined || now - remembered.storedAt < ttl)) return remembered.value as T;

  const response = await fetch(request);
  if (!response.ok) throw new Error('Definitions read failed');
  const value = (await response.json()) as T;
  const storedAt = Date.now();
  definitionMemory.set(url, { storedAt, value });
  if (cache) {
    const cacheHeaders = new Headers({
      'content-type': 'application/json',
      'cache-control': ttl === undefined ? 'public, max-age=31536000, immutable' : 'public, max-age=60',
      'x-rezics-definition-stored-at': String(storedAt),
    });
    try {
      await cache.put(request, new Response(JSON.stringify(value), { headers: cacheHeaders }));
    } catch {
      // Some local Cache API implementations reject entries; the bounded memory copy is the fallback.
    }
  }
  return value;
}

function kernelOrigin(): string {
  const origin = (env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN;
  if (origin) return origin;
  if (import.meta.env.DEV) return 'http://kernel.local';
  throw new Error('KERNEL_ORIGIN is required to read definitions');
}

async function readRelease(): Promise<Release> {
  const origin = kernelOrigin();
  const activeUrl = new URL('/v1/definitions/active', origin).href;
  const active = await cachedDefinition<{ digest?: unknown }>(activeUrl, 60_000);
  if (typeof active.digest !== 'string' || active.digest.length === 0 || active.digest.length > 256)
    throw new Error('Active definitions release is invalid');
  const releaseUrl = new URL(`/v1/definitions/releases/${encodeURIComponent(active.digest)}`, origin).href;
  const response = await cachedDefinition<{ digest?: unknown; release?: unknown }>(releaseUrl);
  const value = response.release;
  if (response.digest !== active.digest || !isRecord(value) || !isRecord(value.types) || !isRecord(value.properties))
    throw new Error('Definitions release is invalid');
  return value as unknown as Release;
}

function allowedType(release: Release, type: unknown): type is string {
  return typeof type === 'string' && Object.hasOwn(release.types, type) && isRecord(release.types[type]);
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
    const languages = data.locale === 'en' ? ['en'] : [data.locale, 'en'];
    const properties = release && type ? factProperties(release, type) : [];
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
          const response = await kernelClient().subjects.$search.post(body);
          if (response.error) throw new Error('Search failed');
          return response.data as SearchResult;
        })()
      : Promise.resolve(undefined);

    const facetPropertiesForType = release && type ? facetProperties(release, [type]).slice(0, 8) : [];
    const facetsPromise: Promise<FacetResult | null | undefined> =
      release && type && facetPropertiesForType.length > 0
        ? kernelClient()
            .subjects.$facets.post({
              ...(data.query ? { text: data.query } : {}),
              ...(filter ? { filter } : {}),
              facets: facetPropertiesForType.map((property) => ({ property, size: 10 })),
            })
            .then((response) => {
              if (response.error) return null;
              return response.data as FacetResult;
            })
            .catch(() => null)
        : Promise.resolve(undefined);

    const [result, facetResult] = await Promise.all([searchPromise, facetsPromise]);
    const facetsAvailable = !release || !type || facetResult !== null;
    const valuesByProperty = new Map((facetResult?.facets ?? []).map((facet) => [facet.property, facet.values]));
    const groups =
      release && type && facetResult
        ? facetPropertiesForType.map((property) => ({
            property,
            labels: release!.properties[property]?.labels ?? {},
            values: valuesByProperty.get(property) ?? [],
          }))
        : [];
    const hitTypes: Record<string, Record<string, string>> = {};
    if (release)
      for (const subject of result?.subjects ?? [])
        if (allowedType(release, subject.type)) hitTypes[subject.type] = release.types[subject.type]?.labels ?? {};
    const typeChoices = release
      ? Object.entries(release.types)
          .filter(
            ([, definition]) =>
              isRecord(definition) && Array.isArray(definition.facets) && definition.facets.length > 0,
          )
          .map(([id, definition]) => ({ id, labels: definition.labels ?? {} }))
      : [];

    return {
      ...(result ? { result } : {}),
      ...(type ? { type } : {}),
      ...(type && release ? { typeLabels: release.types[type]?.labels ?? {} } : {}),
      hitTypes,
      typeChoices,
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

/** The same fallback the subject page uses: the page locale first, then the related and fallback languages. */
function localizedLabel(labels: Record<string, string>, locale: string): { text: string; lang?: string } {
  const picked = pickText(labels, locale);
  return { text: picked.text, ...(picked.lang ? { lang: picked.lang } : {}) };
}

/** The shown form of one fact value; an item without a label in the asked languages has nothing to show. */
function factText(fact: Fact, locale: string): { text: string; lang?: string } {
  if (fact.kind === 'item') return localizedLabel(fact.labels, locale);
  if (fact.kind === 'time') return { text: String(fact.year) };
  if (fact.kind === 'quantity')
    return { text: `${new Intl.NumberFormat(locale).format(fact.amount)}${fact.unit ? ` ${fact.unit}` : ''}` };
  return { text: fact.value };
}

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

export function SearchPage({ query, cursor, data }: { query: string; cursor?: string; data?: SearchPageData }) {
  const [formQuery, setFormQuery] = useState(query);
  const [hydrated, setHydrated] = useState(false);
  const locale = getLocale();
  const type = data?.type;
  const result = data?.result;
  const selectedFacets = data?.selectedFacets ?? {};
  const activeFilterCount =
    (type ? 1 : 0) + Object.values(selectedFacets).reduce((sum, values) => sum + values.length, 0);
  useEffect(() => setHydrated(true), []);
  useEffect(() => setFormQuery(query), [query]);

  const typeLabel = type
    ? localizedLabel(data?.typeLabels ?? data?.typeChoices.find((choice) => choice.id === type)?.labels ?? {}, locale)
    : undefined;
  const hasFilterPanel = Boolean(data?.facetsAvailable && (data.typeChoices.length > 0 || type));

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <PageHeading>{m.search_heading()}</PageHeading>
      <form method="get" action={`/${locale}/search`} className="space-y-5">
        <div className="flex gap-2">
          <label className="sr-only" htmlFor="search-query">
            {m.search_label()}
          </label>
          <input
            id="search-query"
            name="q"
            value={formQuery}
            onChange={(event) => setFormQuery(event.target.value)}
            className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-background px-3"
          />
          <button className="rounded-xl bg-primary px-4 text-primary-foreground">{m.search_submit()}</button>
        </div>
        {type && <input type="hidden" name="type" value={type} />}
        {hasFilterPanel ? (
          <div className="grid items-start gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
            <details open className="rounded-xl border border-border/60 p-4 lg:col-start-1 lg:row-start-1">
              <summary className="cursor-pointer font-medium lg:hidden">
                {m.search_filters()} ({new Intl.NumberFormat(locale).format(activeFilterCount)})
              </summary>
              <div className="space-y-5 pt-3 lg:pt-0">
                {type ? (
                  <section className="space-y-3">
                    <h2 className="font-medium">
                      {m.search_type()}: <span lang={typeLabel?.lang}>{typeLabel?.text || type}</span>
                    </h2>
                    <a className="text-sm underline" href={searchHref(locale, query, undefined, {})}>
                      {m.search_clear_type()}
                    </a>
                    {Object.entries(selectedFacets).length > 0 && (
                      <ul className="space-y-2 border-t border-border/60 pt-3">
                        {Object.entries(selectedFacets).map(([property, values]) => {
                          const label = localizedLabel(data?.selectedFacetLabels[property] ?? {}, locale);
                          return (
                            <li key={property} className="flex items-baseline justify-between gap-2 text-sm">
                              <span lang={label.lang}>{label.text || property}</span>
                              <a
                                className="underline"
                                href={searchHref(
                                  locale,
                                  query,
                                  type,
                                  Object.fromEntries(
                                    Object.entries(selectedFacets).filter(
                                      ([selectedProperty]) => selectedProperty !== property,
                                    ),
                                  ),
                                )}
                              >
                                {m.search_clear_facet()} ({new Intl.NumberFormat(locale).format(values.length)})
                              </a>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {data?.groups.map((group) => {
                      const propertyLabel = localizedLabel(group.labels, locale);
                      const selected = selectedFacets[group.property] ?? [];
                      return (
                        <fieldset key={group.property} className="space-y-2 border-t border-border/60 pt-3">
                          <legend className="font-medium" lang={propertyLabel.lang}>
                            {propertyLabel.text || group.property}
                          </legend>
                          <ul className="space-y-2">
                            {group.values.map((entry) => {
                              const valueLabel = localizedLabel(entry.labels, locale);
                              const id = `facet-${encodeURIComponent(group.property)}-${encodeURIComponent(entry.value)}`;
                              return (
                                <li key={entry.value}>
                                  <label className="flex items-start gap-2 text-sm" htmlFor={id} lang={valueLabel.lang}>
                                    <input
                                      id={id}
                                      type="checkbox"
                                      name={`f.${group.property}`}
                                      value={entry.value}
                                      defaultChecked={selected.includes(entry.value)}
                                      onChange={(event) => {
                                        if (hydrated) event.currentTarget.form?.requestSubmit();
                                      }}
                                    />
                                    <span>
                                      {valueLabel.text || entry.value} (
                                      {new Intl.NumberFormat(locale).format(entry.count)})
                                    </span>
                                  </label>
                                </li>
                              );
                            })}
                          </ul>
                        </fieldset>
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
                            <a className="underline" href={searchHref(locale, query, choice.id, {})} lang={label.lang}>
                              {label.text || choice.id}
                            </a>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}
                <button type="submit" hidden={hydrated} className="rounded-lg border border-border px-3 py-2 text-sm">
                  {m.search_apply()}
                </button>
              </div>
            </details>
            <div className="space-y-4 lg:col-start-2 lg:row-start-1">
              {renderResults(query, cursor, result, locale, type, selectedFacets, data?.hitTypes ?? {})}
            </div>
          </div>
        ) : (
          renderResults(query, cursor, result, locale, type, selectedFacets, data?.hitTypes ?? {})
        )}
      </form>
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
  hitTypes: Record<string, Record<string, string>>,
) {
  if (!result) return null;
  if (result.subjects.length === 0) return <p>{m.search_no_results()}</p>;
  return (
    <>
      <p className="text-sm text-muted-foreground">{m.search_results()}</p>
      <ul className="divide-y divide-border/60 rounded-xl border border-border/60">
        {result.subjects.map((subject) => {
          const label = localizedLabel(subject.labels, locale);
          const typeName = localizedLabel(
            Object.hasOwn(hitTypes, subject.type) ? (hitTypes[subject.type] ?? {}) : {},
            locale,
          );
          const description = localizedLabel(subject.descriptions ?? {}, locale);
          const facts = Object.values(subject.facts ?? {}).flatMap((values) =>
            values
              .slice(0, FACT_VALUES)
              .map((value) => factText(value, locale))
              .filter((value) => value.text),
          );
          return (
            <li key={subject.id} className="space-y-1 px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <Link
                  to="/subjects/$id"
                  params={{ id: subject.id }}
                  lang={label.lang}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {label.text}
                </Link>
                {typeName.text && (
                  <span className="text-xs text-muted-foreground" lang={typeName.lang}>
                    {typeName.text}
                  </span>
                )}
              </div>
              {facts.length > 0 && (
                <p className="text-sm">
                  {facts.map((fact, index) => (
                    <span key={index}>
                      {index > 0 && ' · '}
                      <span lang={fact.lang}>{fact.text}</span>
                    </span>
                  ))}
                </p>
              )}
              {description.text && (
                <p className="line-clamp-2 text-sm text-muted-foreground" lang={description.lang}>
                  {description.text}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {result.next && (
        <a
          href={searchHref(locale, query, type, selectedFacets, result.next)}
          className="inline-flex rounded-lg border px-3 py-2"
        >
          {m.search_more()}
        </a>
      )}
    </>
  );
}

/** The route's loader call; the page locale travels with the request so the server asks for the right languages. */
function readSearch({ data }: { data: Omit<SearchParams, 'locale'> }): Promise<SearchPageData> {
  return readSearchWithLocale({ data: { ...data, locale: getLocale() } });
}

export { readSearch };

export function ShellSearch() {
  const locale = getLocale();
  const navigate = useNavigate();
  const [inputValue, setInputValue] = useState('');
  const collectionState = useListCollection({
    initialItems: [] as { value: string; label: string; subject: SuggestResult['subjects'][number] }[],
  });
  const collection = collectionState.collection;
  useEffect(() => {
    const value = inputValue.trim();
    if (!value) {
      collectionState.clear();
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/search/suggestions?q=${encodeURIComponent(value)}`, {
          signal: controller.signal,
        });
        if (!response.ok) return;
        const result = (await response.json()) as SuggestResult;
        collectionState.set(
          result.subjects.map((subject) => ({
            value: subject.id,
            label: localizedLabel(subject.labels, locale).text,
            subject,
          })),
        );
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) collectionState.clear();
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
        search: { q: inputValue.trim(), type: undefined, facetValues: {}, cursor: undefined },
      });
  };
  return (
    <Combobox
      collection={collection}
      onInputValueChange={({ inputValue: value }) => setInputValue(value)}
      onValueChange={({ value }) => {
        const id = value[0];
        if (id) void navigate({ to: '/subjects/$id', params: { id } });
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.currentTarget.getAttribute('aria-activedescendant')) {
          event.preventDefault();
          submit();
        }
      }}
    >
      <ComboboxInput
        className="h-9 w-28 text-sm sm:w-44"
        aria-label={m.search_label()}
        placeholder={m.search_placeholder()}
        showTrigger={false}
      />
      <ComboboxContent>
        <ComboboxEmpty>{m.search_no_suggestions()}</ComboboxEmpty>
        <ComboboxList>
          {collection.items.map((item) => (
            <ComboboxItem item={item} key={item.value}>
              {item.label}
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
