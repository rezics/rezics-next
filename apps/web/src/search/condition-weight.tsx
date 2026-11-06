import type { FilterQualifier } from '@rezics/filter';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { useId } from 'react';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import type { ConditionMetadata } from './condition-editor-model';
import { searchQuantityUnitText } from './condition-quantity';
import { parseConditionRangeDraft } from './condition-range-input';
import { localizedLabel } from './results';

const weightProperty = 'rezics:sourceTagWeight';

/** Edit only the released weight qualifier of the fixed tag statement, using Search's numeric grammar. */
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
  const unitMessages = {
    missing: () => m.search_quantity_unit_missing({}, options),
    unitless: () => m.search_quantity_unitless_count({}, options),
    marker: (unit: string) => m.search_quantity_unit_marker({ unit }, options),
    notAdmitted: (unit: string) => m.search_quantity_unit_not_admitted({ unit }, options),
    unavailable: (unit: string) => m.search_quantity_unit_label_unavailable({ unit }, options),
  };
  return (
    <form
      className="space-y-3 rounded-lg border border-border/60 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const lower = parseConditionRangeDraft(String(data.get('gte') ?? ''), 'quantity');
        const upper = parseConditionRangeDraft(String(data.get('lte') ?? ''), 'quantity');
        if (!lower.valid || !upper.valid) return;
        const unit = String(data.get('unit'));
        const next = qualifiers.filter((qualifier) => qualifier.property !== weightProperty);
        if (lower.value !== undefined || upper.value !== undefined)
          next.push({
            property: weightProperty,
            range: {
              unit,
              ...(lower.value !== undefined ? { gte: lower.value } : {}),
              ...(upper.value !== undefined ? { lte: upper.value } : {}),
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
              type="text"
              inputMode="decimal"
              defaultValue={range?.[bound] ?? ''}
            />
          </Field>
        ))}
        <Field>
          <FieldLabel htmlFor={`${id}-unit`}>{m.refinement_unit({}, options)}</FieldLabel>
          <NativeSelect id={`${id}-unit`} name="unit" defaultValue={range?.unit ?? definition.units[0]}>
            {definition.units.map((unit) => (
              <NativeSelectOption key={unit} value={unit}>
                {searchQuantityUnitText(unit, definition.units ?? [], locale, unitMessages)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <Button type="submit" variant="outline">
        {m.search_apply({}, options)}
      </Button>
    </form>
  );
}
