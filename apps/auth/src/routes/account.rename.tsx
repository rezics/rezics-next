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
  type RenameAttempt,
  type RenameRead,
  type RenameSource,
  type RenameTarget,
} from '../account-rename';

export const Route = createFileRoute('/account/rename')({
  head: () => ({ meta: [{ title: `${m.auth_rename_heading()} · REZICS` }] }),
  component: RenameAccountPage,
});

export function RenameAccountPage({ source = nativeRenameSource }: { source?: RenameSource } = {}) {
  const [review, setReview] = useState({ source, generation: 0 });
  const router = useRouter({ warn: false });
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
    <RoutedRenameReview key={review.generation} source={source} />
  ) : (
    <RenameReview key={review.generation} source={source} />
  );
}

type DepartureState = { protected: boolean; allow: boolean };
type DepartureBlocker =
  | { status: 'idle'; proceed: undefined; reset: undefined }
  | { status: 'blocked'; proceed: () => void; reset: () => void };

function RoutedRenameReview({ source }: { source: RenameSource }) {
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
  return <RenameReview source={source} departure={departure} blocker={blocker} revoke={revoke} />;
}

function sameRenameSession(left: RenameTarget, right: RenameTarget) {
  const leftScopes = left.scopes ?? [];
  const rightScopes = right.scopes ?? [];
  return (
    left.accountId === right.accountId &&
    left.clientId === right.clientId &&
    leftScopes.length === rightScopes.length &&
    leftScopes.every((scope, index) => scope === rightScopes[index])
  );
}

