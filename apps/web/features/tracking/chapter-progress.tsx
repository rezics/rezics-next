'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { Skeleton } from '@rezics/ui/skeleton';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ProgressConflict } from './conflict-panel.tsx';
import type { EpisodeProgress, ProgressStale } from './episode-api.ts';
import type { ChapterStanding, MediaApi } from './media-api.ts';
import type { Place } from './media.ts';
import type { Copy } from './messages.ts';

type Conflict = { place: Place; current: EpisodeProgress; submitted: ProgressStale['submitted'] };
type Scope = { api: MediaApi; work: string; read: number; write: number; busy: boolean; paging: boolean; choicesLoaded: boolean };

type Read = { status: 'loading' } | { status: 'pending' } | { status: 'failed' } | { status: 'ready'; progress: EpisodeProgress };

const named = (place: Place, t: Copy) => place.label || t.unnamedPart;

/** An inventory start or a pending resume has not read saved progress. */
export function chapterProgressWhere(standing: ChapterStanding, t: Copy) {
  return standing.last ? t.lastRead({ place: named(standing.last, t) }) : t.unknown;
}

/**
 * Main's last read chapter comes from one resume response. Another chapter
 * is chosen from a page of the Work's positions, and that chapter's own progress is read only then.
 */
export function ChapterProgress({ work, api, t, className }: { work: string; api: MediaApi; t: Copy; className?: string }) {
  const headingId = useId();
  const [standing, setStanding] = useState<ChapterStanding | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [inventoryComplete, setInventoryComplete] = useState(false);
  const [failedLoad, setFailedLoad] = useState(false);
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<Place | null>(null);
  const [read, setRead] = useState<Read | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);

  const active = useRef<Scope | null>(null);

  useLayoutEffect(() => {
    const scope: Scope = { api, work, read: 0, write: 0, busy: false, paging: false, choicesLoaded: false };
    active.current = scope;
    setStanding(null);
    setPlaces([]);
    setCursor(null);
    setLoadingMore(false);
    setInventoryComplete(false);
    setFailedLoad(false);
    setPending(false);
    setSelected(null);
    setRead(null);
    setSaving(false);
    setFailed(false);
    setConflict(null);
    return () => { if (active.current === scope) active.current = null; };
  }, [api, work]);

  useEffect(() => {
    let current = true;
    const scope = active.current;
    if (!scope || scope.api !== api || scope.work !== work) return;
    const write = scope.write;
    void (async () => {
      const found = await api.standing(work);
      if (!current || active.current !== scope || write !== scope.write) return;
      if (!found.ok) { setPending(found.status === 202); setFailedLoad(found.status !== 202); return; }
      if (!scope.choicesLoaded) {
        let page = found.data.opened;
        if (!page) {
          const opened = await api.positions(work);
          if (!current || active.current !== scope || write !== scope.write) return;
          if (!opened.ok) { setPending(opened.status === 202); setFailedLoad(opened.status !== 202); return; }
          page = opened.data;
        }
        setPlaces(page.items);
        setCursor(page.next);
        setInventoryComplete(page.complete === true);
        scope.choicesLoaded = true;
      }
      setFailedLoad(false);
      setPending(false);
      setStanding(found.data);
    })();
    return () => { current = false; };
  }, [api, work, reload]);

  async function more() {
    const scope = active.current;
    if (!cursor || !scope || scope.api !== api || scope.work !== work || scope.busy || scope.paging) return;
    scope.paging = true;
    setLoadingMore(true);
    const page = await api.positions(work, cursor);
    if (active.current !== scope) return;
    scope.paging = false;
    setLoadingMore(false);
    if (!page.ok) { setFailed(true); return; }
    setPlaces(current => [...current, ...page.data.items]);
    setCursor(page.data.next);
    setInventoryComplete(page.data.complete === true);
  }

  async function choose(place: Place) {
    const scope = active.current;
    if (!scope || scope.api !== api || scope.work !== work || scope.busy) return;
    const request = ++scope.read;
    const write = scope.write;
    setSelected(place);
    setConflict(null);
    setRead({ status: 'loading' });
    const progress = await api.progress(place);
    if (active.current !== scope || request !== scope.read || write !== scope.write) return;
    setRead(progress.ok ? { status: 'ready', progress: progress.data } : { status: progress.status === 202 ? 'pending' : 'failed' });
  }

  async function write(place: Place, completed: boolean, position: string | null) {
    const scope = active.current;
    if (!scope || scope.api !== api || scope.work !== work || scope.busy) return;
    scope.busy = true;
    ++scope.read;
    const request = ++scope.write;
    setSaving(true);
    setFailed(false);
    const written = await api.mark(place, { completed, position,
      ...(read?.status === 'ready' ? { expectedVersion: read.progress.version } : {}) });
    if (active.current !== scope || request !== scope.write) return;
    ++scope.read;
    scope.busy = false;
    setSaving(false);
    if (!written.ok && written.failure === 'stale') {
      setConflict({ place, current: written.current, submitted: written.submitted });
      setSelected(place);
      setRead({ status: 'ready', progress: written.current });
      setStanding(null);
      setReload(count => count + 1);
      return;
    }
    if (!written.ok) {
      if (written.status === 202) { setStanding(null); setPending(true); }
      else setFailed(true);
      return;
    }
    setConflict(null);
    setSelected(place);
    setRead({ status: 'ready', progress: written.data });
    setStanding(null);
    setReload(count => count + 1);
  }

  if (failedLoad) {
    return <section aria-labelledby={headingId} className={className}>
      <h2 id={headingId} className="sr-only">{t.chapters}</h2>
      <Alert variant="destructive" role="alert"><AlertDescription>{t.trackedUnavailable}</AlertDescription></Alert>
      <Button variant="outline" onClick={() => { setFailedLoad(false); setReload(count => count + 1); }}>{t.retry}</Button></section>;
  }
  if (!standing) return <section aria-labelledby={headingId} data-chapter-progress data-loading={!pending || undefined}
    data-pending={pending || undefined} aria-busy="true"
    className={className ?? 'grid gap-4 rounded-2xl border border-border/60 p-4 sm:p-5'}>
    <h2 id={headingId} className="font-semibold text-xl tracking-tight">{t.chapters}</h2>
    <p role="status" className="text-muted-foreground text-sm">{t.unknown}</p>
    {pending ? <Button variant="outline" onClick={() => { setPending(false); setReload(count => count + 1); }}>{t.retry}</Button>
      : <Skeleton className="h-32 rounded-xl" />}
  </section>;
  const ready = read?.status === 'ready' ? read.progress : null;
  return <section aria-labelledby={headingId} data-chapter-progress
    data-last={standing.last?.occurrence ?? ''}
    className={className ?? 'grid gap-4 rounded-2xl border border-border/60 p-4 sm:p-5'}>
    <h2 id={headingId} className="font-semibold text-xl tracking-tight">{t.chapters}</h2>
    <p className="font-medium text-base" data-where>{chapterProgressWhere(standing, t)}</p>

    {places.length ? <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
      {places.map(place => <li key={place.occurrence} className="min-w-0">
        <Button type="button" variant={selected?.occurrence === place.occurrence ? 'default' : 'outline'}
          className="h-auto min-h-11 w-full max-w-full justify-start whitespace-normal text-start sm:w-auto" disabled={saving} aria-pressed={selected?.occurrence === place.occurrence}
          onClick={() => void choose(place)}>{named(place, t)}</Button>
      </li>)}
    </ul> : inventoryComplete && !cursor ? <p className="text-muted-foreground text-sm" data-empty>{t.noChapters}</p> : null}
    {!places.length && !cursor && !inventoryComplete ? <div><Button type="button" variant="outline" onClick={() => {
      const scope = active.current;
      if (!scope || scope.api !== api || scope.work !== work) return;
      scope.choicesLoaded = false;
      setStanding(null);
      setReload(count => count + 1);
    }}>{t.retry}</Button></div> : null}
    {cursor ? <div><Button type="button" variant="outline" className="min-h-11 sm:min-h-8" disabled={saving || loadingMore}
      onClick={() => void more()}>{t.showMore}</Button></div> : null}

    {selected ? <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-xl bg-muted/40 p-3" data-selected={selected.occurrence}
      data-pending={read?.status === 'pending' || undefined} aria-live="polite">
      <p className="font-medium text-sm">{named(selected, t)}
        {ready ? <span className="text-muted-foreground" data-state={ready.completed ? 'done' : 'open'}>
          {' · '}{ready.completed ? t.chapterRead : t.chapterUnread}</span> : null}
        {read?.status === 'loading' ? <span className="text-muted-foreground">{' · '}{t.episodeSaving}</span> : null}</p>
      {read?.status === 'pending' ? <Button variant="outline" onClick={() => void choose(selected)}>{t.retry}</Button> : null}
      {ready ? <div className="min-w-0"><Button type="button" variant={ready.completed ? 'ghost' : 'outline'} className="h-auto min-h-11 max-w-full whitespace-normal sm:min-h-8" disabled={saving}
        onClick={() => void write(selected, !ready.completed, ready.completed ? null : ready.position)}>{ready.completed ? t.markChapterUnread : t.markChapterRead}</Button></div> : null}
      {ready ? <ChapterPosition key={`${selected.structure}/${selected.occurrence}/${ready.version}`}
        progress={ready} t={t} busy={saving} onSave={position => void write(selected, ready.completed, position)} /> : null}
    </div> : null}

    {conflict ? <ProgressConflict label={t.status} mine={chapterChangeName(conflict.submitted, t)}
      theirs={chapterChangeName(conflict.current, t)} t={t} busy={saving} failed={failed}
      onKeep={() => void write(conflict.place, conflict.submitted.completed, conflict.submitted.position)}
      onUse={() => {
        const scope = active.current;
        if (!scope || scope.api !== api || scope.work !== work || scope.busy) return;
        ++scope.read;
        setSelected(conflict.place);
        setRead({ status: 'ready', progress: conflict.current });
        setConflict(null);
        setStanding(null);
        setReload(count => count + 1);
      }} /> : null}
    <p role="status" className="text-destructive-foreground text-xs">{failed || read?.status === 'failed' ? t.saveFailed : null}</p>
  </section>;
}

function chapterChangeName(change: { completed: boolean; position: string | null }, t: Copy) {
  const state = change.completed ? t.chapterRead : t.chapterUnread;
  return change.position ? `${state} · ${change.position}` : state;
}

/** Free-text positions are Main's opaque chapter locator; an empty field clears it. */
function ChapterPosition({ progress, t, busy, onSave }: {
  progress: EpisodeProgress; t: Copy; busy: boolean; onSave: (position: string | null) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(progress.position ?? '');
  const position = draft === '' ? null : draft;
  return <Field className="min-w-0 gap-2">
    <FieldLabel htmlFor={id}>{t.conflictPosition}</FieldLabel>
    <div className="flex flex-wrap gap-2">
      <Input id={id} value={draft} maxLength={500} disabled={busy} className="min-w-0 flex-1"
        onChange={event => setDraft(event.target.value)} />
      <Button type="button" variant="outline" className="h-auto min-h-8 max-w-full whitespace-normal" disabled={busy || position === progress.position}
        onClick={() => onSave(position)}>{t.savePosition}</Button>
    </div>
  </Field>;
}
