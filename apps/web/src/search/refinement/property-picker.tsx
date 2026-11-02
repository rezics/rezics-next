import { useId, useState } from 'react';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../../paraglide/messages.js';
import { localizedLabel } from '../results';
import type { RefinementProperty } from './model';

function propertyName(entry: RefinementProperty, locale: string) {
  return entry.mode === 'types' ? m.search_subject_types() : localizedLabel(entry.labels, locale).text;
}

export function PropertyPicker({
  properties,
  locale,
  onSelect,
}: {
  properties: RefinementProperty[];
  locale: string;
  onSelect: (property: string) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const needle = query.trim();
  const exact = properties.filter((entry) => entry.property === needle);
  const matches = !needle
    ? properties
    : exact.length
      ? exact
      : properties.filter((entry) =>
          propertyName(entry, locale).toLocaleLowerCase(locale).includes(needle.toLocaleLowerCase(locale)),
        );
  const names = matches.map((entry) => [entry, propertyName(entry, locale) || entry.property] as const);
  const counts = new Map<string, number>();
  for (const [, name] of names) counts.set(name, (counts.get(name) ?? 0) + 1);

  return (
    <div className="space-y-2">
      <Field>
        <FieldLabel htmlFor={`${id}-find`}>{m.refinement_property_find_label()}</FieldLabel>
        <Input
          id={`${id}-find`}
          type="search"
          autoComplete="off"
          placeholder={m.refinement_property_find_placeholder()}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </Field>
      {needle && matches.length === 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.refinement_property_find_no_match()}
        </p>
      )}
      <Field>
        <FieldLabel htmlFor={`${id}-property`}>{m.refinement_property()}</FieldLabel>
        <NativeSelect
          id={`${id}-property`}
          value=""
          onChange={(event) => {
            const property = event.currentTarget.value;
            if (!property) return;
            onSelect(property);
            setQuery('');
          }}
        >
          <NativeSelectOption value="">{m.refinement_choose_property()}</NativeSelectOption>
          {names.map(([entry, name]) => (
            <NativeSelectOption key={entry.property} value={entry.property}>
              {counts.get(name)! > 1 ? `${name} (${entry.property})` : name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
    </div>
  );
}
