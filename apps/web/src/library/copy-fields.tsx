import { useId } from 'react';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { copyFieldInputIsTooLong, copyTextFieldLimits, type CopyTextField } from './copy-field-input';

export type CopyDraft = {
  status: string;
  location: string;
  source: string;
  acquiredOn: string;
  disposedOn: string;
  note: string;
};

const inputClass =
  'min-h-11 min-w-0 w-full max-w-full rounded-lg border border-border bg-background px-3 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function copyFieldLabel(field: CopyTextField): string {
  switch (field) {
    case 'location':
      return m.library_copy_location();
    case 'source':
      return m.library_copy_source();
    case 'note':
      return m.library_copy_note();
  }
}

function fieldMessage(field: CopyTextField, invalid: boolean): string {
  switch (field) {
    case 'location':
      return invalid ? m.library_copy_field_input_location_too_long() : m.library_copy_field_input_location_limit();
    case 'source':
      return invalid ? m.library_copy_field_input_source_too_long() : m.library_copy_field_input_source_limit();
    case 'note':
      return invalid ? m.library_copy_field_input_note_too_long() : m.library_copy_field_input_note_limit();
  }
}

export function invalidCopyFields(draft: CopyDraft): CopyTextField[] {
  return (['location', 'source', 'note'] as const).filter((field) => copyFieldInputIsTooLong(field, draft[field]));
}

/** Both the inline form and the dialog use the existing Unicode field grammar. */
export function CopyValidationSummary({
  fields,
  prefix,
  onFocusField,
}: {
  fields: CopyTextField[];
  prefix: string;
  onFocusField: (field: CopyTextField) => void;
}) {
  if (!fields.length) return null;
  return (
    <section
      role="alert"
      aria-labelledby={`${prefix}-errors`}
      className="min-w-0 space-y-2 rounded-lg border border-destructive p-4"
    >
      <h3 id={`${prefix}-errors`} className="font-medium">
        {m.library_copy_editor_correct_fields()}
      </h3>
      <ul className="list-inside list-disc">
        {fields.map((field) => (
          <li key={field}>
            <a
              className="inline-flex min-h-11 items-center text-primary underline underline-offset-4"
              href={`#${prefix}-${field}`}
              onClick={(event) => {
                event.preventDefault();
                onFocusField(field);
              }}
            >
              {fieldMessage(field, true)}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CopyTextInput({
  field,
  value,
  prefix,
  showErrors,
  onChange,
}: {
  field: CopyTextField;
  value: string;
  prefix: string;
  showErrors: boolean;
  onChange: (value: string) => void;
}) {
  const id = `${prefix}-${field}`;
  const invalid = showErrors && copyFieldInputIsTooLong(field, value);
  const length = Array.from(value).length;
  const attributes = {
    id,
    name: field,
    value,
    'aria-invalid': invalid || undefined,
    'aria-describedby': `${id}-hint ${id}-count`,
    autoComplete: 'off',
  } as const;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{copyFieldLabel(field)}</FieldLabel>
      {field === 'note' ? (
        <Textarea
          {...attributes}
          className="min-h-36 min-w-0 w-full max-w-full resize-y text-base [overflow-wrap:anywhere]"
          rows={6}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      ) : (
        <input
          {...attributes}
          className={inputClass}
          type="text"
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      )}
      <div className="flex min-w-0 flex-wrap justify-between gap-x-4 gap-y-1 text-sm">
        <p id={`${id}-hint`} className={invalid ? 'text-destructive' : 'text-muted-foreground'}>
          {fieldMessage(field, invalid)}
        </p>
        <p id={`${id}-count`} className="text-muted-foreground tabular-nums">
          {m.library_copy_editor_character_count({ count: String(length), limit: String(copyTextFieldLimits[field]) })}
        </p>
      </div>
    </Field>
  );
}

function CopyDateInput({
  field,
  value,
  prefix,
  onChange,
}: {
  field: 'acquiredOn' | 'disposedOn';
  value: string;
  prefix: string;
  onChange: (value: string) => void;
}) {
  const id = `${prefix}-${field}`;
  return (
    <Field>
      <FieldLabel htmlFor={id}>
        {field === 'acquiredOn' ? m.library_copy_acquired() : m.library_copy_disposed()}
      </FieldLabel>
      <input
        id={id}
        name={field}
        type="date"
        lang={getLocale()}
        className={inputClass}
        value={value}
        aria-describedby={`${prefix}-dates-hint`}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </Field>
  );
}

/** Disclosure never unmounts its fields, including invalid controls and their selection. */
export function CopyOptionalFields({
  draft,
  prefix,
  expanded,
  showErrors,
  onExpandedChange,
  onChange,
}: {
  draft: CopyDraft;
  prefix: string;
  expanded: boolean;
  showErrors: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onChange: <K extends keyof CopyDraft>(field: K, value: CopyDraft[K]) => void;
}) {
  return (
    <section className="min-w-0 space-y-4">
      <button
        type="button"
        className="min-h-11 max-w-full rounded-md py-2 text-left text-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        aria-controls={`${prefix}-optional`}
        aria-expanded={expanded}
        onClick={() => onExpandedChange(!expanded)}
      >
        {expanded ? m.library_copy_less() : m.library_copy_more()}
      </button>
      <div id={`${prefix}-optional`} hidden={!expanded} className="min-w-0 space-y-5">
        <header className="space-y-1">
          <h3 className="font-medium">{m.library_copy_editor_optional_title()}</h3>
          <p className="text-sm text-muted-foreground">{m.library_copy_editor_optional_description()}</p>
        </header>
        <CopyTextInput
          field="location"
          value={draft.location}
          prefix={prefix}
          showErrors={showErrors}
          onChange={(value) => onChange('location', value)}
        />
        <CopyTextInput
          field="source"
          value={draft.source}
          prefix={prefix}
          showErrors={showErrors}
          onChange={(value) => onChange('source', value)}
        />
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <CopyDateInput
            field="acquiredOn"
            value={draft.acquiredOn}
            prefix={prefix}
            onChange={(value) => onChange('acquiredOn', value)}
          />
          <CopyDateInput
            field="disposedOn"
            value={draft.disposedOn}
            prefix={prefix}
            onChange={(value) => onChange('disposedOn', value)}
          />
        </div>
        <p id={`${prefix}-dates-hint`} className="text-sm text-muted-foreground">
          {m.library_copy_editor_dates_hint()}
        </p>
        <CopyTextInput
          field="note"
          value={draft.note}
          prefix={prefix}
          showErrors={showErrors}
          onChange={(value) => onChange('note', value)}
        />
      </div>
    </section>
  );
}

export function CopyChoiceField({
  name,
  label,
  value,
  choices,
  onChange,
}: {
  name: string;
  label: string;
  value: string;
  choices: { id: string; label: string; labelLanguage?: string }[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  const selected = choices.find((choice) => choice.id === value);
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <NativeSelect
        id={id}
        name={name}
        className={`${inputClass} [&_select]:min-h-11 [&_select]:text-base`}
        value={value}
        lang={selected?.labelLanguage}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {choices.map((choice) => (
          <NativeSelectOption key={choice.id} value={choice.id} lang={choice.labelLanguage}>
            {choice.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  );
}
