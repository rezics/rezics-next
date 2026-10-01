'use client';

import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { StaleChange, TrackingApi } from './api.ts';
import { DateField, EditionPicker, PositionEditor } from './attempt-fields.tsx';
import { ConflictPanel } from './conflict-panel.tsx';
import { editionName, formatLabel, moveLabel, stateLabel } from './display.ts';
import type { Copy } from './messages.ts';
import { conflictRows, editionOptions, hasEnded, movesFrom, selectionInput, takesPosition, withoutVersion } from './model.ts';
import type { Editions, LocatorUnit, Session, SessionChanges } from './types.ts';

type Conflict = { current: Session; submitted: StaleChange };

/**
 * One attempt: its status, dates, editions and formats, and where the reader is in each. Every edit
 * is sent on the version the card last saw; if another device got there first, the card shows both
 * sides and waits for the reader's choice.
 */
export function AttemptCard({ session, title, work, editions, api, locale, t, onChange }: {
  session: Session; title: string; work: string; editions: Editions | null; api: TrackingApi; locale: UiLocale; t: Copy;
  onChange: (session: Session) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [keepFailed, setKeepFailed] = useState(false);
  const ended = hasEnded(session);

  /** Sends one change; true when Main applied it. A stale version opens the conflict instead. */
  async function apply(changes: SessionChanges, version = session.version): Promise<boolean> {
    setBusy(true);
    setFailed(false);
    const written = await api.change(session.id, version, changes);
    setBusy(false);
    if (written.ok) { setConflict(null); setKeepFailed(false); onChange(written.data); return true; }
    if (written.failure === 'stale') {
      onChange(written.current);
      setKeepFailed(false);
      // Main already holds what was asked for: nothing to choose between. Otherwise the refused change
      // waits for the reader's choice, beside the attempt as it now stands.
      if (!conflictRows(written.current, written.submitted).length) { setConflict(null); return true; }
      setConflict({ current: written.current, submitted: written.submitted });
    } else if (version === session.version) setFailed(true);
    else setKeepFailed(true);
    return false;
  }

  const options = editionOptions(work, editions, session);
  const nameOf = (option: { resource: string; kind: 'work' | 'realization' | 'release' }) =>
    editionName(option.resource, option.kind, editions, locale, t);

  return <article aria-label={title} data-session={session.id} data-state={session.state} className="grid gap-4 rounded-2xl border border-border/60 p-4">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold text-base">{title}</h3>
      <Badge variant={session.state === 'finished' ? 'success' : session.state === 'dnf' ? 'outline' : 'secondary'}
        aria-busy={busy || undefined}>{stateLabel(session.state, t)}</Badge>
    </header>

    {conflict ? <ConflictPanel rows={conflictRows(conflict.current, conflict.submitted)} current={conflict.current} editions={editions}
      locale={locale} t={t} busy={busy} failed={keepFailed}
      onKeep={() => void apply(withoutVersion(conflict.submitted), conflict.current.version)}
      onUse={() => { setConflict(null); setKeepFailed(false); }} /> : null}

    {ended ? <p className="text-muted-foreground text-sm">{session.state === 'dnf' ? t.dnfNote : t.endedNote}</p>
      : <div className="flex flex-wrap gap-2" role="group" aria-label={t.status}>
        {movesFrom(session.state).map(state => <Button key={state} size="sm" variant={state === 'finished' ? 'default' : 'outline'}
          disabled={busy} onClick={() => void apply({ state })}>{moveLabel(state, session.state, t)}</Button>)}
      </div>}

    <div className="grid gap-3 sm:grid-cols-2">
      <DateField label={t.startedOn} value={session.startedOn} locale={locale} t={t} busy={busy}
        onSave={next => apply({ startedOn: next })} />
      <DateField label={t.finishedOn} value={session.finishedOn} locale={locale} t={t} busy={busy}
        onSave={next => apply({ finishedOn: next })} />
    </div>

    <div className="grid gap-3">
      <h4 className="font-medium text-sm">{t.editions}</h4>
      <ul className="grid gap-3">
        {session.selections.map(selection => {
          const format = formatLabel(selection.format, t);
          return <li key={selection.target.resource} className="grid gap-1.5 border-border/60 border-s-2 ps-3" data-selection={selection.target.base}>
            <p className="font-medium text-sm">{nameOf({ resource: selection.target.resource, kind: selection.target.base === 'work'
              ? 'work' : selection.target.base === 'release' ? 'release' : 'realization' })}
            {format ? <span className="font-normal text-muted-foreground"> · {format}</span> : null}</p>
            {takesPosition(selection)
              ? <PositionEditor session={session} selection={selection} t={t} busy={busy}
                onSave={(target: string, unit: LocatorUnit, value: number) => apply({ position: { target, unit, value } })} />
              : <p className="text-muted-foreground text-xs">{selection.progress === 'structure' ? t.structureNote : t.needsEdition}</p>}
          </li>;
        })}
      </ul>
      {options.length ? <>
        <EditionPicker options={options} nameOf={nameOf} t={t} busy={busy} submit={t.addEdition} allowWork={false}
          onSubmit={(option, format) => option ? apply({ addSelections: [selectionInput(option, format)] }) : Promise.resolve(false)} />
        <p className="text-muted-foreground text-xs">{t.editionsNote}</p>
      </> : editions ? <p className="text-muted-foreground text-xs">{t.noEditionsLeft}</p> : null}
      {failed ? <p role="status" className="text-destructive-foreground text-xs">{t.saveFailed}</p> : null}
    </div>
  </article>;
}
