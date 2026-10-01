'use client';

import { Checkbox } from '@rezics/ui/checkbox';
import { Field, FieldContent, FieldError, FieldHelper, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { Textarea } from '@rezics/ui/textarea';
import { type RefObject, useEffect } from 'react';

/** One labelled line or paragraph. A problem is said on the field itself, which Ark ties to the control. */
export function Line({ label, value, onChange, help, error, multiline = false, type = 'text', maxLength, lang, dir }: {
  label: string; value: string; onChange: (value: string) => void; help?: string; error?: string | null;
  multiline?: boolean; type?: 'text' | 'email' | 'tel'; maxLength?: number; lang?: string; dir?: 'ltr' | 'rtl';
}) {
  return <Field invalid={Boolean(error)}>
    <FieldLabel>{label}</FieldLabel>
    {multiline
      ? <Textarea value={value} rows={3} maxLength={maxLength} lang={lang} dir={dir}
        onChange={event => onChange(event.currentTarget.value)} />
      : <Input type={type} value={value} maxLength={maxLength} lang={lang} dir={dir}
        onChange={event => onChange(event.currentTarget.value)} />}
    {error ? <FieldError>{error}</FieldError> : help ? <FieldHelper>{help}</FieldHelper> : null}
  </Field>;
}

/** A statement the person must tick, with its own error when they have not. */
export function Confirm({ checked, onChange, error, children }: { checked: boolean; onChange: (checked: boolean) => void;
  error?: string | null; children: string }) {
  return <Field orientation="horizontal" invalid={Boolean(error)}>
    <Checkbox checked={checked} onCheckedChange={details => onChange(details.checked === true)} />
    <FieldContent>
      <FieldLabel>{children}</FieldLabel>
      {error ? <FieldError>{error}</FieldError> : null}
    </FieldContent>
  </Field>;
}

/** The first control a failed submit left invalid, in reading order. */
export function focusFirstProblem(root: HTMLElement | null) {
  root?.querySelector<HTMLElement>('[data-scope="field"][data-invalid] :is(input, textarea)')?.focus();
}

/** Moves focus to the first invalid control each time `attempt` changes to a failed one. */
export function useFocusProblem(root: RefObject<HTMLElement | null>, attempt: number) {
  useEffect(() => { if (attempt > 0) focusFirstProblem(root.current); }, [root, attempt]);
}
