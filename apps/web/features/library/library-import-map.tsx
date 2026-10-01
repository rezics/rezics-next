'use client';

import { Button } from '@rezics/ui/button';
import { ChoiceSelect } from '@rezics/ui/select';
import { materializeData } from 'native-i18n';
import { useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { CsvInspection, CsvMapping, SourceStatus } from './import-api.ts';
import type { LibraryMessages } from './messages.ts';

type T = ReturnType<typeof materializeData<LibraryMessages>>;

export const sourceStatuses: readonly SourceStatus[] = ['want-to-read', 'reading', 'read', 'paused', 'dnf'];
export const sourceStatusLabel = (status: SourceStatus, t: T) => status === 'want-to-read' ? t.wantToRead
  : status === 'reading' ? t.reading : status === 'read' ? t.read : status === 'paused' ? t.importStatePaused
    : t.importStateDnf;

type Field = 'title' | 'author' | 'status' | 'progress' | 'startedOn' | 'finishedOn';
const fields: readonly Field[] = ['title', 'author', 'status', 'progress', 'startedOn', 'finishedOn'];

/**
 * A list REZICS has no format for. Main returned the file's headers and the distinct values of each; the
 * reader says which column is which and what each status value means. Nothing is guessed here, and a
 * status left unmapped is kept with the row rather than turned into a Library state.
 */
export function CsvMapper({ inspection, locale, messages, busy, onSubmit, onCancel }: {
  inspection: CsvInspection; locale: UiLocale; messages: LibraryMessages; busy: boolean;
  onSubmit: (mapping: CsvMapping) => void; onCancel: () => void;
}) {
  const t = materializeData(messages, { locale });
  const [columns, setColumns] = useState<Record<Field, string>>({ title: '', author: '', status: '', progress: '',
    startedOn: '', finishedOn: '' });
  const [unit, setUnit] = useState<'' | 'page' | 'percentage'>('');
  const [statuses, setStatuses] = useState<Record<string, SourceStatus | ''>>({});
  const label: Record<Field, string> = { title: t.importColTitle, author: t.importColAuthor, status: t.importColStatus,
    progress: t.importColProgress, startedOn: t.importColStarted, finishedOn: t.importColFinished };
  const options = [{ value: '', label: t.importColNone },
    ...inspection.headers.map(header => ({ value: header, label: header }))];
  const values = columns.status ? inspection.distinctValues[columns.status] ?? [] : [];

  function submit() {
    const mapping: CsvMapping = { title: columns.title,
      ...Object.fromEntries(fields.filter(field => field !== 'title' && columns[field]).map(field => [field, columns[field]])),
      ...columns.progress && unit ? { progressUnit: unit } : {},
      statuses: Object.fromEntries(values.map(value => [value, statuses[value] || null])) };
    onSubmit(mapping);
  }

  return <form noValidate onSubmit={event => { event.preventDefault(); if (columns.title) submit(); }}
    className="grid gap-4 rounded-xl bg-muted/40 p-4">
    <div className="grid gap-1">
      <h3 className="font-semibold">{t.importMapTitle}</h3>
      <p className="text-muted-foreground text-sm">{t.importMapHelp}</p>
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.map(field => <div key={field} className="grid gap-1 text-sm">
        <span className="font-medium">{label[field]}</span>
        <ChoiceSelect value={columns[field]} label={label[field]} options={field === 'title' ? options.slice(1) : options}
          placeholder={t.importColNone} onValueChange={value => setColumns({ ...columns, [field]: value })} />
      </div>)}
      {columns.progress ? <div className="grid gap-1 text-sm">
        <span className="font-medium">{t.importProgressUnit}</span>
        <ChoiceSelect value={unit} label={t.importProgressUnit}
          options={[{ value: '', label: t.importColNone }, { value: 'page', label: t.importUnitPage },
            { value: 'percentage', label: t.importUnitPercent }]}
          onValueChange={value => setUnit(value === 'page' || value === 'percentage' ? value : '')} />
      </div> : null}
    </div>
    {values.length ? <fieldset className="grid gap-3">
      <legend className="font-medium text-sm">{t.importMapStatuses}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {values.map(value => <div key={value} className="grid gap-1 text-sm">
          <span className="break-words text-muted-foreground">{t.importStatusValue({ value })}</span>
          <ChoiceSelect value={statuses[value] ?? ''} label={t.importStatusValue({ value })}
            options={[{ value: '', label: t.importStatusUnmapped },
              ...sourceStatuses.map(status => ({ value: status, label: sourceStatusLabel(status, t) }))]}
            onValueChange={status => setStatuses({ ...statuses,
              [value]: sourceStatuses.find(known => known === status) ?? '' })} />
        </div>)}
      </div>
    </fieldset> : null}
    <div className="flex flex-wrap gap-2">
      <Button type="submit" isLoading={busy} disabled={!columns.title}>{t.importMapSubmit}</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>{t.cancel}</Button>
    </div>
  </form>;
}
