import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link, useRouter } from '@tanstack/react-router';
import { AuthoringDepartureBoundary, useAuthoringDeparture } from '../threads/authoring-departure';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldDescription, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { m } from '../paraglide/messages.js';
import { readAttempt, saveAttempt, clearAttempt } from './attempt';
import type { Operation, OperationResult } from './transport';
import { verificationCommandTimeout, withVerificationDeadline } from './deadline';

type DecisionDraft = { dirty: () => boolean; leave: () => void };
const DecisionsContext = createContext<{
  register: (draft: DecisionDraft) => () => void;
  refresh: () => void;
  navigate: (action: () => void) => void;
} | null>(null);
const departureMessages = () => ({
  title: m.settings_verification_leave_title(),
  unsaved: m.av_leave_unsaved(),
  pending: m.av_leave_pending(),
  discardTitle: m.settings_verification_leave_title(),
  discardUnsaved: m.av_leave_unsaved(),
  discardPending: m.av_leave_pending(),
  discardAction: m.thread_authoring_leave(),
});

export function VerificationDeparture({ children }: { children: ReactNode }) {
  return <AuthoringDepartureBoundary navigationMessages={departureMessages()}>{children}</AuthoringDepartureBoundary>;
}

/** Queue moves share one decision for every form; saved commands remain available for explicit recovery after leaving. */
export function VerificationDecisions({
  operation,
  authorized,
  children,
}: {
  operation: ReturnType<typeof useOperationAttempt>;
  authorized: boolean;
  children: ReactNode;
}) {
  const drafts = useRef(new Set<DecisionDraft>());
  const [, update] = useState(0);
  const refresh = useCallback(() => update((value) => value + 1), []);
  const register = useCallback(
    (draft: DecisionDraft) => {
      drafts.current.add(draft);
      refresh();
      return () => {
        drafts.current.delete(draft);
        refresh();
      };
    },
    [refresh],
  );
  const transition = useRef<(() => void) | null>(null);
  const leave = () => {
    for (const draft of drafts.current) draft.leave();
    operation.retire();
  };
  const dirty = authorized && (!!operation.attempt || [...drafts.current].some((draft) => draft.dirty()));
  const { requestDiscard } = useAuthoringDeparture(
    dirty,
    authorized && !!operation.attempt,
    `${dirty}:${operation.attempt?.key ?? ''}`,
    () => {
      leave();
      const action = transition.current;
      transition.current = null;
      action?.();
    },
    leave,
    undefined,
    departureMessages(),
  );
  return (
    <DecisionsContext.Provider
      value={{
        register,
        refresh,
        navigate: (action) => {
          if (!dirty) {
            action();
            return;
          }
          transition.current = action;
          requestDiscard();
        },
      }}
    >
      {children}
    </DecisionsContext.Provider>
  );
}

export function useVerificationNavigation() {
  return useContext(DecisionsContext)?.navigate ?? ((action: () => void) => action());
}

/** Native proof links open separately; in-app destinations participate in the page's router decision. */
export function VerificationLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className: string;
}) {
  const router = useRouter({ warn: false });
  return router ? (
    <Link to={href} className={className}>
      {children}
    </Link>
  ) : (
    <a href={href} className={className}>
      {children}
    </a>
  );
}

export type SubmitOperation = (operation: Operation, signal?: AbortSignal) => Promise<OperationResult>;
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

