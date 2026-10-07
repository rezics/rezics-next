'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@rezics/ui/sheet';
import { Skeleton } from '@rezics/ui/skeleton';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { appendEditionPage, type EditionPageRequest, type TrackingApi } from './api.ts';
import { AttemptCard } from './attempt-card.tsx';
import { EditionPicker } from './attempt-fields.tsx';
import { editionName } from './display.ts';
import { copyOf, type Copy } from './messages.ts';
import { editionListed, editionOptions, hasEnded, isOpen, numbered, selectionInput } from './model.ts';
import type { Editions, Session } from './types.ts';

type Attempts = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; items: Session[]; next: string | null };

/** What the sheet offers once a page of editions is in hand: another page, a retry, or nothing. */
export function editionContinuation(editions: Editions | null, failed: boolean): 'more' | 'retry' | null {
  if (failed && editions) return 'retry';
  return editions?.realizationsCursor || editions?.releasesCursor ? 'more' : null;
}

/**
 * A failed next page leaves the editions already listed untouched and asks for a retry.
 * A page that arrives is appended in its own order, without repeating an edition already shown.
 */
export function applyEditionPage(current: Editions, read: Awaited<ReturnType<TrackingApi['editions']>>, requested: EditionPageRequest):
  { editions: Editions; retry: boolean } {
  if (!read.ok) return { editions: current, retry: true };
  return { editions: appendEditionPage(current, read.data, requested), retry: false };
}

/** The next page to ask for: only lists that still have a cursor. */
function editionRequest(editions: Editions): { query: { realizations?: string; releases?: string }; requested: EditionPageRequest } | null {
  const requested = { realizations: Boolean(editions.realizationsCursor), releases: Boolean(editions.releasesCursor) };
  if (!requested.realizations && !requested.releases) return null;
  return { requested, query: {
    ...(editions.realizationsCursor ? { realizations: editions.realizationsCursor } : {}),
    ...(editions.releasesCursor ? { releases: editions.releasesCursor } : {}),
  } };
}

/** The attempts of one Work, read when the sheet opens; a write replaces the attempt it changed. */
function useAttempts(work: string, api: TrackingApi, open: boolean) {
  const [attempts, setAttempts] = useState<Attempts>({ status: 'loading' });
  const [editions, setEditions] = useState<Editions | null>(null);
  const [editionsFailed, setEditionsFailed] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const generation = useRef(0);
  const readingMore = useRef(false);
  const load = useCallback(async () => {
    const ticket = ++generation.current;
    setAttempts({ status: 'loading' });
    setMoreFailed(false);
    setMoreBusy(false);
    const [read, offered] = await Promise.all([api.sessions(work), api.editions(work)]);
    if (ticket !== generation.current) return;
    setAttempts(read.ok ? { status: 'ready', items: read.data.items, next: read.data.next } : { status: 'failed' });
    setEditions(offered.ok ? offered.data : null);
    setEditionsFailed(!offered.ok);
  }, [api, work]);
  useEffect(() => { if (open) void load(); }, [open, load]);
  const more = async () => {
    if (attempts.status !== 'ready' || !attempts.next) return;
    const read = await api.sessions(work, attempts.next);
    if (read.ok) setAttempts({ status: 'ready', items: [...attempts.items, ...read.data.items], next: read.data.next });
  };
  const moreEditions = async () => {
    if (!editions || readingMore.current) return;
    const next = editionRequest(editions);
    if (!next) return;
    const ticket = generation.current;
    const held = editions;
    readingMore.current = true;
    setMoreBusy(true);
    setMoreFailed(false);
    try {
      const read = await api.editions(work, next.query);
      if (ticket !== generation.current) return;
      const applied = applyEditionPage(held, read, next.requested);
      setEditions(applied.editions);
      setMoreFailed(applied.retry);
    } finally {
      readingMore.current = false;
      setMoreBusy(false);
    }
  };
  /** An attempt as Main now holds it: replaced in place, or put first when it is new. */
  const put = (session: Session) => setAttempts(current => current.status !== 'ready' ? current
    : { ...current, items: current.items.some(item => item.id === session.id)
      ? current.items.map(item => (item.id === session.id ? session : item)) : [session, ...current.items] });
  return { attempts, editions, editionsFailed, moreFailed, moreBusy, load, more, moreEditions, put };
}

