import { createFileRoute, useBlocker, useRouter } from '@tanstack/react-router';
import { AuthButton as Button } from '../button';
import { Field, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@rezics/ui/shadcn/alert-dialog';
import { useCallback, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';
import { ErrorAlert } from '../alert';
import {
  accountOperationSessionMatches,
  accountOperationStepUpUrl,
  clearPendingAccountOperationStepUp,
  pendingAccountOperationMatches,
  pendingAccountOperationStepUpState,
  storePendingAccountOperationStepUp,
  accountOperationProfile,
  type PendingAccountOperationStepUp,
} from '../account-operation-step-up';
import {
  forgetOperationKey,
  loadAccountSession,
  operationKeyFor,
  readPendingOrganizationHandle,
  runAccountOperation,
  storePendingOrganizationHandle,
  type AccountSessionResult,
} from '../account-operations';
import { normalizeSignupHandle } from '../signup';
import {
  initialOrganizationCreateReturn,
  transitionOrganizationCreateReturn,
  type OrganizationCreateReturnEvent,
  type OrganizationCreateReturnState,
} from '../organization-create-return';
import { OrganizationCreateReturnView } from '../organization-create-return-view';

type LoadState = 'loading' | 'ready' | 'signed-out' | 'failure';

const handleId = 'organization-handle';
const handleErrorId = 'organization-handle-error';

export const Route = createFileRoute('/organizations/new')({
  head: () => ({ meta: [{ title: `${m.auth_organization_heading()} · REZICS` }] }),
  component: NewOrganizationPage,
});

// Keep the router adapter local; isolated page fixtures do not require a router.
function OrganizationDeparture({
  shouldWarn,
  leave,
  focus,
}: {
  shouldWarn: () => boolean;
  leave: () => void;
  focus: () => void;
}) {
  const blocker = useBlocker({ shouldBlockFn: shouldWarn, enableBeforeUnload: false, withResolver: true });
  useLayoutEffect(() => {
    // Retired drafts release their prompt; an unresolved send keeps protection.
    if (blocker.status === 'blocked' && !shouldWarn()) blocker.proceed();
  });
  const stay = () => {
    if (blocker.status === 'blocked') blocker.reset();
  };
  return (
    <AlertDialog
      open={blocker.status === 'blocked'}
      onOpenChange={(open) => {
        if (!open) stay();
      }}
    >
      <AlertDialogContent
        finalFocus={() => {
          focus();
          return false;
        }}
      >
        <AlertDialogTitle>{m.auth_organization_departure_heading()}</AlertDialogTitle>
        <AlertDialogDescription>
          {m.auth_organization_departure_description()} {m.auth_account_operation_leave_notice()}
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={stay}>{m.auth_organization_departure_stay()}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (blocker.status !== 'blocked') return;
              leave();
              blocker.proceed();
            }}
          >
            {m.auth_organization_departure_leave()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function NewOrganizationPage({ initial }: { initial?: AccountSessionResult } = {}) {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [accountId, setAccountId] = useState('');
  const [needsProfile, setNeedsProfile] = useState(false);
  const [returned, setReturned] = useState(false);
  const [returnState, setReturnState] = useState<OrganizationCreateReturnState>(initialOrganizationCreateReturn);
  const unresolvedAttempt = useRef<PendingAccountOperationStepUp | null>(null);
  const [restricted, setRestricted] = useState(false);
  const [recoveryUnavailable, setRecoveryUnavailable] = useState(false);
  const [handle, setHandle] = useState('');
  const [handleError, setHandleError] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [showRetry, setShowRetry] = useState(false);
  const [createdHandle, setCreatedHandle] = useState('');
  const [createdAccountId, setCreatedAccountId] = useState('');
  const [loadMessage, setLoadMessage] = useState('');
  const submitting = useRef(false);
  const lifetime = useRef<object | null>(null);
  const [reload, setReload] = useState(0);
  const handleInput = useRef<HTMLInputElement>(null);
  const alert = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLDivElement>(null);
  const focusAfterReturn = useRef(false);
  const router = useRouter({ warn: false });
  const bypassDeparture = useRef(false);
  const authority = useRef<Extract<AccountSessionResult, { kind: 'ready' }> | null>(null);
  const review = useRef({ handle, protect: false });
  review.current = {
    handle,
    // Losing current authority retires the form, but cannot settle an earlier send.
    protect:
      returnState.history === 'unconfirmed' ||
      (loadState === 'ready' && !createdHandle && Boolean(handle.trim() || pending)),
  };
  const unknown = returnState.history === 'unconfirmed';
  const shouldWarn = useCallback(() => !bypassDeparture.current && review.current.protect, []);
  const recordReturn = useCallback((event: OrganizationCreateReturnEvent) => {
    setReturnState((current) => transitionOrganizationCreateReturn(current, event));
  }, []);
  const depart = useCallback(() => {
    const descriptorHandle =
      unresolvedAttempt.current?.operation.kind === 'organization'
        ? unresolvedAttempt.current.operation.handle
        : '';
    const draft = review.current.handle || descriptorHandle;
    const marker = pendingAccountOperationStepUpState();
    // Retire authority and force private DOM removal before the browser can cache this document.
    lifetime.current = null;
    authority.current = null;
    submitting.current = false;
    bypassDeparture.current = true;
    flushSync(() => {
      setLoadState('loading');
      setAccountId('');
      setNeedsProfile(false);
      setReturned(false);
      setRestricted(false);
      setRecoveryUnavailable(false);
      setHandle('');
      setHandleError('');
      setPending(false);
      setMessage('');
      setShowRetry(false);
      setCreatedHandle('');
      setCreatedAccountId('');
      setLoadMessage('');
      recordReturn({ type: 'return' });
    });
    // A retained command, including one whose outcome is unknown, keeps its exact identity.
    if (marker.kind === 'absent' && readPendingOrganizationHandle() === draft)
      storePendingOrganizationHandle('');
  }, [recordReturn]);
  const departure = router ? (
    <OrganizationDeparture shouldWarn={shouldWarn} leave={depart} focus={() => handleInput.current?.focus()} />
  ) : null;

  useLayoutEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (!shouldWarn()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [shouldWarn]);

  useLayoutEffect(() => {
    const current = {};
    lifetime.current = current;
    bypassDeparture.current = false;
    authority.current = null;
    submitting.current = false;
    setPending(false);
    setLoadState(initial?.kind === 'signed-out' && reload === 0 ? 'signed-out' : 'loading');
    setAccountId('');
    setNeedsProfile(false);
    setHandle('');
    setHandleError('');
    setCreatedHandle('');
    setCreatedAccountId('');
    setMessage('');
    setShowRetry(false);
    setReturned(false);
    setRestricted(false);
    setRecoveryUnavailable(false);
    const stored = pendingAccountOperationStepUpState();
    const saved = stored.kind === 'pending' ? stored.value : null;
    if (!unresolvedAttempt.current && saved?.kind === 'organization') {
      // Storage is a recovery hint, including submitted:false. It cannot prove
      // how far a former mounted page got through approval and execution.
      unresolvedAttempt.current = saved;
      setReturnState((state) =>
        state.phase === 'review' && state.history === 'none'
          ? transitionOrganizationCreateReturn(state, { type: 'unknown' })
          : state,
      );
    }
    const retire = () => {
      lifetime.current = null;
    };
    const leaveDocument = () => {
      if (lifetime.current === current) depart();
    };
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      focusAfterReturn.current = true;
      depart();
      flushSync(() => setReload((value) => value + 1));
    };
    window.addEventListener('pagehide', leaveDocument);
    window.addEventListener('pageshow', restore);
    void (initial && reload === 0 ? Promise.resolve(initial) : loadAccountSession()).then((result) => {
      if (lifetime.current !== current) return;
      if (result.kind === 'ready') {
        const pendingState = pendingAccountOperationStepUpState();
        const pendingOperation = pendingState.kind === 'pending' ? pendingState.value : null;
        const attemptMismatch =
          unresolvedAttempt.current !== null &&
          !pendingAccountOperationMatches(
            pendingOperation,
            unresolvedAttempt.current.accountId,
            unresolvedAttempt.current.operationKey,
            unresolvedAttempt.current.operation,
          );
        const sessionMismatch =
          pendingOperation !== null &&
          (pendingOperation.kind !== 'organization' ||
            pendingOperation.returnTo !== '/organizations/new' ||
            !accountOperationSessionMatches(result, pendingOperation));
        if (
          pendingState.kind === 'invalid' ||
          attemptMismatch ||
          sessionMismatch
        ) {
          authority.current = result;
          setAccountId(result.accountId);
          const expected = accountOperationProfile('organization');
          setNeedsProfile(
            result.clientId !== expected.client_id ||
              result.scopes?.length !== 1 ||
              result.scopes[0] !== expected.scope[0],
          );
          setHandle('');
          setCreatedHandle('');
          setCreatedAccountId('');
          setMessage('');
          setShowRetry(false);
          setRecoveryUnavailable(true);
          recordReturn({ type: 'unresumable' });
          setLoadMessage(m.auth_account_operation_failure());
          setLoadState('ready');
          return;
        }
        if (pendingOperation?.operation.kind === 'organization') {
          setHandle(pendingOperation.operation.handle);
        } else setHandle(readPendingOrganizationHandle());
        authority.current = result;
        setAccountId(result.accountId);
        setReturned(Boolean(pendingOperation));
        const expected = accountOperationProfile('organization');
        setNeedsProfile(
          result.clientId !== expected.client_id ||
            result.scopes?.length !== 1 ||
            result.scopes[0] !== expected.scope[0],
        );
        setLoadState('ready');
      } else if (result.kind === 'signed-out') {
        setLoadState('signed-out');
      } else {
        recordReturn({ type: 'read-unavailable' });
        setLoadMessage(result.message);
        setLoadState('failure');
      }
    });
    return () => {
      retire();
      window.removeEventListener('pagehide', leaveDocument);
      window.removeEventListener('pageshow', restore);
    };
  }, [initial, reload, depart, recordReturn]);

  useLayoutEffect(() => {
    if (handleError) handleInput.current?.focus();
    else if (message) {
      if (message === m.auth_organization_conflict()) handleInput.current?.focus();
      else alert.current?.focus();
    }
  }, [handleError, message]);

  useLayoutEffect(() => {
    if (!focusAfterReturn.current || loadState === 'loading') return;
    focusAfterReturn.current = false;
    if (returnFocus.current) returnFocus.current.focus();
    else handleInput.current?.focus();
  }, [loadState, returnState.phase]);

  useLayoutEffect(() => {
    if (createdHandle) returnFocus.current?.focus();
  }, [createdHandle]);

  async function createOrganization() {
    if (
      !lifetime.current ||
      loadState !== 'ready' ||
      submitting.current ||
      pending ||
      restricted ||
      recoveryUnavailable
    )
      return;
    const normalizedHandle = normalizeSignupHandle(handle);
    if (!normalizedHandle) {
      setMessage('');
      setShowRetry(false);
      setHandleError(handle ? m.auth_organization_handle_invalid() : m.auth_form_required());
      return;
    }
    setHandleError('');
    const priorUncertainty = returnState.history === 'unconfirmed';
    recordReturn({ type: 'begin' });
    submitting.current = true;
    setPending(true);
    setMessage('');
    setShowRetry(false);
    const operation = { kind: 'organization' as const, handle: normalizedHandle };
    const pendingState = pendingAccountOperationStepUpState();
    const pendingOperation = pendingState.kind === 'pending' ? pendingState.value : null;
    const invalidContinuation =
      pendingState.kind === 'invalid' ||
      (returnState.history === 'unconfirmed' && !unresolvedAttempt.current) ||
      (unresolvedAttempt.current &&
        !pendingAccountOperationMatches(
          pendingOperation,
          unresolvedAttempt.current.accountId,
          unresolvedAttempt.current.operationKey,
          unresolvedAttempt.current.operation,
        )) ||
      (pendingOperation &&
        !pendingAccountOperationMatches(pendingOperation, accountId, pendingOperation.operationKey, operation));
    if (invalidContinuation) {
      // Missing/replaced storage is not a license to allocate a new command key.
      lifetime.current = null;
      authority.current = null;
      submitting.current = false;
      flushSync(() => {
        setLoadState('failure');
        setAccountId('');
        setNeedsProfile(false);
        setHandle('');
        setHandleError('');
        setPending(false);
        setMessage('');
        setShowRetry(false);
        setCreatedHandle('');
        setCreatedAccountId('');
        setRecoveryUnavailable(true);
        setLoadMessage(m.auth_account_operation_failure());
        recordReturn({ type: 'unresumable' });
      });
      return;
    }
    const operationKey =
      pendingOperation?.operationKey ??
      unresolvedAttempt.current?.operationKey ??
      operationKeyFor(operation, accountId);
    const current = lifetime.current;
    let continuation = JSON.stringify(pendingState);
    const draft = readPendingOrganizationHandle();
    const isCurrent = () => {
      if (lifetime.current !== current) return false;
      if (
        JSON.stringify(pendingAccountOperationStepUpState()) === continuation &&
        readPendingOrganizationHandle() === draft
      )
        return true;
      lifetime.current = null;
      authority.current = null;
      submitting.current = false;
      flushSync(() => {
        setLoadState('failure');
        setAccountId('');
        setNeedsProfile(false);
        setHandle('');
        setHandleError('');
        setPending(false);
        setMessage('');
        setShowRetry(false);
        setCreatedHandle('');
        setCreatedAccountId('');
        setRecoveryUnavailable(true);
        setLoadMessage(m.auth_account_operation_failure());
        recordReturn({ type: 'unresumable' });
      });
      return false;
    };
    const before = await loadAccountSession();
    if (!isCurrent()) return;
    if (
      before.kind !== 'ready' ||
      before.accountId !== accountId ||
      before.clientId !== authority.current?.clientId ||
      JSON.stringify(before.scopes) !== JSON.stringify(authority.current?.scopes)
    ) {
      lifetime.current = null;
      authority.current = null;
      submitting.current = false;
      flushSync(() => {
        setLoadState(before.kind === 'signed-out' ? 'signed-out' : 'failure');
        setAccountId('');
        setNeedsProfile(false);
        setHandle('');
        setHandleError('');
        setPending(false);
        setMessage('');
        setShowRetry(false);
        setCreatedHandle('');
        setCreatedAccountId('');
        setRecoveryUnavailable(false);
        setLoadMessage(m.auth_account_operation_failure());
        recordReturn({ type: 'read-unavailable' });
      });
      return;
    }
    // Retain the exact command before sending it: losing this page cannot unlock another creation.
    const submitted = Boolean(priorUncertainty || pendingOperation?.submitted);
    if (
      !storePendingAccountOperationStepUp({
        kind: 'organization',
        accountId,
        operationKey,
        operation,
        ...(submitted ? { submitted: true } : {}),
      })
    ) {
      setMessage(m.auth_account_operation_failure());
      submitting.current = false;
      setPending(false);
      return;
    }
    continuation = JSON.stringify(pendingAccountOperationStepUpState());
    unresolvedAttempt.current = {
      kind: 'organization',
      accountId,
      operationKey,
      operation,
      returnTo: '/organizations/new',
    };
    recordReturn({ type: 'approval', priorUncertainty });
    let executionDispatched = false;
    let result = await runAccountOperation(operationKey, operation, {
      isCurrent,
      onExecutionDispatch: () => {
        if (!isCurrent()) return false;
        executionDispatched = true;
        recordReturn({ type: 'execution' });
        return isCurrent();
      },
    });
    if (!isCurrent()) return;
    const after = await loadAccountSession();
    if (!isCurrent()) return;
    if (
      after.kind !== 'ready' ||
      after.accountId !== accountId ||
      after.clientId !== before.clientId ||
      JSON.stringify(after.scopes) !== JSON.stringify(before.scopes)
    ) {
      lifetime.current = null;
      authority.current = null;
      submitting.current = false;
      flushSync(() => {
        setLoadState(after.kind === 'signed-out' ? 'signed-out' : 'failure');
        setAccountId('');
        setNeedsProfile(false);
        setHandle('');
        setHandleError('');
        setPending(false);
        setMessage('');
        setShowRetry(false);
        setCreatedHandle('');
        setCreatedAccountId('');
        setRecoveryUnavailable(false);
        setLoadMessage(m.auth_account_operation_failure());
        recordReturn({ type: 'read-unavailable' });
      });
      return;
    }
    if (!result.ok && result.reason === 'denied' && needsProfile) result = { ok: false, reason: 'step-up' };
    if (result.ok) {
      forgetOperationKey(operation, accountId);
      storePendingOrganizationHandle('');
      clearPendingAccountOperationStepUp();
      unresolvedAttempt.current = null;
      recordReturn({ type: 'acknowledged' });
      setCreatedHandle(normalizedHandle);
      setCreatedAccountId(result.accountId);
      submitting.current = false;
      setPending(false);
      return;
    }
    if (result.reason === 'step-up') {
      if (
        !storePendingAccountOperationStepUp({
          kind: 'organization',
          accountId,
          operationKey,
          operation,
          ...(submitted ? { submitted: true } : {}),
        })
      ) {
        setMessage(m.auth_account_operation_failure());
        submitting.current = false;
        setPending(false);
        return;
      }
      recordReturn({ type: 'approval', priorUncertainty, settled: true });
      bypassDeparture.current = true;
      window.location.assign(accountOperationStepUpUrl('organization'));
      return;
    }
    submitting.current = false;
    setPending(false);
    if (result.reason === 'platform-closed' || result.reason === 'denied') {
      setRestricted(true);
      // A refusal on this first mounted invocation proves no earlier invocation
      // is unresolved. A later approval refusal says nothing about an older send.
      if (!priorUncertainty) {
        clearPendingAccountOperationStepUp();
        unresolvedAttempt.current = null;
      }
      recordReturn({ type: 'refused', priorUncertainty });
    }
    if (result.reason === 'platform-closed') {
      setMessage(m.auth_organization_not_open());
    } else if (result.reason === 'denied') {
      setMessage(m.auth_organization_refused());
    } else if (result.reason === 'unknown') {
      recordReturn({ type: 'unknown' });
      setShowRetry(true);
    } else if (result.reason === 'unavailable') {
      recordReturn({ type: 'unavailable' });
      setMessage(m.auth_account_operation_unavailable());
      setShowRetry(true);
    } else {
      recordReturn({ type: executionDispatched || priorUncertainty ? 'unknown' : 'unavailable' });
      setMessage(m.auth_account_operation_failure());
      setShowRetry(true);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void createOrganization();
  }

  function retryRead() {
    focusAfterReturn.current = true;
    depart();
    flushSync(() => setReload((value) => value + 1));
  }

  let returnPhase = returnState.phase;
  if (recoveryUnavailable) returnPhase = 'unresumable';
  else if (loadState === 'failure') returnPhase = 'unavailable';
  else if (loadState === 'signed-out') {
    returnPhase =
      returnState.history === 'unconfirmed'
        ? 'unknown'
        : returnState.history === 'acknowledged'
          ? 'acknowledged'
          : 'review';
  } else if (loadState === 'loading') {
    returnPhase = returnState.history === 'unconfirmed'
      ? 'unknown'
      : returnState.history === 'acknowledged'
        ? 'acknowledged'
        : 'preflight';
  } else if (pending && ['preflight', 'approval', 'execution'].includes(returnState.phase)) {
    returnPhase = returnState.phase;
  } else if (returnState.history === 'unconfirmed') returnPhase = 'unknown';
  else if (returnState.history === 'acknowledged') returnPhase = 'acknowledged';
  else if (returned && returnState.phase === 'approval') returnPhase = 'approval';
  else if (returnState.phase === 'unavailable') returnPhase = 'unavailable';
  else returnPhase = 'review';

  const canRetryRead =
    loadState === 'failure' ||
    recoveryUnavailable ||
    (loadState === 'ready' && returnState.phase === 'unavailable' && !pending) ||
    (loadState === 'ready' && returnState.history === 'unconfirmed' && !pending);
  const canRetryCreation =
    loadState === 'ready' &&
    !pending &&
    !restricted &&
    !recoveryUnavailable &&
    unresolvedAttempt.current !== null &&
    (returnState.history === 'unconfirmed' || showRetry);
  const returnView = (
    <OrganizationCreateReturnView
      phase={returnPhase}
      history={returnState.history}
      pending={pending}
      {...(createdHandle ? { handle: createdHandle, accountId: createdAccountId } : {})}
      canRetryRead={canRetryRead}
      canRetryCreation={canRetryCreation}
      signedOut={loadState === 'signed-out'}
      readRetry={retryRead}
      creationRetry={() => void createOrganization()}
      focusRef={returnFocus}
    />
  );

  if (loadState === 'signed-out')
    return (
      <AuthPage returnToSecurity heading={m.auth_organization_heading()}>
        {departure}
        {returnView}
        <div className="auth-login-form">
          <p>{m.auth_account_operation_sign_in_required()}</p>
        </div>
      </AuthPage>
    );

  if (loadState === 'failure')
    return (
      <AuthPage returnToSecurity heading={m.auth_organization_heading()}>
        {departure}
        {returnView}
        <ErrorAlert>{loadMessage}</ErrorAlert>
      </AuthPage>
    );

  if (loadState === 'loading')
    return (
      <AuthPage returnToSecurity heading={m.auth_organization_heading()}>
        {departure}
        {returnView}
        <p role="status">{m.auth_inventory_loading()}</p>
      </AuthPage>
    );

  if (recoveryUnavailable)
    return (
      <AuthPage returnToSecurity heading={m.auth_organization_heading()}>
        {departure}
        {returnView}
      </AuthPage>
    );

  if (createdHandle)
    return (
      <AuthPage returnToSecurity heading={m.auth_organization_heading()}>
        {departure}
        {returnView}
      </AuthPage>
    );

  return (
    <AuthPage returnToSecurity heading={m.auth_organization_heading()}>
      {departure}
      <form className="auth-login-form" method="post" action="/account-operations/approve" noValidate onSubmit={submit}>
        <p>{m.auth_organization_explanation()}</p>
        {returnView}
        <Field data-invalid={Boolean(handleError)}>
          <FieldLabel htmlFor={handleId}>{m.auth_signup_handle()}</FieldLabel>
          <p id="organization-handle-help">{m.auth_organization_handle_invalid()}</p>
          <Input
            ref={handleInput}
            id={handleId}
            name="handle"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={handle}
            onChange={(event) => {
              setHandle(event.target.value);
              setHandleError('');
              setMessage('');
              setShowRetry(false);
              storePendingOrganizationHandle(event.target.value);
            }}
            aria-invalid={handleError ? true : undefined}
            aria-describedby={handleError ? `organization-handle-help ${handleErrorId}` : 'organization-handle-help'}
            readOnly={pending || unknown || returned}
            required
          />
          {handleError ? <FieldError id={handleErrorId}>{handleError}</FieldError> : null}
        </Field>
        {message ? (
          <ErrorAlert tabIndex={-1} ref={alert}>
            <p>{message}</p>
          </ErrorAlert>
        ) : null}
        {!unknown ? (
          <Button type="submit" disabled={pending || restricted} aria-busy={pending} className="w-full">
            {m.auth_organization_create()}
          </Button>
        ) : null}
      </form>
    </AuthPage>
  );
}
