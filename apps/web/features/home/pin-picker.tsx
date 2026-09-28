'use client';

import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTrigger } from '@rezics/ui/dialog';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@rezics/ui/input-group';
import { Spinner } from '@rezics/ui/spinner';
import { cn } from '@rezics/ui/utils';
import { ArrowLeftIcon, ChevronRightIcon, PinIcon, PlusIcon, SearchIcon, SlidersHorizontalIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FilterDocument } from '../../../../model/definitions/filter-document-v1.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { Loaded } from '../feed/types.ts';
import { type FeedDefaults, feedSearch, type FeedState, pinnedTab } from '../feed/state.ts';
import { mainSavedFilterApi, type SavedFilterApi } from '../saved-filter/api.ts';
import { currentFiltersName, filterTitle, MAX_PINNED } from '../saved-filter/tabs.ts';
import type { CommandFailure, ConceptDetail, SavedFilter, SavedFilters } from '../saved-filter/types.ts';
import type { HomeMessages } from './messages.ts';

type T = ReturnType<typeof materializeData<HomeMessages>>;
interface Topic { id: string; name: { value: string; language?: string } }

const row = cn('flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-start text-sm outline-none',
  'transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60');
const chip = cn('inline-flex h-8 items-center rounded-full border border-border/70 px-3 font-medium text-sm',
  'outline-none transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring');

export interface PinPickerProps {
  state: FeedState;
  defaults: FeedDefaults;
  locale: UiLocale;
  messages: HomeMessages;
  actingSubject: string;
  filters: SavedFilters;
  /** Home's active Filters (languages and communities) and their names, which can be saved as a tab. */
  current: { document: FilterDocument; labels: string[] } | null;
  /** Stories: an in-memory Main. */
  api?: SavedFilterApi;
  /** Stories: start open. */
  defaultOpen?: boolean;
}

/**
 * `+` after the tabs: pin a topic by searching Concepts in the reader's
 * language, stepping to broader or narrower ones to refine, or save the
 * Filters Home shows now as a tab. With no pinned tab yet it says so in words,
 * as the invitation Home gives a reader who skipped choosing topics.
 */
export function PinPicker({ state, defaults, locale, messages, actingSubject, filters, current, api: given,
  defaultOpen = false }: PinPickerProps) {
  const t = materializeData(messages, { locale });
  const router = useRouter();
  const api = useRef<SavedFilterApi | null>(given ?? null);
  const client = useCallback(() => api.current ??= mainSavedFilterApi(actingSubject), [actingSubject]);
  const [open, setOpen] = useState(defaultOpen);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<CommandFailure | null>(null);
  const full = filters.pinned.length >= MAX_PINNED;
  const empty = !filters.pinned.length;

  const go = (id: string) => {
    setOpen(false);
    router.push(localizedPath(`/${feedSearch(pinnedTab(state, id), defaults)}`, locale));
  };
  const fail = (reason: CommandFailure) => { setBusy(null); setFailure(reason); };

  async function pinConcept(topic: Topic) {
    setBusy(topic.id); setFailure(null);
    const known = [...filters.pinned, ...filters.unpinned].find(filter => filter.concept?.id === topic.id);
    if (known?.position !== null && known) return go(known.id);
    if (known) {
      const pinned = await client().update(known, { pinned: true });
      return pinned.ok ? go(known.id) : fail(pinned.failure);
    }
    const followed = await client().followConcept(topic.id, true);
    if (!followed.ok) return fail(followed.failure);
    const listed = await client().list(locale);
    const made = listed.ok ? listed.data.items.find(item => item.concept?.id === topic.id) : undefined;
    if (!made) return fail('unavailable');
    if (made.position === null) return fail('full');
    go(made.id);
  }

  async function pinFilter(filter: SavedFilter) {
    setBusy(filter.id); setFailure(null);
    const pinned = await client().update(filter, { pinned: true });
    return pinned.ok ? go(filter.id) : fail(pinned.failure);
  }

  async function saveCurrent(name: string) {
    if (!current) return;
    setBusy('current'); setFailure(null);
    const created = await client().create({ name, filter: current.document, pinned: true });
    return created.ok && created.data.id ? go(created.data.id) : fail(created.ok ? 'unavailable' : created.failure);
  }

  return <Dialog open={open} onOpenChange={details => { setOpen(details.open); if (!details.open) setFailure(null); }}>
    <DialogTrigger aria-label={empty ? undefined : t.pinMore} title={empty ? undefined : t.pinMore}
      className={cn('flex h-12 shrink-0 items-center gap-1.5 border-border/60 border-s px-3.5 font-medium text-sm',
        'text-primary outline-none transition-colors hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-ring',
        'focus-visible:ring-inset')}>
      <PlusIcon aria-hidden="true" className="size-4.5" />
      {empty ? <span className="whitespace-nowrap">{t.pinTopic}</span> : null}
    </DialogTrigger>
    <DialogContent size="md">
      <DialogHeader title={t.pinTitle} description={t.pinBody} />
      <DialogBody className="grid gap-5">
        {full ? <p role="status" className="rounded-xl bg-muted px-3 py-2 text-muted-foreground text-sm">{t.tabsFull}</p>
          : null}
        {failure && !(full && failure === 'full') ? <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2
          text-destructive-foreground text-sm">{failure === 'full' ? t.tabsFull : failure === 'unsupported'
            ? t.tabUnsupported : t.pinFailed}</p> : null}
        <TopicSearch t={t} locale={locale} api={client} disabled={full} busy={busy}
          unpinned={filters.unpinned} onPin={topic => void pinConcept(topic)} onPinFilter={filter => void pinFilter(filter)} />
        {current ? <SaveCurrent t={t} labels={current.labels} disabled={full} busy={busy === 'current'}
          onSave={name => void saveCurrent(name)} /> : null}
      </DialogBody>
    </DialogContent>
  </Dialog>;
}

