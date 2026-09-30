'use client';

import { Combobox as ArkCombobox, useListCollection } from '@ark-ui/react/combobox';
import { materializeData } from 'native-i18n';
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
import { messages } from '../search/messages.ts';
import { type SearchState, searchHref } from '../search/state.ts';

export interface ConditionSelection { include: string[]; exclude: string[]; match: 'all' | 'any' }
export interface NamedCondition { id: string; name: string; language?: string; count?: number }
type SearchItem = { concept: string; label: string; language: string };
export type ValueSearch = (phrase: string, locale: UiLocale, realm: string | null) => Promise<SearchItem[]>;

/** A Condition value may be a UUID or the native IRI of that UUID. */
export function sameConcept(valueId: string, id: string): boolean {
  return valueId === id || idOf(valueId) === id || idOf(valueId) === idOf(id);
}

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
/** Set when a suggestion was just chosen, so the field keeps focus across the address change. */
let refocusSearch = false;

/** The admitted Concept Facet's reusable editor. Every change gets an address, so back and share preserve meaning. */
export function ConditionBar({ selection, href, fixed, values = EMPTY_VALUES, suggestions = EMPTY_VALUES,
  maxValues: suppliedMax,
  maxTotal, realm = null, locale, actingSubject, search = searchValues }: {
  selection: ConditionSelection; href: (next: ConditionSelection) => string; fixed?: string;
  values?: readonly NamedCondition[]; suggestions?: readonly NamedCondition[];
  maxValues?: number; maxTotal?: number;
  realm?: string | null; locale: UiLocale; actingSubject?: string;
  search?: ValueSearch;
}) {
  const t = materializeData(messages[locale], { locale });
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
  const root = useRef<HTMLElement>(null);
  const [phrase, setPhrase] = useState('');
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
    const missing = ids.filter(id => !values.some(value => sameConcept(value.id, id)));
    if (!missing.length) return;
    let active = true;
    void browserMainApi().v1.resources.summaries.post({ profile: 'resource-summary-batch-v1',
      resources: missing.map(iriOf),
      ...(actingSubject ? { actingSubject } : {}) }).then(result => {
        if (!active) return;
        setNames((result.data?.summaries ?? []).flatMap(item => item.status === 'available'
          ? [{ id: item.reference, name: item.name.value, language: item.name.language }] : []));
      }).catch(() => {});
    return () => { active = false; };
  // The URL state is the lookup identity; names are only presentation.
  }, [ids.join(','), values, locale, actingSubject]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const named = (id: string) => [...values, ...suggestions, ...names].find(value => sameConcept(value.id, id));
  const taken = new Set(ids);
  const totalRoom = maxTotal === undefined || ids.length < maxTotal;
  const room = { include: totalRoom && selection.include.length < maxValues,
    exclude: totalRoom && selection.exclude.length < maxValues };
  const offered = suggestions.filter(value => !ids.some(id => sameConcept(value.id, id))).slice(0, 8);
  function addConcept(concept: string) {
    const id = idOf(concept);
    if (!id || taken.has(id) || !room[operator]) return;
    const next: ConditionSelection = { ...selection,
      include: selection.include.filter(item => item !== id),
      exclude: selection.exclude.filter(item => item !== id), match: selection.match };
    next[operator] = [...next[operator], id];
    setPhrase('');
    set([]);
    setStatus('idle');
    refocusSearch = true;
    router.push(localizedPath(href(next), locale), { scroll: false });
  }
  useEffect(() => {
    if (!refocusSearch) return;
    refocusSearch = false;
    const focus = () => root.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
    focus();
    const timer = window.setTimeout(focus, 50);
    return () => window.clearTimeout(timer);
  }, [ids.join(',')]);
  const change = (next: ConditionSelection) => href(next);
  const chip = (id: string, mode: 'include' | 'exclude') => {
    const value = named(id), label = value?.name ?? id.slice(-8), isFixed = id === fixed;
    const next = { ...selection, [mode]: selection[mode].filter(item => item !== id) };
    return <li key={`${mode}-${id}`} className={`inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-full
      border px-3 text-sm ${mode === 'exclude' ? 'border-dashed bg-muted/50 text-muted-foreground' : 'bg-card'}`}>
      {mode === 'exclude' ? <MinusIcon aria-hidden="true" className="size-3.5 shrink-0" /> : null}
      <span lang={value?.language} className="truncate">{label}</span>
      {value?.count !== undefined ? <span className="tabular-nums text-muted-foreground">{value.count}</span> : null}
      {isFixed ? <span className="sr-only">{t.conditionFixed({ name: label })}</span> : <Link href={change(next)} scroll={false}
        aria-label={t.conditionRemove({ name: label })} className="grid size-6 shrink-0 place-items-center rounded-full outline-none
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
  return <section ref={root} aria-labelledby={heading} className="grid gap-3 rounded-2xl border border-border/60 bg-card/60 p-4">
    <h2 id={heading} className="font-semibold text-sm">{t.conditionHeading}</h2>
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">{facetLabel ?? t.conditionFacet}</span>
      <ul className="flex min-w-0 flex-wrap gap-2">{selection.include.map(id => chip(id, 'include'))}</ul>
      {selection.exclude.length ? <span className="text-muted-foreground">{t.exclude}</span> : null}
      <ul className="flex min-w-0 flex-wrap gap-2">{selection.exclude.map(id => chip(id, 'exclude'))}</ul>
      {ids.some(id => id !== fixed) ? <Link href={change({ include: fixed ? [fixed] : [], exclude: [], match: 'all' })}
        scroll={false} className="font-medium text-primary underline-offset-4 hover:underline">{t.conditionClear}</Link> : null}
    </div>
    <div className="flex flex-wrap items-center gap-3">
      {selection.include.length > 1 ? <div role="group" aria-label={t.conditionMatch} className="flex items-center gap-1">
        <span className="text-muted-foreground text-sm">{t.conditionMatch}</span>
        {(['all', 'any'] as const).map(match => <Link key={match} href={change({ ...selection, match })}
          aria-current={selection.match === match || undefined} scroll={false}
          className="rounded-lg px-3 py-1.5 text-sm aria-[current=true]:bg-primary/10
            aria-[current=true]:text-primary hover:bg-accent">{match === 'all' ? t.conditionAll : t.conditionAny}</Link>)}
      </div> : null}
      {room.include || room.exclude ? <>
        <SegmentGroup value={operator} onValueChange={({ value }) => value && setOperator(value as typeof operator)}
          aria-label={t.conditionHeading} className="p-0.5">
          <SegmentGroupItem value="include" disabled={!room.include} className="h-7 px-3">
            <PlusIcon aria-hidden="true" /><SegmentGroupItemText>{t.include}</SegmentGroupItemText>
          </SegmentGroupItem>
          <SegmentGroupItem value="exclude" disabled={!room.exclude} className="h-7 px-3">
            <MinusIcon aria-hidden="true" /><SegmentGroupItemText>{t.exclude}</SegmentGroupItemText>
          </SegmentGroupItem>
        </SegmentGroup>
        <Combobox collection={collection} openOnClick={false} selectionBehavior="clear" inputValue={phrase}
          className="w-full min-w-48 sm:w-64"
          onInputValueChange={({ inputValue, reason }) => {
            setPhrase(inputValue);
            // "script" is a controlled echo of the same keystrokes; still search it.
            if (reason !== 'item-select' && reason !== 'clear-trigger' && reason !== 'interact-outside') {
              lookup(inputValue);
            }
          }}
          onSelect={({ itemValue }) => addConcept(itemValue)}>
          <ArkCombobox.Label className="sr-only">{t.conditionSearch}</ArkCombobox.Label>
          <ComboboxInput placeholder={t.conditionSearch} showTrigger={false} size="sm" />
          <ComboboxContent><ComboboxEmpty>{status === 'searching' ? t.conditionSearching
            : status === 'failed' ? t.conditionFailed : t.conditionEmpty}</ComboboxEmpty>
            <ComboboxList>{collection.items.map(item => <ComboboxItem key={item.concept} item={item}
              onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); addConcept(item.concept); }}>
              <span lang={item.language} className="truncate">{item.label}</span>
            </ComboboxItem>)}</ComboboxList></ComboboxContent>
        </Combobox>
      </> : <p className="text-muted-foreground text-sm">{t.conditionFull({ count: String(maxTotal ?? maxValues) })}</p>}
    </div>
    {offered.length ? <div className="grid gap-2">
      <p className="text-muted-foreground text-xs">{t.conditionAlsoOn}</p>
      <ul className="flex flex-wrap gap-2">{offered.map(value => {
        const id = idOf(value.id) ?? value.id;
        return <li key={id} className="inline-flex h-8 items-center gap-1 rounded-full border bg-background ps-3 pe-1
          text-sm"><span lang={value.language}>{value.name}</span>
          {room.include ? <Link href={change({ ...selection, include: [...selection.include, id] })}
            aria-label={t.conditionIncludeName({ name: value.name })} scroll={false} className="grid size-6 place-items-center rounded-full
              hover:bg-accent"><PlusIcon aria-hidden="true" className="size-3.5" /></Link> : null}
          {room.exclude ? <Link href={change({ ...selection, exclude: [...selection.exclude, id] })}
            aria-label={t.conditionExcludeName({ name: value.name })} scroll={false} className="grid size-6 place-items-center rounded-full
              hover:bg-accent"><MinusIcon aria-hidden="true" className="size-3.5" /></Link> : null}
        </li>;
      })}</ul>
    </div> : null}
  </section>;
}

/** Search keeps its first included Concept in `term` for shareable existing links. */
export function SearchConditionBar({ state, locale, values = EMPTY_VALUES, actingSubject }: { state: SearchState;
  locale: UiLocale; values?: readonly NamedCondition[]; actingSubject?: string }) {
  const selection: ConditionSelection = { include: [...(state.term ? [state.term] : []),
    ...(state.concepts?.include ?? [])], exclude: state.concepts?.exclude ?? [],
    match: state.concepts?.match ?? 'all' };
  return <ConditionBar selection={selection} locale={locale} values={values} actingSubject={actingSubject} maxTotal={3}
    realm={state.scope.kind === 'realm' ? state.scope.realm : null}
    href={next => searchHref({ ...state, term: next.include[0] ?? null,
      concepts: { include: next.include.slice(1), exclude: next.exclude, match: next.match } })} />;
}

export function DiscoverConditionBar({ state, locale, values = EMPTY_VALUES, actingSubject }: { state: DiscoverState;
  locale: UiLocale; values?: readonly NamedCondition[]; actingSubject?: string }) {
  const selection: ConditionSelection = state.conditions ?? { include: [], exclude: [], match: 'all' };
  return <ConditionBar selection={selection} locale={locale} values={values} actingSubject={actingSubject}
    realm={state.scope.kind === 'realm' ? state.scope.realm : null}
    href={next => discoverHref({ ...state, conditions: next })} />;
}
