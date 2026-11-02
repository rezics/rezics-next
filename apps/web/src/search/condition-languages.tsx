import { useId, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';

export const MAX_LANGUAGE_PREFERENCES = 8;

export type LanguagePreferenceAction =
  | { type: 'add'; tag: string }
  | { type: 'remove'; index: number }
  | { type: 'move'; index: number; offset: -1 | 1 }
  | { type: 'clear' };

export function updateLanguagePreferences(current: readonly string[], action: LanguagePreferenceAction): string[] {
  if (action.type === 'clear') return [];
  if (action.type === 'add') {
    if (
      current.length >= MAX_LANGUAGE_PREFERENCES ||
      !locales.includes(action.tag) ||
      current.some((tag) => tag.toLowerCase() === action.tag.toLowerCase())
    )
      return [...current];
    return [...current, action.tag];
  }
  if (action.type === 'remove') {
    if (action.index < 0 || action.index >= current.length) return [...current];
    return current.filter((_tag, index) => index !== action.index);
  }

  const target = action.index + action.offset;
  if (action.index < 0 || action.index >= current.length || target < 0 || target >= current.length)
    return [...current];
  const updated = [...current];
  [updated[action.index], updated[target]] = [updated[target]!, updated[action.index]!];
  return updated;
}

function displayLanguage(tag: string, displayNames: Intl.DisplayNames) {
  try {
    return displayNames.of(tag) ?? tag;
  } catch {
    return tag;
  }
}

export function ConditionLanguages({
  languages,
  locale,
  disabled = false,
  onChange,
}: {
  languages: readonly string[];
  locale: string;
  disabled?: boolean;
  onChange(languages: string[]): void;
}) {
  const selectId = useId();
  const [selected, setSelected] = useState('');
  const atLimit = languages.length >= MAX_LANGUAGE_PREFERENCES;
  const available = locales.filter((tag) => !languages.some((language) => language.toLowerCase() === tag.toLowerCase()));
  const displayNames = new Intl.DisplayNames([locale], { type: 'language' });

  const update = (action: LanguagePreferenceAction) => onChange(updateLanguagePreferences(languages, action));

  return (
    <Field>
      <FieldLabel htmlFor={selectId}>{m.condition_languages_label()}</FieldLabel>
      <div className="flex flex-wrap items-end gap-2">
        <NativeSelect
          id={selectId}
          value={selected}
          disabled={disabled || atLimit || available.length === 0}
          onChange={(event) => setSelected(event.currentTarget.value)}
        >
          <NativeSelectOption value="">{m.condition_languages_choose()}</NativeSelectOption>
          {available.map((tag) => (
            <NativeSelectOption key={tag} value={tag}>
              {displayLanguage(tag, displayNames)} ({tag})
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || atLimit || !selected}
          onClick={() => {
            update({ type: 'add', tag: selected });
            setSelected('');
          }}
        >
          {m.condition_languages_add()}
        </Button>
      </div>
      {languages.length > 0 && (
        <ol aria-label={m.condition_languages_label()} className="mt-2 space-y-2">
          {languages.map((tag, index) => (
            <li key={`${tag}:${index}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 p-2">
              <div className="flex min-w-0 flex-col">
                <span>{displayLanguage(tag, displayNames)}</span>
                <code className="break-all text-xs text-muted-foreground" dir="ltr">
                  {tag}
                </code>
              </div>
              <div className="flex flex-wrap gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={m.condition_languages_move_up({ language: tag })}
                  disabled={disabled || index === 0}
                  onClick={() => update({ type: 'move', index, offset: -1 })}
                >
                  {m.condition_languages_up()}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={m.condition_languages_move_down({ language: tag })}
                  disabled={disabled || index === languages.length - 1}
                  onClick={() => update({ type: 'move', index, offset: 1 })}
                >
                  {m.condition_languages_down()}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={m.condition_languages_remove({ language: tag })}
                  disabled={disabled}
                  onClick={() => update({ type: 'remove', index })}
                >
                  {m.condition_languages_remove_action()}
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}
      {atLimit && <p className="mt-2 text-sm text-muted-foreground">{m.condition_languages_limit()}</p>}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mt-2"
        disabled={disabled || languages.length === 0}
        onClick={() => update({ type: 'clear' })}
      >
        {m.condition_languages_use_default()}
      </Button>
    </Field>
  );
}
