import { useEffect, useId, useRef, useState } from 'react';
import type { FilterRange } from '@rezics/filter';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';

/** No equivalence between numeric projection and precision overlap is assumed. */
export function ConditionRangeMode({
  range,
  locale,
  onChange,
}: {
  range: FilterRange;
  locale: string;
  onChange(range: FilterRange): void;
}) {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const mode = range.type === 'time' ? 'calendar' : 'year';
  const [pending, setPending] = useState<'calendar' | 'year'>();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (pending && !dialog.current?.open) dialog.current?.showModal();
  }, [pending]);
  const replace = (next: 'calendar' | 'year') => onChange(next === 'calendar' ? { type: 'time' } : {});
  const cancel = () => {
    setPending(undefined);
    select.current?.focus();
  };
  return (
    <>
      <Field>
        <FieldLabel htmlFor={id}>{m.condition_range_mode({}, options)}</FieldLabel>
        <NativeSelect
          ref={select}
          id={id}
          value={mode}
          onChange={(event) => {
            const next = event.currentTarget.value === 'calendar' ? 'calendar' : 'year';
            if (next === mode) return;
            // Confirm even empty operands: unfinished raw drafts may still belong to this occurrence.
            setPending(next);
          }}
        >
          <NativeSelectOption value="year">{m.condition_range_year_mode({}, options)}</NativeSelectOption>
          <NativeSelectOption value="calendar">{m.condition_range_calendar_mode({}, options)}</NativeSelectOption>
        </NativeSelect>
      </Field>
      {pending && (
        <dialog
          ref={dialog}
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-help`}
          className="max-w-lg rounded-lg border border-border bg-background p-4 text-foreground shadow-xl backdrop:bg-black/50"
          onCancel={(event) => {
            event.preventDefault();
            cancel();
          }}
        >
          <h2 id={`${id}-title`} className="font-semibold">
            {m.condition_range_replace_title({}, options)}
          </h2>
          <p id={`${id}-help`} className="mt-2 text-sm">
            {m.condition_range_replace_help({}, options)}
          </p>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" autoFocus onClick={cancel}>
              {m.condition_property_change_cancel({}, options)}
            </Button>
            <Button
              type="button"
              onClick={() => {
                const next = pending;
                setPending(undefined);
                replace(next);
              }}
            >
              {m.condition_range_replace_confirm({}, options)}
            </Button>
          </div>
        </dialog>
      )}
    </>
  );
}
