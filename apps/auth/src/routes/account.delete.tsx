import { createFileRoute } from '@tanstack/react-router';
import { AuthButton as Button } from '../button';
import { Input } from '@rezics/ui/shadcn/input';
import { Field, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';
import { ErrorAlert } from '../alert';
import { readPrivacyContact } from '../privacy-contact';
import {
  forgetOperationKey,
  loadAccountSession,
  operationKeyFor,
  runAccountOperation,
  type AccountOperation,
} from '../account-operations';

type LoadState = 'loading' | 'ready' | 'signed-out' | 'failure';

const STEP_UP_URL = '/step-up?return_to=%2Faccount%2Fdelete';

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
  const [privacyBefore, privacyAfter] = privacyContact
    ? m.auth_account_delete_privacy_contact({ contact: privacyContact }).split(privacyContact)
    : [];
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [accountId, setAccountId] = useState('');
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
    void loadAccountSession().then((result) => {
      if (!active) return;
      if (result.kind === 'ready') {
        setAccountId(result.accountId);
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
  }, []);

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
    const result = await runAccountOperation(operationKeyFor(operation), operation);
    if (result.ok) {
      forgetOperationKey(operation);
      setDeleted(true);
      submitting.current = false;
      setPending(false);
      return;
    }
    if (result.reason === 'step-up') {
      window.location.assign(STEP_UP_URL);
      return;
    }
    submitting.current = false;
    setPending(false);
    if (result.reason === 'denied') {
      setMessage(m.auth_account_delete_denied());
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
      <AuthPage heading={m.auth_account_delete_heading()}>
        <div className="auth-login-form">
          <p>{m.auth_account_operation_sign_in_required()}</p>
          <a href="/login">{m.auth_security_sign_in()}</a>
        </div>
      </AuthPage>
    );

  if (loadState === 'failure')
    return (
      <AuthPage heading={m.auth_account_delete_heading()}>
        <ErrorAlert>{loadMessage}</ErrorAlert>
      </AuthPage>
    );

  if (loadState === 'loading') return <AuthPage heading={m.auth_account_delete_heading()} />;

  if (deleted)
    return (
      <AuthPage heading={m.auth_account_delete_heading()}>
        <div className="auth-login-alert auth-account-operation-success" role="status">
          {m.auth_account_delete_success()}
        </div>
      </AuthPage>
    );

  return (
    <AuthPage heading={m.auth_account_delete_heading()}>
      <div className="auth-account-operation-copy">
        <p>{m.auth_account_delete_description()}</p>
        <section aria-labelledby="account-delete-erased" className="grid gap-2">
          <h2 id="account-delete-erased" className="font-semibold">
            {m.auth_account_delete_erased_heading()}
          </h2>
          <ul className="auth-account-operation-requirements">
            <li>{m.auth_account_delete_erased_profile()}</li>
            <li>{m.auth_account_delete_erased_library()}</li>
            <li>{m.auth_account_delete_erased_collections()}</li>
          </ul>
        </section>
        <section aria-labelledby="account-delete-retained" className="grid gap-2">
          <h2 id="account-delete-retained" className="font-semibold">
            {m.auth_account_delete_retained_heading()}
          </h2>
          <ul className="auth-account-operation-requirements">
            <li>{m.auth_account_delete_retained_collections()}</li>
            <li>{m.auth_account_delete_retained_logs()}</li>
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
        <ul className="auth-account-operation-requirements">
          <li>{m.auth_account_delete_no_automated_accounts()}</li>
          <li>{m.auth_account_delete_not_last_owner()}</li>
          <li>{m.auth_account_delete_no_pending_transfer()}</li>
        </ul>
      </div>
      <form className="auth-login-form" method="post" action="/account-operations/approve" noValidate onSubmit={submit}>
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
            {showRetry ? (
              <Button type="button" variant="outline" disabled={pending} onClick={() => void deleteAccount()}>
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
