'use client';

import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { PlusIcon, XIcon } from 'lucide-react';
import type { Source } from './candidate.ts';
import type { T } from './parts.tsx';

const MAX_SOURCES = 5;

/** Sources to cite: a web or REZICS address and where in it the fact is. Optional; Main takes none or several. */
export function SourcesField({ sources, onChange, t }: { sources: Source[]; onChange: (sources: Source[]) => void; t: T }) {
  const set = (index: number, patch: Partial<Source>) => onChange(sources.map((row, at) => at === index
    ? { ...row, ...patch } : row));
  return <fieldset className="grid gap-3">
    <legend className="font-medium text-sm">{t.sourcesHeading}</legend>
    <p className="text-muted-foreground text-xs">{t.sourcesHelp}</p>
    {sources.map((item, index) => <div key={index} className="grid gap-3 rounded-xl bg-muted/40 p-3 sm:grid-cols-[2fr_1fr_auto]">
      <Field>
        <FieldLabel>{t.sourceLabel}</FieldLabel>
        <Input value={item.source} maxLength={512} inputMode="url" dir="auto"
          onChange={event => set(index, { source: event.currentTarget.value })} />
      </Field>
      <Field>
        <FieldLabel>{t.sourceLocator}</FieldLabel>
        <Input value={item.locator} maxLength={200} dir="auto"
          onChange={event => set(index, { locator: event.currentTarget.value })} />
      </Field>
      {sources.length > 1 ? <Button type="button" variant="ghost" size="icon-sm" aria-label={t.removeSource}
        className="self-end" onClick={() => onChange(sources.filter((_, at) => at !== index))}>
        <XIcon aria-hidden="true" /></Button> : null}
    </div>)}
    {sources.length < MAX_SOURCES ? <Button type="button" variant="outline" size="sm" className="w-fit"
      onClick={() => onChange([...sources, { source: '', locator: '' }])}>
      <PlusIcon aria-hidden="true" />{t.addSource}</Button> : null}
  </fieldset>;
}
