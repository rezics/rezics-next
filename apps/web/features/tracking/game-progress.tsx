'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { CheckIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { ProgressConflict } from './conflict-panel.tsx';
import type { EpisodeProgress, ProgressStale } from './episode-api.ts';
import type { MediaApi } from './media-api.ts';
import { gameStatus, type RouteRef } from './media.ts';
import type { Copy } from './messages.ts';

type Row = RouteRef & { completed: boolean; started: boolean };
type Conflict = { route: RouteRef; current: EpisodeProgress; submitted: ProgressStale['submitted'] };
type Read = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; progress: EpisodeProgress };

const word = (progress: EpisodeProgress, t: Copy) =>
  progress.completed ? t.gameCompleted : progress.position ? t.gamePlayed : t.notPlayed;

const rowOf = (route: RouteRef, progress: EpisodeProgress): Row => ({ ...route,
  completed: progress.completed, started: progress.completed || progress.position !== null });

/** A completion summary omits unfinished play, so every displayed part needs its own progress. */
async function pageOf(api: MediaApi, work: string, after?: string) {
  const found = await api.routes(work, after);
  if (!found.ok) return found;
  const progress = await Promise.all(found.data.items.map(route => api.progress(route)));
  const failed = progress.find(read => !read.ok);
  if (failed && !failed.ok) return failed;
  return { ok: true as const, data: { next: found.data.next, items: found.data.items.map((route, index) => {
    const read = progress[index]!;
    if (!read.ok) throw new Error('A failed part read cannot become an unplayed part.');
    return rowOf(route, read.data);
  }) } };
}