function StartAttempt({ work, editions, api, locale, t, reread, query, onStarted }: {
  work: string; editions: Editions | null; api: TrackingApi; locale: UiLocale; t: Copy; reread: boolean; query: string;
  onStarted: (session: Session) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const nameOf = (option: { resource: string; kind: 'work' | 'realization' | 'release' }) =>
    editionName(option.resource, option.kind, editions, locale, t);
  const options = editionOptions(work, editions, null).filter(option => editionListed(nameOf(option), query));
  async function start(state: 'planned' | 'active', option: Parameters<typeof selectionInput>[0] | null, format: string | null) {
    setBusy(true);
    setFailed(false);
    const addSelections = option || format
      ? [selectionInput(option ?? { resource: work, kind: 'work', language: null }, format)] : undefined;
    const written = await api.start(work, { state, ...(addSelections ? { addSelections } : {}) });
    setBusy(false);
    if (written.ok) onStarted(written.data);
    else setFailed(true);
  }
  return <section aria-label={reread ? t.startReread : t.start} className="grid gap-3 rounded-2xl border border-border/60 border-dashed p-4">
    <h3 className="font-semibold text-base">{reread ? t.startReread : t.start}</h3>
    <EditionPicker options={options} nameOf={nameOf} t={t} busy={busy} submit={t.startReading} allowWork
      onSubmit={(option, format) => start('active', option, format)}
      secondary={{ label: t.plan, onSubmit: (option, format) => start('planned', option, format) }} />
    {failed ? <p role="status" className="text-destructive-foreground text-xs">{t.saveFailed}</p> : null}
  </section>;
}

/** The control that reaches the next page of editions, or retries a page that failed without discarding the ones listed. */
export function EditionContinuation({ editions, failed, busy, t, onMore }: {
  editions: Editions | null; failed: boolean; busy: boolean; t: Copy; onMore: () => void;
}) {
  const mode = editionContinuation(editions, failed);
  if (!mode) return null;
  return <div className="flex flex-wrap items-center gap-2">
    {mode === 'retry' ? <p role="alert" className="text-destructive-foreground text-xs">{t.moreEditionsFailed}</p> : null}
    <Button variant="outline" size="sm" disabled={busy} onClick={onMore}>{mode === 'retry' ? t.retry : t.moreEditions}</Button>
  </div>;
}

function listedEditionMatches(work: string, editions: Editions | null, locale: UiLocale, t: Copy, query: string): boolean {
  if (!query.trim()) return true;
  return editionOptions(work, editions, null).some(option => option.kind !== 'work'
    && editionListed(editionName(option.resource, option.kind, editions, locale, t), query));
}

function SheetAttempts({ work, api, locale, t, open }: {
  work: string; api: TrackingApi; locale: UiLocale; t: Copy; open: boolean;
}) {
  const { attempts, editions, editionsFailed, moreFailed, moreBusy, load, more, moreEditions, put } = useAttempts(work, api, open);
  const [query, setQuery] = useState('');
  if (attempts.status === 'loading') {
    return <div className="grid gap-3" aria-busy="true"><Skeleton className="h-28 rounded-2xl" /><Skeleton className="h-28 rounded-2xl" /></div>;
  }
  if (attempts.status === 'failed') {
    return <Alert variant="destructive" role="alert"><AlertDescription className="flex flex-wrap items-center gap-3">
      {t.loadFailed}<Button size="sm" variant="outline" onClick={() => void load()}>{t.retry}</Button></AlertDescription></Alert>;
  }
  const rows = numbered(attempts.items);
  const openCount = attempts.items.filter(isOpen).length;
  const ended = attempts.items.some(hasEnded);
  // A short list is chosen from the select. The filter appears once another page remains, or enough editions
  // are listed that the one the reader wants is no longer obvious.
  const listedCount = (editions?.realizations.length ?? 0) + (editions?.releases.length ?? 0);
  const canFilter = listedCount > 8 || editionContinuation(editions, false) === 'more';
  return <div className="grid gap-4" data-listed-editions={listedCount}>
    {openCount > 1 ? <Alert variant="warning" role="status" data-two-open><AlertDescription>{t.twoOpen}</AlertDescription></Alert> : null}
    {editionsFailed ? <p className="text-muted-foreground text-xs">{t.editionsFailed}</p> : null}
    {canFilter ? <Field className="gap-1.5">
      <FieldLabel className="text-muted-foreground text-xs">{t.filterEditions}</FieldLabel>
      <Input size="sm" value={query} className="w-full" aria-label={t.filterEditions}
        onChange={event => setQuery(event.target.value)} />
    </Field> : null}
    {canFilter && !listedEditionMatches(work, editions, locale, t, query)
      ? <p className="text-muted-foreground text-xs">{t.noMatchingEditions}</p> : null}
    <EditionContinuation editions={editions} failed={moreFailed} busy={moreBusy} t={t} onMore={() => void moreEditions()} />
    {/* One attempt at a time: a second would be two open attempts. The form returns once the open one ends. */}
    {attempts.items.some(item => !hasEnded(item)) ? null
      : <StartAttempt work={work} editions={editions} api={api} locale={locale} t={t} reread={ended} query={query} onStarted={put} />}
    {rows.length === 0 ? <p className="text-muted-foreground text-sm">{t.noAttempts}</p> : null}
    <ol className="grid gap-4" aria-label={t.attempts}>
      {rows.map(({ session, number }) => <li key={session.id}>
        <AttemptCard session={session} title={number === 1 ? t.firstRead : t.reread({ number: String(number - 1) })} work={work}
          editions={editions} editionQuery={query} api={api} locale={locale} t={t} onChange={put} />
      </li>)}
    </ol>
    {attempts.next ? <Button variant="outline" size="sm" onClick={() => void more()}>{t.showMore}</Button> : null}
  </div>;
}

/** The details sheet: attempts, rereads, editions and formats, dates and position of one Work. */
export function TrackingSheet({ work, title, api, locale, open, onOpenChange }: {
  work: string; title: string; api: TrackingApi; locale: UiLocale; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const t = copyOf(locale);
  return <Sheet open={open} onOpenChange={details => onOpenChange(details.open)}>
    <SheetContent placement="right" className="w-full max-w-lg sm:max-w-lg">
      <SheetHeader>
        <SheetTitle>{t.sheetTitle}</SheetTitle>
        <SheetDescription>{t.sheetFor({ title })}</SheetDescription>
      </SheetHeader>
      <SheetBody className="overflow-y-auto">
        {open ? <SheetAttempts work={work} api={api} locale={locale} t={t} open={open} /> : null}
      </SheetBody>
    </SheetContent>
  </Sheet>;
}
