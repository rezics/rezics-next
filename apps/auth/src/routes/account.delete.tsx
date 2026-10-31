import { createFileRoute } from '@tanstack/react-router';
import { AuthButton as Button } from '../button';
import { Input } from '@rezics/ui/shadcn/input';
import { Field, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';
import { ErrorAlert } from '../alert';
import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { SecurityInventory, type InventorySource } from '../security-inventory-view';
import { readPrivacyContact } from '../privacy-contact';
import {
  accountOperationSessionMatches,
  accountOperationStepUpUrl,
  clearPendingAccountOperationStepUp,
  pendingAccountOperationMatches,
  pendingAccountOperationStepUpState,
  storePendingAccountOperationStepUp,
} from '../account-operation-step-up';
import {
  forgetOperationKey,
  loadAccountSession,
  operationKeyFor,
  runAccountOperation,
  type AccountOperation,
  type AccountSessionResult,
} from '../account-operations';
import { accountOperationProfile } from '../account-operation-step-up';

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

export function DeleteAccountContent({
  privacyContact,
  initial,
  inventorySource,
}: {
  privacyContact: string | null;
  initial?: AccountSessionResult;
  inventorySource?: InventorySource;
}) {
  const [privacyBefore, privacyAfter] = privacyContact
    ? m.auth_account_delete_privacy_contact({ contact: privacyContact }).split(privacyContact)
    : [];
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [accountId, setAccountId] = useState('');
  const [needsProfile, setNeedsProfile] = useState(false);
  const [returned, setReturned] = useState(false);
  const [loadMessage, setLoadMessage] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const confirmationPhrase = m.auth_account_delete_confirmation_phrase();
  const confirmed = normalizeConfirmation(confirmation) === normalizeConfirmation(confirmationPhrase);
  const [confirmationError, setConfirmationError] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [showRetry, setShowRetry] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const submitting = useRef(false);
  const alert = useRef<HTMLDivElement>(null);
  const confirmationInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void (initial ? Promise.resolve(initial) : loadAccountSession()).then((result) => {
      if (!active) return;
      if (result.kind === 'ready') {
        const pendingState = pendingAccountOperationStepUpState();
        const pendingOperation = pendingState.kind === 'pending' ? pendingState.value : null;
        if (
          pendingState.kind === 'invalid' ||
          (pendingOperation &&
            (pendingOperation.kind !== 'delete' ||
              pendingOperation.returnTo !== '/account/delete' ||
              !accountOperationSessionMatches(result, pendingOperation)))
        ) {
          setLoadMessage(m.auth_account_operation_failure());
          setLoadState('failure');
          return;
        }
        setAccountId(result.accountId);
        setReturned(Boolean(pendingOperation));
        const expected = accountOperationProfile('delete');
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
      active = false;
    };
  }, [initial]);

  useLayoutEffect(() => {
    if (confirmationError) confirmationInput.current?.focus();
    else if (message) alert.current?.focus();
  }, [confirmationError, message]);

  async function deleteAccount() {
    if (!privacyContact || submitting.current || pending) return;
    if (!confirmed) {
      setMessage('');
      setConfirmationError(true);
      return;
    }
    setConfirmationError(false);
    submitting.current = true;
    setPending(true);
    setMessage('');
    setShowRetry(false);
    const operation: AccountOperation = { kind: 'delete', accountId };
    const operationKey = operationKeyFor(operation, accountId);
    const pendingState = pendingAccountOperationStepUpState();
    const pendingOperation = pendingState.kind === 'pending' ? pendingState.value : null;
    if (
      pendingState.kind === 'invalid' ||
      (pendingOperation && !pendingAccountOperationMatches(pendingOperation, accountId, operationKey, operation))
    ) {
      setMessage(m.auth_account_operation_failure());
      submitting.current = false;
      setPending(false);
      return;
    }
    let result = await runAccountOperation(operationKey, operation);
    if (!result.ok && result.reason === 'denied' && needsProfile) result = { ok: false, reason: 'step-up' };
    if (result.ok) {
      forgetOperationKey(operation, accountId);
      clearPendingAccountOperationStepUp();
      setDeleted(true);
      submitting.current = false;
      setPending(false);
      return;
    }
    if (result.reason === 'step-up') {
      if (!storePendingAccountOperationStepUp({ kind: 'delete', accountId, operationKey, operation })) {
        setMessage(m.auth_account_operation_failure());
        submitting.current = false;
        setPending(false);
        return;
      }
      window.location.assign(accountOperationStepUpUrl('delete'));
      return;
    }
    submitting.current = false;
    setPending(false);
    setConfirmation('');
    if (result.reason === 'denied') {
      setMessage(m.auth_account_delete_denied());
    } else if (result.reason === 'platform-closed') {
      setMessage(m.auth_organization_not_open());
    } else if (result.reason === 'unknown') {
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
    void deleteAccount();
  }

  if (loadState === 'signed-out')
    return (
      <AuthPage returnToSecurity heading={m.auth_account_delete_heading()}>
        <div className="auth-login-form">
          <p>{m.auth_account_operation_sign_in_required()}</p>
          <a href="/login">{m.auth_security_sign_in()}</a>
        </div>
      </AuthPage>
    );

  if (loadState === 'failure')
    return (
      <AuthPage returnToSecurity heading={m.auth_account_delete_heading()}>
        <ErrorAlert>{loadMessage}</ErrorAlert>
      </AuthPage>
    );

  if (loadState === 'loading')
    return (
      <AuthPage returnToSecurity heading={m.auth_account_delete_heading()}>
        <p role="status">{m.auth_inventory_loading()}</p>
      </AuthPage>
    );

  if (deleted)
    return (
      <AuthPage heading={m.auth_account_delete_heading()}>
        <Alert role="status" className="mt-8">
          <AlertDescription>
            <p>{m.auth_account_delete_success()}</p>
            <p>{m.auth_account_delete_cleanup_pending()}</p>
            <p>{m.auth_account_delete_finality()}</p>
          </AlertDescription>
        </Alert>
      </AuthPage>
    );

  return (
    <AuthPage returnToSecurity heading={m.auth_account_delete_heading()}>
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
      <div className="mt-8">
        <SecurityInventory preflight {...(inventorySource ? { source: inventorySource } : {})} />
      </div>
      <form className="auth-login-form" method="post" action="/account-operations/approve" noValidate onSubmit={submit}>
        {returned ? (
          <Alert role="status">
            <AlertDescription>{m.auth_account_operation_reconfirm()}</AlertDescription>
          </Alert>
        ) : null}
        <p>{m.auth_account_delete_finality()}</p>
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
              setConfirmation(value);
              if (normalizeConfirmation(value) === normalizeConfirmation(confirmationPhrase))
                setConfirmationError(false);
            }}
          />
          {confirmationError ? (
            <FieldError id="account-delete-confirmation-error">{m.auth_account_delete_confirmation_error()}</FieldError>
          ) : null}
        </Field>
        {message ? (
          <ErrorAlert tabIndex={-1} ref={alert}>
            <p>{message}</p>
            <a href="#account-delete-prerequisites" className="underline underline-offset-4">
              {m.auth_account_delete_prerequisites_heading()}
            </a>
            {showRetry ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending || !confirmed}
                onClick={() => void deleteAccount()}
              >
                {m.auth_account_delete_retry()}
              </Button>
            ) : null}
          </ErrorAlert>
        ) : null}
        <Button
          type="submit"
          variant="destructive"
          disabled={!privacyContact || pending || !confirmed}
          aria-busy={pending}
          className="w-full"
        >
          {m.auth_account_delete_submit()}
        </Button>
      </form>
    </AuthPage>
  );
}
