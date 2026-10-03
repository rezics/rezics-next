'use client';

import type { EntityPickerLoad, EntityPickerSelection } from '@rezics/ui/entity-picker';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { browserMainApi } from '../api/browser.ts';
import { idOf, iriOf } from '../discover/scope.ts';
import { type DiscoverState, discoverHref } from '../discover/state.ts';
import { browseHref, changeBrowse, type BrowseState } from '../discover/browse-state.ts';
import type { ConceptChoice } from '../discover/api.ts';
import { TopicPicker, type TopicItem } from '../discover/topic-picker.tsx';
import Link from '../shell/localized-link.tsx';
import { messages } from '../search/messages.ts';
import { type SearchState, searchHref } from '../search/state.ts';

export interface ConditionSelection {
  include: string[];
  exclude: string[];
  match: 'all' | 'any';
}
export interface NamedCondition {
  id: string;
  name: string;
  language?: string;
  count?: number;
}
type SearchItem = { concept: string; label: string; language: string };
/** Compatibility for existing story fixtures. Production uses the cursor-based Concept loader. */
export type ValueSearch = (
  phrase: string,
  locale: UiLocale,
  realm: string | null,
) => Promise<SearchItem[]>;
export function sameConcept(valueId: string, id: string): boolean {
  return (idOf(valueId) ?? valueId) === (idOf(id) ?? id);
}
const EMPTY_VALUES: readonly NamedCondition[] = [];
export function ConditionBar({
  selection,
  href,
  fixed,
  values = EMPTY_VALUES,
  suggestions = EMPTY_VALUES,
  maxValues: suppliedMax,
  maxTotal,
  realm = null,
  locale,
  actingSubject,
  search,
  load,
}: {
  selection: ConditionSelection;
  href: (next: ConditionSelection) => string;
  fixed?: string;
  values?: readonly NamedCondition[];
  suggestions?: readonly NamedCondition[];
  maxValues?: number;
  maxTotal?: number;
  realm?: string | null;
  locale: UiLocale;
  actingSubject?: string;
  search?: ValueSearch;
  load?: EntityPickerLoad<TopicItem>;
}) {
  const t = materializeData(messages[locale], { locale });
  const router = useRouter();
  const [admittedMax, setMaxValues] = useState(8);
  const [names, setNames] = useState<TopicItem[]>([]);
  const ids = [...selection.include, ...selection.exclude];
  const maxValues = Math.min(suppliedMax ?? admittedMax, admittedMax);
  useEffect(() => {
    let active = true;
    void browserMainApi()
      .v1.facets.get()
      .then((result) => {
        const concept = result.data?.facets.find(
          (facet) => facet.current && facet.name === 'concept',
        );
        if (active && concept) setMaxValues(concept.cost.maxValues);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const missing = ids.filter(
      (id) =>
        ![...values, ...suggestions].some((value) => sameConcept(value.id, id)) &&
        !names.some((item) => sameConcept(item.value, id)),
    );
    if (!missing.length) return;
    let active = true;
    void browserMainApi()
      .v1.resources.summaries.post({
        profile: 'resource-summary-batch-v1',
        resources: missing.map((id) => (idOf(id) ? id : iriOf(id))),
        ...(actingSubject ? { actingSubject } : {}),
      })
      .then((result) => {
        if (!active) return;
        const added = (result.data?.summaries ?? []).flatMap((item) =>
          item.status === 'available'
            ? [
                {
                  value: item.reference,
                  label: item.name.value,
                  language: item.name.language,
                  direction: item.name.direction,
                },
              ]
            : [],
        );
        setNames((current) => [
          ...new Map([...current, ...added].map((item) => [item.value, item])).values(),
        ]);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [ids.join(','), values, suggestions, names, actingSubject]);

  function named(id: string): TopicItem {
    const known = [...values, ...suggestions].find((value) => sameConcept(value.id, id));
    return (
      names.find((item) => sameConcept(item.value, id)) ??
      (known
        ? {
            value: idOf(id) ? id : iriOf(id),
            label: known.name,
            language: known.language,
            usageCount: known.count,
          }
        : { value: idOf(id) ? id : iriOf(id), label: id.slice(-8) })
    );
  }
  const picked: EntityPickerSelection<TopicItem>[] = [
    ...selection.include.map((id) => ({ item: named(id), mode: 'include' as const })),
    ...selection.exclude.map((id) => ({ item: named(id), mode: 'exclude' as const })),
  ];
  const read =
    load ??
    (search
      ? async ({ q }: { q: string; cursor: string | null }) => ({
          items: (await search(q, locale, realm)).map((item) => ({
            value: item.concept,
            label: item.label,
            language: item.language,
          })),
          nextCursor: null,
          complete: true,
        })
      : undefined);
  function change(next: EntityPickerSelection<TopicItem>[]) {
    const include = next
      .filter((item) => item.mode !== 'exclude')
      .map((item) => idOf(item.item.value) ?? item.item.value);
    const exclude = next
      .filter((item) => item.mode === 'exclude')
      .map((item) => idOf(item.item.value) ?? item.item.value);
    if (
      (fixed && !include.includes(fixed)) ||
      include.length > maxValues ||
      exclude.length > maxValues
    )
      return;
    setNames((current) => [
      ...new Map(
        [...current, ...next.map((entry) => entry.item)].map((item) => [item.value, item]),
      ).values(),
    ]);
    router.push(localizedPath(href({ include, exclude, match: selection.match }), locale), {
      scroll: false,
    });
  }
  return (
    <section aria-label={t.conditionHeading} className="grid min-w-0 gap-3">
      <TopicPicker
        locale={locale}
        value={picked}
        onChange={change}
        actingSubject={actingSubject}
        realm={realm ? iriOf(realm) : undefined}
        load={read}
        allowExclude
        max={maxTotal ?? maxValues * 2}
      />
      {selection.include.length > 1 ? (
        <div
          role="group"
          aria-label={t.conditionMatch}
          className="flex flex-wrap items-center gap-2 text-sm"
        >
          <span className="text-muted-foreground">{t.conditionMatch}</span>
          {(['all', 'any'] as const).map((match) => (
            <Link
              key={match}
              href={href({ ...selection, match })}
              aria-current={selection.match === match || undefined}
              scroll={false}
              className="rounded-lg px-3 py-1.5 aria-[current=true]:bg-accent hover:bg-accent/60"
            >
              {match === 'all' ? t.conditionAll : t.conditionAny}
            </Link>
          ))}
        </div>
      ) : null}
      {suggestions.length &&
      selection.include.length < maxValues &&
      (maxTotal === undefined || ids.length < maxTotal) ? (
        <ul className="flex min-w-0 flex-wrap gap-2">
          {suggestions
            .filter((value) => !ids.some((id) => sameConcept(value.id, id)))
            .map((value) => (
              <li key={value.id}>
                <Link
                  href={href({
                    ...selection,
                    include: [...selection.include, idOf(value.id) ?? value.id],
                  })}
                  scroll={false}
                  lang={value.language}
                  className="inline-flex rounded-full border border-border px-3 py-1.5 text-sm
            outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={t.conditionIncludeName({ name: value.name })}
                >
                  {value.name}
                </Link>
              </li>
            ))}
        </ul>
      ) : null}
    </section>
  );
}
export function SearchConditionBar({
  state,
  locale,
  values = EMPTY_VALUES,
  actingSubject,
}: {
  state: SearchState;
  locale: UiLocale;
  values?: readonly NamedCondition[];
  actingSubject?: string;
}) {
  const selection: ConditionSelection = {
    include: [...(state.term ? [state.term] : []), ...(state.concepts?.include ?? [])],
    exclude: state.concepts?.exclude ?? [],
    match: state.concepts?.match ?? 'all',
  };
  return (
    <ConditionBar
      selection={selection}
      locale={locale}
      values={values}
      actingSubject={actingSubject}
      maxTotal={3}
      realm={state.scope.kind === 'realm' ? state.scope.realm : null}
      href={(next) =>
        searchHref({
          ...state,
          term: next.include[0] ?? null,
          concepts: { include: next.include.slice(1), exclude: next.exclude, match: next.match },
        })
      }
    />
  );
}
/** Kept for older consumers while Discover uses the whole-resource Query. */
export function DiscoverConditionBar({
  state,
  locale,
  values = EMPTY_VALUES,
  actingSubject,
}: {
  state: DiscoverState;
  locale: UiLocale;
  values?: readonly NamedCondition[];
  actingSubject?: string;
}) {
  return (
    <ConditionBar
      selection={state.conditions ?? { include: [], exclude: [], match: 'all' }}
      locale={locale}
      values={values}
      actingSubject={actingSubject}
      realm={state.scope.kind === 'realm' ? state.scope.realm : null}
      href={(next) => discoverHref({ ...state, conditions: next })}
    />
  );
}
export function DiscoverBrowseConditions({
  state,
  locale,
  actingSubject,
  topics,
  load,
}: {
  state: BrowseState;
  locale: UiLocale;
  actingSubject?: string;
  topics: readonly ConceptChoice[];
  load?: EntityPickerLoad<TopicItem>;
}) {
  // Main supplies followed topics first. Retain its order; usage and hierarchy travel with picker results.
  const values = topics.map((topic) => ({
    id: topic.id,
    name: topic.name.value,
    language: topic.name.language,
    count: topic.usageCount,
  }));
  const initialLoad = load ?? undefined;
  return (
    <ConditionBar
      selection={state.conditions}
      locale={locale}
      actingSubject={actingSubject}
      values={values}
      suggestions={values}
      load={initialLoad}
      realm={state.scope.kind === 'realm' ? state.scope.realm : null}
      href={(conditions) => browseHref(changeBrowse(state, { conditions }))}
    />
  );
}
