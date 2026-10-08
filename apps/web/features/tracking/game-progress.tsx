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

type Row = RouteRef & { completed: boolean; started: boolean; version: number };
type Conflict = { route: RouteRef; current: EpisodeProgress; submitted: ProgressStale['submitted'] };

const word = (row: { completed: boolean; started: boolean }, t: Copy) =>
  row.completed ? t.gameCompleted : row.started ? t.gamePlayed : t.notPlayed;

/**
 * A game is played and completed on the parts its structure already has. Required parts are the
 * game; a named optional or extra part is a route. There is no separate store for hours.
 */
export function GameProgress({ work, api, t, className }: { work: string; api: MediaApi; t: Copy; className?: string }) {
  const headingId = useId();
  const [routes, setRoutes] = useState<Row[] | null>(null);
  const [failedLoad, setFailedLoad] = useState(false);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);

  useEffect(() => {
    let current = true;
    void (async () => {
      const found = await api.routes(work);
      if (!found.ok) { if (current) setFailedLoad(true); return; }
      const rows = await Promise.all(found.data.map(async route => {
        const read = await api.progress(route);
        const progress = read.ok ? read.data : { completed: false, position: null, version: 0 };
        return { ...route, completed: progress.completed, started: progress.completed || progress.position !== null, version: progress.version };
      }));
      if (current) { setFailedLoad(false); setRoutes(rows); }
    })();
    return () => { current = false; };
  }, [api, reload, work]);

  if (failedLoad) {
    return <section aria-labelledby={headingId} className={className}>
      <h2 id={headingId} className="sr-only">{t.playHeading}</h2>
      <Alert variant="destructive" role="alert"><AlertDescription>{t.trackedUnavailable}</AlertDescription></Alert></section>;
  }
  if (!routes?.length) return null;
  const status = gameStatus(routes);
  const gate = routes.some(route => route.required) ? routes.filter(route => route.required) : routes;
  const named = routes.filter(route => !route.required);
  const chosen = named.find(route => route.occurrence === selected) ?? null;

  async function write(route: RouteRef, completed: boolean) {
    setSaving(true);
    setFailed(false);
    const written = await api.mark(route, { completed, position: completed ? 'completed' : 'played' });
    setSaving(false);
    if (!written.ok && written.failure === 'stale') { setConflict({ route, current: written.current, submitted: written.submitted }); return false; }
    if (!written.ok) { setFailed(true); return false; }
    setConflict(null);
    return true;
  }

  async function writeGame(completed: boolean) {
    for (const route of gate) {
      if (completed ? route.completed : route.started) continue;
      if (!await write(route, completed)) return;
    }
    setReload(count => count + 1);
  }

  return <section aria-labelledby={headingId} data-game-progress data-play-state={status}
    className={className ?? 'grid gap-4 rounded-2xl border border-border/60 p-4 sm:p-5'}>
    <h2 id={headingId} className="font-semibold text-xl tracking-tight">{t.playHeading}</h2>
    <p className="font-medium text-base" data-where>{status === 'completed' ? t.gameCompleted : status === 'played' ? t.gamePlayed : t.notPlayed}</p>
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" disabled={saving || status === 'completed'}
        onClick={() => void writeGame(false)}>{saving ? t.episodeSaving : t.markPlayed}</Button>
      <Button type="button" className="min-h-11 w-full sm:w-auto" disabled={saving || status === 'completed'}
        onClick={() => void writeGame(true)}>
        <CheckIcon aria-hidden="true" />{saving ? t.episodeSaving : t.markCompleted}</Button>
    </div>

    {named.length ? <div className="grid gap-3 border-border/60 border-t pt-3" data-routes>
      <h3 className="font-medium text-sm">{t.routesTitle}</h3>
      <p className="text-muted-foreground text-xs">{t.routesNote}</p>
      <ul className="flex flex-wrap gap-2">
        {named.map(route => <li key={route.occurrence}>
          <Button type="button" size="sm" className="min-h-11 sm:min-h-8" data-route={route.occurrence}
            data-route-state={route.completed ? 'completed' : route.started ? 'played' : 'none'}
            variant={selected === route.occurrence ? 'default' : 'outline'} aria-pressed={selected === route.occurrence}
            onClick={() => { setSelected(route.occurrence); setConflict(null); }}>{route.label}</Button>
        </li>)}
      </ul>
      {chosen ? <div className="grid gap-2 rounded-xl bg-muted/40 p-3" data-selected={chosen.occurrence}>
        <p className="font-medium text-sm">{chosen.label}
          <span className="text-muted-foreground">{' · '}{word(chosen, t)}</span></p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={saving}
            onClick={() => void write(chosen, false).then(ok => { if (ok) setReload(count => count + 1); })}>{t.markPlayed}</Button>
          <Button type="button" size="sm" className="min-h-11 sm:min-h-8" disabled={saving}
            onClick={() => void write(chosen, true).then(ok => { if (ok) setReload(count => count + 1); })}>{t.markCompleted}</Button>
        </div>
      </div> : null}
    </div> : null}

    {conflict ? <ProgressConflict label={t.status}
      mine={conflict.submitted.completed ? t.gameCompleted : t.gamePlayed}
      theirs={conflict.current.completed ? t.gameCompleted : conflict.current.position ? t.gamePlayed : t.notPlayed}
      t={t} busy={saving} failed={failed}
      onKeep={() => void write(conflict.route, conflict.submitted.completed).then(ok => { if (ok) setReload(count => count + 1); })}
      onUse={() => { setConflict(null); setReload(count => count + 1); }} /> : null}
    <p role="status" className="text-destructive-foreground text-xs">{failed ? t.saveFailed : null}</p>
  </section>;
}