/** Whole-game writes first establish the complete set of required parts. */
export function GameProgress({ work, api, t, className }: { work: string; api: MediaApi; t: Copy; className?: string }) {
  const headingId = useId();
  const [routes, setRoutes] = useState<Row[] | null>(null);
  const [more, setMore] = useState<string | null>(null);
  const [failedLoad, setFailedLoad] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [read, setRead] = useState<Read | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const busy = useRef(false);
  const selection = useRef(0);

  useEffect(() => {
    let current = true;
    void (async () => {
      setRoutes(null);
      setSelected(null);
      setRead(null);
      setConflict(null);
      setFailed(false);
      setFailedLoad(false);
      const found = await pageOf(api, work);
      if (!found.ok) { if (current) setFailedLoad(true); return; }
      if (!current) return;
      setFailedLoad(false);
      setRoutes(found.data.items);
      setMore(found.data.next);
    })();
    return () => { current = false; ++selection.current; };
  }, [api, work]);

  async function further() {
    if (!more || !routes || busy.current) return;
    busy.current = true;
    setSaving(true);
    setFailed(false);
    try {
      const found = await pageOf(api, work, more);
      if (!found.ok) { setFailed(true); return; }
      setRoutes(current => [...(current ?? []), ...found.data.items]);
      setMore(found.data.next);
    } finally { busy.current = false; setSaving(false); }
  }

  async function choose(route: RouteRef) {
    const request = ++selection.current;
    setSelected(route.occurrence);
    setConflict(null);
    setFailed(false);
    setRead({ status: 'loading' });
    const progress = await api.progress(route);
    if (request !== selection.current) return;
    setRead(progress.ok ? { status: 'ready', progress: progress.data } : { status: 'failed' });
    if (progress.ok) update(route, progress.data);
  }

  function update(route: RouteRef, progress: EpisodeProgress) {
    setRoutes(current => current?.map(row => row.occurrence === route.occurrence ? rowOf(row, progress) : row) ?? null);
    if (selected === route.occurrence) setRead({ status: 'ready', progress });
  }

  async function write(route: RouteRef, completed: boolean, position: string | null) {
    const written = await api.mark(route, { completed, position });
    if (!written.ok && written.failure === 'stale') {
      update(route, written.current);
      setConflict({ route, current: written.current, submitted: written.submitted }); return false;
    }
    if (!written.ok) { setFailed(true); return false; }
    setConflict(null);
    update(route, written.data);
    return true;
  }

  async function save(action: () => Promise<unknown>) {
    if (busy.current) return;
    busy.current = true;
    ++selection.current;
    setSaving(true);
    setFailed(false);
    try { await action(); } finally { busy.current = false; setSaving(false); }
  }

  async function writeGame(mode: 'played' | 'completed' | 'undo') {
    if (!routes) return;
    await save(async () => {
      let all = routes;
      let cursor = more;
      const seen = new Set<string>();
      // No marks are sent until every page is available, including a required part after optional ones.
      while (cursor) {
        if (seen.has(cursor)) { setFailed(true); return; }
        seen.add(cursor);
        const found = await pageOf(api, work, cursor);
        if (!found.ok) { setFailed(true); return; }
        all = [...all, ...found.data.items];
        cursor = found.data.next;
        setRoutes(all);
        setMore(cursor);
      }
      const gate = all.some(route => route.required) ? all.filter(route => route.required) : all;
      if (mode === 'played' && gate.some(route => route.started)) return;
      for (const route of gate) {
        if (mode === 'completed' && route.completed) continue;
        if (mode === 'undo' && !route.completed) continue;
        const ok = await write(route, mode === 'completed', mode === 'completed' ? 'completed' : mode === 'played' ? 'played' : null);
        if (!ok || mode === 'played') return;
      }
    });
  }

  if (failedLoad) {
    return <section aria-labelledby={headingId} className={className}>
      <h2 id={headingId} className="sr-only">{t.playHeading}</h2>
      <Alert variant="destructive" role="alert"><AlertDescription>{t.trackedUnavailable}</AlertDescription></Alert></section>;
  }
  if (!routes || !routes.length && !more) return null;
  const status = routes.length ? gameStatus(routes, !more) : 'unknown';
  const required = routes.filter(route => route.required);
  const named = routes.filter(route => !route.required);
  const chosen = routes.find(route => route.occurrence === selected) ?? null;
  const ready = read?.status === 'ready' ? read.progress : null;
  const waiting = saving || read?.status === 'loading';
  const headline = status === 'completed' ? t.gameCompleted : status === 'played' ? t.gamePlayed : status === 'none' ? t.notPlayed : '';
  const parts = (rows: Row[]) => <ul className="flex flex-wrap gap-2">
    {rows.map(route => <li key={route.occurrence}>
      <Button type="button" size="sm" className="min-h-11 sm:min-h-8" data-route={route.occurrence}
        data-route-state={route.completed ? 'completed' : route.started ? 'played' : 'none'} disabled={saving}
        variant={selected === route.occurrence ? 'default' : 'outline'} aria-pressed={selected === route.occurrence}
        onClick={() => void choose(route)}>
        {route.completed ? <><CheckIcon aria-hidden="true" /><span className="sr-only">{t.gameCompleted}{' · '}</span></> : null}
        {route.label}{route.started && !route.completed ? <span className="text-muted-foreground">{' · '}{t.gamePlayed}</span> : null}
      </Button>
    </li>)}
  </ul>;
  return <section aria-labelledby={headingId} data-game-progress data-play-state={status}
    className={className ?? 'grid gap-4 rounded-2xl border border-border/60 p-4 sm:p-5'}>
    <h2 id={headingId} className="font-semibold text-xl tracking-tight">{t.playHeading}</h2>
    <p className="font-medium text-base" data-where>{headline}</p>
    <div className="flex flex-wrap gap-2">
      {status === 'completed'
        ? <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" disabled={waiting}
          onClick={() => void writeGame('undo')}>{saving ? t.episodeSaving : t.markNotCompleted}</Button>
        : <>
          <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" disabled={waiting}
            onClick={() => void writeGame('played')}>{saving ? t.episodeSaving : t.markPlayed}</Button>
          <Button type="button" className="min-h-11 w-full sm:w-auto" disabled={waiting} onClick={() => void writeGame('completed')}>
            <CheckIcon aria-hidden="true" />{saving ? t.episodeSaving : t.markCompleted}</Button>
        </>}
    </div>

    {required.length ? <div data-required-parts>{parts(required)}</div> : null}
    {named.length ? <div className="grid gap-3 border-border/60 border-t pt-3" data-routes>
      <h3 className="font-medium text-sm">{t.routesTitle}</h3>
      <p className="text-muted-foreground text-xs">{t.routesNote}</p>
      {parts(named)}
    </div> : null}
    {more ? <div><Button type="button" variant="outline" className="min-h-11 sm:min-h-8" disabled={saving}
      onClick={() => void further()}>{t.showMore}</Button></div> : null}
    {chosen ? <div className="grid gap-2 rounded-xl bg-muted/40 p-3" data-selected={chosen.occurrence}>
        <p className="font-medium text-sm">{chosen.label}
          {ready ? <span className="text-muted-foreground">{' · '}{word(ready, t)}</span> : null}
          {read?.status === 'loading' ? <span className="text-muted-foreground">{' · '}{t.episodeSaving}</span> : null}</p>
        {ready?.completed ? <div><Button type="button" size="sm" variant="ghost" className="min-h-11 sm:min-h-8" disabled={saving}
          onClick={() => void save(() => write(chosen, false, null))}>{t.markNotCompleted}</Button></div>
          : ready ? <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={saving}
              onClick={() => void save(() => write(chosen, false, 'played'))}>{t.markPlayed}</Button>
            <Button type="button" size="sm" className="min-h-11 sm:min-h-8" disabled={saving}
              onClick={() => void save(() => write(chosen, true, 'completed'))}>{t.markCompleted}</Button>
          </div> : null}
    </div> : null}

    {conflict ? <ProgressConflict label={t.status}
      mine={conflict.submitted.completed ? t.gameCompleted : conflict.submitted.position ? t.gamePlayed : t.notPlayed}
      theirs={conflict.current.completed ? t.gameCompleted : conflict.current.position ? t.gamePlayed : t.notPlayed}
      t={t} busy={saving} failed={failed}
      onKeep={() => void save(() => write(conflict.route, conflict.submitted.completed, conflict.submitted.position))}
      onUse={() => setConflict(null)} /> : null}
    <p role="status" className="text-destructive-foreground text-xs">{failed || read?.status === 'failed' ? t.saveFailed : null}</p>
  </section>;
}
