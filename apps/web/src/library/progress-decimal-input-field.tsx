import { useId, type ComponentProps } from 'react';
import { Input } from '@rezics/ui/shadcn/input';
import { m } from '../paraglide/messages.js';
import { progressDecimalPlaces, type ProgressDecimalRules, type ProgressInputIssue } from './progress-decimal-input';

export function ProgressInputError({
  id,
  issue,
  rules = {},
}: {
  id: string;
  issue: ProgressInputIssue | null;
  rules?: ProgressDecimalRules;
}) {
  if (!issue) return null;
  const message = {
    required: () => m.library_progress_decimal_input_required(),
    syntax: () => m.library_progress_decimal_input_syntax(),
    min: () => m.library_progress_decimal_input_min({ value: rules.min! }),
    max: () => m.library_progress_decimal_input_max({ value: rules.max! }),
    precision: () => m.library_progress_decimal_input_precision({ places: progressDecimalPlaces(rules.step!) }),
    locator: () => m.library_progress_decimal_input_locator(),
  }[issue]();
  return <p id={id} role="alert" className="text-sm text-destructive">{message}</p>;
}

/** Text keeps invalid drafts and exact decimals intact; the form validates native rules before capture. */
export function ProgressDecimalInput({
  issue,
  rules = {},
  ...props
}: Omit<ComponentProps<typeof Input>, 'type' | 'inputMode'> & {
  issue: ProgressInputIssue | null;
  rules?: ProgressDecimalRules;
}) {
  const errorId = useId();
  return (
    <>
      <Input
        {...props}
        min={rules.min}
        max={rules.max}
        step={rules.step}
        type="text"
        inputMode="decimal"
        aria-invalid={issue ? true : undefined}
        aria-describedby={[props['aria-describedby'], issue ? errorId : null].filter(Boolean).join(' ') || undefined}
      />
      <ProgressInputError id={errorId} issue={issue} rules={rules} />
    </>
  );
}
