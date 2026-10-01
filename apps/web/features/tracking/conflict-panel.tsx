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
      <table className="w-full text-start text-sm">
        <thead className="text-xs">
          <tr><th scope="col" className="sr-only">{t.status}</th>
            <th scope="col" className="pe-3 text-start font-medium">{t.conflictMine}</th>
            <th scope="col" className="text-start font-medium">{t.conflictTheirs}</th></tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const cell = cells(row, editions, locale, t);
            return <tr key={`${row.field}:${'target' in row ? row.target : ''}`} data-conflict-field={row.field}>
              <th scope="row" className="py-0.5 pe-3 text-start font-normal text-muted-foreground">{cell.label}</th>
              <td className="pe-3">{cell.mine}</td><td>{cell.theirs}</td>
            </tr>;
          })}
        </tbody>
      </table>
      {failed ? <p role="status" className="text-destructive-foreground text-xs">{t.conflictFailed}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={onKeep}>{t.keepMine}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onUse}>{t.useTheirs}</Button>
      </div>
    </AlertDescription>
  </Alert>;
}
