'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { CheckIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { ProgressConflict } from './conflict-panel.tsx';
import type { MediaApi } from './media-api.ts';
import { type ChapterRef, chapterPosition, flattenChapters, resumeAt } from './media.ts';
import type { Copy } from './messages.ts';
import type { EpisodeProgress, ProgressStale } from './episode-api.ts';

const placeOf = (chapter: ChapterRef, t: Copy) => {
  if (!chapter.volume) return t.chapterPlace({ number: String(chapter.number) });
  const volume = chapter.volume.label && !/^\d+$/.test(chapter.volume.label) ? chapter.volume.label : String(chapter.volume.number);
  return t.volumeChapter({ volume, number: String(chapter.number) });
};

type Conflict = { chapter: ChapterRef; current: EpisodeProgress; submitted: ProgressStale['submitted'] };

/**
 * Where the reader is in a manga: the last chapter read, and the next one. A chapter is the
 * occurrence on its volume, so a series and an omnibus that share the volume resume at the same place.
 */
export function ChapterProgress({ work, api, t, className }: { work: string; api: MediaApi; t: Copy; className?: string }) {
  const headingId = useId();
  const volumeId = useId();
  const chapterId = useId();
  const [chapters, setChapters] = useState<ChapterRef[] | null>(null);
  const [failedLoad, setFailedLoad] = useState(false);
  const [completed, setCompleted] = useState<ReadonlySet<string>>(new Set());
  const [furthest, setFurthest] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<ChapterRef | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [volumeTyped, setVolumeTyped] = useState('');
  const [chapterTyped, setChapterTyped] = useState('');
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let current = true;
    void (async () => {
      const volumes = await api.volumes(work);
      if (!volumes.ok) { if (current) setFailedLoad(true); return; }
      let list: ChapterRef[] = [];
      if (volumes.data.length) {
        const books = [];
        for (const volume of volumes.data) {
          const book = await api.chapters(volume.work);
          if (!book.ok) { if (current) setFailedLoad(true); return; }
          books.push({ number: volume.number, label: volume.label, chapters: (book.data ?? []).map(chapter => ({
            structure: chapter.structure, occurrence: chapter.occurrence, number: chapter.number, label: chapter.label })) });
        }
        list = flattenChapters(books);
      } else {
        const own = await api.chapters(work);
        if (!own.ok) { if (current) setFailedLoad(true); return; }
        list = own.data ?? [];
      }
      if (current) { setFailedLoad(false); setChapters(list); }
    })();
    return () => { current = false; };
  }, [api, work]);

  useEffect(() => {
    if (!chapters?.length) return;
    let current = true;
    void (async () => {
      const [rows, resumed] = await Promise.all([
        Promise.all(chapters.map(chapter => api.progress(chapter))),
        api.resume(work),
      ]);
      if (!current) return;
      const done = new Set<string>();
      chapters.forEach((chapter, index) => { if (rows[index]?.ok && rows[index].data.completed) done.add(chapter.occurrence); });
      setCompleted(done);
      setFurthest(resumed.ok ? resumed.data : null);
    })();
    return () => { current = false; };
  }, [api, chapters, reload, work]);

  if (failedLoad) {
    return <section aria-labelledby={headingId} className={className}>
      <h2 id={headingId} className="sr-only">{t.chapters}</h2>
      <Alert variant="destructive" role="alert"><AlertDescription>{t.trackedUnavailable}</AlertDescription></Alert></section>;
  }
  if (!chapters?.length) return null;
  const place = resumeAt(chapters, furthest, completed);
  const hasVolumes = chapters.some(chapter => chapter.volume);
  const volumeNumber = /^\d+$/.test(volumeTyped.trim()) ? Number(volumeTyped.trim()) : null;
  const chapterNumber = /^\d+$/.test(chapterTyped.trim()) ? Number(chapterTyped.trim()) : null;

  async function write(chapter: ChapterRef, read: boolean) {
    setSaving(true);
    setFailed(false);
    const written = await api.mark(chapter, { completed: read, position: read ? chapterPosition(chapter) : null });
    setSaving(false);
    if (!written.ok && written.failure === 'stale') {
      setConflict({ chapter, current: written.current, submitted: written.submitted });
      setSelected(chapter);
      return;
    }
    if (!written.ok) { setFailed(true); return; }
    setConflict(null);
    setCompleted(current => { const next = new Set(current); if (read) next.add(chapter.occurrence); else next.delete(chapter.occurrence); return next; });
    if (read) setFurthest(chapter.occurrence);
    setReload(count => count + 1);
  }

  function jump() {
    setMissing(false);
    const found = chapters!.find(chapter => chapter.number === chapterNumber
      && (hasVolumes ? chapter.volume?.number === volumeNumber : true));
    if (!found) { setMissing(true); setSelected(null); return; }
    setSelected(found);
    setConflict(null);
  }

  const selectedState = selected && completed.has(selected.occurrence);
  return <section aria-labelledby={headingId} data-chapter-progress
    data-last={place.last?.occurrence ?? ''} data-continue={place.next?.occurrence ?? ''}
    data-last-volume={place.last?.volume?.number ?? ''} data-last-chapter={place.last?.number ?? ''}
    className={className ?? 'grid gap-4 rounded-2xl border border-border/60 p-4 sm:p-5'}>
    <h2 id={headingId} className="font-semibold text-xl tracking-tight">{t.chapters}</h2>
    <p className="font-medium text-base" data-where>{place.last ? t.lastRead({ place: placeOf(place.last, t) }) : t.noneRead}</p>
    {place.next ? <div className="grid gap-2" data-next>
      <p className="text-muted-foreground text-sm">{t.continueChapter({ place: placeOf(place.next, t) })}</p>
      <div><Button type="button" className="min-h-11 w-full sm:w-auto" disabled={saving} onClick={() => void write(place.next!, true)}>
        <CheckIcon aria-hidden="true" />{saving ? t.episodeSaving : t.markChapter({ place: placeOf(place.next, t) })}</Button></div>
    </div> : <p className="text-muted-foreground text-sm" data-caught-up>{t.allChaptersRead}</p>}

    <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); jump(); }}>
      {hasVolumes ? <Field className="w-24 gap-1">
        <FieldLabel htmlFor={volumeId} className="text-muted-foreground text-xs">{t.volumeNumber}</FieldLabel>
        <Input id={volumeId} size="sm" inputMode="numeric" className="h-11 sm:h-8" value={volumeTyped}
          onChange={event => { setVolumeTyped(event.target.value); setMissing(false); }} />
      </Field> : null}
      <Field className="w-24 gap-1">
        <FieldLabel htmlFor={chapterId} className="text-muted-foreground text-xs">{t.chapterNumber}</FieldLabel>
        <Input id={chapterId} size="sm" inputMode="numeric" className="h-11 sm:h-8" value={chapterTyped}
          onChange={event => { setChapterTyped(event.target.value); setMissing(false); }} />
      </Field>
      <Button type="submit" variant="outline" className="min-h-11 sm:min-h-8" disabled={saving
        || chapterNumber === null || (hasVolumes && volumeNumber === null)}>{t.jumpGo}</Button>
    </form>
    {missing ? <p role="status" className="text-muted-foreground text-sm">{t.noSuchChapter}</p> : null}

    {selected ? <div className="grid gap-2 rounded-xl bg-muted/40 p-3" data-selected={selected.occurrence} aria-live="polite">
      <p className="font-medium text-sm">{placeOf(selected, t)}
        <span className="text-muted-foreground" data-state={selectedState ? 'done' : 'open'}>
          {' · '}{selectedState ? t.chapterRead : t.chapterUnread}</span></p>
      <div><Button type="button" variant={selectedState ? 'ghost' : 'outline'} className="min-h-11 sm:min-h-8" disabled={saving}
        onClick={() => void write(selected, !selectedState)}>{selectedState ? t.markChapterUnread : t.markChapterRead}</Button></div>
    </div> : null}

    {conflict ? <ProgressConflict label={t.status} mine={conflict.submitted.completed ? t.chapterRead : t.chapterUnread}
      theirs={conflict.current.completed ? t.chapterRead : t.chapterUnread} t={t} busy={saving} failed={failed}
      onKeep={() => void write(conflict.chapter, conflict.submitted.completed)}
      onUse={() => {
        const read = conflict.current.completed;
        setCompleted(current => { const next = new Set(current); if (read) next.add(conflict.chapter.occurrence); else next.delete(conflict.chapter.occurrence); return next; });
        setConflict(null);
        setReload(count => count + 1);
      }} /> : null}
    <p role="status" className="text-destructive-foreground text-xs">{failed ? t.saveFailed : null}</p>
  </section>;
}
