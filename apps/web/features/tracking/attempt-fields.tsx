'use client';

import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { ChoiceSelect } from '@rezics/ui/select';
import { useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { formatLabel, locatorParts, unitLabel } from './display.ts';
import type { Copy } from './messages.ts';
import { dateText, type EditionOption, isoDatePlaceholder, knownFormats, locatorOf, parsePosition, today, validDate } from './model.ts';
import type { LocatorUnit, Selection, Session } from './types.ts';

// The small forms of an attempt. Each sends one change and says nothing about the result: the card
// that owns the attempt applies Main's answer, or shows the conflict.

/** One date of an attempt, at the precision the reader knows; empty is unknown, never today. */
export function DateField({ label, value, locale, t, busy, onSave }: {
  label: string; value: string | null; locale: UiLocale; t: Copy; busy: boolean; onSave: (next: string | null) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(value ?? '');
  const [invalid, setInvalid] = useState(false);
  const [seen, setSeen] = useState(value);
  // Main's answer (or the other device's) replaces what was typed.
  if (seen !== value) { setSeen(value); setDraft(value ?? ''); setInvalid(false); }
  const next = draft.trim() === '' ? null : draft.trim();
  async function save(to: string | null) {
    if (to !== null && !validDate(to)) { setInvalid(true); return; }
    setInvalid(false);
    await onSave(to);
  }
  return <Field className="gap-1.5">
    <FieldLabel className="text-muted-foreground text-xs">{label} · <span className="text-foreground">
      {dateText(value, locale) ?? t.dateUnknown}</span></FieldLabel>
    <div className="flex flex-wrap items-center gap-2">
      <Input size="sm" value={draft} inputMode="numeric" placeholder={isoDatePlaceholder} aria-label={label} aria-invalid={invalid || undefined}
        className="w-36"
        onChange={event => { setDraft(event.target.value); setInvalid(false); }} />
      <Button size="sm" variant="outline" disabled={busy || next === value} onClick={() => void save(next)}>{t.saveDate}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setDraft(today()); setInvalid(false); }}>{t.today}</Button>
      <Button size="sm" variant="ghost" disabled={busy || value === null} onClick={() => void save(null)}>{t.markUnknown}</Button>
    </div>
    {invalid ? <p role="alert" className="text-destructive-foreground text-xs">{t.invalidDate}</p> : null}
  </Field>;
}

/** The edition and format pickers a new attempt and an existing one share. */
export function EditionPicker({ options, nameOf, t, busy, submit, onSubmit, allowWork, secondary }: {
  options: EditionOption[]; nameOf: (option: EditionOption) => string; t: Copy; busy: boolean; submit: string;
  /** A new attempt may name just the Work; one that has begun already holds it, pinned once. */
  allowWork: boolean;
  /** A second way to use the same choice, such as planning an attempt instead of starting it. */
  secondary?: { label: string; onSubmit: (option: EditionOption | null, format: string | null) => Promise<unknown> };
  onSubmit: (option: EditionOption | null, format: string | null) => Promise<unknown>;
}) {
  const [resource, setResource] = useState('');
  const [format, setFormat] = useState('');
  const chosen = options.find(option => option.resource === resource) ?? null;
  return <div className="flex flex-wrap items-end gap-2">
    <Field className="gap-1">
      <FieldLabel className="text-muted-foreground text-xs">{t.edition}</FieldLabel>
      <ChoiceSelect portalled={false} size="sm" value={resource} onValueChange={setResource} label={t.edition} className="max-w-56"
        options={[{ value: '', label: allowWork ? t.workInGeneral : t.chooseEdition },
          ...options.filter(option => option.kind !== 'work').map(option => ({ value: option.resource, label: nameOf(option) }))]} />
    </Field>
    <Field className="gap-1">
      <FieldLabel className="text-muted-foreground text-xs">{t.format}</FieldLabel>
      <ChoiceSelect portalled={false} size="sm" value={format} onValueChange={setFormat} label={t.format}
        options={[{ value: '', label: t.noFormat }, ...knownFormats.map(known => ({ value: known, label: formatLabel(known, t) ?? known }))]} />
    </Field>
    <Button size="sm" variant="outline" disabled={busy || (!allowWork && !chosen)}
      onClick={() => void onSubmit(chosen, format || null)}>{submit}</Button>
    {secondary ? <Button size="sm" variant="ghost" disabled={busy || (!allowWork && !chosen)}
      onClick={() => void secondary.onSubmit(chosen, format || null)}>{secondary.label}</Button> : null}
  </div>;
}

/** Where the reader is in one edition: current and furthest apart, and a form to move the current one. */
export function PositionEditor({ session, selection, t, busy, onSave }: {
  session: Session; selection: Selection; t: Copy; busy: boolean;
  onSave: (target: string, unit: LocatorUnit, value: number) => Promise<boolean>;
}) {
  const locator = locatorOf(session, selection);
  const [unit, setUnit] = useState<LocatorUnit>(locator?.unit ?? 'page');
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const parts = locator ? locatorParts(locator, t) : null;
  async function save() {
    const value = parsePosition(unit, text);
    if (value === null) { setInvalid(true); return; }
    setInvalid(false);
    if (await onSave(selection.target.resource, unit, value)) setText('');
  }
  return <div className="grid gap-1.5">
    {parts ? <p className="text-sm"><span className="text-muted-foreground">{t.positionNow}</span> {parts.now}
      <span aria-hidden="true"> · </span><span className="text-muted-foreground">{t.positionFurthest}</span> {parts.furthest}</p> : null}
    <div className="flex flex-wrap items-end gap-2">
      <Field className="gap-1">
        <FieldLabel className="text-muted-foreground text-xs">{t.positionUnit}</FieldLabel>
        <ChoiceSelect portalled={false} size="sm" value={unit} disabled={Boolean(locator)} onValueChange={value => setUnit(value as LocatorUnit)}
          label={t.positionUnit}
          options={(['page', 'percentage', 'media-time'] as const).map(item => ({ value: item, label: unitLabel(item, t) }))} />
      </Field>
      <Field className="gap-1">
        <FieldLabel className="text-muted-foreground text-xs">{t.positionValue}</FieldLabel>
        <Input size="sm" value={text} inputMode={unit === 'media-time' ? 'text' : 'decimal'} className="w-28" aria-invalid={invalid || undefined}
          onChange={event => { setText(event.target.value); setInvalid(false); }} />
      </Field>
      <Button size="sm" variant="outline" disabled={busy || text.trim() === ''} onClick={() => void save()}>{t.savePosition}</Button>
    </div>
    {invalid ? <p role="alert" className="text-destructive-foreground text-xs">{t.invalidPosition}</p> : null}
  </div>;
}
