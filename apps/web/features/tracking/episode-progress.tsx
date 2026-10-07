'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { Progress } from '@rezics/ui/progress';
import { CheckIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { EpisodeApi, EpisodeProgress as Mark } from './episode-api.ts';
import { type Episode, markPosition, reach, standingOf, totalOf } from './episodes.ts';
import type { Copy } from './messages.ts';

const nameOf = (episode: Episode, t: Copy) =>
  episode.label ?? (episode.special ? t.specialLabel : t.episodeLabel)({ number: String(episode.number) });

type Selected = { episode: Episode; mark: Mark | 'loading' | 'failed' };

/**
 * Where the reader stands in a series' episodes, and the ways to move: mark the next one in a tap,
 * jump to any by number, and keep a special apart from the main run. Everything shown is Main's;
 * after each write the standing is read again, so a second device that loads the page sees the same.
 * "Watched through N" means the episodes from the first to N are all marked watched.
 */
export function EpisodeProgress({ work, api, t, className }: { work: string; api: EpisodeApi; t: Copy; className?: string }) {
  const headingId = useId();
  const jumpId = useId();
  const [standing, setStanding] = useState<Awaited<ReturnType<typeof standingOf>> | null>(null);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [typed, setTyped] = useState('');
  const [missing, setMissing] = useState<number | null>(null);
  const [finding, setFinding] = useState<number | null>(null);

  useEffect(() => {
    let current = true;
    void standingOf(api, work).then(read => { if (current) setStanding(read); });
    return () => { current = false; };
  }, [api, work, reload]);

  if (!standing) return null;
  if (!standing.ok) {
    return standing.failure === 'missing' || standing.failure === 'sign-in' ? null
      : <section aria-labelledby={headingId} className={className}>
        <h2 id={headingId} className="sr-only">{t.episodes}</h2>
        <Alert variant="destructive" role="alert"><AlertDescription>{t.trackedUnavailable}</AlertDescription></Alert></section>;
  }
  const read = standing.data;
  if (!read) return null;
  const total = totalOf(read);
  const typedNumber = /^[1-9]\d*$/.test(typed.trim()) ? Number(typed.trim()) : null;

  async function select(episode: Episode) {
    setSelected({ episode, mark: 'loading' });
    setFailed(false);
    const state = await api.progress(episode);
    setSelected(now => (now?.episode.occurrence === episode.occurrence ? { episode, mark: state.ok ? state.data : 'failed' } : now));
  }

  async function write(episode: Episode, completed: boolean) {
    setSaving(true);
    setFailed(false);
    const written = await api.mark(episode, { completed, ...(completed ? { position: markPosition(episode) } : {}) });
    setSaving(false);
    if (!written.ok) { setFailed(true); return; }
    setSelected(now => (now?.episode.occurrence === episode.occurrence ? { episode, mark: written.data } : now));
    // The next episode marked moves the run on at once; Main is read again either way, and settles it.
    const after = read!.mains.items[episode.number];
    if (completed && episode.occurrence === read!.next?.occurrence && (after || read!.mains.next === null)) {
      setStanding({ ok: true, data: { ...read!, through: episode, next: after ?? null } });
    }
    setReload(count => count + 1);
  }

  async function jump() {
    if (typedNumber === null) return;
    setMissing(null);
    setFailed(false);
    setFinding(typedNumber);
    let found: Episode | null = null;
    try { found = await reach(api, read!.mains, typedNumber); } catch { setFinding(null); setFailed(true); return; }
    setFinding(null);
    if (!found) { setMissing(typedNumber); setSelected(null); return; }
    await select(found);
  }

  const mark = selected && typeof selected.mark === 'object' ? selected.mark : null;
  return <section aria-labelledby={headingId} data-episode-progress data-through={read.through?.number ?? ''}
    data-continue={read.next?.number ?? ''}
    className={className ?? 'grid gap-4 rounded-2xl border border-border/60 p-4 sm:p-5'}>
    <h2 id={headingId} className="font-semibold text-xl tracking-tight">{t.episodes}</h2>

    <div className="grid gap-2">
      <p className="font-medium text-base" data-where>
        {!read.through ? t.noneWatched : total !== null
          ? t.watchedThroughOf({ number: String(read.through.number), total: String(total) })
          : t.watchedThrough({ number: String(read.through.number) })}</p>
      {total !== null && read.through
        ? <Progress value={Math.round((read.through.number / total) * 100)} aria-label={t.episodes} /> : null}
    </div>

    {read.next ? <div className="grid gap-2" data-next>
      <p className="text-muted-foreground text-sm">{t.continueFrom({ number: String(read.next.number) })}</p>
      <div><Button type="button" className="min-h-11 w-full sm:w-auto" disabled={saving}
        onClick={() => void write(read.next!, true)}>
        <CheckIcon aria-hidden="true" />{saving ? t.episodeSaving : t.markNext({ number: String(read.next.number) })}</Button></div>
    </div> : read.through ? <p className="text-muted-foreground text-sm" data-caught-up>{t.allWatched}</p> : null}

    <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); void jump(); }}>
      <Field className="gap-1">
        <FieldLabel htmlFor={jumpId} className="text-muted-foreground text-xs">{t.jumpTo}</FieldLabel>
        <Input id={jumpId} size="sm" inputMode="numeric" className="h-11 w-32 sm:h-8" value={typed}
          onChange={event => { setTyped(event.target.value); setMissing(null); }} />
      </Field>
      <Button type="submit" variant="outline" className="min-h-11 sm:min-h-8" disabled={saving || finding !== null || typedNumber === null}>{t.jumpGo}</Button>
    </form>
    {finding !== null ? <p role="status" className="text-muted-foreground text-sm" data-finding>{t.findingEpisode({ number: String(finding) })}</p> : null}
    {missing !== null ? <p role="status" className="text-muted-foreground text-sm">{t.noSuchEpisode({ number: String(missing) })}</p> : null}

    {read.specials.length ? <div className="grid gap-3 border-border/60 border-t pt-3" data-specials>
      <h3 className="font-medium text-sm">{read.specials.length === 1 && read.specials[0]!.label ? read.specials[0]!.label : t.specialsTitle}</h3>
      <p className="text-muted-foreground text-xs">{t.specialsNote}</p>
      <ul className="flex flex-wrap gap-2">
        {read.specials.flatMap(group => group.walk.items).map(episode => <li key={episode.occurrence}>
          <Button type="button" size="sm" className="min-h-11 sm:min-h-8"
            variant={selected?.episode.occurrence === episode.occurrence ? 'default' : 'outline'}
            aria-pressed={selected?.episode.occurrence === episode.occurrence}
            data-special={episode.occurrence} onClick={() => void select(episode)}>{nameOf(episode, t)}</Button>
        </li>)}
      </ul>
    </div> : null}

    {selected ? <div className="grid gap-2 rounded-xl bg-muted/40 p-3" data-selected={selected.episode.special ? 'special' : 'main'}
      aria-live="polite">
      <p className="font-medium text-sm">{nameOf(selected.episode, t)}
        {mark ? <span className="text-muted-foreground" data-state={mark.completed ? 'done' : 'open'}>
          {' · '}{mark.completed ? t.watched : t.notWatched}</span> : null}</p>
      {mark ? <div><Button type="button" variant={mark.completed ? 'ghost' : 'outline'} className="min-h-11 sm:min-h-8" disabled={saving}
        onClick={() => void write(selected.episode, !mark.completed)}>
        {mark.completed ? t.markNotWatched : t.markWatched}</Button></div> : null}
    </div> : null}

    <p role="status" className="text-destructive-foreground text-xs">{failed || selected?.mark === 'failed' ? t.saveFailed : null}</p>
  </section>;
}
