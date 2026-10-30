import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldDescription, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { m } from '../paraglide/messages.js';
import { readAttempt, saveAttempt, clearAttempt } from './attempt';
import type { Operation, OperationResult } from './transport';

export type SubmitOperation = (operation: Operation) => Promise<OperationResult>;
export function actionLabel(action: Operation['action']) {
  return {
    approve: m.av_approve,
    reject: m.av_reject,
    release: m.av_release,
    revoke: m.av_revoke,
    withdraw: m.av_withdraw,
  }[action]();
}
export function resultLabel(result: OperationResult) {
  if (result.state === 'accepted') {
    if (result.reversal) return m.av_reversal_accepted();
    if (result.request?.state === 'approving') return m.av_approval_accepted();
    if (result.request?.state === 'rejected') return m.av_rejected();
    if (result.request?.state === 'withdrawn') return m.av_withdrawn();
    return m.av_recorded();
  }
  return {
    denied: m.av_denied,
    preparing: m.av_preparing,
    unavailable: m.av_unavailable,
    uncertain: m.av_uncertain,
    conflict: m.av_conflict,
    invalid: m.av_invalid,
  }[result.state]();
}

export function useOperationAttempt(scope: string | null, submit: SubmitOperation, refresh: () => void) {
  const [attempt, setAttempt] = useState<Operation | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OperationResult | null>(null);
  const locked = useRef(false);
  const storageReady = useRef(false);
  useEffect(() => {
    setAttempt(null);
    setResult(null);
    storageReady.current = false;
    if (!scope) return;
    try {
      setAttempt(readAttempt(sessionStorage, scope));
      storageReady.current = true;
    } catch {
      setResult({ state: 'unavailable' });
    }
  }, [scope]);

  async function run(operation: Operation) {
    if (!scope || locked.current || !storageReady.current) return;
    locked.current = true;
    setBusy(true);
    // Save before dispatch; a response loss/reload must resume exactly this input and key.
    try {
      saveAttempt(sessionStorage, scope, operation);
    } catch {
      setResult({ state: 'unavailable' });
      locked.current = false;
      setBusy(false);
      return;
    }
    setAttempt(operation);
    setResult(null);
    let outcome: OperationResult;
    try {
      outcome = await submit(operation);
    } catch {
      outcome = { state: 'uncertain' };
    }
    if (['accepted', 'conflict', 'invalid'].includes(outcome.state)) {
      try {
        clearAttempt(sessionStorage, scope);
        setAttempt(null);
      } catch {
        /* Retaining the same operation is safer than generating a second key. */
      }
    }
    setResult(outcome);
    locked.current = false;
    setBusy(false);
    refresh();
  }
  return { attempt, busy, result, run };
}

export function OperationFeedback({ operation }: { operation: ReturnType<typeof useOperationAttempt> }) {
  const feedback = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (operation.result) feedback.current?.focus();
  }, [operation.result]);
  return (
    <div ref={feedback} tabIndex={-1} className="space-y-3 rounded-xl border border-border p-4 empty:hidden">
      {operation.result && (
        <p role={operation.result.state === 'accepted' ? 'status' : 'alert'}>{resultLabel(operation.result)}</p>
      )}
      {operation.attempt && (
        <>
          <p>{m.av_resume_help()}</p>
          <Button type="button" disabled={operation.busy} onClick={() => void operation.run(operation.attempt!)}>
            {m.av_resume({ action: actionLabel(operation.attempt.action) })}
          </Button>
        </>
      )}
    </div>
  );
}

export function OperationForm({
  actions,
  targetId,
  disabled,
  onSubmit,
}: {
  actions: Operation['action'][];
  targetId: string;
  disabled: boolean;
  onSubmit: (operation: Operation) => void;
}) {
  const id = useId();
  const [action, setAction] = useState(actions[0]!);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const hasReason = action === 'approve' || action === 'reject' || action === 'revoke';
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!confirm) {
          setConfirm(true);
          return;
        }
        if (disabled) return;
        onSubmit({ action, targetId, reason: hasReason ? reason.trim() : '', key: crypto.randomUUID() });
        setConfirm(false);
      }}
    >
      <Field>
        <FieldLabel htmlFor={`${id}-action`}>{m.av_decision()}</FieldLabel>
        <NativeSelect
          id={`${id}-action`}
          value={action}
          disabled={disabled || confirm}
          onChange={(event) => setAction(event.target.value as Operation['action'])}
        >
          {actions.map((value) => (
            <NativeSelectOption key={value} value={value}>
              {actionLabel(value)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      {hasReason && (
        <Field>
          <FieldLabel htmlFor={`${id}-reason`}>{m.av_reason()}</FieldLabel>
          <Textarea
            id={`${id}-reason`}
            value={reason}
            maxLength={500}
            required
            disabled={disabled || confirm}
            onChange={(event) => setReason(event.target.value)}
          />
          <FieldDescription>{m.av_reason_help()}</FieldDescription>
        </Field>
      )}
      {confirm && <p role="status">{m.av_confirm({ action: actionLabel(action) })}</p>}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={disabled || (hasReason && !reason.trim())}
          variant={['release', 'revoke', 'reject'].includes(action) ? 'destructive' : 'default'}
        >
          {confirm ? m.av_confirm_button() : actionLabel(action)}
        </Button>
        {confirm && (
          <Button type="button" variant="outline" disabled={disabled} onClick={() => setConfirm(false)}>
            {m.av_cancel()}
          </Button>
        )}
      </div>
    </form>
  );
}
