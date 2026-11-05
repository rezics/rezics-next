import type { FilterQualifier } from '@rezics/filter';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { useId } from 'react';
import { m } from '../../../paraglide/messages.js';
import { locales } from '../../../paraglide/runtime.js';
import type { ConditionMetadata } from '../../../search/condition-editor-model';
import { localizedLabel } from '../../../search/results';

const weightProperty = 'rezics:sourceTagWeight';

/** Edit only the released weight qualifier of the fixed tag statement. */
export function ConceptWeightRange({
  metadata,
  property,
  qualifiers = [],
  locale,
  onChange,
}: {
  metadata: ConditionMetadata;
  property: string;
  qualifiers?: readonly FilterQualifier[] | undefined;
  locale: string;
  onChange(qualifiers: readonly FilterQualifier[]): void;
}) {
  const id = useId();
  const definition = metadata.properties[weightProperty];
  if (
    !metadata.properties[property]?.qualifiers?.includes(weightProperty) ||
    definition?.datatype !== 'quantity' ||
    !definition.units?.length
  )
    return null;
  const current = qualifiers.find((qualifier) => qualifier.property === weightProperty);
  const range = current && 'range' in current ? current.range : undefined;
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const label = localizedLabel(definition.labels ?? {}, locale).text || weightProperty;
  return (
    <form
      className="space-y-3 rounded-lg border border-border/60 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const lower = String(data.get('gte') ?? '');
        const upper = String(data.get('lte') ?? '');
        const unit = String(data.get('unit'));
        const next = qualifiers.filter((qualifier) => qualifier.property !== weightProperty);
        if (lower !== '' || upper !== '')
          next.push({
            property: weightProperty,
            range: {
              unit,
              ...(lower !== '' ? { gte: Number(lower) } : {}),
              ...(upper !== '' ? { lte: Number(upper) } : {}),
            },
          });
        onChange(next);
      }}
    >
      <p className="font-medium">{label}</p>
      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        {(['gte', 'lte'] as const).map((bound) => (
          <Field key={bound}>
            <FieldLabel htmlFor={`${id}-${bound}`}>
              {bound === 'gte' ? m.refinement_lower({}, options) : m.refinement_upper({}, options)}
            </FieldLabel>
            <Input
              id={`${id}-${bound}`}
              name={bound}
              type="number"
              step="any"
              inputMode="decimal"
              defaultValue={range?.[bound] ?? ''}
            />
          </Field>
        ))}
        <Field>
          <FieldLabel htmlFor={`${id}-unit`}>{m.refinement_unit({}, options)}</FieldLabel>
          <NativeSelect
            id={`${id}-unit`}
            name="unit"
            defaultValue={range?.unit ?? definition.units[0]}
            className="w-full min-w-0 max-w-full [&_select]:h-auto [&_select]:min-h-11 [&_select]:max-w-full"
          >
            {definition.units.map((unit) => (
              <NativeSelectOption key={unit} value={unit}>
                {unit}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <Button
        type="submit"
        variant="outline"
        className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2"
      >
        {m.search_apply({}, options)}
      </Button>
    </form>
  );
}
