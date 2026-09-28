'use client';

import { Combobox as ArkCombobox, useListCollection } from '@ark-ui/react/combobox';
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem,
  ComboboxList } from '@rezics/ui/combobox';
import { SegmentGroup, SegmentGroupItem, SegmentGroupItemText } from '@rezics/ui/segment-group';
import { cn } from '@rezics/ui/utils';
import { MinusIcon, PlusIcon, XIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { browserMainApi } from '../api/browser.ts';
import { idOf, iriOf } from '../discover/scope.ts';
import Link from '../shell/localized-link.tsx';
import type { ConceptMessages } from './messages.ts';
import { type ConceptState, conceptHref, DEFAULT_MAX_VALUES, hasRoom, withoutValue, withValue } from './state.ts';
import type { ConceptSearchItem } from './types.ts';

type Text = ReturnType<typeof materializeData<ConceptMessages>>;
type Name = { value: string; language: string; direction: 'ltr' | 'rtl' };

/** A value in the bar or offered to it, named by its Concept; null while Main could not name it. */
export interface BarValue { id: string; name: Name | null }

/** Concepts whose labels contain a phrase, in the reader's language and English. */
export type ConceptSearch = (phrase: string, locale: UiLocale, realm: string | null) => Promise<ConceptSearchItem[]>;

const mainSearch: ConceptSearch = async (phrase, locale, realm) => {
  const languages = locale === 'en' ? ['en'] : [locale, 'en'];
  const pages = await Promise.all(languages.map(language => browserMainApi().v1.concepts.get({ query: {
    q: phrase, language, limit: 8, ...(realm ? { realm: iriOf(realm) } : {}) } })));
  if (pages.every(page => page.error)) throw new Error('Concept search failed');
  const seen = new Set<string>();
  return pages.flatMap(page => page.data?.items ?? []).filter(item => !seen.has(item.concept) && seen.add(item.concept));
};

const chip = 'inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border text-sm';
const iconLink = cn('grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground outline-none',
  'transition-colors hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring');

function Label({ value, fallback }: { value: BarValue; fallback: string }) {
  return value.name ? <span lang={value.name.language} dir={value.name.direction} className="truncate">
    {value.name.value}</span> : <span className="truncate text-muted-foreground">{fallback}</span>;
}

/** One value in the bar: the page's Concept stays; every other can be removed. */
function ValueChip({ value, operator, fixed, state, t }: { value: BarValue; operator: 'include' | 'exclude';
  fixed?: boolean; state: ConceptState; t: Text }) {
  const name = value.name?.value ?? (idOf(value.id) ?? value.id).slice(-8);
  const said = fixed ? t.pageValue({ name }) : operator === 'include' ? t.includedValue({ name })
    : t.excludedValue({ name });
  return <li className={cn(chip, 'min-w-0', fixed ? 'border-primary/40 bg-primary/10 px-3.5 font-medium text-primary'
    : operator === 'include' ? 'border-border bg-card ps-3.5 pe-1'
      : 'border-foreground/25 border-dashed bg-muted/50 ps-2.5 pe-1 text-muted-foreground')}>
    {operator === 'exclude' ? <MinusIcon aria-hidden="true" className="size-3.5 shrink-0" /> : null}
    <span className="sr-only">{said}</span>
    <span aria-hidden="true" className={cn('min-w-0 truncate', operator === 'exclude' && 'line-through')}>
      <Label value={value} fallback={name} /></span>
    {fixed ? null : <Link href={conceptHref(withoutValue(state, idOf(value.id) ?? value.id))} className={iconLink}
      aria-label={t.removeValue({ name })} scroll={false}><XIcon aria-hidden="true" className="size-3.5" /></Link>}
  </li>;
}

/** All or any of the included values, as links: the choice is the page's address. */
function Match({ state, t }: { state: ConceptState; t: Text }) {
  const option = (match: 'all' | 'any', label: string, help: string) => <Link
    href={conceptHref({ ...state, match })} scroll={false} aria-current={state.match === match || undefined}
    title={help} className={cn('inline-flex h-7 items-center rounded-lg px-3 font-medium text-sm outline-none',
      'transition-colors focus-visible:ring-2 focus-visible:ring-ring', state.match === match
        ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground')}>
    {label}<span className="sr-only"> — {help}</span></Link>;
  return <div role="group" aria-label={t.match} className="flex items-center gap-2">
    <span aria-hidden="true" className="text-muted-foreground text-sm">{t.match}</span>
    <div className="flex rounded-xl border border-border/60 bg-card p-0.5">
      {option('all', t.matchAll, t.matchAllHelp)}{option('any', t.matchAny, t.matchAnyHelp)}
    </div>
  </div>;
}

/** Find a Concept by its label and include or exclude it: the page moves to the new Condition. */
function AddConcept({ state, taken, maxValues, search, locale, t }: { state: ConceptState; taken: ReadonlySet<string>;
  maxValues: number; search: ConceptSearch; locale: UiLocale; t: Text }) {
  const router = useRouter();
  const [operator, setOperator] = useState<'include' | 'exclude'>(hasRoom(state, 'include', maxValues)
    ? 'include' : 'exclude');
  const [status, setStatus] = useState<'idle' | 'searching' | 'failed'>('idle');
  const { collection, set } = useListCollection<ConceptSearchItem>({ initialItems: [],
    itemToValue: item => item.concept, itemToString: item => item.label });
  const request = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const room = { include: hasRoom(state, 'include', maxValues), exclude: hasRoom(state, 'exclude', maxValues) };
  if (!room.include && !room.exclude) return <p className="text-muted-foreground text-sm">
    {t.full({ count: String(maxValues) })}</p>;

  function lookup(phrase: string) {
    clearTimeout(timer.current);
    const mine = ++request.current;
    if (!phrase.trim()) { set([]); setStatus('idle'); return; }
    setStatus('searching');
    timer.current = setTimeout(() => {
      search(phrase.trim(), locale, state.scope.kind === 'realm' ? state.scope.realm : null).then(items => {
        if (mine !== request.current) return;
        set(items.filter(item => !taken.has(item.concept)));
        setStatus('idle');
      }, () => { if (mine === request.current) { set([]); setStatus('failed'); } });
    }, 200);
  }

  return <div className="flex min-w-0 flex-wrap items-center gap-2">
    <SegmentGroup value={operator} onValueChange={({ value }) => value && setOperator(value as typeof operator)}
      aria-label={t.addConcept} className="p-0.5">
      <SegmentGroupItem value="include" disabled={!room.include} className="h-7 px-3">
        <PlusIcon aria-hidden="true" /><SegmentGroupItemText>{t.include}</SegmentGroupItemText></SegmentGroupItem>
      <SegmentGroupItem value="exclude" disabled={!room.exclude} className="h-7 px-3">
        <MinusIcon aria-hidden="true" /><SegmentGroupItemText>{t.exclude}</SegmentGroupItemText></SegmentGroupItem>
    </SegmentGroup>
    <Combobox collection={collection} openOnClick={false} className="w-full min-w-48 sm:w-64"
      onInputValueChange={({ inputValue, reason }) => { if (reason === 'input-change') lookup(inputValue); }}
      onValueChange={({ value }) => {
        const id = idOf(value[0] ?? '');
        if (id) router.push(localizedPath(conceptHref(withValue(state, id, operator)), locale), { scroll: false });
      }}>
      {/* Names the input, its popup and its list alike. */}
      <ArkCombobox.Label className="sr-only">{t.addConcept}</ArkCombobox.Label>
      <ComboboxInput placeholder={t.searchConcepts} showTrigger={false} size="sm" />
      <ComboboxContent>
        <ComboboxEmpty>{status === 'searching' ? t.searchingConcepts : status === 'failed' ? t.conceptSearchFailed
          : t.noConcepts}</ComboboxEmpty>
        <ComboboxList>
          {collection.items.map(item => <ComboboxItem key={item.concept} item={item}>
            <span lang={item.language} className="truncate">{item.label}</span>
          </ComboboxItem>)}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  </div>;
}

/**
 * The Condition bar, as AO3's typed tag filters: the page's Concept and the
 * values included with it, matching all or any, then those excluded. Values
 * are added by name or from the ones the listed Works also carry; every
 * change is a new address, so a filtered list can be shared and gone back from.
 */
export function ConditionBar({ state, page, values, suggestions, maxValues = DEFAULT_MAX_VALUES, search = mainSearch,
  locale, messages }: {
  state: ConceptState;
  /** The page's Concept. */
  page: BarValue;
  /** The bar's other values, named by Main when it could read them. */
  values: readonly BarValue[];
  /** Concepts the listed Works also carry, to include or exclude in one step. */
  suggestions: readonly BarValue[];
  /** Values per operator the Concept Facet admits. */
  maxValues?: number;
  search?: ConceptSearch;
  locale: UiLocale; messages: ConceptMessages;
}) {
  const t = materializeData(messages, { locale });
  const heading = useId();
  const named = (id: string) => values.find(value => idOf(value.id) === id) ?? { id: iriOf(id), name: null };
  const taken = new Set([state.concept, ...state.include, ...state.exclude].map(iriOf));
  const offered = suggestions.filter(value => !taken.has(value.id)).slice(0, 8);
  const filtered = state.include.length > 0 || state.exclude.length > 0;
  return <section aria-labelledby={heading} className="grid gap-4 rounded-2xl border border-border/60 bg-card/60 p-4
    sm:p-5">
    <h2 id={heading} className="sr-only">{t.conditions}</h2>
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="text-muted-foreground text-sm">{t.worksWith}</span>
      <ul className="flex min-w-0 flex-wrap items-center gap-2">
        <ValueChip value={page} operator="include" fixed state={state} t={t} />
        {state.include.map(id => <ValueChip key={id} value={named(id)} operator="include" state={state} t={t} />)}
      </ul>
      {state.exclude.length ? <>
        <span className="text-muted-foreground text-sm">{t.without}</span>
        <ul className="flex min-w-0 flex-wrap items-center gap-2">
          {state.exclude.map(id => <ValueChip key={id} value={named(id)} operator="exclude" state={state} t={t} />)}
        </ul>
      </> : null}
      {filtered ? <Link href={conceptHref({ ...state, include: [], exclude: [], match: 'all' })} scroll={false}
        className="ms-1 rounded-sm font-medium text-primary text-sm underline-offset-4 outline-none hover:underline
          focus-visible:ring-2 focus-visible:ring-ring">{t.clearConditions}</Link> : null}
    </div>
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      {state.include.length ? <Match state={state} t={t} /> : null}
      {/* A new address starts a new search: the chosen Concept is now a chip, not text in the field. */}
      <AddConcept key={conceptHref(state)} state={state} taken={taken} maxValues={maxValues} search={search}
        locale={locale} t={t} />
    </div>
    {offered.length ? <div className="grid gap-2">
      <p className="text-muted-foreground text-xs">{t.alsoOn}</p>
      <ul className="flex flex-wrap gap-2">
        {offered.map(value => {
          const id = idOf(value.id) ?? value.id;
          const name = value.name?.value ?? id.slice(-8);
          return <li key={value.id} className={cn(chip, 'border-border/70 bg-background ps-3 pe-1')}>
            <Label value={value} fallback={name} />
            {hasRoom(state, 'include', maxValues) ? <Link href={conceptHref(withValue(state, id, 'include'))}
              scroll={false} aria-label={t.includeName({ name })} className={iconLink}>
              <PlusIcon aria-hidden="true" className="size-3.5" /></Link> : null}
            {hasRoom(state, 'exclude', maxValues) ? <Link href={conceptHref(withValue(state, id, 'exclude'))}
              scroll={false} aria-label={t.excludeName({ name })} className={iconLink}>
              <MinusIcon aria-hidden="true" className="size-3.5" /></Link> : null}
          </li>;
        })}
      </ul>
    </div> : null}
  </section>;
}