/**
 * Concept search in the reader's language (then English), the reader's own
 * unpinned topics and popular ones before a search, and one Concept's broader
 * and narrower neighbours to refine a choice before pinning it.
 */
function TopicSearch({ t, locale, api, disabled, busy, unpinned, onPin, onPinFilter }: { t: T; locale: UiLocale;
  api: () => SavedFilterApi; disabled: boolean; busy: string | null; unpinned: readonly SavedFilter[];
  onPin: (topic: Topic) => void; onPinFilter: (filter: SavedFilter) => void }) {
  const [phrase, setPhrase] = useState('');
  const [results, setResults] = useState<Loaded<Topic[]> | null>(null);
  const [popular, setPopular] = useState<Topic[] | null>(null);
  const [selected, setSelected] = useState<Topic | null>(null);
  const [detail, setDetail] = useState<Loaded<ConceptDetail> | null>(null);
  const request = useRef(0);

  useEffect(() => {
    let active = true;
    void api().popularConcepts(locale).then(read => { if (active) setPopular(read.ok ? read.data : []); });
    return () => { active = false; };
  }, [api, locale]);

  useEffect(() => {
    const query = phrase.trim();
    const id = ++request.current;
    if (!query) { setResults(null); return; }
    const timer = setTimeout(() => {
      void api().searchConcepts(query, locale).then(read => {
        if (id !== request.current) return;
        setResults(read.ok ? { ok: true, data: read.data.map(item => ({ id: item.concept,
          name: { value: item.label, language: item.language } })) } : read);
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [api, phrase, locale]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let active = true;
    setDetail(null);
    void api().concept(selected.id, locale).then(read => { if (active) setDetail(read); });
    return () => { active = false; };
  }, [api, selected, locale]);

  if (selected) {
    const neighbours = (title: string, items: readonly { id: string; name: { value: string; language: string } }[]) =>
      items.length ? <section aria-label={title} className="grid gap-2">
        <h3 className="font-medium text-muted-foreground text-xs">{title}</h3>
        <ul className="flex flex-wrap gap-2">
          {items.map(item => <li key={item.id}><button type="button" className={chip} lang={item.name.language}
            onClick={() => setSelected({ id: item.id, name: item.name })}>{item.name.value}</button></li>)}
        </ul>
      </section> : null;
    const name = detail?.ok ? detail.data.name : selected.name;
    return <div className="grid gap-4">
      <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setSelected(null)}>
        <ArrowLeftIcon aria-hidden="true" className="rtl:rotate-180" />{t.back}</Button>
      <div className="grid gap-1.5">
        <h3 lang={name.language} className="text-balance font-semibold text-xl">{name.value}</h3>
        {detail?.ok && detail.data.description ? <p lang={detail.data.description.language}
          className="text-pretty text-muted-foreground text-sm">{detail.data.description.value}</p> : null}
      </div>
      {!detail ? <Spinner aria-hidden="true" /> : detail.ok ? <>
        {neighbours(t.broader, detail.data.broader)}
        {neighbours(t.narrower, detail.data.narrower)}
      </> : null}
      <Button className="justify-self-start" disabled={disabled} isLoading={busy === selected.id}
        onClick={() => onPin({ id: selected.id, name })}><PinIcon aria-hidden="true" />
        {t.pinThis({ topic: name.value })}</Button>
    </div>;
  }

  return <div className="grid gap-4">
    <Field>
      <FieldLabel className="sr-only">{t.searchTopics}</FieldLabel>
      <InputGroup>
        <InputGroupAddon><SearchIcon aria-hidden="true" /></InputGroupAddon>
        <InputGroupInput type="search" value={phrase} placeholder={t.searchTopics} aria-label={t.searchTopics}
          onChange={event => setPhrase(event.target.value)} />
      </InputGroup>
    </Field>
    {phrase.trim() ? !results ? <p role="status" className="flex items-center gap-2 text-muted-foreground text-sm">
      <Spinner aria-hidden="true" />{t.searching}</p>
      : !results.ok ? <p role="alert" className="text-destructive-foreground text-sm">{t.searchFailed}</p>
        : !results.data.length ? <p role="status" className="text-muted-foreground text-sm">{t.noTopics}</p>
          : <ul aria-label={t.searchTopics} className="-mx-3 grid">
            {results.data.map(topic => <li key={topic.id}><button type="button" className={row}
              onClick={() => setSelected(topic)}>
              <span lang={topic.name.language} className="min-w-0 flex-1 truncate">{topic.name.value}</span>
              <ChevronRightIcon aria-hidden="true" className="size-4 text-muted-foreground rtl:rotate-180" />
            </button></li>)}
          </ul>
      : <>
        {unpinned.length ? <section aria-label={t.yourTopics} className="grid gap-2">
          <h3 className="font-medium text-muted-foreground text-xs">{t.yourTopics}</h3>
          <ul className="-mx-3 grid">
            {unpinned.slice(0, 8).map(filter => {
              const title = filterTitle(filter);
              return <li key={filter.id}><button type="button" className={row}
                disabled={disabled || filter.home !== 'available'} onClick={() => onPinFilter(filter)}>
                {filter.concept ? <PinIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                  : <SlidersHorizontalIcon aria-hidden="true" className="size-4 text-muted-foreground" />}
                <span lang={title?.language} className="min-w-0 flex-1 truncate">{title?.value ?? t.untitledTab}</span>
                {busy === filter.id ? <Spinner aria-hidden="true" /> : null}
              </button></li>;
            })}
          </ul>
        </section> : null}
        {popular?.length ? <section aria-label={t.popularTopics} className="grid gap-2">
          <h3 className="font-medium text-muted-foreground text-xs">{t.popularTopics}</h3>
          <ul className="flex flex-wrap gap-2">
            {popular.map(topic => <li key={topic.id}><button type="button" className={chip} lang={topic.name.language}
              onClick={() => setSelected(topic)}>{topic.name.value}</button></li>)}
          </ul>
        </section> : null}
      </>}
  </div>;
}

/** Home's active Filters as one named tab. */
function SaveCurrent({ t, labels, disabled, busy, onSave }: { t: T; labels: readonly string[]; disabled: boolean;
  busy: boolean; onSave: (name: string) => void }) {
  const [name, setName] = useState(() => currentFiltersName(labels));
  const trimmed = name.trim();
  return <form aria-label={t.saveFilters} className="grid gap-3 border-border/60 border-t pt-5"
    onSubmit={event => { event.preventDefault(); if (trimmed) onSave(trimmed); }}>
    <div className="grid gap-1">
      <h3 className="font-semibold text-sm">{t.saveFilters}</h3>
      <p className="text-muted-foreground text-sm">{t.saveFiltersBody}</p>
    </div>
    <ul className="flex flex-wrap gap-1.5">
      {labels.map(label => <li key={label} className="rounded-full bg-primary/10 px-2.5 py-1 font-medium text-primary
        text-xs">{label}</li>)}
    </ul>
    <div className="flex flex-wrap items-end gap-2">
      <Field className="min-w-48 flex-1">
        <FieldLabel>{t.tabName}</FieldLabel>
        <Input value={name} maxLength={80} onChange={event => setName(event.target.value)} />
      </Field>
      <Button type="submit" variant="soft" disabled={disabled || !trimmed} isLoading={busy}>{t.saveTab}</Button>
    </div>
  </form>;
}