export function useOperationAttempt(
  scope: string | null,
  submit: SubmitOperation,
  refresh: () => void,
  canWrite = true,
  authority = '',
) {
  const [generation, setGeneration] = useState(0);
  const binding = useRef({ scope, submit, authority });
  binding.current = { scope, submit, authority };
  const [attempt, setAttempt] = useState<Operation | null>(null);
  const [command, setCommand] = useState<Operation | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OperationResult | null>(null);
  const refreshCurrentList = useRef(refresh);
  useEffect(() => {
    refreshCurrentList.current = refresh;
  }, [refresh]);
  const current = useRef<{
    scope: string | null;
    submit: SubmitOperation;
    authority: string;
    active: boolean;
    ready: boolean;
    locked: boolean;
    pending: Operation | null;
    controller: AbortController;
  } | null>(null);
  useLayoutEffect(() => {
    const lifetime = {
      scope,
      submit,
      authority,
      active: true,
      ready: false,
      locked: false,
      pending: null as Operation | null,
      controller: new AbortController(),
    };
    current.current = lifetime;
    setAttempt(null);
    setCommand(null);
    setResult(null);
    setBusy(false);
    if (scope) {
      try {
        lifetime.pending = readAttempt(sessionStorage, scope);
        setAttempt(lifetime.pending);
        setCommand(lifetime.pending);
        lifetime.ready = true;
      } catch {
        setResult({ state: 'unavailable' });
      }
    }
    return () => {
      lifetime.active = false;
      lifetime.controller.abort();
    };
  }, [scope, submit, authority, generation]);

  const retire = useCallback(() => {
    if (current.current) {
      current.current.active = false;
      current.current.controller.abort();
    }
    setGeneration((value) => value + 1);
  }, []);

  async function run(operation: Operation) {
    const lifetime = current.current;
    if (!scope || !canWrite || !lifetime?.active || lifetime.scope !== scope || lifetime.locked || !lifetime.ready)
      return;
    // Only the saved command may reconcile an unfinished submission.
    if (
      lifetime.pending &&
      (lifetime.pending.key !== operation.key ||
        lifetime.pending.targetId !== operation.targetId ||
        lifetime.pending.action !== operation.action ||
        lifetime.pending.reason !== operation.reason)
    )
      return;
    lifetime.locked = true;
    setBusy(true);
    // Save before dispatch; a response loss/reload must resume exactly this input and key.
    try {
      saveAttempt(sessionStorage, scope, operation);
    } catch {
      setResult({ state: 'unavailable' });
      lifetime.locked = false;
      setBusy(false);
      return;
    }
    lifetime.pending = operation;
    setAttempt(operation);
    setCommand(operation);
    setResult(null);
    let outcome: OperationResult;
    try {
      outcome = await withVerificationDeadline(
        (signal) => submit(operation, signal),
        lifetime.controller.signal,
        verificationCommandTimeout,
      );
    } catch {
      outcome = { state: 'uncertain' };
    }
    // Navigation may have replaced this viewer/scope while the native command was running.
    if (
      !lifetime.active ||
      current.current !== lifetime ||
      binding.current.scope !== lifetime.scope ||
      binding.current.submit !== lifetime.submit ||
      binding.current.authority !== lifetime.authority
    )
      return;
    if (['accepted', 'conflict', 'invalid'].includes(outcome.state)) {
      try {
        clearAttempt(sessionStorage, scope);
        lifetime.pending = null;
        setAttempt(null);
      } catch {
        /* Retaining the same operation is safer than generating a second key. */
      }
    }
    setResult(outcome);
    lifetime.locked = false;
    setBusy(false);
    refreshCurrentList.current();
  }
  return { attempt, command, busy, result, run, retire };
}

export function OperationFeedback({
  operation,
  disabled = false,
}: {
  operation: ReturnType<typeof useOperationAttempt>;
  disabled?: boolean;
}) {
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
          <Button
            type="button"
            disabled={disabled || operation.busy}
            onClick={() => void operation.run(operation.attempt!)}
          >
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
  draft,
  reconciled = false,
}: {
  actions: Operation['action'][];
  targetId: string;
  disabled: boolean;
  onSubmit: (operation: Operation) => void;
  draft?: Operation | null;
  reconciled?: boolean;
}) {
  const id = useId();
  const initial = draft?.targetId === targetId ? draft : null;
  const [action, setAction] = useState(initial && actions.includes(initial.action) ? initial.action : actions[0]!);
  const [reason, setReason] = useState(initial?.reason ?? '');
  const [confirm, setConfirm] = useState(false);
  const hasReason = action === 'approve' || action === 'reject' || action === 'revoke';
  const decisions = useContext(DecisionsContext);
  const dirty = !reconciled && (confirm || reason.trim() !== '' || action !== actions[0]);
  const latest = useRef({ dirty, leave: () => {} });
  latest.current = {
    dirty,
    leave: () => {
      setReason('');
      setAction(actions[0]!);
      setConfirm(false);
    },
  };
  useLayoutEffect(
    () => decisions?.register({ dirty: () => latest.current.dirty, leave: () => latest.current.leave() }),
    [decisions?.register],
  );
  useLayoutEffect(() => decisions?.refresh(), [decisions?.refresh, dirty]);
  useEffect(() => {
    if (draft?.targetId === targetId && !latest.current.dirty) {
      setAction(draft.action);
      setReason(draft.reason);
    }
  }, [draft?.key, targetId]);
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
