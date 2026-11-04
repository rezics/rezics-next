import { createFileRoute, useBlocker, useRouter } from '@tanstack/react-router';
import { AuthButton as Button } from '../button';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@rezics/ui/shadcn/alert-dialog';
import { Input } from '@rezics/ui/shadcn/input';
import { Field, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { useCallback, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';
import {
  loadAccountDeletionPage,
  type AccountDeletionPage,
  type AccountDeletionPageSource,
} from '../account-deletion-page';
import { AccountIdentitySummary } from '../account-identity-view';
import { ErrorAlert } from '../alert';
import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { SecurityInventory, type InventorySource } from '../security-inventory-view';
import { readPrivacyContact } from '../privacy-contact';
import {
  accountOperationStepUpUrl,
  clearPendingAccountOperationStepUp,
  pendingAccountOperationMatches,
  pendingAccountOperationStepUpState,
  storePendingAccountOperationStepUp,
} from '../account-operation-step-up';
import { forgetOperationKey, operationKeyFor, runAccountOperation, type AccountOperation } from '../account-operations';
import {
  accountDeletionAttemptMatches,
  accountDeletionAttemptMayHaveCommitted,
  beginAccountDeletionAttempt,
  createAccountDeletionAttempt,
  finishAccountDeletionAttempt,
  markAccountDeletionExecutionDispatched,
  restoreAccountDeletionAttempt,
  retireAccountDeletionAttempt,
  type AccountDeletionAttempt,
} from '../account-deletion-attempt';
import { AccountDeletionRecovery } from '../account-deletion-recovery';

type LoadState = 'loading' | 'ready' | 'signed-out' | 'failure';

function normalizeConfirmation(value: string): string {
  return value.trim().normalize('NFC').toLowerCase();
}

export const Route = createFileRoute('/account/delete')({
  head: () => ({ meta: [{ title: `${m.auth_account_delete_heading()} · REZICS` }] }),
  loader: () => readPrivacyContact(),
  component: DeleteAccountPage,
});

function DeleteAccountPage() {
  const privacyContact = Route.useLoaderData();
  return <DeleteAccountContent privacyContact={privacyContact} />;
}

function DeletionDeparture({
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
        <AlertDialogTitle>{m.auth_account_delete_departure_heading()}</AlertDialogTitle>
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

export function DeleteAccountContent({
  privacyContact,
  initial,
  inventorySource,
  source = loadAccountDeletionPage,
}: {
  privacyContact: string | null;
  initial?: AccountDeletionPage;
  inventorySource?: InventorySource;
  source?: AccountDeletionPageSource;
}) {
  const [privacyBefore, privacyAfter] = privacyContact
    ? m.auth_account_delete_privacy_contact({ contact: privacyContact }).split(privacyContact)
    : [];
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [accountId, setAccountId] = useState('');
  const [advice, setAdvice] = useState<AccountDeletionPage | null>(null);
  const [returned, setReturned] = useState(false);
  const [loadMessage, setLoadMessage] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const confirmationPhrase = m.auth_account_delete_confirmation_phrase();
  const confirmed = normalizeConfirmation(confirmation) === normalizeConfirmation(confirmationPhrase);
  const [confirmationError, setConfirmationError] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [requiresAdviceRefresh, setRequiresAdviceRefresh] = useState(false);
  const [attempt, setAttempt] = useState<AccountDeletionAttempt | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [identityVisible, setIdentityVisible] = useState(true);
  const submitting = useRef(false);
  const refreshing = useRef(false);
  const router = useRouter({ warn: false });
  const review = useRef<HTMLFormElement>(null);
  const confirmationValue = useRef('');
  const attemptRef = useRef<AccountDeletionAttempt | null>(null);
  const alert = useRef<HTMLDivElement>(null);
  const confirmationInput = useRef<HTMLInputElement>(null);
  const authorityGeneration = useRef(0);
  const activeAccount = useRef('');
  const intendedAccount = useRef('');
  const accepted = useRef(false);
  const [reload, setReload] = useState(0);
  const renderedGeneration = authorityGeneration.current;
  const identity = {
    state:
      advice?.kind === 'review' && identityVisible
        ? { kind: 'ready' as const, accountId: advice.accountId, email: advice.email }
        : { kind: 'unavailable' as const },
    retry: () => {
      setIdentityVisible(true);
      refreshAdvice();
    },
  };

  const shouldWarn = useCallback(
    () =>
      !accepted.current &&
      Boolean(confirmationValue.current.trim() || accountDeletionAttemptMayHaveCommitted(attemptRef.current)),
    [],
  );
  const publishAttempt = (next: AccountDeletionAttempt | null) => {
    attemptRef.current = next;
    setAttempt(next);
  };
  const recoveryVisible = Boolean(
    attempt &&
      (attempt.uncertain || attempt.phase === 'approval' || attempt.phase === 'execution' || requiresAdviceRefresh),
  );
  const recoveryPanel = () => (
    <AccountDeletionRecovery
      attempt={attempt}
      visible={recoveryVisible}
      refreshing={loadState === 'loading'}
      onRefresh={refreshAdvice}
    />
  );
  const page = (content: ReactNode) => (
    <>
      {router ? (
        <DeletionDeparture
          shouldWarn={shouldWarn}
          leave={() => clearAuthority('denied')}
          focus={() => {
            if (confirmationInput.current && !confirmationInput.current.disabled) confirmationInput.current.focus();
            else review.current?.focus();
          }}
        />
      ) : null}
      {content}
    </>
  );

  useLayoutEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (!shouldWarn()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const follow = (event: MouseEvent) => {
      if (
        !router ||
        !shouldWarn() ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (
        !(link instanceof HTMLElement) ||
        link.hasAttribute('download') ||
        (link.getAttribute('target') && link.getAttribute('target') !== '_self')
      )
        return;
      const url = new URL(link.getAttribute('href')!, window.location.href);
      if (url.origin !== window.location.origin || link.getAttribute('href')?.startsWith('#')) return;
      event.preventDefault();
      void router.navigate({ href: `${url.pathname}${url.search}${url.hash}` });
    };
    window.addEventListener('beforeunload', unload);
    document.addEventListener('click', follow);
    return () => {
      window.removeEventListener('beforeunload', unload);
      document.removeEventListener('click', follow);
    };
  }, [router, shouldWarn]);

  function clearAuthority(kind: 'signed-out' | 'denied') {
    authorityGeneration.current++;
    activeAccount.current = '';
    submitting.current = false;
    setAccountId('');
    confirmationValue.current = '';
    setConfirmation('');
    setConfirmationError(false);
    setPending(false);
    setMessage('');
    setReturned(false);
    setAdvice(null);
    setIdentityVisible(true);
    publishAttempt(attemptRef.current ? retireAccountDeletionAttempt(attemptRef.current) : null);
    setLoadMessage(m.auth_account_operation_failure());
    setLoadState(kind === 'signed-out' ? 'signed-out' : 'failure');
  }

  function refreshAdvice() {
    if (pending || submitting.current || refreshing.current || loadState === 'loading') return;
    refreshing.current = true;
    setRequiresAdviceRefresh(true);
    setReload((value) => value + 1);
  }

  useLayoutEffect(() => {
    let active = true;
    clearAuthority('denied');
    setDeleted(accepted.current);
    setLoadState(accepted.current ? 'ready' : 'loading');
    const generation = authorityGeneration.current;
    const controller = new AbortController();
    const retire = () => {
      active = false;
      controller.abort();
      refreshing.current = false;
      clearAuthority('denied');
      if (accepted.current) setLoadState('ready');
    };
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) {
        retire();
        setReload((value) => value + 1);
      }
    };
    window.addEventListener('pagehide', retire);
    window.addEventListener('pageshow', restore);
    if (!accepted.current)
      void (initial && reload === 0 ? Promise.resolve(initial) : source(controller.signal))
        .catch((): AccountDeletionPage => ({ kind: 'unavailable' }))
        .then((result) => {
          if (!active || authorityGeneration.current !== generation) return;
          if (result.kind === 'review' || result.kind === 'authentication-required') {
            const pendingState = pendingAccountOperationStepUpState();
            const pendingOperation = pendingState.kind === 'pending' ? pendingState.value : null;
            if (
              (intendedAccount.current && intendedAccount.current !== result.accountId) ||
              pendingState.kind === 'invalid' ||
              (pendingOperation &&
                (pendingOperation.kind !== 'delete' ||
                  pendingOperation.returnTo !== '/account/delete' ||
                  pendingOperation.accountId !== result.accountId ||
                  (attemptRef.current &&
                    !accountDeletionAttemptMatches(
                      attemptRef.current,
                      result.accountId,
                      pendingOperation.operationKey,
                    )))) ||
              (attemptRef.current && attemptRef.current.operation.accountId !== result.accountId)
            ) {
              activeAccount.current = '';
              setAccountId('');
              setAdvice(null);
              confirmationValue.current = '';
              setConfirmation('');
              setConfirmationError(false);
              refreshing.current = false;
              setLoadMessage(m.auth_account_operation_failure());
              setLoadState('failure');
              return;
            }
            intendedAccount.current = result.accountId;
            activeAccount.current = result.accountId;
            setAccountId(result.accountId);
            if (pendingOperation && !attemptRef.current) {
              const restored = restoreAccountDeletionAttempt(pendingOperation);
              if (restored) publishAttempt(restored);
            }
            setReturned(Boolean(pendingOperation));
            setAdvice(result);
            setIdentityVisible(true);
            setRequiresAdviceRefresh(false);
            refreshing.current = false;
            setLoadState('ready');
          } else if (result.kind === 'signed-out') {
            activeAccount.current = '';
            setAccountId('');
            setAdvice(null);
            confirmationValue.current = '';
            setConfirmation('');
            setConfirmationError(false);
            refreshing.current = false;
            setLoadState('signed-out');
          } else {
            activeAccount.current = '';
            setAccountId('');
            setAdvice(null);
            confirmationValue.current = '';
            setConfirmation('');
            setConfirmationError(false);
            refreshing.current = false;
            setLoadMessage(
              result.kind === 'refused'
                ? m.auth_account_delete_denied()
                : result.kind === 'changed'
                  ? m.auth_account_delete_review_changed()
                  : m.auth_account_operation_unavailable(),
            );
            setLoadState('failure');
          }
        });
    return () => {
      active = false;
      controller.abort();
      authorityGeneration.current++;
      activeAccount.current = '';
      window.removeEventListener('pagehide', retire);
      window.removeEventListener('pageshow', restore);
    };
  }, [initial, reload, source]);

  useLayoutEffect(() => {
    if (confirmationError) confirmationInput.current?.focus();
    else if (message) alert.current?.focus();
  }, [confirmationError, message]);

  async function deleteAccount() {
    if (
      !privacyContact ||
      authorityGeneration.current !== renderedGeneration ||
      submitting.current ||
      pending ||
      requiresAdviceRefresh ||
      loadState !== 'ready' ||
      advice?.kind !== 'review' ||
      advice.action !== 'available' ||
      activeAccount.current !== accountId
    )
      return;
    if (!confirmed) {
      setMessage('');
      setConfirmationError(true);
      return;
    }
    setConfirmationError(false);
    submitting.current = true;
    setPending(true);
    setMessage('');
    const generation = authorityGeneration.current;
    const pendingState = pendingAccountOperationStepUpState();
    const pendingOperation = pendingState.kind === 'pending' ? pendingState.value : null;
    const currentAttempt = attemptRef.current;
    const retainedAttempt = currentAttempt?.operation.accountId === accountId ? currentAttempt : null;
    const operation: AccountOperation = retainedAttempt?.operation ?? { kind: 'delete', accountId };
    const operationKey = retainedAttempt?.operationKey ?? operationKeyFor(operation, accountId);
    if (
      pendingState.kind === 'invalid' ||
      (pendingOperation && !pendingAccountOperationMatches(pendingOperation, accountId, operationKey, operation))
    ) {
      setMessage(m.auth_account_operation_failure());
      submitting.current = false;
      setPending(false);
      return;
    }
    let continuation = JSON.stringify(pendingState);
    const submittedHint = retainedAttempt?.submitted ?? Boolean(pendingOperation && pendingOperation.submitted !== false);
    const baseAttempt = retainedAttempt ?? createAccountDeletionAttempt(accountId, operationKey, submittedHint);
    const started = beginAccountDeletionAttempt(baseAttempt, generation);
    const runId = started.runId;
    publishAttempt(started);
    const isCurrent = () =>
      authorityGeneration.current === generation &&
      activeAccount.current === accountId &&
      attemptRef.current?.runId === runId &&
      JSON.stringify(pendingAccountOperationStepUpState()) === continuation;
    // Persist only the safe exact continuation before approval. Approval alone stays unsent.
    if (
      !storePendingAccountOperationStepUp({
        kind: 'delete',
        accountId,
        operationKey,
        operation,
        submitted: started.submitted,
      })
    ) {
      setMessage(m.auth_account_operation_failure());
      submitting.current = false;
      setPending(false);
      return;
    }
    continuation = JSON.stringify(pendingAccountOperationStepUpState());
    const onExecutionDispatch = () => {
      if (!isCurrent()) return false;
      const state = pendingAccountOperationStepUpState();
      if (
        state.kind !== 'pending' ||
        !pendingAccountOperationMatches(state.value, accountId, operationKey, operation)
      )
        return false;
      if (
        !storePendingAccountOperationStepUp({ kind: 'delete', accountId, operationKey, operation, submitted: true })
      )
        return false;
      const updated = pendingAccountOperationStepUpState();
      if (
        updated.kind !== 'pending' ||
        !pendingAccountOperationMatches(updated.value, accountId, operationKey, operation) ||
        updated.value.submitted !== true
      )
        return false;
      continuation = JSON.stringify(updated);
      const activeAttempt = attemptRef.current;
      if (!activeAttempt || activeAttempt.runId !== runId) return false;
      publishAttempt(markAccountDeletionExecutionDispatched(activeAttempt, runId));
      return isCurrent();
    };
    const result = await runAccountOperation(operationKey, operation, {
      isCurrent,
      retryUncertain: true,
      onExecutionDispatch,
    });
    if (!isCurrent()) return;
    const activeAttempt = attemptRef.current;
    if (!activeAttempt) return;
    const completedAttempt = finishAccountDeletionAttempt(activeAttempt, runId, result);
    publishAttempt(completedAttempt);
    if (result.ok) {
      accepted.current = true;
      forgetOperationKey(operation, accountId);
      clearPendingAccountOperationStepUp();
      publishAttempt(null);
      clearAuthority('signed-out');
      setDeleted(true);
      setLoadState('ready');
      submitting.current = false;
      setPending(false);
      return;
    }
    if (result.reason === 'step-up') {
      if (
        !storePendingAccountOperationStepUp({
          kind: 'delete',
          accountId,
          operationKey,
          operation,
          submitted: completedAttempt.submitted,
        })
      ) {
        setMessage(m.auth_account_operation_failure());
        submitting.current = false;
        setPending(false);
        return;
      }
      clearAuthority('signed-out');
      window.location.assign(accountOperationStepUpUrl('delete'));
      return;
    }
    submitting.current = false;
    setPending(false);
    confirmationValue.current = '';
    setConfirmation('');
    setRequiresAdviceRefresh(true);
    if (result.reason === 'denied') {
      // A current refusal hides the identity but cannot settle an earlier unknown execution.
      activeAccount.current = '';
      setAccountId('');
      setIdentityVisible(false);
      setAdvice({ kind: 'refused' });
      setMessage(m.auth_account_delete_denied());
    } else if (result.reason === 'platform-closed') {
      setMessage(m.auth_organization_not_open());
    } else if (result.reason === 'unknown') {
      setMessage(m.auth_account_operation_unknown());
    } else if (result.reason === 'unavailable') {
      setMessage(m.auth_account_operation_unavailable());
    } else {
      setMessage(m.auth_account_operation_failure());
    }
  }

  function authenticate() {
    if (
      pending ||
      requiresAdviceRefresh ||
      authorityGeneration.current !== renderedGeneration ||
      advice?.kind !== 'authentication-required' ||
      !accountId ||
      activeAccount.current !== accountId
    )
      return;
    const currentAttempt = attemptRef.current;
    const retainedAttempt = currentAttempt?.operation.accountId === accountId ? currentAttempt : null;
    const operation: AccountOperation = retainedAttempt?.operation ?? { kind: 'delete', accountId };
    const state = pendingAccountOperationStepUpState();
    if (
      state.kind === 'invalid' ||
      (state.kind === 'pending' &&
        !pendingAccountOperationMatches(state.value, accountId, state.value.operationKey, operation))
    ) {
      clearAuthority('denied');
      return;
    }
    const operationKey = retainedAttempt
      ? retainedAttempt.operationKey
      : state.kind === 'pending'
        ? state.value.operationKey
        : operationKeyFor(operation, accountId);
    const submitted = retainedAttempt
      ? retainedAttempt.submitted
      : state.kind === 'pending'
        ? state.value.submitted !== false
        : false;
    if (
      !storePendingAccountOperationStepUp({
        kind: 'delete',
        accountId,
        operationKey,
        operation,
        submitted,
      })
    ) {
      setMessage(m.auth_account_operation_failure());
      return;
    }
    if (!retainedAttempt) publishAttempt(createAccountDeletionAttempt(accountId, operationKey, submitted));
    clearAuthority('signed-out');
    window.location.assign(accountOperationStepUpUrl('delete'));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void deleteAccount();
  }

  if (loadState === 'signed-out')
    return page(
      <AuthPage returnToSecurity heading={m.auth_account_delete_heading()}>
        <div className="auth-login-form">
          {recoveryPanel()}
          <p>{m.auth_account_operation_sign_in_required()}</p>
          <a href="/login">{m.auth_security_sign_in()}</a>
          <p>
            <a href="/security">{m.auth_account_operation_return()}</a>
          </p>
        </div>
      </AuthPage>,
    );

  if (loadState === 'failure')
    return page(
      <AuthPage returnToSecurity heading={m.auth_account_delete_heading()}>
        <div className="auth-login-form">
          {recoveryPanel()}
          <ErrorAlert>{loadMessage}</ErrorAlert>
          {!recoveryVisible ? (
            <Button type="button" onClick={refreshAdvice}>
              {m.auth_account_delete_retry()}
            </Button>
          ) : null}
          <a href="/login">{m.auth_security_sign_in()}</a>
          <p>
            <a href="/security">{m.auth_account_operation_return()}</a>
          </p>
        </div>
      </AuthPage>,
    );

  if (loadState === 'loading')
    return page(
      <AuthPage
        returnToSecurity
        heading={m.auth_account_delete_heading()}
        identity={
          <AccountIdentitySummary accountId="" state={{ kind: 'loading' }} action="delete" retry={identity.retry} />
        }
      >
        {recoveryPanel()}
        <p role="status">{m.auth_inventory_loading()}</p>
      </AuthPage>,
    );

  if (deleted)
    return page(
      <AuthPage heading={m.auth_account_delete_heading()}>
        <Alert role="status" className="mt-8">
          <AlertDescription>
            <p>{m.auth_account_delete_success()}</p>
            <p>{m.auth_account_delete_cleanup_pending()}</p>
            <p>{m.auth_account_delete_finality()}</p>
          </AlertDescription>
        </Alert>
      </AuthPage>,
    );

  return page(
    <AuthPage
      returnToSecurity
      heading={m.auth_account_delete_heading()}
      identity={
        advice?.kind === 'review' ? (
          <AccountIdentitySummary
            accountId={accountId}
            state={identityVisible ? identity.state : { kind: 'unavailable' }}
            action="delete"
            retry={() => {
              setIdentityVisible(true);
              identity.retry();
            }}
          />
        ) : undefined
      }
    >
      <div className="auth-account-operation-copy">
        <p>{m.auth_account_delete_description()}</p>
        <p>{m.auth_account_delete_cleanup_explanation()}</p>
        <section aria-labelledby="account-delete-erased" className="grid gap-2">
          <h2 id="account-delete-erased" className="font-semibold">
            {m.auth_account_delete_erased_heading()}
          </h2>
          <ul className="auth-account-operation-requirements">
            <li>{m.auth_account_delete_erased_profile()}</li>
            <li>{m.auth_account_delete_erased_library()}</li>
            <li>{m.auth_account_delete_erased_collections()}</li>
            <li>{m.auth_account_delete_erased_logs()}</li>
          </ul>
        </section>
        <section aria-labelledby="account-delete-retained" className="grid gap-2">
          <h2 id="account-delete-retained" className="font-semibold">
            {m.auth_account_delete_retained_heading()}
          </h2>
          <ul className="auth-account-operation-requirements">
            <li>{m.auth_account_delete_retained_collections()}</li>
            <li>{m.auth_account_delete_retained_posts()}</li>
          </ul>
          <p>{m.auth_account_delete_retained_attribution()}</p>
          <p>{m.auth_account_delete_retention_limits()}</p>
        </section>
        <p>{m.auth_account_delete_prepare()}</p>
        {privacyContact ? (
          <p>
            {privacyBefore}
            <a href={privacyContact} className="wrap-anywhere underline underline-offset-4">
              {privacyContact}
            </a>
            {privacyAfter}
          </p>
        ) : (
          <ErrorAlert>{m.auth_account_delete_unavailable()}</ErrorAlert>
        )}
        <section
          id="account-delete-prerequisites"
          aria-labelledby="account-delete-prerequisites-heading"
          className="grid gap-2"
        >
          <h2 id="account-delete-prerequisites-heading" className="font-semibold">
            {m.auth_account_delete_prerequisites_heading()}
          </h2>
          <p>{m.auth_account_delete_prerequisites_description()}</p>
          <p>{m.auth_account_delete_submit_requirements()}</p>
          <ul className="auth-account-operation-requirements">
            <li>
              <p>{m.auth_account_delete_no_automated_accounts()}</p>
              <a href="/operators/transfer">{m.auth_transfer_heading()}</a>
            </li>
            <li>
              <p>{m.auth_account_delete_not_last_owner()}</p>
              <p>{m.auth_account_delete_ownership_navigation()}</p>
              <a href="/security">{m.auth_account_operation_return()}</a>
            </li>
            <li>
              <p>{m.auth_account_delete_no_pending_transfer()}</p>
              <a href="/operators/transfer">{m.auth_transfer_heading()}</a>
            </li>
          </ul>
        </section>
      </div>
      {advice?.kind === 'review' ? (
        <div className="mt-8">
          <SecurityInventory
            preflight
            {...(inventorySource ? { source: inventorySource } : {})}
            onSessionEnded={() => clearAuthority('signed-out')}
          />
        </div>
      ) : (
        <p>
          <a href="/security">{m.auth_account_operation_return()}</a>
        </p>
      )}
      {recoveryPanel()}
      <form
        ref={review}
        tabIndex={-1}
        className="auth-login-form"
        method="post"
        action="/account-operations/approve"
        noValidate
        onSubmit={submit}
      >
        {returned && !attempt?.uncertain ? (
          <Alert role="status">
            <AlertDescription>{m.auth_account_operation_reconfirm()}</AlertDescription>
          </Alert>
        ) : null}
        <p>{m.auth_account_delete_finality()}</p>
        {advice?.kind === 'authentication-required' ? (
          <Alert role="status">
            <AlertDescription>
              <p>{m.auth_account_delete_authentication_required()}</p>
              <Button type="button" disabled={requiresAdviceRefresh || pending} onClick={authenticate}>
                {m.auth_account_delete_authenticate()}
              </Button>
            </AlertDescription>
          </Alert>
        ) : advice?.kind === 'review' && advice.action === 'available' ? (
          <p>{m.auth_account_delete_advice_available()}</p>
        ) : !message ? (
          <ErrorAlert>{m.auth_account_delete_denied()}</ErrorAlert>
        ) : null}
        {advice?.kind === 'review' && advice.action === 'available' && !requiresAdviceRefresh ? (
          <Field id="account-delete-confirmation" data-invalid={confirmationError}>
            <FieldLabel htmlFor="account-delete-input">
              {m.auth_account_delete_confirmation_prompt({ phrase: confirmationPhrase })}
            </FieldLabel>
            <Input
              ref={confirmationInput}
              id="account-delete-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              aria-invalid={confirmationError || undefined}
              aria-describedby={confirmationError ? 'account-delete-confirmation-error' : undefined}
              value={confirmation}
              onChange={(event) => {
                const value = event.target.value;
                confirmationValue.current = value;
                setConfirmation(value);
                if (normalizeConfirmation(value) === normalizeConfirmation(confirmationPhrase))
                  setConfirmationError(false);
              }}
            />
            {confirmationError ? (
              <FieldError id="account-delete-confirmation-error">
                {m.auth_account_delete_confirmation_error()}
              </FieldError>
            ) : null}
          </Field>
        ) : null}
        {message ? (
          <ErrorAlert tabIndex={-1} ref={alert}>
            <p>{message}</p>
            <a href="#account-delete-prerequisites" className="underline underline-offset-4">
              {m.auth_account_delete_prerequisites_heading()}
            </a>
          </ErrorAlert>
        ) : null}
        <Button
          type="submit"
          variant="destructive"
          disabled={
            !privacyContact ||
            pending ||
            requiresAdviceRefresh ||
            !confirmed ||
            advice?.kind !== 'review' ||
            advice.action !== 'available'
          }
          aria-busy={pending}
          className="w-full"
        >
          {attempt?.uncertain ? m.auth_account_delete_recovery_repeat() : m.auth_account_delete_submit()}
        </Button>
      </form>
    </AuthPage>,
  );
}
