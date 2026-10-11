'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { CheckIcon } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ProgressConflict } from './conflict-panel.tsx';
import type { EpisodeProgress, ProgressStale } from './episode-api.ts';
import { GAME_PART_PAGE_LIMIT, type MediaApi } from './media-api.ts';
import { gameStatus, type RouteRef } from './media.ts';
import type { Copy } from './messages.ts';

type Row = RouteRef & { completed: boolean; started: boolean };
type Conflict = { route: RouteRef; current: EpisodeProgress; submitted: ProgressStale['submitted'] };
type Read = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; progress: EpisodeProgress };

const word = (progress: EpisodeProgress, t: Copy) =>
  progress.completed ? t.gameCompleted : progress.position ? t.gamePlayed : t.notPlayed;

const rowOf = (route: RouteRef, progress: EpisodeProgress): Row => ({ ...route,
  completed: progress.completed, started: progress.completed || progress.position !== null });

type Scope = { work: string; api: MediaApi; busy: boolean; selection: number };
type State = {
  scope: Scope | null; routes: Row[] | null; more: string | null; failedLoad: boolean;
  selected: string | null; read: Read | null; saving: boolean; failed: boolean; conflict: Conflict | null;
};
const initial: State = { scope: null, routes: null, more: null, failedLoad: false,
  selected: null, read: null, saving: false, failed: false, conflict: null };

