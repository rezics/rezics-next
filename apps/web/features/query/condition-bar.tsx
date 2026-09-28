'use client';

import { Combobox as ArkCombobox, useListCollection } from '@ark-ui/react/combobox';
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem,
  ComboboxList } from '@rezics/ui/combobox';
import { SegmentGroup, SegmentGroupItem, SegmentGroupItemText } from '@rezics/ui/segment-group';
import { MinusIcon, PlusIcon, XIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { browserMainApi } from '../api/browser.ts';
import { idOf, iriOf } from '../discover/scope.ts';
import { type DiscoverState, discoverHref } from '../discover/state.ts';
import Link from '../shell/localized-link.tsx';
import { type SearchState, searchHref } from '../search/state.ts';

export interface ConditionSelection { include: string[]; exclude: string[]; match: 'all' | 'any' }
export interface NamedCondition { id: string; name: string; language?: string; count?: number }
type SearchItem = { concept: string; label: string; language: string };
export type ValueSearch = (phrase: string, locale: UiLocale, realm: string | null) => Promise<SearchItem[]>;

const copy = {
  en: { heading: 'Conditions', facet: 'Tags', include: 'Include', exclude: 'Exclude',
    match: 'Match', all: 'All', any: 'Any', search: 'Search tags', searching: 'Searching…',
    empty: 'No tags found', failed: 'Tags could not be searched', clear: 'Clear Conditions',
    remove: (name: string) => `Remove ${name}`, fixed: (name: string) => `${name}, this page’s tag`,
    full: (count: number) => `Choose up to ${count} tags here.`, alsoOn: 'Also on these works',
    includeName: (name: string) => `Include ${name}`, excludeName: (name: string) => `Exclude ${name}` },
  'zh-Hans': { heading: '筛选条件', facet: '标签', include: '包含', exclude: '排除',
    match: '匹配', all: '全部', any: '任一', search: '搜索标签', searching: '正在搜索…',
    empty: '没有找到标签', failed: '暂时无法搜索标签', clear: '清除筛选条件',
    remove: (name: string) => `移除${name}`, fixed: (name: string) => `${name}，本页标签`,
    full: (count: number) => `这里最多可选择${count}个标签。`, alsoOn: '这些作品还包含',
    includeName: (name: string) => `包含${name}`, excludeName: (name: string) => `排除${name}` },
} as const;

const searchValues: ValueSearch = async (phrase, locale, realm) => {
  const languages = locale === 'en' ? ['en'] : [locale, 'en'];
  const results = await Promise.all(languages.map(language => browserMainApi().v1.concepts.get({ query: {
    q: phrase, language, limit: 8, ...(realm ? { realm: iriOf(realm) } : {}),
  } })));
  if (results.every(result => result.error)) throw new Error('Concept search failed');
  return [...new Map(results.flatMap(result => result.data?.items ?? [])
    .map(item => [item.concept, item] as const)).values()];
};
const EMPTY_VALUES: readonly NamedCondition[] = [];

/** The admitted Concept Facet's reusable editor. Every change gets an address, so back and share preserve meaning. */
export function ConditionBar({ selection, href, fixed, values = EMPTY_VALUES, suggestions = EMPTY_VALUES,
  maxValues: suppliedMax,
  maxTotal, realm = null, locale, search = searchValues }: {
  selection: ConditionSelection; href: (next: ConditionSelection) => string; fixed?: string;
  values?: readonly NamedCondition[]; suggestions?: readonly NamedCondition[];
  maxValues?: number; maxTotal?: number;
  realm?: string | null; locale: UiLocale;
  search?: ValueSearch;
}) {
  const t = locale === 'zh-Hans' ? copy['zh-Hans'] : copy.en;
  const router = useRouter();
  const heading = useId();
  const [admittedMax, setMaxValues] = useState(8);
  const [facetLabel, setFacetLabel] = useState<string | null>(null);
  const [names, setNames] = useState<NamedCondition[]>([]);
  const [operator, setOperator] = useState<'include' | 'exclude'>('include');
  const [status, setStatus] = useState<'idle' | 'searching' | 'failed'>('idle');
  const { collection, set } = useListCollection<SearchItem>({ initialItems: [],
    itemToValue: item => item.concept, itemToString: item => item.label });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const request = useRef(0);
  const ids = [...selection.include, ...selection.exclude];
  const maxValues = Math.min(suppliedMax ?? admittedMax, admittedMax);
  useEffect(() => {
    let active = true;
    void browserMainApi().v1.facets.get().then(result => {
      const concept = result.data?.facets.find(facet => facet.current && facet.name === 'concept');
      if (active && concept) {
        setMaxValues(concept.cost.maxValues);
        setFacetLabel(concept.labels[locale] ?? concept.labels.en);
      }
    }).catch(() => {});
    return () => { active = false; };
  }, [locale]);
  useEffect(() => {
    const missing = ids.filter(id => !values.some(value => idOf(value.id) === id));
    if (!missing.length) return;
    let active = true;
    void browserMainApi().v1.resources.summaries.post({ profile: 'resource-summary-batch-v1',
      resources: missing.map(iriOf), language: locale }).then(result => {
        if (!active) return;
        setNames((result.data?.summaries ?? []).flatMap(item => item.status === 'available'
          ? [{ id: item.reference, name: item.name.value, language: item.name.language }] : []));
      }).catch(() => {});
    return () => { active = false; };
  // The URL state is the lookup identity; names are only presentation.
  }, [ids.join(','), values, locale]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const named = (id: string) => [...values, ...suggestions, ...names].find(value => idOf(value.id) === id);
  const taken = new Set(ids);
  const totalRoom = maxTotal === undefined || ids.length < maxTotal;
  const room = { include: totalRoom && selection.include.length < maxValues,
    exclude: totalRoom && selection.exclude.length < maxValues };
  const offered = suggestions.filter(value => !ids.includes(idOf(value.id) ?? '')).slice(0, 8);
  const change = (next: ConditionSelection) => href(next);
  const chip = (id: string, mode: 'include' | 'exclude') => {
    const value = named(id), label = value?.name ?? id.slice(-8), isFixed = id === fixed;
    const next = { ...selection, [mode]: selection[mode].filter(item => item !== id) };
    return <li key={`${mode}-${id}`} className={`inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-full
      border px-3 text-sm ${mode === 'exclude' ? 'border-dashed bg-muted/50 text-muted-foreground' : 'bg-card'}`}>
      {mode === 'exclude' ? <MinusIcon aria-hidden="true" className="size-3.5 shrink-0" /> : null}
      <span lang={value?.language} className="truncate">{label}</span>
      {value?.count !== undefined ? <span className="tabular-nums text-muted-foreground">{value.count}</span> : null}
      {isFixed ? <span className="sr-only">{t.fixed(label)}</span> : <Link href={change(next)} scroll={false}
        aria-label={t.remove(label)} className="grid size-6 shrink-0 place-items-center rounded-full outline-none
          hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"><XIcon aria-hidden="true" className="size-3.5" />
      </Link>}
    </li>;
  };
  function lookup(phrase: string) {
    clearTimeout(timer.current);
    const mine = ++request.current;
    if (!phrase.trim()) { set([]); setStatus('idle'); return; }
    setStatus('searching');
    timer.current = setTimeout(() => {
      search(phrase.trim(), locale, realm).then(items => {
        if (mine !== request.current) return;
        set(items.filter(item => !taken.has(idOf(item.concept) ?? '')));
        setStatus('idle');
      }, () => { if (mine === request.current) { set([]); setStatus('failed'); } });
    }, 200);
  }
  return <section aria-labelledby={heading} className="grid gap-3 rounded-2xl border border-border/60 bg-card/60 p-4">
    <h2 id={heading} className="font-semibold text-sm">{t.heading}</h2>
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">{facetLabel ?? t.facet}</span>
      <ul className="flex min-w-0 flex-wrap gap-2">{selection.include.map(id => chip(id, 'include'))}</ul>
      {selection.exclude.length ? <span className="text-muted-foreground">{t.exclude}</span> : null}
      <ul className="flex min-w-0 flex-wrap gap-2">{selection.exclude.map(id => chip(id, 'exclude'))}</ul>
      {ids.some(id => id !== fixed) ? <Link href={change({ include: fixed ? [fixed] : [], exclude: [], match: 'all' })}
        scroll={false} className="font-medium text-primary underline-offset-4 hover:underline">{t.clear}</Link> : null}
    </div>
    <div className="flex flex-wrap items-center gap-3">
      {selection.include.length > 1 ? <div role="group" aria-label={t.match} className="flex items-center gap-1">
        <span className="text-muted-foreground text-sm">{t.match}</span>
        {(['all', 'any'] as const).map(match => <Link key={match} href={change({ ...selection, match })}
          aria-current={selection.match === match || undefined} scroll={false}
          className="rounded-lg px-3 py-1.5 text-sm aria-[current=true]:bg-primary/10
            aria-[current=true]:text-primary hover:bg-accent">{t[match]}</Link>)}
      </div> : null}
      {room.include || room.exclude ? <>
        <SegmentGroup value={operator} onValueChange={({ value }) => value && setOperator(value as typeof operator)}
          aria-label={t.heading} className="p-0.5">
          <SegmentGroupItem value="include" disabled={!room.include} className="h-7 px-3">
            <PlusIcon aria-hidden="true" /><SegmentGroupItemText>{t.include}</SegmentGroupItemText>
          </SegmentGroupItem>
          <SegmentGroupItem value="exclude" disabled={!room.exclude} className="h-7 px-3">
            <MinusIcon aria-hidden="true" /><SegmentGroupItemText>{t.exclude}</SegmentGroupItemText>
          </SegmentGroupItem>
        </SegmentGroup>
        <Combobox collection={collection} openOnClick={false} className="w-full min-w-48 sm:w-64"
          onInputValueChange={({ inputValue, reason }) => { if (reason === 'input-change') lookup(inputValue); }}
          onValueChange={({ value }) => {
            const id = idOf(value[0] ?? '');
            if (!id || !room[operator]) return;
            const next: ConditionSelection = { ...selection,
              include: selection.include.filter(item => item !== id),
              exclude: selection.exclude.filter(item => item !== id) };
            next[operator].push(id);
            router.push(localizedPath(change(next), locale), { scroll: false });
          }}>
          <ArkCombobox.Label className="sr-only">{t.search}</ArkCombobox.Label>
          <ComboboxInput placeholder={t.search} showTrigger={false} size="sm" />
          <ComboboxContent><ComboboxEmpty>{status === 'searching' ? t.searching
            : status === 'failed' ? t.failed : t.empty}</ComboboxEmpty>
            <ComboboxList>{collection.items.map(item => <ComboboxItem key={item.concept} item={item}>
              <span lang={item.language} className="truncate">{item.label}</span>
            </ComboboxItem>)}</ComboboxList></ComboboxContent>
        </Combobox>
      </> : <p className="text-muted-foreground text-sm">{t.full(maxTotal ?? maxValues)}</p>}
    </div>
    {offered.length ? <div className="grid gap-2">
      <p className="text-muted-foreground text-xs">{t.alsoOn}</p>
      <ul className="flex flex-wrap gap-2">{offered.map(value => {
        const id = idOf(value.id) ?? value.id;
        return <li key={id} className="inline-flex h-8 items-center gap-1 rounded-full border bg-background ps-3 pe-1
          text-sm"><span lang={value.language}>{value.name}</span>
          {room.include ? <Link href={change({ ...selection, include: [...selection.include, id] })}
            aria-label={t.includeName(value.name)} scroll={false} className="grid size-6 place-items-center rounded-full
              hover:bg-accent"><PlusIcon aria-hidden="true" className="size-3.5" /></Link> : null}
          {room.exclude ? <Link href={change({ ...selection, exclude: [...selection.exclude, id] })}
            aria-label={t.excludeName(value.name)} scroll={false} className="grid size-6 place-items-center rounded-full
              hover:bg-accent"><MinusIcon aria-hidden="true" className="size-3.5" /></Link> : null}
        </li>;
      })}</ul>
    </div> : null}
  </section>;
}

/** Search keeps its first included Concept in `term` for shareable existing links. */
export function SearchConditionBar({ state, locale, values = EMPTY_VALUES }: { state: SearchState;
  locale: UiLocale; values?: readonly NamedCondition[] }) {
  const selection: ConditionSelection = { include: [...(state.term ? [state.term] : []),
    ...(state.concepts?.include ?? [])], exclude: state.concepts?.exclude ?? [],
    match: state.concepts?.match ?? 'all' };
  return <ConditionBar selection={selection} locale={locale} values={values} maxTotal={3}
    realm={state.scope.kind === 'realm' ? state.scope.realm : null}
    href={next => searchHref({ ...state, term: next.include[0] ?? null,
      concepts: { include: next.include.slice(1), exclude: next.exclude, match: next.match } })} />;
}

export function DiscoverConditionBar({ state, locale, values = EMPTY_VALUES }: { state: DiscoverState;
  locale: UiLocale; values?: readonly NamedCondition[] }) {
  const selection: ConditionSelection = state.conditions ?? { include: [], exclude: [], match: 'all' };
  return <ConditionBar selection={selection} locale={locale} values={values}
    realm={state.scope.kind === 'realm' ? state.scope.realm : null}
    href={next => discoverHref({ ...state, conditions: next })} />;
}
