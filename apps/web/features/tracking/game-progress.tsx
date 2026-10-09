'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { CheckIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { ProgressConflict } from './conflict-panel.tsx';
import type { EpisodeProgress, ProgressStale } from './episode-api.ts';
import type { MediaApi } from './media-api.ts';
import { gameStatus, type RouteRef } from './media.ts';
import type { Copy } from './messages.ts';

type Row = RouteRef & { completed: boolean | null; started: boolean };
type Conflict = { route: RouteRef; current: EpisodeProgress; submitted: ProgressStale['submitted'] };
type Read = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; progress: EpisodeProgress };

const word = (progress: EpisodeProgress, t: Copy) =>
  progress.completed ? t.gameCompleted : progress.position ? t.gamePlayed : t.notPlayed;

/**
 * A game is played and completed on the parts its structure already has. The headline comes from one
 * page of those parts and one page of completed occurrences. A part's own progress is read only when
 * that part is the one being marked, or when nothing on the page is completed and the page is the
 * whole list. A named optional or extra part is a route.
 */
export function GameProgress({ work, api, t, className }: { work: string; api: MediaApi; t: Copy; className?: string }) {
  const headingId = useId();
  const [routes, setRoutes] = useState<Row[] | null>(null);
  const [more, setMore] = useState<string | null>(null);
  const [exhaustive, setExhaustive] = useState(false);
  const [failedLoad, setFailedLoad] = useState(false);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [read, setRead] = useState<Read | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);

  useEffect(() => {
    let current = true;
    void (async () => {
      const found = await api.routes(work);
      if (!found.ok) { if (current) setFailedLoad(true); return; }
      if (!found.data.items.length) { if (current) { setFailedLoad(false); setRoutes([]); } return; }
      const done = await api.completions(found.data.items[0]!.structure);
      if (!done.ok) { if (current) setFailedLoad(true); return; }
      const completed = new Set(done.data.occurrences);
      const pageExhaustive = done.data.complete && !found.data.next;
      let rows: Row[] = found.data.items.map(route => ({ ...route,
        completed: completed.has(route.occurrence) ? true : pageExhaustive ? false : null,
        started: completed.has(route.occurrence) }));
      const gate = rows.some(route => route.required) ? rows.filter(route => route.required) : rows;
      // The completion page lists only finished parts. One read of the first required part tells
      // played from not played; the other parts stay unread until one is chosen.
      if (pageExhaustive && !rows.some(route => route.completed === true) && gate[0]) {
        const primary = await api.progress(gate[0]);
        if (!primary.ok) { if (current) setFailedLoad(true); return; }
        const played = primary.data.completed || primary.data.position !== null;
        rows = rows.map(route => route.occurrence === gate[0]!.occurrence
          ? { ...route, completed: primary.data.completed ? true : false, started: played } : route);
      }
      if (!current) return;
      setFailedLoad(false);
      setRoutes(rows);
      setMore(found.data.next);
      setExhaustive(pageExhaustive);
    })();
    return () => { current = false; };
  }, [api, reload, work]);

  async function further() {
    if (!more || !routes) return;
    const found = await api.routes(work, more);
    if (!found.ok) { setFailed(true); return; }
    setRoutes(current => [...(current ?? []), ...found.data.items.map(route => ({ ...route, completed: null, started: false }))]);
    setMore(found.data.next);
    setExhaustive(false);
  }

  async function choose(route: RouteRef) {
    setSelected(route.occurrence);
    setConflict(null);
    setRead({ status: 'loading' });
    const progress = await api.progress(route);
    setRead(progress.ok ? { status: 'ready', progress: progress.data } : { status: 'failed' });
  }

  async function write(route: RouteRef, completed: boolean, position: string | null) {
    setSaving(true);
    setFailed(false);
    const written = await api.mark(route, { completed, position });
    setSaving(false);
    if (!written.ok && written.failure === 'stale') { setConflict({ route, current: written.current, submitted: written.submitted }); return false; }
    if (!written.ok) { setFailed(true); return false; }
    setConflict(null);
    setRead({ status: 'ready', progress: written.data });
    return true;
  }

  async function writeGame(mode: 'played' | 'completed' | 'undo') {
    if (!routes) return;
    const gate = routes.some(route => route.required) ? routes.filter(route => route.required) : routes;
    for (const route of gate) {
      if (mode === 'completed' && route.completed === true) continue;
      if (mode === 'undo' && route.completed !== true) continue;
      if (mode === 'played' && route.completed !== false) continue;
      const ok = await write(route, mode === 'completed', mode === 'completed' ? 'completed' : mode === 'played' ? 'played' : null);
      if (!ok) return;
      if (mode === 'played') break;
    }
    setReload(count => count + 1);
  }

  if (failedLoad) {
    return <section aria-labelledby={headingId} className={className}>
      <h2 id={headingId} className="sr-only">{t.playHeading}</h2>
      <Alert variant="destructive" role="alert"><AlertDescription>{t.trackedUnavailable}</AlertDescription></Alert></section>;
  }
  if (!routes?.length) return null;
  const status = gameStatus(routes, exhaustive && !more);
  const named = routes.filter(route => !route.required);
  const chosen = named.find(route => route.occurrence === selected) ?? null;
  const ready = read?.status === 'ready' ? read.progress : null;
  const headline = status === 'completed' ? t.gameCompleted : status === 'played' ? t.gamePlayed : status === 'none' ? t.notPlayed : '';
  return <section aria-labelledby={headingId} data-game-progress data-play-state={status}
    className={className ?? 'grid gap-4 rounded-2xl border border-border/60 p-4 sm:p-5'}>
    <h2 id={headingId} className="font-semibold text-xl tracking-tight">{t.playHeading}</h2>
    <p className="font-medium text-base" data-where>{headline}</p>
    <div className="flex flex-wrap gap-2">
      {status === 'completed'
        ? <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" disabled={saving}
          onClick={() => void writeGame('undo')}>{saving ? t.episodeSaving : t.markNotCompleted}</Button>
        : <>
          <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" disabled={saving}
            onClick={() => void writeGame('played')}>{saving ? t.episodeSaving : t.markPlayed}</Button>
          <Button type="button" className="min-h-11 w-full sm:w-auto" disabled={saving} onClick={() => void writeGame('completed')}>
            <CheckIcon aria-hidden="true" />{saving ? t.episodeSaving : t.markCompleted}</Button>
        </>}
    </div>

    {named.length ? <div className="grid gap-3 border-border/60 border-t pt-3" data-routes>
      <h3 className="font-medium text-sm">{t.routesTitle}</h3>
      <p className="text-muted-foreground text-xs">{t.routesNote}</p>
      <ul className="flex flex-wrap gap-2">
        {named.map(route => <li key={route.occurrence}>
          <Button type="button" size="sm" className="min-h-11 sm:min-h-8" data-route={route.occurrence}
            data-route-state={route.completed === true ? 'completed' : route.completed === false ? 'none' : 'unknown'}
            variant={selected === route.occurrence ? 'default' : 'outline'} aria-pressed={selected === route.occurrence}
            onClick={() => void choose(route)}>{route.label}</Button>
        </li>)}
      </ul>
      {more ? <div><Button type="button" variant="outline" className="min-h-11 sm:min-h-8" disabled={saving}
        onClick={() => void further()}>{t.showMore}</Button></div> : null}
      {chosen ? <div className="grid gap-2 rounded-xl bg-muted/40 p-3" data-selected={chosen.occurrence}>
        <p className="font-medium text-sm">{chosen.label}
          {ready ? <span className="text-muted-foreground">{' · '}{word(ready, t)}</span> : null}
          {read?.status === 'loading' ? <span className="text-muted-foreground">{' · '}{t.episodeSaving}</span> : null}</p>
        {ready?.completed ? <div><Button type="button" size="sm" variant="ghost" className="min-h-11 sm:min-h-8" disabled={saving}
          onClick={() => void write(chosen, false, null).then(ok => { if (ok) setReload(count => count + 1); })}>{t.markNotCompleted}</Button></div>
          : ready ? <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={saving}
              onClick={() => void write(chosen, false, 'played').then(ok => { if (ok) setReload(count => count + 1); })}>{t.markPlayed}</Button>
            <Button type="button" size="sm" className="min-h-11 sm:min-h-8" disabled={saving}
              onClick={() => void write(chosen, true, 'completed').then(ok => { if (ok) setReload(count => count + 1); })}>{t.markCompleted}</Button>
          </div> : null}
      </div> : null}
    </div> : null}

    {conflict ? <ProgressConflict label={t.status}
      mine={conflict.submitted.completed ? t.gameCompleted : conflict.submitted.position ? t.gamePlayed : t.notPlayed}
      theirs={conflict.current.completed ? t.gameCompleted : conflict.current.position ? t.gamePlayed : t.notPlayed}
      t={t} busy={saving} failed={failed}
      onKeep={() => void write(conflict.route, conflict.submitted.completed, conflict.submitted.position)
        .then(ok => { if (ok) setReload(count => count + 1); })}
      onUse={() => { setConflict(null); setReload(count => count + 1); }} /> : null}
    <p role="status" className="text-destructive-foreground text-xs">{failed || read?.status === 'failed' ? t.saveFailed : null}</p>
  </section>;
}
