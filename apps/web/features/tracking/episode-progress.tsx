'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { EpisodeApi, EpisodeProgress as Mark } from './episode-api.ts';
import { type Episode, type Standing, markPosition, reach, standingOf } from './episodes.ts';
import type { Copy } from './messages.ts';

const nameOf = (episode: Episode, t: Copy) =>
  episode.label ?? (episode.special ? t.specialLabel : t.episodeLabel)({ number: String(episode.number) });

type Selected = { episode: Episode; mark: Mark | 'loading' | 'failed' };
type Scope = { api: EpisodeApi; work: string; request: number; busy: boolean };

/** Without an occurrence-count summary, only the name in Main's resume response is known. */
export function episodeProgressWhere(read: Standing, t: Copy): string {
  if (!read.furthest) return t.unknown;
  return read.furthest.label ? t.lastWatched({ place: read.furthest.label }) : t.someWatched;
}

/**
 * Main's last watched episode, a jump to an episode by number, and specials kept apart.
 * The resume response supplies progress; inventory pages supply choices;
 * after each write the standing is read again, so a second device that loads the page sees the same.
 * Main currently exposes no episode coverage counts, so this panel makes no coverage claim.
 */
export function EpisodeProgress({ work, api, t, className, region }: {
  work: string; api: EpisodeApi; t: Copy; className?: string;
  /** Names this panel when more than one is on the page. One panel keeps its episode heading as the name. */
  region?: string;
}) {
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
  const active = useRef<Scope | null>(null);

  useLayoutEffect(() => {
    const scope: Scope = { api, work, request: 0, busy: false };
    active.current = scope;
    setStanding(null);
    setSelected(null);
    setSaving(false);
    setFailed(false);
    setTyped('');
    setMissing(null);
    setFinding(null);
    return () => { if (active.current === scope) active.current = null; };
  }, [api, work]);

  useEffect(() => {
    const scope = active.current;
    if (!scope || scope.api !== api || scope.work !== work) return;
    const request = ++scope.request;
    const current = () => active.current === scope && request === scope.request;
    void standingOf(api, work, current).then(read => {
      if (current()) setStanding(read);
    });
    return () => { if (current()) ++scope.request; };
  }, [api, work, reload]);

  const named = region ? { 'aria-label': region } : { 'aria-labelledby': headingId };
  if (!standing) return <section {...named} data-episode-progress data-pending
    className={className ?? 'grid gap-4 rounded-2xl border border-border/60 p-4 sm:p-5'}>
    <h2 id={headingId} className="font-semibold text-xl tracking-tight">{t.episodes}</h2>
    <p role="status" className="text-muted-foreground text-sm">{t.unknown}</p>
  </section>;
  if (!standing.ok) {
    return standing.failure === 'missing' || standing.failure === 'sign-in' ? null
      : <section {...named} className={className}>
        <h2 id={headingId} className="sr-only">{t.episodes}</h2>
        <Alert variant="destructive" role="alert"><AlertDescription>{t.trackedUnavailable}</AlertDescription></Alert></section>;
  }
  const read = standing.data;
  if (!read) return null;
  const typedNumber = /^[1-9]\d*$/.test(typed.trim()) ? Number(typed.trim()) : null;

  async function select(occurrence: string, scope: Scope, request: number) {
    if (active.current !== scope || request !== scope.request) return;
    const episode = read!.mains.items.find(item => item.occurrence === occurrence)
      ?? read!.specials.flatMap(group => group.walk.items).find(item => item.occurrence === occurrence);
    if (!episode) return;
    setSelected({ episode, mark: 'loading' });
    setFinding(null);
    setMissing(null);
    setFailed(false);
    const state = await api.progress(episode);
    // The same occurrence can have a newer selection or write while this read is pending.
    if (active.current !== scope || request !== scope.request) return;
    setSelected(now => (now?.episode.occurrence === occurrence ? { episode, mark: state.ok ? state.data : 'failed' } : now));
  }

  async function choose(occurrence: string) {
    const scope = active.current;
    if (!scope || scope.api !== api || scope.work !== work || scope.busy) return;
    await select(occurrence, scope, ++scope.request);
  }

  async function write(episode: Episode, completed: boolean) {
    const scope = active.current;
    if (!scope || scope.api !== api || scope.work !== work || scope.busy) return;
    scope.busy = true;
    setFinding(null);
    const request = ++scope.request;
    setSaving(true);
    setFailed(false);
    const written = await api.mark(episode, { completed, ...(completed ? { position: markPosition(episode) } : {}) });
    if (active.current !== scope || request !== scope.request) return;
    scope.busy = false;
    setSaving(false);
    if (!written.ok) { setFailed(true); return; }
    setSelected(now => (now?.episode.occurrence === episode.occurrence ? { episode, mark: written.data } : now));
    // A successful write invalidates the old Main response before refresh can start.
    setStanding(null);
    setReload(count => count + 1);
  }

  async function jump() {
    if (typedNumber === null) return;
    const scope = active.current;
    if (!scope || scope.api !== api || scope.work !== work || scope.busy) return;
    const request = ++scope.request;
    setMissing(null);
    setFailed(false);
    setFinding(typedNumber);
    let found: Episode | null = null;
    try { found = await reach(api, read!.mains, typedNumber, () => active.current === scope && request === scope.request); } catch {
      if (active.current === scope && request === scope.request) { setFinding(null); setFailed(true); }
      return;
    }
    if (active.current !== scope || request !== scope.request) return;
    setFinding(null);
    if (!found) { setMissing(typedNumber); setSelected(null); return; }
    await select(found.occurrence, scope, request);
  }

  const mark = selected && typeof selected.mark === 'object' ? selected.mark : null;
  return <section {...named} data-episode-progress
    className={className ?? 'grid gap-4 rounded-2xl border border-border/60 p-4 sm:p-5'}>
    <h2 id={headingId} className="font-semibold text-xl tracking-tight">{t.episodes}</h2>

    <div className="grid gap-2">
      <p className="font-medium text-base" data-where>{episodeProgressWhere(read, t)}</p>
    </div>

    <form className="flex items-end gap-2 sm:max-w-sm" onSubmit={event => { event.preventDefault(); void jump(); }}>
      <Field className="min-w-0 flex-1 gap-1">
        <FieldLabel htmlFor={jumpId} className="text-muted-foreground text-xs">{t.jumpTo}</FieldLabel>
        <Input id={jumpId} size="sm" inputMode="numeric" className="h-11 sm:h-8" value={typed}
          onChange={event => { setTyped(event.target.value); setMissing(null); }} />
      </Field>
      <Button type="submit" variant="outline" className="min-h-11 shrink-0 sm:min-h-8" disabled={saving || finding !== null || typedNumber === null}>{t.jumpGo}</Button>
    </form>
    {finding !== null ? <p role="status" className="text-muted-foreground text-sm" data-finding>{t.findingEpisode({ number: String(finding) })}</p> : null}
    {missing !== null ? <p role="status" className="text-muted-foreground text-sm">{t.noSuchEpisode({ number: String(missing) })}</p> : null}

    {read.specials.length ? <div className="grid gap-3 border-border/60 border-t pt-3" data-specials>
      <h3 className="font-medium text-sm">{read.specials.length === 1 && read.specials[0]!.label ? read.specials[0]!.label : t.specialsTitle}</h3>
      <p className="text-muted-foreground text-xs">{t.specialsNote}</p>
      <ul className="flex flex-wrap gap-2">
        {read.specials.flatMap(group => group.walk.items).map(episode => <li key={episode.occurrence}>
          <Button type="button" size="sm" className="min-h-11 sm:min-h-8"
            disabled={saving}
            variant={selected?.episode.occurrence === episode.occurrence ? 'default' : 'outline'}
            aria-pressed={selected?.episode.occurrence === episode.occurrence}
            data-special={episode.occurrence} onClick={() => void choose(episode.occurrence)}>{nameOf(episode, t)}</Button>
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
