import { createFileRoute } from '@tanstack/react-router';
import { Button } from '@rezics/ui/button';
import { Checkbox } from '@rezics/ui/checkbox';
import { Field, FieldError } from '@rezics/ui/field';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';
import { ErrorAlert } from '../alert';
import {
  forgetOperationKey,
  loadAccountSession,
  operationKeyFor,
  runAccountOperation,
  type AccountOperation,
} from '../account-operations';

type LoadState = 'loading' | 'ready' | 'signed-out' | 'failure';

const STEP_UP_URL = '/step-up?return_to=%2Faccount%2Fdelete';

export const Route = createFileRoute('/account/delete')({
  component: DeleteAccountPage,
});

function DeleteAccountPage() {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [accountId, setAccountId] = useState('');
  const [loadMessage, setLoadMessage] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [confirmationError, setConfirmationError] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [showRetry, setShowRetry] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const submitting = useRef(false);
  const alert = useRef<HTMLDivElement>(null);

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
    if (confirmationError) document.querySelector<HTMLInputElement>('#account-delete-confirmation input')?.focus();
    else if (message) alert.current?.focus();
  }, [confirmationError, message]);

  async function deleteAccount() {
    if (submitting.current || pending) return;
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
        <ul className="auth-account-operation-requirements">
          <li>{m.auth_account_delete_no_automated_accounts()}</li>
          <li>{m.auth_account_delete_not_last_owner()}</li>
          <li>{m.auth_account_delete_no_pending_transfer()}</li>
        </ul>
      </div>
      <form className="auth-login-form" method="post" action="/account-operations/approve" noValidate onSubmit={submit}>
        <Field id="account-delete-confirmation" invalid={confirmationError}>
          <Checkbox
            checked={confirmed}
            onCheckedChange={(details) => {
              setConfirmed(details.checked === true);
              if (details.checked === true) setConfirmationError(false);
            }}
          >
            {m.auth_account_delete_confirmation()}
          </Checkbox>
          {confirmationError ? <FieldError>{m.auth_form_required()}</FieldError> : null}
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
        <Button type="submit" variant="destructive" disabled={pending} isLoading={pending} className="w-full">
          {m.auth_account_delete_submit()}
        </Button>
      </form>
    </AuthPage>
  );
}
