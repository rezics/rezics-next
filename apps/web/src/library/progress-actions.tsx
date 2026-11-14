import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import { useId } from 'react';
import { m } from '../paraglide/messages.js';
import type { ProgressRecordInput } from './progress-reads';

/** The same labelled control is used for discovery and native recording choices. */
export function ProgressChoice({
  id: controlId,
  name,
  label,
  value,
  options,
  onValueChange,
  disabled = false,
}: {
  id?: string;
  name?: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
}) {
  const generatedId = useId();
  const id = controlId ?? generatedId;
  return (
    <Field className="min-w-0 gap-2">
      <FieldLabel id={`${id}-label`} htmlFor={id} className="text-sm font-medium">
        {label}
      </FieldLabel>
      <Select<string, false>
        name={name}
        items={options}
        value={value}
        disabled={disabled}
        onValueChange={(next) => onValueChange(next ?? '')}
      >
        <SelectTrigger id={id} aria-labelledby={`${id}-label`} className="min-h-11 w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

/** Show the captured request, including exact sparse keys, before sending or retrying it. */
export function ProgressCorrectionReview({
  data,
  busy,
  conflict,
  onConfirm,
  onCancel,
  onReload,
}: {
  data: ProgressRecordInput;
  busy: boolean;
  conflict: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onReload: () => void;
}) {
  return (
    <section
      className="space-y-4 rounded-xl border border-border bg-muted/30 p-4"
      aria-label={m.library_progress_review()}
    >
      <h2 className="text-xl font-semibold">{m.library_progress_review()}</h2>
      {data.measureId !== undefined ? (
        <p className="break-all">
          {m.library_progress_unit()}: {data.measureId}
        </p>
      ) : null}
      {data.clear ? (
        <p>{data.measureId === undefined ? m.library_progress_clear_scope() : m.library_progress_measure_clear()}</p>
      ) : (
        <dl className="space-y-3">
          {data.amount !== undefined ? (
            <div>
              <dt>{m.library_progress_amount()}</dt>
              <dd className="break-all">{data.amount}</dd>
            </div>
          ) : null}
          {data.locator !== undefined ? (
            <div>
              <dt>{m.library_progress_locator()}</dt>
              <dd className="whitespace-pre-wrap break-all">{data.locator}</dd>
            </div>
          ) : null}
          {data.position !== undefined ? (
            <div>
              <dt>{m.library_progress_position()}</dt>
              <dd>{data.position}</dd>
            </div>
          ) : null}
          {(
            [
              ['add', m.library_progress_add_units()],
              ['remove', m.library_progress_remove_units()],
            ] as const
          ).map(([field, label]) =>
            data[field] ? (
              <div key={field}>
                <dt>{label}</dt>
                <dd>
                  <ul>
                    {data[field].map((id) => (
                      <li key={id} className="break-all">
                        {id}
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            ) : null,
          )}
        </dl>
      )}
      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        <Button disabled={busy} onClick={onConfirm}>
          {data.clear ? m.library_progress_confirm_clear() : m.library_progress_confirm_correction()}
        </Button>
        <Button variant="outline" disabled={busy} onClick={onCancel}>
          {m.library_progress_cancel()}
        </Button>
        {conflict ? (
          <Button variant="outline" disabled={busy} onClick={onReload}>
            {m.library_progress_review_latest()}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