function RenameReview({
  source,
  departure,
  blocker,
  revoke,
}: {
  source: RenameSource;
  departure?: MutableRefObject<DepartureState>;
  blocker?: DepartureBlocker;
  revoke?: () => void;
}) {
  const [current, setCurrent] = useState<RenameRead | null>(null);
  const [handle, setHandle] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [returned, setReturned] = useState(false);
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

  useLayoutEffect(() => {
    let active = true;
    const isCurrent = () => active;
    owner.current = isCurrent;
    busy.current = false;
    const retireReview = () => {
      active = false;
    };
    const pagehide = () => {
      retireReview();
      if (!attempt.current?.submitted && !departure?.current.allow) clearRenameContinuation();
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
    (result: RenameRead) => {
      const previous = currentTarget.current;
      const changedSession =
        previous !== null && result.kind === 'ready' && !sameRenameSession(previous, result.target);
      const authorityLost = result.kind === 'signed-out' || result.kind === 'denied';
      if (result.kind === 'ready') currentTarget.current = result.target;
      else if (authorityLost) currentTarget.current = null;
      if (changedSession || authorityLost) {
        clearRenameContinuation();
        attempt.current = null;
        setLocked(false);
        setHandle('');
        setConfirmed(false);
        setReturned(false);
        setInputError('');
        setMessage('');
        revoke?.();
      }
      const saved = readRenameContinuation();
      if (!changedSession && !authorityLost && saved && result.kind === 'ready') {
        if (saved.accountId !== result.target.accountId) {
          clearRenameContinuation();
          attempt.current = null;
          setLocked(false);
          setHandle('');
          setConfirmed(false);
          setReturned(false);
          setMessage(m.auth_rename_denied());
          revoke?.();
        } else if (saved.submitted || saved.operation.expectedHandle === result.target.handle) {
          attempt.current = saved;
          setHandle(saved.operation.handle);
          setLocked(saved.submitted);
          setConfirmed(false);
          setReturned(true);
        } else {
          clearRenameContinuation();
          attempt.current = null;
          setConfirmed(false);
          setMessage(m.auth_rename_conflict());
        }
      }
      setCurrent(result);
    },
    [revoke],
  );

  // Initial loading and explicit recovery share the same ownership boundary.
  const reload = useCallback(async () => {
    const isCurrent = owner.current!;
    if (!isCurrent() || busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      const result = await source.readCurrent();
      if (isCurrent()) receiveCurrent(result);
    } catch {
      if (isCurrent()) setCurrent({ kind: 'unavailable' });
    } finally {
      if (isCurrent()) {
        busy.current = false;
        setPending(false);
      }
    }
  }, [source, receiveCurrent]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useLayoutEffect(() => {
    if (inputError) input.current?.focus();
    else if (message || current?.kind === 'unavailable' || current?.kind === 'denied') alert.current?.focus();
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
    const selected = attempt.current ?? createRenameAttempt(current.target, handle);
    if (!selected) return;
    attempt.current = selected;
    busy.current = true;
    setPending(true);
    setMessage('');
    setInputError('');
    try {
      const result = await source.run(selected, isCurrent);
      if (!isCurrent()) return;
      setLocked(selected.submitted);
      if (result.kind === 'renamed') {
        clearRenameContinuation();
        attempt.current = null;
        revoke?.();
        setRenamed(result.target.handle ?? '');
      } else if (result.kind === 'step-up') {
        saveRenameContinuation(selected);
        setConfirmed(false);
        if (departure) departure.current.allow = true;
        const handedOff = await source.stepUp(selected, isCurrent);
        if (isCurrent() && !handedOff) {
          if (departure) departure.current.allow = false;
          setMessage(m.auth_rename_unavailable());
        }
      } else if (result.kind === 'conflict') {
        clearRenameContinuation();
        attempt.current = null;
        setLocked(false);
        setConfirmed(false);
        receiveCurrent(result.current);
        setMessage(m.auth_rename_conflict());
      } else if (result.kind === 'denied') {
        clearRenameContinuation();
        attempt.current = null;
        setLocked(false);
        setHandle('');
        setConfirmed(false);
        setReturned(false);
        setInputError('');
        setCurrent({ kind: 'denied' });
        revoke?.();
        setMessage(m.auth_rename_denied());
      } else {
        setMessage(result.kind === 'unknown' ? m.auth_rename_unknown() : m.auth_rename_unavailable());
      }
    } catch {
      if (isCurrent()) {
        if (departure) departure.current.allow = false;
        setLocked(selected.submitted);
        setMessage(selected.submitted ? m.auth_rename_unknown() : m.auth_rename_unavailable());
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
      !renamed && (hasChangedInput || Boolean(attempt.current?.submitted) || (pending && attempt.current !== null));

  function stay() {
    focusAfterStay.current = true;
    blocker?.status === 'blocked' && blocker.reset();
  }

  function leave() {
    departure && (departure.current.allow = true);
    if (!attempt.current?.submitted) {
      attempt.current = null;
      clearRenameContinuation();
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
        {!current ? (
          <p role="status">{m.auth_inventory_loading()}</p>
        ) : current.kind === 'signed-out' ? (
          <p>
            {m.auth_rename_signed_out()}{' '}
            <a href="/login" className="underline">
              {m.auth_security_sign_in()}
            </a>
          </p>
        ) : current.kind !== 'ready' ? (
          <>
            <ErrorAlert ref={alert} tabIndex={-1}>
              {m.auth_rename_unavailable()}
            </ErrorAlert>
            <Button type="button" disabled={pending} aria-busy={pending} onClick={() => void reload()}>
              {m.auth_rename_reload()}
            </Button>
          </>
        ) : (
          <form
            className="auth-login-form"
            method="post"
            action="/account-operations/approve"
            noValidate
            onSubmit={submit}
          >
            <p>{m.auth_rename_current({ handle: current.target.handle ?? m.auth_rename_no_handle() })}</p>
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
                disabled={pending || locked}
                aria-invalid={Boolean(inputError)}
                aria-describedby={inputError ? 'rename-handle-help rename-handle-error' : 'rename-handle-help'}
                onChange={(event) => {
                  setHandle(event.target.value);
                  setConfirmed(false);
                  setReturned(false);
                  setInputError('');
                  attempt.current = null;
                  clearRenameContinuation();
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
            <Button type="submit" className="w-full" disabled={pending || !confirmed || !candidate} aria-busy={pending}>
              {locked ? m.auth_rename_retry() : m.auth_rename_submit()}
            </Button>
          </form>
        )}
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
              input.current?.focus();
              return false;
            }
          }}
        >
          <AlertDialogTitle>{m.auth_rename_departure_heading()}</AlertDialogTitle>
          <AlertDialogDescription>
            {attempt.current?.submitted ? m.auth_rename_departure_pending() : m.auth_rename_departure_unsent()}
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
