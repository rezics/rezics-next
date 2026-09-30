'use client';

import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { TriangleAlertIcon } from 'lucide-react';
import type { UiLocale } from '../../i18n/define.ts';
import { editionName, formatLabel, pointText, stateLabel } from './display.ts';
import type { Copy } from './messages.ts';
import { type ConflictRow, dateText } from './model.ts';
import type { Editions, Session } from './types.ts';

function cells(row: ConflictRow, editions: Editions | null, locale: UiLocale, t: Copy):
  { label: string; mine: string; theirs: string } {
  switch (row.field) {
    case 'state':
      return { label: t.status, mine: stateLabel(row.mine, t), theirs: stateLabel(row.theirs, t) };
    case 'startedOn':
    case 'finishedOn':
      return { label: row.field === 'startedOn' ? t.conflictStarted : t.conflictFinished,
        mine: dateText(row.mine, locale) ?? t.dateUnknown, theirs: dateText(row.theirs, locale) ?? t.dateUnknown };
    case 'selection': {
      const format = formatLabel(row.mine.format ?? null, t);
      const name = editionName(row.mine.target, 'resource', editions, locale, t);
      return { label: t.edition, mine: t.conflictEdition({ edition: format ? `${name} · ${format}` : name }),
        theirs: row.theirs ? [editionName(row.theirs.target.resource, row.theirs.target.base, editions, locale, t),
          formatLabel(row.theirs.format, t)].filter(Boolean).join(' · ') : t.notSet };
    }
    case 'position':
      return { label: t.conflictPosition, mine: pointText(row.unit, row.mine, t),
        theirs: row.theirs ? pointText(row.theirs.unit, row.theirs.current, t) : t.notSet };
  }
}

/**
 * Both sides of a 409: what the reader tried to save and what another device saved first. Nothing is
 * merged; the reader keeps their change (sent again on the newer version) or takes the other.
 */
export function ConflictPanel({ rows, current, editions, locale, t, busy, failed, onKeep, onUse }: {
  rows: ConflictRow[]; current: Session; editions: Editions | null; locale: UiLocale; t: Copy; busy: boolean; failed: boolean;
  onKeep: () => void; onUse: () => void;
}) {
  return <Alert variant="warning" role="alert" data-conflict={current.id}>
    <TriangleAlertIcon aria-hidden="true" />
    <AlertTitle>{t.conflictTitle}</AlertTitle>
    <AlertDescription className="grid gap-3">
      <p>{t.conflictBody}</p>
      <dl className="grid grid-cols-[auto_1fr_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="sr-only">{t.status}</dt>
        <dd className="col-start-2 font-medium text-xs">{t.conflictMine}</dd>
        <dd className="font-medium text-xs">{t.conflictTheirs}</dd>
        {rows.map(row => {
          const cell = cells(row, editions, locale, t);
          return <div key={`${row.field}:${'target' in row ? row.target : ''}`} className="contents" data-conflict-field={row.field}>
            <dt className="text-muted-foreground">{cell.label}</dt><dd>{cell.mine}</dd><dd>{cell.theirs}</dd>
          </div>;
        })}
      </dl>
      {failed ? <p role="status" className="text-destructive-foreground text-xs">{t.conflictFailed}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={onKeep}>{t.keepMine}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onUse}>{t.useTheirs}</Button>
      </div>
    </AlertDescription>
  </Alert>;
}
