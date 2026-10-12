'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ProgressConflict } from './conflict-panel.tsx';
import type { EpisodeProgress, ProgressStale } from './episode-api.ts';
import type { ChapterStanding, MediaApi } from './media-api.ts';
import type { Place } from './media.ts';
import type { Copy } from './messages.ts';

type Conflict = { place: Place; current: EpisodeProgress; submitted: ProgressStale['submitted'] };
type Scope = { api: MediaApi; work: string; read: number; write: number; busy: boolean; choicesLoaded: boolean };

type Read = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; progress: EpisodeProgress };

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
  const [failedLoad, setFailedLoad] = useState(false);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<Place | null>(null);
  const [read, setRead] = useState<Read | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);

  const active = useRef<Scope | null>(null);

  useLayoutEffect(() => {
    const scope: Scope = { api, work, read: 0, write: 0, busy: false, choicesLoaded: false };
    active.current = scope;
    setStanding(null);
    setPlaces([]);
    setCursor(null);
    setFailedLoad(false);
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
      if (!found.ok) { setFailedLoad(true); return; }
      if (!scope.choicesLoaded) {
        let page = found.data.opened;
        if (!page) {
          const opened = await api.positions(work);
          if (!current || active.current !== scope || write !== scope.write) return;
          if (!opened.ok) { setFailedLoad(true); return; }
          page = opened.data;
        }
        setPlaces(page.items);
        setCursor(page.next);
        scope.choicesLoaded = true;
      }
      setFailedLoad(false);
      setStanding(found.data);
    })();
    return () => { current = false; };
  }, [api, work, reload]);

  async function more() {
    const scope = active.current;
    if (!cursor || !scope || scope.api !== api || scope.work !== work || scope.busy) return;
    const page = await api.positions(work, cursor);
    if (active.current !== scope) return;
    if (!page.ok) { setFailed(true); return; }
    setPlaces(current => [...current, ...page.data.items]);
    setCursor(page.data.next);
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
    setRead(progress.ok ? { status: 'ready', progress: progress.data } : { status: 'failed' });
  }

  async function write(place: Place, completed: boolean) {
    const scope = active.current;
    if (!scope || scope.api !== api || scope.work !== work || scope.busy) return;
    scope.busy = true;
    ++scope.read;
    const request = ++scope.write;
    setSaving(true);
    setFailed(false);
    const written = await api.mark(place, { completed, position: completed ? 'read' : null });
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
    if (!written.ok) { setFailed(true); return; }
    setConflict(null);
    setSelected(place);
    setRead({ status: 'ready', progress: written.data });
    setStanding(null);
    setReload(count => count + 1);
  }

  if (failedLoad) {
    return <section aria-labelledby={headingId} className={className}>
      <h2 id={headingId} className="sr-only">{t.chapters}</h2>
      <Alert variant="destructive" role="alert"><AlertDescription>{t.trackedUnavailable}</AlertDescription></Alert></section>;
  }
  if (!standing) return <section aria-labelledby={headingId} data-chapter-progress data-pending
    className={className ?? 'grid gap-4 rounded-2xl border border-border/60 p-4 sm:p-5'}>
    <h2 id={headingId} className="font-semibold text-xl tracking-tight">{t.chapters}</h2>
    <p role="status" className="text-muted-foreground text-sm">{t.unknown}</p>
  </section>;
  const ready = read?.status === 'ready' ? read.progress : null;
  return <section aria-labelledby={headingId} data-chapter-progress
    data-last={standing.last?.occurrence ?? ''}
    className={className ?? 'grid gap-4 rounded-2xl border border-border/60 p-4 sm:p-5'}>
    <h2 id={headingId} className="font-semibold text-xl tracking-tight">{t.chapters}</h2>
    <p className="font-medium text-base" data-where>{chapterProgressWhere(standing, t)}</p>

    {places.length ? <ul className="grid gap-2">
      {places.map(place => <li key={place.occurrence}>
        <Button type="button" variant={selected?.occurrence === place.occurrence ? 'default' : 'outline'}
          className="min-h-11 w-full justify-start sm:w-auto" disabled={saving} aria-pressed={selected?.occurrence === place.occurrence}
          onClick={() => void choose(place)}>{named(place, t)}</Button>
      </li>)}
    </ul> : null}
    {cursor ? <div><Button type="button" variant="outline" className="min-h-11 sm:min-h-8" disabled={saving}
      onClick={() => void more()}>{t.showMore}</Button></div> : null}

    {selected ? <div className="grid gap-2 rounded-xl bg-muted/40 p-3" data-selected={selected.occurrence} aria-live="polite">
      <p className="font-medium text-sm">{named(selected, t)}
        {ready ? <span className="text-muted-foreground" data-state={ready.completed ? 'done' : 'open'}>
          {' · '}{ready.completed ? t.chapterRead : t.chapterUnread}</span> : null}
        {read?.status === 'loading' ? <span className="text-muted-foreground">{' · '}{t.episodeSaving}</span> : null}</p>
      {ready ? <div><Button type="button" variant={ready.completed ? 'ghost' : 'outline'} className="min-h-11 sm:min-h-8" disabled={saving}
        onClick={() => void write(selected, !ready.completed)}>{ready.completed ? t.markChapterUnread : t.markChapterRead}</Button></div> : null}
    </div> : null}

    {conflict ? <ProgressConflict label={t.status} mine={conflict.submitted.completed ? t.chapterRead : t.chapterUnread}
      theirs={conflict.current.completed ? t.chapterRead : t.chapterUnread} t={t} busy={saving} failed={failed}
      onKeep={() => void write(conflict.place, conflict.submitted.completed)}
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
