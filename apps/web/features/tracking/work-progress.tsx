'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Skeleton } from '@rezics/ui/skeleton';
import { CheckIcon } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ProgressConflict } from './conflict-panel.tsx';
import type { MediaApi, WorkMark, WorkStanding } from './media-api.ts';
import type { Copy } from './messages.ts';
import { workStandingRead } from './work-standing.ts';

type ProgressApi = Pick<MediaApi, 'workStanding' | 'markWork'>;
type Read = ({ status: 'loading' } | { status: 'pending' } | ReturnType<typeof workStandingRead>) & { work: string; api: ProgressApi };
type Conflict = { current: WorkMark; submitted: WorkStanding };

const playState = (standing: WorkStanding) => standing === 'started' ? 'playing' : standing === 'not-started' ? 'none' : standing;

/**
 * A Work with no parts is still one thing the reader can be in the middle of, finish, or drop.
 * Playing and reading are the same mark. Another device reads the same row. Undo clears it.
 */
export function WorkProgress({ work, api, verb, t, className }: {
  work: string; api: Pick<MediaApi, 'workStanding' | 'markWork'>; verb: 'play' | 'read'; t: Copy; className?: string;
}) {
  const headingId = useId();
  const [read, setRead] = useState<Read>({ status: 'loading', work, api });
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [reload, setReload] = useState(0);
  const active = useRef<{ busy: boolean; write: number } | null>(null);

  useLayoutEffect(() => {
    const scope = { busy: false, write: 0 };
    active.current = scope;
    setRead({ status: 'loading', work, api });
    setSaving(false); setFailed(false); setConflict(null);
    return () => { if (active.current === scope) active.current = null; };
  }, [api, work]);

  useEffect(() => {
    let current = true;
    const scope = active.current, write = scope?.write;
    void api.workStanding(work).then(found => {
      if (!current || active.current !== scope || scope?.write !== write) return;
      setRead({ ...(!found.ok && found.status === 202 ? { status: 'pending' as const } : workStandingRead(found)), work, api });
    }).catch(() => {
      if (current && active.current === scope && scope?.write === write)
        setRead({ ...workStandingRead({ ok: false, failure: 'unavailable' }), work, api });
    });
    return () => { current = false; };
  }, [api, work, reload]);

  async function write(standing: WorkStanding) {
    const scope = active.current;
    if (!scope || scope.busy) return false;
    scope.busy = true;
    ++scope.write;
    setSaving(true);
    setFailed(false);
    let written: Awaited<ReturnType<MediaApi['markWork']>>;
    try { written = await api.markWork(work, standing); }
    catch {
      if (active.current === scope) { scope.busy = false; setSaving(false); setFailed(true); }
      return false;
    }
    if (active.current !== scope) return false;
    scope.busy = false;
    setSaving(false);
    if (!written.ok && written.failure === 'has-parts') { setRead({ status: 'absent', work, api }); return false; }
    if (!written.ok && written.failure === 'stale') { setConflict({ current: written.current, submitted: written.submitted }); return false; }
    if (!written.ok) {
      if (written.status === 202) setRead({ status: 'pending', work, api });
      else setFailed(true);
      return false;
    }
    setConflict(null);
    setRead({ status: 'ready', mark: written.data, work, api });
    return true;
  }

  if (read.work !== work || read.api !== api || read.status === 'absent') return null;
  if (read.status === 'loading' || read.status === 'pending') return <section aria-labelledby={headingId} aria-busy="true"
    data-loading={read.status === 'loading' || undefined} data-pending={read.status === 'pending' || undefined}
    className={className ?? 'grid gap-4 rounded-2xl border border-border/60 p-4 sm:p-5'}>
    <h2 id={headingId} className="font-semibold text-xl tracking-tight">{t.workProgress}</h2>
    {read.status === 'loading' ? <Skeleton className="h-24 rounded-xl" />
      : <><p role="status">{t.unknown}</p><Button variant="outline" onClick={() => setReload(count => count + 1)}>{t.retry}</Button></>}
  </section>;
  if (read.status === 'failed') {
    return <section aria-labelledby={headingId} className={className}>
      <h2 id={headingId} className="sr-only">{t.workProgress}</h2>
      <Alert variant="destructive" role="alert"><AlertDescription>{t.workUnavailable}</AlertDescription></Alert>
      <Button variant="outline" onClick={() => { setRead({ status: 'loading', work, api }); setReload(count => count + 1); }}>{t.retry}</Button></section>;
  }
  const mark = read.mark;
  const word = (standing: WorkStanding) => standing === 'completed' ? t.gameCompleted
    : standing === 'dropped' ? t.workDropped
      : standing === 'started' ? (verb === 'play' ? t.workPlaying : t.workReading) : t.notStarted;
  const offers: WorkStanding[] = mark.standing === 'not-started' ? ['started', 'completed', 'dropped']
    : mark.standing === 'started' ? ['completed', 'dropped', 'not-started'] : ['not-started'];
  const button = (standing: WorkStanding) => standing === 'completed' ? t.markCompleted
    : standing === 'dropped' ? t.markDropped
      : standing === 'started' ? (verb === 'play' ? t.markPlaying : t.markReading) : t.markNotStarted;
  return <section aria-labelledby={headingId} data-work-progress data-play-state={playState(mark.standing)}
    data-verb={verb} className={className ?? 'grid gap-4 rounded-2xl border border-border/60 p-4 sm:p-5'}>
    <h2 id={headingId} className="font-semibold text-xl tracking-tight">{t.workProgress}</h2>
    <p className="font-medium text-base" data-where>{word(mark.standing)}</p>
    <div className="flex flex-wrap gap-2">
      {offers.map(standing => <Button key={standing} type="button"
        variant={standing === 'completed' ? 'default' : 'outline'} className="min-h-11 w-full sm:w-auto"
        disabled={saving} onClick={() => void write(standing)}>
        {standing === 'completed' ? <CheckIcon aria-hidden="true" /> : null}
        {saving ? t.episodeSaving : button(standing)}
      </Button>)}
    </div>
    {conflict ? <ProgressConflict label={t.status} mine={word(conflict.submitted)} theirs={word(conflict.current.standing)}
      t={t} busy={saving} failed={failed}
      onKeep={() => void write(conflict.submitted)}
      onUse={() => { setConflict(null); setRead({ status: 'ready', mark: conflict.current, work, api }); }} /> : null}
    <p role="status" className="text-destructive-foreground text-xs">{failed ? t.saveFailed : null}</p>
  </section>;
}
