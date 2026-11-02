import { useId, useState } from 'react';
import type { FilterDocument } from '@rezics/filter';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../paraglide/messages.js';
import { editConditionTree, type ConditionTreeEdit, type ConditionTreePath } from './condition-tree-edit';

export type SavedFilterEditMode = 'append' | 'replace';

/** Return only a structurally valid edit that also admits the full resulting tree. */
export function editSavedFilterTree(
  tree: FilterDocument,
  path: ConditionTreePath,
  id: string,
  mode: SavedFilterEditMode,
  admits: (tree: FilterDocument) => boolean,
): FilterDocument | undefined {
  const edit: ConditionTreeEdit =
    mode === 'append' ? { type: 'append', value: { saved: id } } : { type: 'replace', value: { saved: id } };
  const result = editConditionTree(tree, path, edit);
  return result.accepted && result.value && admits(result.value) ? result.value : undefined;
}

/** A released saved-filter picker that never loads private metadata or rewrites the authored reference. */
export function ConditionSavedFilter({
  filters,
  value,
  canSelect,
  onSelect,
}: {
  filters: readonly string[];
  value?: string;
  canSelect(id: string): boolean;
  onSelect(id: string): boolean;
}) {
  const selectId = useId();
  const adding = value === undefined;
  const [selected, setSelected] = useState('');
  const unavailable = !adding && !filters.includes(value);
  const current = adding ? selected : value;

  return (
    <div className="flex flex-wrap items-end gap-2" data-condition-saved-filter>
      <Field>
        <FieldLabel htmlFor={selectId}>
          {adding ? m.condition_saved_filter_add_label() : m.condition_saved_filter_reference()}
        </FieldLabel>
        <NativeSelect
          id={selectId}
          value={current}
          disabled={adding && filters.length === 0}
          onChange={(event) => {
            const next = event.currentTarget.value;
            if (adding) setSelected(next);
            else if (next && next !== value && canSelect(next)) onSelect(next);
          }}
        >
          {adding && <NativeSelectOption value="">{m.condition_saved_filter_choose()}</NativeSelectOption>}
          {unavailable && (
            <NativeSelectOption value={value} disabled>
              {m.condition_saved_filter_unavailable_reference({ id: value })}
            </NativeSelectOption>
          )}
          {filters.map((id) => (
            <NativeSelectOption key={id} value={id} disabled={id !== value && !canSelect(id)}>
              {id}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      {adding && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!selected || !canSelect(selected)}
          onClick={() => {
            if (selected && canSelect(selected) && onSelect(selected)) setSelected('');
          }}
        >
          {m.condition_saved_filter_add()}
        </Button>
      )}
      {adding && filters.length === 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.condition_saved_filter_unavailable()}
        </p>
      )}
      {unavailable && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.condition_saved_filter_unavailable_reference({ id: value })}
        </p>
      )}
    </div>
  );
}
