import { useId, useState } from 'react';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { NativeCopyList } from './copies-server';

type FilterOptions = NativeCopyList['filterOptions'];

function meaning(value: FilterOptions['kinds']['choices'][number]['meaning']) {
  switch (value) {
    case 'available':
      return m.library_copy_filter_available();
    case 'unsupported':
      return m.library_copy_filter_unsupported();
    case 'unavailable':
      return m.library_copy_filter_unavailable();
  }
}

function InventoryFilter({
  name,
  label,
  selected,
  facet,
}: {
  name: 'kind' | 'status';
  label: string;
  selected: string | null;
  facet: FilterOptions['kinds'] | undefined;
}) {
  const id = useId();
  const description = useId();
  const [value, setValue] = useState(selected ?? '');
  const choices = facet?.choices ?? [];
  const missing = value && !choices.some((choice) => choice.id === value);
  return (
    <Field className="min-w-0">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <NativeSelect
        id={id}
        name={value ? name : undefined}
        value={value}
        aria-describedby={description}
        className="min-w-0 max-w-full w-full [&_select]:min-h-11 [&_select]:w-full"
        onChange={(event) => setValue(event.currentTarget.value)}
      >
        <NativeSelectOption value="">{m.library_copy_filter_any()}</NativeSelectOption>
        {missing ? (
          <NativeSelectOption value={value}>
            {value} — {m.library_copy_filter_unavailable()}
          </NativeSelectOption>
        ) : null}
        {choices.map((choice) => (
          <NativeSelectOption key={choice.id} value={choice.id} lang={choice.labelLanguage}>
            {choice.label} — {meaning(choice.meaning)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <p id={description} className="text-sm text-muted-foreground">
        {facet?.state === 'available'
          ? choices.length
            ? m.library_copy_filter_history()
            : m.library_copy_filter_none()
          : m.library_copy_filter_options_unavailable()}
      </p>
    </Field>
  );
}

/** Native historical inventory choices are independent of the active create/edit profile. */
export function CopyInventoryFilters({
  subjectId,
  kind,
  status,
  filterOptions,
  current,
}: {
  subjectId: string | null;
  kind: string | null;
  status: string | null;
  filterOptions: FilterOptions | undefined;
  current: () => boolean;
}) {
  return (
    <form
      method="get"
      action={`/${encodeURIComponent(getLocale())}/library/copies`}
      aria-label={m.library_copy_filters_active()}
      className="grid min-w-0 gap-4 sm:grid-cols-2"
      onSubmit={(event) => {
        if (!current()) event.preventDefault();
      }}
    >
      {subjectId ? <input type="hidden" name="subjectId" value={subjectId} /> : null}
      <InventoryFilter
        key={`kind:${kind}`}
        name="kind"
        label={m.library_copy_kind()}
        selected={kind}
        facet={filterOptions?.kinds}
      />
      <InventoryFilter
        key={`status:${status}`}
        name="status"
        label={m.library_copy_status()}
        selected={status}
        facet={filterOptions?.statuses}
      />
      <button type="submit" className="min-h-11 min-w-11 rounded-lg border border-border px-4 py-2 sm:col-span-2">
        {m.library_copy_filter_apply()}
      </button>
    </form>
  );
}