/** Retired inventory reads must not start progress reads for the old Work. */
async function pageOf(scope: Scope, current: (scope: Scope) => boolean, after?: string) {
  if (!current(scope)) return null;
  const found = await scope.api.routes(scope.work, after);
  if (!current(scope)) return null;
  if (!found.ok) return found;
  // A completion summary omits unfinished play, so each displayed part needs its own progress.
  const progress = await Promise.all(found.data.items.map(route => scope.api.progress(route)));
  if (!current(scope)) return null;
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
  const [state, setState] = useState(initial);
  const active = useRef<Scope | null>(null);
  const current = (scope: Scope) => active.current === scope;

  // Check again when React applies an update: a queued result can outlive its Work/API instance.
  function change(scope: Scope, patch: Partial<State> | ((previous: State) => Partial<State>)) {
    if (!current(scope)) return;
    setState(previous => current(scope) ? { ...previous,
      ...(typeof patch === 'function' ? patch(previous) : patch) } : previous);
  }

  // Retire the old scope during commit, before the new Work can paint or accept an action.
  useLayoutEffect(() => {
    const scope: Scope = { work, api, busy: false, selection: 0 };
    active.current = scope;
    change(scope, { ...initial, scope });
    void (async () => {
      try {
        const found = await pageOf(scope, current);
        if (!found) return;
        if (!found.ok) { change(scope, { failedLoad: true }); return; }
        change(scope, { routes: found.data.items, more: found.data.next });
      } catch { change(scope, { failedLoad: true }); }
    })();
    return () => { if (current(scope)) active.current = null; };
  }, [api, work]);

  const { routes, more, failedLoad, selected, read, saving, failed, conflict } = state;
  function scopeOfAction() {
    const scope = active.current;
    return scope && scope === state.scope && scope.work === work && scope.api === api ? scope : null;
  }

  async function further() {
    const scope = scopeOfAction();
    if (!scope || !more || !routes || scope.busy) return;
    scope.busy = true;
    change(scope, { saving: true, failed: false });
    try {
      const found = await pageOf(scope, current, more);
      if (!found) return;
      if (!found.ok) { change(scope, { failed: true }); return; }
      change(scope, previous => ({ routes: [...(previous.routes ?? []), ...found.data.items], more: found.data.next }));
    } catch { change(scope, { failed: true }); }
    finally { if (current(scope)) { scope.busy = false; change(scope, { saving: false }); } }
  }

  async function choose(route: RouteRef) {
    const scope = scopeOfAction();
    if (!scope || scope.busy) return;
    const request = ++scope.selection;
    change(scope, { selected: route.occurrence, conflict: null, failed: false, read: { status: 'loading' } });
    try {
      const progress = await scope.api.progress(route);
      if (!current(scope) || request !== scope.selection) return;
      change(scope, { read: progress.ok ? { status: 'ready', progress: progress.data } : { status: 'failed' } });
      if (progress.ok) update(scope, route, progress.data);
    } catch {
      if (current(scope) && request === scope.selection) change(scope, { read: { status: 'failed' } });
    }
  }

  function update(scope: Scope, route: RouteRef, progress: EpisodeProgress) {
    change(scope, previous => ({
      routes: previous.routes?.map(row => row.occurrence === route.occurrence ? rowOf(row, progress) : row) ?? null,
      ...(previous.selected === route.occurrence ? { read: { status: 'ready', progress } as Read } : {}),
    }));
  }

  async function write(scope: Scope, route: RouteRef, completed: boolean, position: string | null) {
    if (!current(scope)) return false;
    const written = await scope.api.mark(route, { completed, position });
    if (!current(scope)) return false;
    if (!written.ok && written.failure === 'stale') {
      update(scope, route, written.current);
      change(scope, { conflict: { route, current: written.current, submitted: written.submitted } }); return false;
    }
    if (!written.ok) { change(scope, { failed: true }); return false; }
    change(scope, { conflict: null });
    update(scope, route, written.data);
    return true;
  }

  async function save(action: (scope: Scope) => Promise<unknown>) {
    const scope = scopeOfAction();
    if (!scope || scope.busy) return;
    scope.busy = true;
    ++scope.selection;
    change(scope, { saving: true, failed: false });
    try { await action(scope); }
    catch { change(scope, { failed: true }); }
    finally { if (current(scope)) { scope.busy = false; change(scope, { saving: false }); } }
  }

  async function writeGame(mode: 'played' | 'completed' | 'undo') {
    if (!routes) return;
    await save(async scope => {
      let all = routes;
      let cursor = more;
      const seen = new Set<string>();
      // No marks are sent until every page is available, including a required part after optional ones.
      while (cursor) {
        if (!current(scope)) return;
        if (seen.size >= GAME_PART_PAGE_LIMIT || seen.has(cursor)) { change(scope, { failed: true }); return; }
        seen.add(cursor);
        const found = await pageOf(scope, current, cursor);
        if (!found) return;
        if (!found.ok) { change(scope, { failed: true }); return; }
        all = [...all, ...found.data.items];
        cursor = found.data.next;
        change(scope, { routes: all, more: cursor });
      }
      const gate = all.some(route => route.required) ? all.filter(route => route.required) : all;
      if (mode === 'played' && gate.some(route => route.started)) return;
      for (const route of gate) {
        if (!current(scope)) return;
        if (mode === 'completed' && route.completed) continue;
        if (mode === 'undo' && !route.completed) continue;
        const ok = await write(scope, route, mode === 'completed', mode === 'completed' ? 'completed' : mode === 'played' ? 'played' : null);
        if (!ok || mode === 'played') return;
      }
    });
  }

  if (state.scope?.work !== work || state.scope.api !== api) return null;
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
          onClick={() => void save(scope => write(scope, chosen, false, null))}>{t.markNotCompleted}</Button></div>
          : ready ? <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={saving}
              onClick={() => void save(scope => write(scope, chosen, false, 'played'))}>{t.markPlayed}</Button>
            <Button type="button" size="sm" className="min-h-11 sm:min-h-8" disabled={saving}
              onClick={() => void save(scope => write(scope, chosen, true, 'completed'))}>{t.markCompleted}</Button>
          </div> : null}
    </div> : null}

    {conflict ? <ProgressConflict label={t.status}
      mine={conflict.submitted.completed ? t.gameCompleted : conflict.submitted.position ? t.gamePlayed : t.notPlayed}
      theirs={conflict.current.completed ? t.gameCompleted : conflict.current.position ? t.gamePlayed : t.notPlayed}
      t={t} busy={saving} failed={failed}
      onKeep={() => void save(scope => write(scope, conflict.route, conflict.submitted.completed, conflict.submitted.position))}
      onUse={() => { const scope = scopeOfAction(); if (scope) change(scope, { conflict: null }); }} /> : null}
    <p role="status" className="text-destructive-foreground text-xs">{failed || read?.status === 'failed' ? t.saveFailed : null}</p>
  </section>;
}
