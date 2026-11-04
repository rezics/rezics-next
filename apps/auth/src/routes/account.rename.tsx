import { flushSync } from 'react-dom';
import { createFileRoute, useBlocker, useRouter } from '@tanstack/react-router';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type MutableRefObject,
} from 'react';
import { Field, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@rezics/ui/shadcn/alert-dialog';
import { AuthButton as Button } from '../button';
import { AuthPage } from '../frame';
import { ErrorAlert } from '../alert';
import { m } from '../paraglide/messages.js';
import { normalizeSignupHandle } from '../signup';
import {
  clearRenameContinuation,
  createRenameAttempt,
  nativeRenameSource,
  readRenameContinuation,
  saveRenameContinuation,
  sameRenameContinuation,
  type RenameAttempt,
  type RenameContinuation,
  type RenameRead,
  type RenameSource,
  type RenameTarget,
} from '../account-rename';
import { recoverRenameAttempt, type RenameHistory } from '../rename-recovery';
import { RenameRecoveryNotice } from '../rename-recovery-view';

export const Route = createFileRoute('/account/rename')({
  head: () => ({ meta: [{ title: `${m.auth_rename_heading()} · REZICS` }] }),
  component: RenameAccountPage,
});

export function RenameAccountPage({ source = nativeRenameSource }: { source?: RenameSource } = {}) {
  const [review, setReview] = useState({ source, generation: 0 });
  const router = useRouter({ warn: false });
  const history = useRef<RenameHistory>('none');
  // A different native source starts a fresh review, including its busy gate and draft.
  if (review.source !== source) setReview({ source, generation: review.generation + 1 });
  useEffect(() => {
    const resume = (event: PageTransitionEvent) => {
      // The old document's pending work lost ownership at pagehide, even if the
      // browser later restores this page from its back/forward cache.
      if (event.persisted) setReview((previous) => ({ ...previous, generation: previous.generation + 1 }));
    };
    window.addEventListener('pageshow', resume);
    return () => window.removeEventListener('pageshow', resume);
  }, []);
  return router ? (
    <RoutedRenameReview key={review.generation} source={source} history={history} />
  ) : (
    <RenameReview key={review.generation} source={source} history={history} />
  );
}

type DepartureState = { protected: boolean; allow: boolean };
type DepartureBlocker =
  | { status: 'idle'; proceed: undefined; reset: undefined }
  | { status: 'blocked'; proceed: () => void; reset: () => void };

function RoutedRenameReview({ source, history }: { source: RenameSource; history: MutableRefObject<RenameHistory> }) {
  const departure = useRef<DepartureState>({ protected: false, allow: false });
  const blocker = useBlocker({
    shouldBlockFn: () => departure.current.protected && !departure.current.allow,
    enableBeforeUnload: () => departure.current.protected && !departure.current.allow,
    withResolver: true,
  }) as DepartureBlocker;
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;
  const revoke = useCallback(() => {
    departure.current.protected = false;
    departure.current.allow = false;
    if (blockerRef.current.status === 'blocked') blockerRef.current.proceed();
  }, []);
  useLayoutEffect(
    () => () => {
      if (blockerRef.current.status === 'blocked') blockerRef.current.proceed();
    },
    [],
  );
  return <RenameReview source={source} history={history} departure={departure} blocker={blocker} revoke={revoke} />;
}

function RenameReview({
  source,
  history,
  departure,
  blocker,
  revoke,
}: {
  source: RenameSource;
  history: MutableRefObject<RenameHistory>;
  departure?: MutableRefObject<DepartureState>;
  blocker?: DepartureBlocker;
  revoke?: () => void;
}) {
  const [outcome, setOutcome] = useState<RenameHistory>(history.current);
  function remember(value: RenameHistory) {
    history.current = value;
    setOutcome(value);
  }
  const [current, setCurrent] = useState<RenameRead | null>(null);
  const [handle, setHandle] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [returned, setReturned] = useState(false);
  const [managementReturned, setManagementReturned] = useState(false);
  const [pending, setPending] = useState(false);
  const [locked, setLocked] = useState(false);
  const [message, setMessage] = useState('');
  const [inputError, setInputError] = useState('');
  const [renamed, setRenamed] = useState('');
  const attempt = useRef<RenameAttempt | null>(null);
  const busy = useRef(false);
  const alert = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const departureDialog = useRef<HTMLDivElement>(null);
  const focusAfterStay = useRef(false);
  const owner = useRef<(() => boolean) | null>(null);
  const retire = useRef<() => void>(() => {});
  const currentTarget = useRef<RenameTarget | null>(null);
  const reads = useRef<AbortController | null>(null);
  const reviewFocus = useRef<HTMLDivElement>(null);
  const focusAfterRead = useRef(false);

  useLayoutEffect(() => {
    let active = true;
    const isCurrent = () => active;
    owner.current = isCurrent;
    busy.current = false;
    const saved = readRenameContinuation();
    if (saved?.submitted) {
      attempt.current = saved;
      remember('unknown');
    } else setOutcome(history.current);
    const retireReview = () => {
      if (attempt.current?.submitted) history.current = 'unknown';
      active = false;
      reads.current?.abort();
      attempt.current = null;
      currentTarget.current = null;
    };
    const pagehide = () => {
      const selected = attempt.current;
      const submitted = selected?.submitted;
      retireReview();
      // Clear the cached DOM before it can be restored, as well as retiring callbacks.
      flushSync(() => {
        setOutcome(history.current);
        setCurrent(null);
        setHandle('');
        setConfirmed(false);
        setRenamed('');
        setMessage('');
        setInputError('');
        setReturned(false);
        setManagementReturned(false);
        setPending(false);
        setLocked(false);
      });
      if (!submitted && !readRenameContinuation()?.submitted && !departure?.current.allow) clearRenameContinuation();
    };
    retire.current = retireReview;
    window.addEventListener('pagehide', pagehide);
    return () => {
      retireReview();
      retire.current = () => {};
      window.removeEventListener('pagehide', pagehide);
    };
  }, [departure]);

  const receiveCurrent = useCallback(
    (result: RenameRead, expected: RenameContinuation | null) => {
      const previous = currentTarget.current;
      const stored = readRenameContinuation();
      const saved = stored && expected && sameRenameContinuation(stored, expected) ? stored : null;
      const live =
        !stored || (attempt.current && sameRenameContinuation(stored, attempt.current)) ? attempt.current : null;
      if (live?.submitted || stored?.submitted) remember('unknown');
      const recovered =
        history.current === 'unknown' && saved && !saved.submitted
          ? null
          : recoverRenameAttempt(result, saved, live, previous);
      // Later refusal or a replacement viewer cannot settle an earlier unknown send.
      if (saved && !saved.submitted && !recovered && history.current !== 'unknown') clearRenameContinuation(saved);
      attempt.current = recovered;
      currentTarget.current = result.kind === 'ready' ? result.target : null;
      setHandle(recovered?.operation.handle ?? '');
      setLocked(Boolean(recovered?.submitted));
      setConfirmed(false);
      setReturned(Boolean(recovered));
      setManagementReturned(result.kind === 'ready' && result.target.managementReviewReturned === true);
      setInputError('');
      setMessage('');
      // Only known unsent work may silently release a departure guard.
      if (!recovered && history.current !== 'unknown') revoke?.();
      setCurrent(result);
    },
    [revoke, history],
  );

  // Initial loading and explicit recovery share the same ownership boundary.
  const reload = useCallback(async () => {
    const isCurrent = owner.current!;
    if (!isCurrent() || busy.current) return;
    busy.current = true;
    setPending(true);
    setCurrent(null);
    setConfirmed(false);
    const controller = new AbortController();
    reads.current = controller;
    const expected = readRenameContinuation();
    try {
      const result = await source.readCurrent(controller.signal);
      if (isCurrent()) receiveCurrent(result, expected);
    } catch {
      if (isCurrent()) receiveCurrent({ kind: 'unavailable' }, expected);
    } finally {
      if (isCurrent()) {
        busy.current = false;
        setPending(false);
        if (focusAfterRead.current) {
          focusAfterRead.current = false;
          reviewFocus.current?.focus();
        }
      }
    }
  }, [source, receiveCurrent]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useLayoutEffect(() => {
    if (inputError) input.current?.focus();
    else if (message || current?.kind === 'unavailable' || current?.kind === 'refused')
      (alert.current ?? reviewFocus.current)?.focus();
    else if (current?.kind === 'signed-out' || current?.kind === 'management-auth-required')
      reviewFocus.current?.focus();
  }, [inputError, message, current?.kind]);
  useLayoutEffect(() => {
    if (blocker?.status === 'blocked')
      departureDialog.current?.querySelector<HTMLButtonElement>('[data-stay]')?.focus();
  }, [blocker?.status]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const isCurrent = owner.current!;
    if (!isCurrent() || busy.current || current?.kind !== 'ready' || !confirmed) return;
    const normalized = normalizeSignupHandle(handle);
    if (!normalized || (normalized === current.target.handle && !attempt.current?.submitted)) {
      setInputError(m.auth_rename_invalid());
      return;
    }
    if (outcome === 'unknown' && !attempt.current) return;
    const selected = attempt.current ?? createRenameAttempt(current.target, handle);
    if (!selected) return;
    attempt.current = selected;
    busy.current = true;
    setPending(true);
    setMessage('');
    setInputError('');
    try {
      const controller = new AbortController();
      reads.current = controller;
      const result = await source.run(selected, isCurrent, controller.signal);
      if (!isCurrent()) return;
      setLocked(selected.submitted);
      if (selected.submitted) remember('unknown');
      if (result.kind === 'renamed') {
        clearRenameContinuation(selected);
        attempt.current = null;
        remember('acknowledged');
        revoke?.();
        setRenamed(result.target.handle ?? '');
      } else if (result.kind === 'acknowledged') {
        clearRenameContinuation(selected);
        attempt.current = null;
        receiveCurrent(result.current, selected);
        remember('acknowledged');
        setLocked(false);
        revoke?.();
      } else if (result.kind === 'step-up') {
        setHandle('');
        setConfirmed(false);
        setReturned(false);
        currentTarget.current = null;
        setCurrent({ kind: 'management-auth-required', accountId: selected.accountId });
        attempt.current = null;
        const saved = readRenameContinuation();
        if (saved && !sameRenameContinuation(saved, selected)) return;
        saveRenameContinuation(selected);
        setConfirmed(false);
        if (departure) departure.current.allow = true;
        const handedOff = await source.stepUp(selected, isCurrent);
        if (isCurrent() && !handedOff) {
          if (departure) departure.current.allow = false;
          setMessage(m.auth_rename_unavailable());
        }
      } else if (result.kind === 'conflict' || result.kind === 'denied') {
        if (!selected.submitted) clearRenameContinuation(selected);
        receiveCurrent(result.kind === 'conflict' ? result.current : (result.current ?? { kind: 'refused' }), selected);
        if (selected.submitted) remember('unknown');
        setMessage(result.kind === 'conflict' ? m.auth_rename_conflict() : m.auth_rename_denied());
      } else {
        if (result.current) receiveCurrent(result.current, selected);
        if (selected.submitted) remember('unknown');
        setMessage(result.kind === 'unknown' ? m.auth_rename_unknown() : m.auth_rename_unavailable());
      }
    } catch {
      if (isCurrent()) {
        if (departure) departure.current.allow = false;
        setLocked(selected.submitted);
        if (selected.submitted) remember('unknown');
        setMessage(selected.submitted ? m.auth_rename_unknown() : m.auth_rename_unavailable());
      }
    } finally {
      if (isCurrent()) {
        busy.current = false;
        setPending(false);
      }
    }
  }

  async function continueWithManagementAuthentication() {
    if (current?.kind !== 'management-auth-required' || !source.stepUpForReview || busy.current) return;
    const isCurrent = owner.current!;
    if (!isCurrent()) return;
    busy.current = true;
    setPending(true);
    setMessage('');
    if (departure) departure.current.allow = true;
    try {
      const handedOff = await source.stepUpForReview(current.accountId, isCurrent);
      if (isCurrent() && !handedOff) {
        if (departure) departure.current.allow = false;
        setMessage(m.auth_rename_unavailable());
      }
    } catch {
      if (isCurrent()) {
        if (departure) departure.current.allow = false;
        setMessage(m.auth_rename_unavailable());
      }
    } finally {
      if (isCurrent()) {
        busy.current = false;
        setPending(false);
      }
    }
  }

  const candidate = normalizeSignupHandle(handle);
  const hasChangedInput =
    handle.trim().length > 0 &&
    (candidate === null || candidate !== (current?.kind === 'ready' ? current.target.handle : null));
  if (departure)
    departure.current.protected =
      !renamed &&
      (hasChangedInput ||
        outcome === 'unknown' ||
        Boolean(attempt.current?.submitted) ||
        Boolean(readRenameContinuation()?.submitted) ||
        (pending && attempt.current !== null));

  function stay() {
    focusAfterStay.current = true;
    blocker?.status === 'blocked' && blocker.reset();
  }

  function leave() {
    departure && (departure.current.allow = true);
    if (attempt.current && !attempt.current.submitted) {
      clearRenameContinuation(attempt.current);
      attempt.current = null;
    }
    retire.current();
    blocker?.status === 'blocked' && blocker.proceed();
  }

  if (renamed)
    return (
      <AuthPage returnToSecurity heading={m.auth_rename_heading()}>
        <Alert role="status">
          <AlertDescription>{m.auth_rename_success({ handle: renamed })}</AlertDescription>
        </Alert>
      </AuthPage>
    );
  return (
    <>
      <AuthPage returnToSecurity heading={m.auth_rename_heading()}>
        <div className="auth-account-operation-copy">
          <p>{m.auth_rename_description()}</p>
          <p>{m.auth_rename_forwarding()}</p>
        </div>
        <div ref={reviewFocus} tabIndex={-1} aria-label={m.auth_rename_heading()}>
          <RenameRecoveryNotice history={outcome} observed={current?.kind === 'ready'} />
          {pending ? <p role="status">{m.auth_inventory_loading()}</p> : null}
          {!current ? null : current.kind === 'signed-out' ? (
            <p>
              {m.auth_rename_signed_out()}{' '}
              <a href="/login" className="underline">
                {m.auth_security_sign_in()}
              </a>
            </p>
          ) : current.kind === 'management-auth-required' ? (
            <>
              <p>{m.auth_rename_management_auth_required()}</p>
              {message ? (
                <ErrorAlert ref={alert} tabIndex={-1}>
                  {message}
                </ErrorAlert>
              ) : null}
              <Button
                type="button"
                disabled={pending}
                aria-busy={pending}
                onClick={() => void continueWithManagementAuthentication()}
              >
                {m.auth_rename_management_authenticate()}
              </Button>
            </>
          ) : current.kind === 'refused' ? (
            <ErrorAlert ref={alert} tabIndex={-1}>
              {m.auth_rename_denied()}
            </ErrorAlert>
          ) : current.kind === 'unavailable' ? (
            <>
              {current.target && outcome !== 'unknown' ? (
                <>
                  <p>{m.auth_rename_actor({ accountId: current.target.accountId })}</p>
                  <p>{m.auth_rename_current({ handle: current.target.handle ?? m.auth_rename_no_handle() })}</p>
                </>
              ) : null}
              <ErrorAlert ref={alert} tabIndex={-1}>
                {m.auth_rename_unavailable()}
              </ErrorAlert>
            </>
          ) : outcome === 'unknown' && !attempt.current ? null : (
            <form
              className="auth-login-form"
              method="post"
              action="/account-operations/approve"
              noValidate
              onSubmit={submit}
            >
              <p>{m.auth_rename_current({ handle: current.target.handle ?? m.auth_rename_no_handle() })}</p>
              <p>{m.auth_rename_actor({ accountId: current.target.accountId })}</p>
              {managementReturned ? (
                <Alert role="status">
                  <AlertDescription>{m.auth_rename_management_returned()}</AlertDescription>
                </Alert>
              ) : null}
              {returned ? (
                <Alert role="status">
                  <AlertDescription>{m.auth_rename_reconfirm()}</AlertDescription>
                </Alert>
              ) : null}
              <Field data-invalid={Boolean(inputError)}>
                <FieldLabel htmlFor="rename-handle">{m.auth_rename_handle()}</FieldLabel>
                <p id="rename-handle-help">{m.auth_organization_handle_invalid()}</p>
                <Input
                  ref={input}
                  id="rename-handle"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={handle}
                  disabled={pending || locked || outcome === 'unknown'}
                  aria-invalid={Boolean(inputError)}
                  aria-describedby={inputError ? 'rename-handle-help rename-handle-error' : 'rename-handle-help'}
                  onChange={(event) => {
                    if (attempt.current?.submitted || outcome === 'unknown') return;
                    setHandle(event.target.value);
                    setConfirmed(false);
                    setReturned(false);
                    setInputError('');
                    if (attempt.current) clearRenameContinuation(attempt.current);
                    attempt.current = null;
                  }}
                />
                {inputError ? <FieldError id="rename-handle-error">{inputError}</FieldError> : null}
              </Field>
              {candidate ? (
                <Field>
                  <FieldLabel className="items-start gap-3" htmlFor="rename-confirm">
                    <input
                      id="rename-confirm"
                      type="checkbox"
                      checked={confirmed}
                      disabled={pending}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    {m.auth_rename_confirm({ handle: candidate })}
                  </FieldLabel>
                </Field>
              ) : null}
              {message ? (
                <ErrorAlert tabIndex={-1} ref={alert}>
                  {message}
                </ErrorAlert>
              ) : null}
              <Button
                type="submit"
                className="w-full"
                disabled={pending || !confirmed || !candidate}
                aria-busy={pending}
              >
                {locked ? m.auth_rename_retry() : m.auth_rename_submit()}
              </Button>
            </form>
          )}
          <Button
            type="button"
            disabled={pending}
            aria-busy={pending}
            onClick={() => {
              focusAfterRead.current = true;
              void reload();
            }}
          >
            {m.auth_rename_reload()}
          </Button>
        </div>
      </AuthPage>
      <AlertDialog
        open={blocker?.status === 'blocked'}
        onOpenChange={(open) => {
          if (!open) stay();
        }}
      >
        <AlertDialogContent
          ref={departureDialog}
          onKeyDownCapture={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              stay();
            }
          }}
          finalFocus={() => {
            if (focusAfterStay.current) {
              focusAfterStay.current = false;
              (input.current ?? reviewFocus.current)?.focus();
              return false;
            }
          }}
        >
          <AlertDialogTitle>{m.auth_rename_departure_heading()}</AlertDialogTitle>
          <AlertDialogDescription>
            {outcome === 'unknown' || attempt.current?.submitted
              ? m.auth_rename_departure_pending()
              : m.auth_rename_departure_unsent()}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel data-stay onClick={stay}>
              {m.auth_rename_stay()}
            </AlertDialogCancel>
            <AlertDialogAction data-leave onClick={leave}>
              {m.auth_rename_leave()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
