'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { CheckIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { ProgressConflict } from './conflict-panel.tsx';
import type { EpisodeProgress, ProgressStale } from './episode-api.ts';
import type { ChapterStanding, MediaApi } from './media-api.ts';
import type { Place } from './media.ts';
import type { Copy } from './messages.ts';

type Conflict = { place: Place; current: EpisodeProgress; submitted: ProgressStale['submitted'] };
type Read = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; progress: EpisodeProgress };

const named = (place: Place, t: Copy) => place.label || t.unnamedPart;

/** The resume record names the chapter and omits its label. A page that already includes it supplies the label. */
function withLabel(place: Place | null, known: readonly Place[]): Place | null {
  if (!place || place.label) return place;
  const label = known.find(item => item.occurrence === place.occurrence)?.label;
  return label ? { ...place, label } : place;
}

/**
 * Where the reader is in a manga. Last read and continue come from one resume read. Another chapter
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
  const known = useRef<Place[]>([]);
  known.current = places;

  useEffect(() => {
    let current = true;
    void (async () => {
      const found = await api.standing(work);
      if (!found.ok) { if (current) setFailedLoad(true); return; }
      let page = found.data.opened;
      if (!page) {
        const opened = await api.positions(work);
        if (!opened.ok) { if (current) setFailedLoad(true); return; }
        page = opened.data;
      }
      if (!current) return;
      setFailedLoad(false);
      setStanding({ ...found.data, last: withLabel(found.data.last, page.items), next: withLabel(found.data.next, page.items) });
      setPlaces(page.items);
      setCursor(page.next);
    })();
    return () => { current = false; };
  }, [api, work]);

  useEffect(() => {
    if (reload === 0) return;
    let current = true;
    void (async () => {
      const found = await api.standing(work);
      if (!current) return;
      if (!found.ok) { setFailedLoad(true); return; }
      setStanding({ ...found.data, last: withLabel(found.data.last, known.current), next: withLabel(found.data.next, known.current) });
    })();
    return () => { current = false; };
  }, [api, reload, work]);

  async function more() {
    if (!cursor) return;
    const page = await api.positions(work, cursor);
    if (!page.ok) { setFailed(true); return; }
    setPlaces(current => [...current, ...page.data.items]);
    setCursor(page.data.next);
  }

  async function choose(place: Place) {
    setSelected(place);
    setConflict(null);
    setRead({ status: 'loading' });
    const progress = await api.progress(place);
    setRead(progress.ok ? { status: 'ready', progress: progress.data } : { status: 'failed' });
  }

  async function write(place: Place, completed: boolean) {
    setSaving(true);
    setFailed(false);
    const written = await api.mark(place, { completed, position: completed ? 'read' : null });
    setSaving(false);
    if (!written.ok && written.failure === 'stale') {
      setConflict({ place, current: written.current, submitted: written.submitted });
      setSelected(place);
      return;
    }
    if (!written.ok) { setFailed(true); return; }
    setConflict(null);
    setSelected(place);
    setRead({ status: 'ready', progress: written.data });
    setReload(count => count + 1);
  }

  if (failedLoad) {
    return <section aria-labelledby={headingId} className={className}>
      <h2 id={headingId} className="sr-only">{t.chapters}</h2>
      <Alert variant="destructive" role="alert"><AlertDescription>{t.trackedUnavailable}</AlertDescription></Alert></section>;
  }
  if (!standing) return null;
  if (!standing.last && !standing.next && places.length === 0 && !cursor) return null;
  const ready = read?.status === 'ready' ? read.progress : null;
  return <section aria-labelledby={headingId} data-chapter-progress
    data-last={standing.last?.occurrence ?? ''} data-continue={standing.next?.occurrence ?? ''}
    className={className ?? 'grid gap-4 rounded-2xl border border-border/60 p-4 sm:p-5'}>
    <h2 id={headingId} className="font-semibold text-xl tracking-tight">{t.chapters}</h2>
    <p className="font-medium text-base" data-where>{standing.last ? t.lastRead({ place: named(standing.last, t) }) : t.noneRead}</p>
    {standing.next ? <div className="grid gap-2" data-next>
      <p className="text-muted-foreground text-sm">{t.continueChapter({ place: named(standing.next, t) })}</p>
      <div><Button type="button" className="min-h-11 w-full sm:w-auto" disabled={saving} onClick={() => void write(standing.next!, true)}>
        <CheckIcon aria-hidden="true" />{saving ? t.episodeSaving : t.markChapter({ place: named(standing.next, t) })}</Button></div>
    </div> : standing.caughtUp && standing.last ? <p className="text-muted-foreground text-sm" data-caught-up>{t.allChaptersRead}</p> : null}

    {places.length ? <ul className="grid gap-2">
      {places.map(place => <li key={place.occurrence}>
        <Button type="button" variant={selected?.occurrence === place.occurrence ? 'default' : 'outline'}
          className="min-h-11 w-full justify-start sm:w-auto" aria-pressed={selected?.occurrence === place.occurrence}
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
      onUse={() => { setConflict(null); setReload(count => count + 1); }} /> : null}
    <p role="status" className="text-destructive-foreground text-xs">{failed || read?.status === 'failed' ? t.saveFailed : null}</p>
  </section>;
}
