import { useId } from 'react';
import { m } from '../paraglide/messages.js';
import type { SubjectLabelInputIssue } from './subject-label-input';

const issues: Record<SubjectLabelInputIssue, () => string> = {
  empty: m.library_subject_label_input_empty,
  controls: m.library_subject_label_input_controls,
  surrogates: m.library_subject_label_input_surrogates,
  'too-long': m.library_subject_label_input_too_long,
  transport: m.library_subject_label_input_transport,
};

/** The editor keeps raw text; guidance describes validation of a normalized copy. */
export function SubjectLabelInput({
  value,
  issue,
  onChange,
}: {
  value: string;
  issue: SubjectLabelInputIssue | undefined;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className="space-y-1">
      <label className="grid gap-1 text-sm font-medium">
        {m.library_subject_label_input()}
        <input
          name="name"
          aria-label={m.library_subject_label_name()}
          autoComplete="off"
          value={value}
          aria-invalid={issue ? true : undefined}
          aria-describedby={issue ? `${hintId} ${errorId}` : hintId}
          aria-errormessage={issue ? errorId : undefined}
          onChange={(event) => onChange(event.currentTarget.value)}
          className="h-11 w-full min-w-0 rounded-md border bg-background px-3 text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
        />
      </label>
      <p id={hintId} className="text-sm text-muted-foreground">
        {m.library_subject_label_input_hint()}
      </p>
      {issue ? (
        <p id={errorId} role="status" className="text-sm text-destructive">
          {issues[issue]()}
        </p>
      ) : null}
    </div>
  );
}
