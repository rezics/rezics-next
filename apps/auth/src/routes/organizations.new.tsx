import { createFileRoute, useBlocker, useRouter } from '@tanstack/react-router';
import { AuthButton as Button } from '../button';
import { Field, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import {
  AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription,
  AlertDialogFooter, AlertDialogAction, AlertDialogCancel,
} from '@rezics/ui/shadcn/alert-dialog';
import { useCallback, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';
import { ErrorAlert } from '../alert';
import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import {
  accountOperationSessionMatches,
  accountOperationStepUpUrl,
  clearPendingAccountOperationStepUp,
  pendingAccountOperationMatches,
  pendingAccountOperationStepUpState,
  storePendingAccountOperationStepUp,
  accountOperationProfile,
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
import { membershipId } from '../organization-membership';

type LoadState = 'loading' | 'ready' | 'signed-out' | 'failure';

const handleId = 'organization-handle';
const handleErrorId = 'organization-handle-error';

export const Route = createFileRoute('/organizations/new')({
  head: () => ({ meta: [{ title: `${m.auth_organization_heading()} · REZICS` }] }),
  component: NewOrganizationPage,
});

// Keep the router adapter local; isolated page fixtures do not require a router.
function OrganizationDeparture({ shouldWarn, leave, focus }: {
  shouldWarn: () => boolean;
  leave: () => void;
  focus: () => void;
}) {
  const blocker = useBlocker({ shouldBlockFn: shouldWarn, enableBeforeUnload: false, withResolver: true });
  useLayoutEffect(() => {
    // Completion or loss of caller authority must release an already open prompt.
    if (blocker.status === 'blocked' && !shouldWarn()) blocker.proceed();
  });
  const stay = () => {
    if (blocker.status === 'blocked') blocker.reset();
  };
  return (
    <AlertDialog open={blocker.status === 'blocked'} onOpenChange={(open) => { if (!open) stay(); }}>
      <AlertDialogContent finalFocus={() => { focus(); return false; }}>
        <AlertDialogTitle>{m.auth_organization_departure_heading()}</AlertDialogTitle>
        <AlertDialogDescription>
          {m.auth_organization_departure_description()} {m.auth_account_operation_leave_notice()}
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={stay}>{m.auth_organization_departure_stay()}</AlertDialogCancel>
          <AlertDialogAction onClick={() => {
            if (blocker.status !== 'blocked') return;
            leave();
            blocker.proceed();
          }}>{m.auth_organization_departure_leave()}</AlertDialogAction>
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
  const [unknown, setUnknown] = useState(false);
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
  const router = useRouter({ warn: false });
  const bypassDeparture = useRef(false);
  const review = useRef({ handle, protect: false });
  review.current = {
    handle,
    protect: loadState === 'ready' && !createdHandle && Boolean(handle.trim() || pending || unknown),
  };
  const shouldWarn = useCallback(
    () => Boolean(lifetime.current) && !bypassDeparture.current && review.current.protect,
    [],
  );
  const depart = useCallback(() => {
    // Retire first: an approval or execution response can no longer affect this review.
    lifetime.current = null;
    bypassDeparture.current = true;
    // A retained command, including one whose outcome is unknown, keeps its exact identity.
    if (pendingAccountOperationStepUpState().kind !== 'absent') return;
    if (readPendingOrganizationHandle() === review.current.handle) storePendingOrganizationHandle('');
  }, []);
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
    submitting.current = false;
    setPending(false);
    setLoadState('loading');
    setCreatedHandle('');
    setMessage('');
    setReturned(false);
    const retire = () => {
      lifetime.current = null;
    };
    const leaveDocument = () => { if (lifetime.current === current) depart(); };
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) setReload((value) => value + 1);
    };
    window.addEventListener('pagehide', leaveDocument);
    window.addEventListener('pageshow', restore);
    void (initial && reload === 0 ? Promise.resolve(initial) : loadAccountSession()).then((result) => {
      if (lifetime.current !== current) return;
      if (result.kind === 'ready') {
        const pendingState = pendingAccountOperationStepUpState();
        const pendingOperation = pendingState.kind === 'pending' ? pendingState.value : null;
        if (
          pendingState.kind === 'invalid' ||
          (pendingOperation &&
            (pendingOperation.kind !== 'organization' ||
              pendingOperation.returnTo !== '/organizations/new' ||
              !accountOperationSessionMatches(result, pendingOperation)))
        ) {
          setLoadMessage(m.auth_account_operation_failure());
          setLoadState('failure');
          return;
        }
        if (pendingOperation?.operation.kind === 'organization') {
          setHandle(pendingOperation.operation.handle);
          storePendingOrganizationHandle(pendingOperation.operation.handle);
        } else setHandle(readPendingOrganizationHandle());
        setUnknown(Boolean(pendingOperation));
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
        setLoadMessage(result.message);
        setLoadState('failure');
      }
    });
    return () => {
      retire();
      window.removeEventListener('pagehide', leaveDocument);
      window.removeEventListener('pageshow', restore);
    };
  }, [initial, reload, depart]);

  useLayoutEffect(() => {
    if (handleError) handleInput.current?.focus();
    else if (message) {
      if (message === m.auth_organization_conflict()) handleInput.current?.focus();
      else alert.current?.focus();
    }
  }, [handleError, message]);

  async function createOrganization() {
    if (!lifetime.current || loadState !== 'ready' || submitting.current || pending) return;
    const normalizedHandle = normalizeSignupHandle(handle);
    if (!normalizedHandle) {
      setMessage('');
      setShowRetry(false);
      setHandleError(handle ? m.auth_organization_handle_invalid() : m.auth_form_required());
      return;
    }
    setHandleError('');
    submitting.current = true;
    setPending(true);
    setMessage('');
    setShowRetry(false);
    const operation = { kind: 'organization' as const, handle: normalizedHandle };
    const pendingState = pendingAccountOperationStepUpState();
    const pendingOperation = pendingState.kind === 'pending' ? pendingState.value : null;
    const operationKey = pendingOperation?.operationKey ?? operationKeyFor(operation, accountId);
    if (
      pendingState.kind === 'invalid' ||
      (pendingOperation && !pendingAccountOperationMatches(pendingOperation, accountId, operationKey, operation))
    ) {
      setMessage(m.auth_account_operation_failure());
      submitting.current = false;
      setPending(false);
      return;
    }
    const current = lifetime.current;
    let continuation = JSON.stringify(pendingState);
    const draft = readPendingOrganizationHandle();
    const isCurrent = () =>
      lifetime.current === current &&
      JSON.stringify(pendingAccountOperationStepUpState()) === continuation &&
      readPendingOrganizationHandle() === draft;
    const before = await loadAccountSession();
    if (!isCurrent()) return;
    if (before.kind !== 'ready' || before.accountId !== accountId) {
      lifetime.current = null;
      setLoadState(before.kind === 'signed-out' ? 'signed-out' : 'failure');
      setLoadMessage(m.auth_account_operation_failure());
      submitting.current = false;
      setPending(false);
      return;
    }
    // Retain the exact command before sending it: losing this page cannot unlock another creation.
    if (!storePendingAccountOperationStepUp({ kind: 'organization', accountId, operationKey, operation })) {
      setMessage(m.auth_account_operation_failure());
      submitting.current = false;
      setPending(false);
      return;
    }
    continuation = JSON.stringify(pendingAccountOperationStepUpState());
    setUnknown(true);
    let result = await runAccountOperation(operationKey, operation, { isCurrent });
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
      setLoadState(after.kind === 'signed-out' ? 'signed-out' : 'failure');
      setLoadMessage(m.auth_account_operation_failure());
      submitting.current = false;
      setPending(false);
      return;
    }
    if (!result.ok && result.reason === 'denied' && needsProfile) result = { ok: false, reason: 'step-up' };
    if (result.ok) {
      forgetOperationKey(operation, accountId);
      storePendingOrganizationHandle('');
      clearPendingAccountOperationStepUp();
      setCreatedHandle(normalizedHandle);
      setCreatedAccountId(result.accountId);
      submitting.current = false;
      setPending(false);
      return;
    }
    if (result.reason === 'step-up') {
      if (!storePendingAccountOperationStepUp({ kind: 'organization', accountId, operationKey, operation })) {
        setMessage(m.auth_account_operation_failure());
        submitting.current = false;
        setPending(false);
        return;
      }
      bypassDeparture.current = true;
      window.location.assign(accountOperationStepUpUrl('organization'));
      return;
    }
    submitting.current = false;
    setPending(false);
    if (result.reason === 'platform-closed' || result.reason === 'denied') {
      clearPendingAccountOperationStepUp();
      setUnknown(false);
      if (result.reason === 'denied') bypassDeparture.current = true;
    }
    if (result.reason === 'platform-closed') {
      setMessage(m.auth_organization_not_open());
    } else if (result.reason === 'denied') {
      setMessage(m.auth_organization_refused());
    } else if (result.reason === 'unknown') {
      storePendingAccountOperationStepUp({ kind: 'organization', accountId, operationKey, operation });
      setUnknown(true);
      setMessage(m.auth_account_operation_unknown());
      setShowRetry(true);
    } else if (result.reason === 'unavailable') {
      setMessage(m.auth_account_operation_unavailable());
      setShowRetry(true);
    } else {
      setMessage(m.auth_account_operation_failure());
      setShowRetry(true);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void createOrganization();
  }

  if (loadState === 'signed-out')
    return (
      <AuthPage returnToSecurity heading={m.auth_organization_heading()}>
        {departure}
        <div className="auth-login-form">
          <p>{m.auth_account_operation_sign_in_required()}</p>
          <a href="/login">{m.auth_security_sign_in()}</a>
        </div>
      </AuthPage>
    );

  if (loadState === 'failure')
    return (
      <AuthPage returnToSecurity heading={m.auth_organization_heading()}>
        {departure}
        <ErrorAlert>{loadMessage}</ErrorAlert>
        <Button type="button" onClick={() => setReload((value) => value + 1)}>
          {m.auth_account_delete_retry()}
        </Button>
      </AuthPage>
    );

  if (loadState === 'loading')
    return (
      <AuthPage returnToSecurity heading={m.auth_organization_heading()}>
        {departure}
        <p role="status">{m.auth_inventory_loading()}</p>
      </AuthPage>
    );

  if (createdHandle)
    return (
      <AuthPage returnToSecurity heading={m.auth_organization_heading()}>
        {departure}
        <div className="auth-account-operation-success" role="status">
          <p>{m.auth_organization_created({ handle: createdHandle })}</p>
          {membershipId(createdAccountId) ? (
            <p>
              <a href={`/organizations/members?${new URLSearchParams({ organizationId: createdAccountId })}`}>
                {m.auth_members_heading()}
              </a>
            </p>
          ) : null}
          <a href="/security">{m.auth_security_heading()}</a>
        </div>
      </AuthPage>
    );

  return (
    <AuthPage returnToSecurity heading={m.auth_organization_heading()}>
        {departure}
      <form className="auth-login-form" method="post" action="/account-operations/approve" noValidate onSubmit={submit}>
        <p>{m.auth_organization_explanation()}</p>
        {returned ? (
          <Alert role="status">
            <AlertDescription>{m.auth_account_operation_reconfirm()}</AlertDescription>
          </Alert>
        ) : null}
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
            readOnly={pending || unknown}
            required
          />
          {handleError ? <FieldError id={handleErrorId}>{handleError}</FieldError> : null}
        </Field>
        {message ? (
          <ErrorAlert tabIndex={-1} ref={alert}>
            <p>{message}</p>
            {showRetry ? (
              <Button type="button" variant="outline" disabled={pending} onClick={() => void createOrganization()}>
                {m.auth_account_delete_retry()}
              </Button>
            ) : null}
          </ErrorAlert>
        ) : null}
        <Button type="submit" disabled={pending} aria-busy={pending} className="w-full">
          {m.auth_organization_create()}
        </Button>
      </form>
    </AuthPage>
  );
}
