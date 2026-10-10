'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { CheckIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { ProgressConflict } from './conflict-panel.tsx';
import type { MediaApi, WorkMark, WorkStanding } from './media-api.ts';
import type { Copy } from './messages.ts';

type Read = { status: 'loading' } | { status: 'absent' } | { status: 'failed' } | { status: 'ready'; mark: WorkMark };
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
  const [read, setRead] = useState<Read>({ status: 'loading' });
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);

  useEffect(() => {
    let current = true;
    void api.workStanding(work).then(found => {
      if (!current) return;
      setRead(found.ok ? { status: 'ready', mark: found.data }
        : found.failure === 'sign-in' || found.failure === 'missing' ? { status: 'absent' } : { status: 'failed' });
    });
    return () => { current = false; };
  }, [api, work]);

  async function write(standing: WorkStanding) {
    setSaving(true);
    setFailed(false);
    const written = await api.markWork(work, standing);
    setSaving(false);
    if (!written.ok && written.failure === 'stale') { setConflict({ current: written.current, submitted: written.submitted }); return false; }
    if (!written.ok) { setFailed(true); return false; }
    setConflict(null);
    setRead({ status: 'ready', mark: written.data });
    return true;
  }

  if (read.status === 'loading' || read.status === 'absent') return null;
  if (read.status === 'failed') {
    return <section aria-labelledby={headingId} className={className}>
      <h2 id={headingId} className="sr-only">{t.workProgress}</h2>
      <Alert variant="destructive" role="alert"><AlertDescription>{t.workUnavailable}</AlertDescription></Alert></section>;
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
      onUse={() => { setConflict(null); setRead({ status: 'ready', mark: conflict.current }); }} /> : null}
    <p role="status" className="text-destructive-foreground text-xs">{failed ? t.saveFailed : null}</p>
  </section>;
}
