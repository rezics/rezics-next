import { useLayoutEffect, useRef, useState } from 'react';
import { Input } from '@rezics/ui/shadcn/input';
import { m } from '../paraglide/messages.js';

export type ConditionRangeDatatype = 'quantity' | 'time';
type RangeDraft = { valid: true; value: number | undefined } | { valid: false };
export type ConditionRangeDraft = { current?: { raw: string; value: number | undefined } };

const numericGrammar = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function parseConditionRangeDraft(raw: string, datatype: ConditionRangeDatatype): RangeDraft {
  if (raw === '') return { valid: true, value: undefined };
  if (!numericGrammar.test(raw)) return { valid: false };
  const value = Number(raw);
  return Number.isFinite(value) && (datatype !== 'time' || Number.isSafeInteger(value))
    ? { valid: true, value }
    : { valid: false };
}

export function applyConditionRangeDraft(
  raw: string,
  datatype: ConditionRangeDatatype,
  onValue: (value: number | undefined) => void,
  setValidity: (message: string) => void,
  errorMessage: string,
): RangeDraft {
  const parsed = parseConditionRangeDraft(raw, datatype);
  setValidity(parsed.valid ? '' : errorMessage);
  if (parsed.valid) onValue(parsed.value);
  return parsed;
}

export function ConditionRangeInput({
  value,
  draft,
  datatype,
  label,
  onValue,
  id,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
}: {
  value: number | undefined;
  draft: ConditionRangeDraft;
  datatype: ConditionRangeDatatype;
  label: string;
  onValue(value: number | undefined): void;
  id: string;
  'aria-invalid': boolean;
  'aria-describedby'?: string;
}) {
  const [state, setState] = useState(draft.current ?? { raw: value?.toString() ?? '', value });
  const { raw, value: previous } = state;
  const setDraft = (next: typeof state) => {
    draft.current = next;
    setState(next);
  };
  const input = useRef<HTMLInputElement>(null);
  if (!Object.is(previous, value)) {
    setDraft({ raw: value?.toString() ?? '', value });
  }

  const error = parseConditionRangeDraft(raw, datatype).valid
    ? undefined
    : m.search_reader_condition_format({ field: label });
  const errorId = `${id}-draft-error`;
  useLayoutEffect(() => input.current?.setCustomValidity(error ?? ''), [error]);

  return (
    <>
      <Input
        ref={input}
        {...{ id }}
        type="text"
        inputMode="decimal"
        value={raw}
        aria-invalid={ariaInvalid || error !== undefined}
        aria-describedby={[ariaDescribedBy, error ? errorId : undefined].filter(Boolean).join(' ') || undefined}
        onChange={(event) => {
          const text = event.currentTarget.value;
          const next = applyConditionRangeDraft(
            text,
            datatype,
            onValue,
            (message) => event.currentTarget.setCustomValidity(message),
            m.search_reader_condition_format({ field: label }),
          );
          setDraft({ raw: text, value: next.valid ? next.value : value });
        }}
      />
      {error && (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  );
}
