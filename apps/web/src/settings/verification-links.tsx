import { useEffect, useRef } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { m } from '../paraglide/messages.js';
import type { VerificationIssue } from './verification-validation';

export type VerificationLinkRow = { key: number; label: string; url: string };

export function verificationIssueMessage(issue: VerificationIssue): string {
  const messages = {
    'subject-required': m.settings_verification_subject_required,
    'statement-required': m.settings_verification_statement_required,
    'statement-limit': m.settings_verification_statement_limit,
    'links-limit': m.settings_verification_links_limit,
    'label-required': m.settings_verification_label_required,
    'label-limit': m.settings_verification_label_limit,
    'url-required': m.settings_verification_url_required,
    'url-limit': m.settings_verification_url_limit,
    'url-https': m.settings_verification_url_https,
  };
  return messages[issue.code]();
}

/** Presentation keys and focus stay local; only label and URL enter the native draft. */
export function VerificationLinks({
  id,
  rows,
  onChange,
  errors,
}: {
  id: string;
  rows: VerificationLinkRow[];
  onChange: (rows: VerificationLinkRow[]) => void;
  errors: ReadonlyMap<string, string>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const nextKey = useRef(Math.max(-1, ...rows.map((row) => row.key)) + 1);
  const focus = useRef<number | 'add' | null>(null);
  useEffect(() => {
    if (focus.current === null) return;
    const target = focus.current === 'add' ? `${id}-add-link` : `${id}-label-${focus.current}`;
    container.current?.ownerDocument.getElementById(target)?.focus();
    focus.current = null;
  }, [id, rows]);

  return (
    <div ref={container} className="space-y-4">
      <FieldDescription id={`${id}-links-hint`}>{m.settings_verification_links_hint()}</FieldDescription>
      {rows.map((row, index) => (
        <FieldSet key={row.key} className="min-w-0 gap-4 rounded-xl border p-4">
          <FieldLegend variant="label">{m.settings_verification_link_number({ number: index + 1 })}</FieldLegend>
          <div className="grid gap-4 sm:grid-cols-2">
            {(['label', 'url'] as const).map((field) => {
              const fieldId = `${id}-${field}-${row.key}`;
              const error = errors.get(fieldId);
              return (
                <Field key={field} data-invalid={!!error} className="min-w-0">
                  <FieldLabel htmlFor={fieldId}>
                    {field === 'label' ? m.settings_verification_link_label() : m.settings_verification_link_url()}
                  </FieldLabel>
                  <Input
                    id={fieldId}
                    className="min-h-11 min-w-11"
                    inputMode={field === 'url' ? 'url' : 'text'}
                    autoCapitalize={field === 'url' ? 'none' : undefined}
                    spellCheck={field === 'url' ? false : undefined}
                    value={row[field]}
                    aria-invalid={!!error}
                    aria-describedby={`${id}-links-hint${error ? ` ${fieldId}-error` : ''}`}
                    onChange={(event) =>
                      onChange(
                        rows.map((candidate) =>
                          candidate.key === row.key ? { ...candidate, [field]: event.target.value } : candidate,
                        ),
                      )
                    }
                  />
                  {error ? (
                    <FieldDescription id={`${fieldId}-error`} className="text-destructive">
                      {error}
                    </FieldDescription>
                  ) : null}
                </Field>
              );
            })}
          </div>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 min-w-11 self-start"
            onClick={() => {
              focus.current = rows[index + 1]?.key ?? rows[index - 1]?.key ?? 'add';
              onChange(rows.filter((candidate) => candidate.key !== row.key));
            }}
          >
            {m.settings_verification_remove_numbered_link({ number: index + 1 })}
          </Button>
        </FieldSet>
      ))}
      {rows.length < 5 ? (
        <Button
          id={`${id}-add-link`}
          type="button"
          variant="outline"
          className="min-h-11 min-w-11"
          aria-invalid={errors.has(`${id}-add-link`)}
          aria-describedby={`${id}-links-hint${errors.has(`${id}-add-link`) ? ` ${id}-links-error` : ''}`}
          onClick={() => {
            const key = nextKey.current++;
            focus.current = key;
            onChange([...rows, { key, label: '', url: '' }]);
          }}
        >
          {m.settings_verification_add_link()}
        </Button>
      ) : null}
      {errors.has(`${id}-add-link`) ? (
        <FieldDescription id={`${id}-links-error`} className="text-destructive">
          {errors.get(`${id}-add-link`)}
        </FieldDescription>
      ) : null}
    </div>
  );
}
