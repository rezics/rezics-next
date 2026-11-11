import { useId, useState } from 'react';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { ChoiceSelect } from '@rezics/ui/choice-select';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
/** Presentation state for retained controls and stories; it grants no transport capability. */
export type CopyInventoryOptions = {
  kinds: InventoryFacet;
  statuses: InventoryFacet;
};
type InventoryFacet = {
  state: 'available' | 'unavailable';
  choices: {
    id: string;
    label: string;
    labelLanguage?: string;
    meaning: 'available' | 'unsupported' | 'unavailable';
  }[];
};

function meaning(value: CopyInventoryOptions['kinds']['choices'][number]['meaning']) {
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
  facet: CopyInventoryOptions['kinds'] | undefined;
}) {
  const id = useId();
  const description = useId();
  const [value, setValue] = useState(selected ?? '');
  const choices = facet?.choices ?? [];
  const missing = value && !choices.some((choice) => choice.id === value);
  return (
    <Field className="min-w-0">
      <FieldLabel id={`${id}-label`} htmlFor={id}>
        {label}
      </FieldLabel>
      <ChoiceSelect
        id={id}
        name={value ? name : undefined}
        ariaLabelledBy={`${id}-label`}
        value={value || null}
        ariaDescribedBy={description}
        triggerClassName="min-w-0 max-w-full w-full"
        onValueChange={(next) => setValue(next ?? '')}
        options={[
          { value: null, label: m.library_copy_filter_any() },
          ...(missing ? [{ value, label: `${value} — ${m.library_copy_filter_unavailable()}` }] : []),
          ...choices.map((choice) => ({
            value: choice.id,
            label: `${choice.label} — ${meaning(choice.meaning)}`,
            lang: choice.labelLanguage,
          })),
        ]}
      />
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
  filterOptions: CopyInventoryOptions | undefined;
  current: () => boolean;
}) {
  if (!filterOptions && !kind && !status) return null;
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
