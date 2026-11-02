import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { useId, useState } from 'react';
import { m } from '../../paraglide/messages.js';

/** Reconcile only the pending choice; authored rows and commands belong to the form. */
export function InitialFieldChoice({
  id,
  groups,
  release,
  occupied,
  locale,
  disabled,
  atLimit = false,
  fieldClassName,
  labelClassName,
  selectClassName,
  buttonClassName,
  add,
}: {
  id?: string;
  groups: { label?: string; properties: string[] }[];
  release: Release;
  occupied: string[];
  locale: string;
  disabled: boolean;
  atLimit?: boolean;
  fieldClassName: string;
  labelClassName: string;
  selectClassName: string;
  buttonClassName: string;
  add: (property: string) => void;
}) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const o = { locale: locale as never };
  const [choice, setChoice] = useState({ property: '', withdrawn: false });
  const offeredGroups = groups.map((group) => ({
    ...group,
    properties: group.properties.filter(
      (property) => release.properties[property]?.multivalued || !occupied.includes(property),
    ),
  }));
  const offered = new Set(offeredGroups.flatMap((group) => group.properties));
  const withdrawn = !!choice.property && !offered.has(choice.property);
  // Clear during reconciliation so a later refresh cannot silently revive the old choice.
  if (withdrawn) setChoice({ property: '', withdrawn: true });
  const property = withdrawn ? '' : choice.property;
  const explanation = withdrawn || choice.withdrawn;
  const options = (properties: string[]) =>
    properties.map((id) => {
      const label = pickText(release.properties[id]!.labels, locale);
      return (
        <NativeSelectOption key={id} value={id} lang={label.lang ?? undefined}>
          {label.text}
        </NativeSelectOption>
      );
    });
  return (
    <>
      <Field className={fieldClassName}>
        <FieldLabel className={labelClassName} htmlFor={selectId}>
          {m.character_add_fact({}, o)}
        </FieldLabel>
        <NativeSelect
          id={selectId}
          className={selectClassName}
          disabled={disabled}
          aria-describedby={explanation ? `${selectId}-withdrawn` : undefined}
          value={property}
          onChange={(event) => setChoice({ property: event.target.value, withdrawn: false })}
        >
          <NativeSelectOption value="">{m.correction_choose({}, o)}</NativeSelectOption>
          {offeredGroups.map(
            (group, index) =>
              group.properties.length > 0 &&
              (group.label ? (
                <optgroup key={index} label={group.label}>
                  {options(group.properties)}
                </optgroup>
              ) : (
                options(group.properties)
              )),
          )}
        </NativeSelect>
        {explanation && (
          <p id={`${selectId}-withdrawn`} role="status" className="text-sm text-muted-foreground">
            {m.initial_field_choice_withdrawn({}, o)}
          </p>
        )}
      </Field>
      <Button
        type="button"
        variant="outline"
        className={buttonClassName}
        disabled={disabled || atLimit || !offered.has(property)}
        onClick={() => {
          if (disabled || atLimit || !offered.has(property)) return;
          add(property);
          setChoice({ property: '', withdrawn: false });
        }}
      >
        {m.correction_add({}, o)}
      </Button>
    </>
  );
}
