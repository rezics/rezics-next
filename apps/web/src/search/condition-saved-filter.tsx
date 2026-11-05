import { useId, useState } from 'react';
import { Input } from '@rezics/ui/shadcn/input';
import { ConditionPresetInspection, ConditionPresetName } from './condition-preset';
import { presetText, type ConditionPresetCatalogue } from './condition-preset-model';
import type { FilterDocument } from '@rezics/filter';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
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

function messageOptions(locale: string) {
  return { locale: locales.find((value) => value === locale) ?? 'en' };
}

type PickerProps = {
  catalogue: ConditionPresetCatalogue;
  owner: object;
  value?: string;
  locale: string;
  canSelect(id: string): boolean;
  onSelect(id: string): boolean;
};

/** Only ephemeral picker state retires; the authored tree and its occurrence keys remain in the editor. */
export function ConditionSavedFilter(props: PickerProps) {
  const [session, setSession] = useState({
    catalogue: props.catalogue,
    owner: props.owner,
    value: props.value,
    episode: 0,
  });
  let episode = session.episode;
  if (session.catalogue !== props.catalogue || session.owner !== props.owner || session.value !== props.value) {
    episode++;
    setSession({ catalogue: props.catalogue, owner: props.owner, value: props.value, episode });
  }
  return <SavedFilterPicker key={episode} {...props} />;
}

function SavedFilterPicker({ catalogue, value, locale, canSelect, onSelect }: PickerProps) {
  const selectId = useId();
  const adding = value === undefined;
  const [selected, setSelected] = useState(value ?? '');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const window = catalogue.window(query, page);
  const unavailable = selected && !catalogue.choices.some(({ id }) => id === selected);
  const choices =
    selected && !unavailable && !window.choices.some(({ id }) => id === selected)
      ? [{ id: selected, ...catalogue.name(selected) }, ...window.choices]
      : window.choices;
  const options = messageOptions(locale);

  return (
    <div className="min-w-0 space-y-2" data-condition-saved-filter>
      {!adding && (
        <p>
          {m.condition_saved_filter_reference({}, options)}: <ConditionPresetName id={value} catalogue={catalogue} />
        </p>
      )}
      <Field>
        <FieldLabel htmlFor={`${selectId}-query`}>{m.condition_preset_narrow({}, options)}</FieldLabel>
        <Input
          id={`${selectId}-query`}
          value={query}
          maxLength={128}
          disabled={!catalogue.choices.length}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setPage(0);
          }}
        />
      </Field>
      <div className="flex flex-wrap items-end gap-2">
        <Field className="min-w-0 max-w-full">
          <FieldLabel htmlFor={selectId}>
            {adding ? m.condition_saved_filter_add_label({}, options) : m.condition_saved_filter_reference({}, options)}
          </FieldLabel>
          <NativeSelect
            id={selectId}
            value={selected}
            disabled={!catalogue.choices.length}
            className="max-w-full"
            onChange={(event) => setSelected(event.currentTarget.value)}
          >
            <NativeSelectOption value="">{m.condition_saved_filter_choose({}, options)}</NativeSelectOption>
            {unavailable && (
              <NativeSelectOption value={selected} disabled>
                {m.condition_saved_filter_unavailable_reference({ id: selected }, options)}
              </NativeSelectOption>
            )}
            {choices.map(({ id, text, lang }) => (
              <NativeSelectOption key={id} value={id} lang={lang}>
                {presetText(text)}
                {text !== id ? ` (${id})` : ''}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!selected || selected === value || !canSelect(selected)}
          onClick={() => {
            if (selected && canSelect(selected) && onSelect(selected) && adding) setSelected('');
          }}
        >
          {adding ? m.condition_saved_filter_add({}, options) : m.condition_preset_replace({}, options)}
        </Button>
      </div>
      {window.last > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!window.page}
            onClick={() => setPage(window.page - 1)}
          >
            {m.condition_preset_previous({}, options)}
          </Button>
          <span role="status">
            {m.condition_preset_window({ page: window.page + 1, pages: window.last + 1 }, options)}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={window.page === window.last}
            onClick={() => setPage(window.page + 1)}
          >
            {m.condition_preset_next({}, options)}
          </Button>
        </div>
      )}
      {selected && (
        <div key={selected}>
          <ConditionPresetName id={selected} catalogue={catalogue} />
          <ConditionPresetInspection id={selected} catalogue={catalogue} locale={locale} />
        </div>
      )}
      {!catalogue.choices.length && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.condition_saved_filter_unavailable({}, options)}
        </p>
      )}
      {unavailable && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.condition_saved_filter_unavailable_reference({ id: selected }, options)}
        </p>
      )}
    </div>
  );
}
