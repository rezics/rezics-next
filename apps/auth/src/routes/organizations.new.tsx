import { createFileRoute } from '@tanstack/react-router';
import { AuthButton as Button } from '../button';
import { Field, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';
import { ErrorAlert } from '../alert';
import {
  forgetOperationKey,
  loadAccountSession,
  operationKeyFor,
  readPendingOrganizationHandle,
  runAccountOperation,
  storePendingOrganizationHandle,
} from '../account-operations';
import { normalizeSignupHandle } from '../signup';

type LoadState = 'loading' | 'ready' | 'signed-out' | 'failure';

const handleId = 'organization-handle';
const handleErrorId = 'organization-handle-error';
const STEP_UP_URL = '/step-up?return_to=%2Forganizations%2Fnew';

export const Route = createFileRoute('/organizations/new')({
  head: () => ({ meta: [{ title: `${m.auth_organization_heading()} · REZICS` }] }),
  component: NewOrganizationPage,
});

function NewOrganizationPage() {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [handle, setHandle] = useState('');
  const [handleError, setHandleError] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [showRetry, setShowRetry] = useState(false);
  const [createdHandle, setCreatedHandle] = useState('');
  const [loadMessage, setLoadMessage] = useState('');
  const submitting = useRef(false);
  const handleInput = useRef<HTMLInputElement>(null);
  const alert = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    setHandle(readPendingOrganizationHandle());
    void loadAccountSession().then((result) => {
      if (!active) return;
      if (result.kind === 'ready') {
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
    if (handleError) handleInput.current?.focus();
    else if (message) {
      if (message === m.auth_organization_conflict()) handleInput.current?.focus();
      else alert.current?.focus();
    }
  }, [handleError, message]);

  async function createOrganization() {
    if (submitting.current || pending) return;
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
    const result = await runAccountOperation(operationKeyFor(operation), operation);
    if (result.ok) {
      forgetOperationKey(operation);
      storePendingOrganizationHandle('');
      setCreatedHandle(normalizedHandle);
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
    if (result.reason === 'platform-closed') {
      setMessage(m.auth_organization_not_open());
    } else if (result.reason === 'denied') {
      setMessage(m.auth_organization_conflict());
      setHandleError(m.auth_signup_handle_unavailable());
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
      <AuthPage heading={m.auth_organization_heading()}>
        <div className="auth-login-form">
          <p>{m.auth_account_operation_sign_in_required()}</p>
          <a href="/login">{m.auth_security_sign_in()}</a>
        </div>
      </AuthPage>
    );

  if (loadState === 'failure')
    return (
      <AuthPage heading={m.auth_organization_heading()}>
        <ErrorAlert>{loadMessage}</ErrorAlert>
      </AuthPage>
    );

  if (loadState === 'loading') return <AuthPage heading={m.auth_organization_heading()} />;

  if (createdHandle)
    return (
      <AuthPage heading={m.auth_organization_heading()}>
        <div className="auth-account-operation-success" role="status">
          <p>{m.auth_organization_created({ handle: createdHandle })}</p>
          <a href="/security">{m.auth_security_heading()}</a>
        </div>
      </AuthPage>
    );

  return (
    <AuthPage heading={m.auth_organization_heading()}>
      <form className="auth-login-form" method="post" action="/account-operations/approve" noValidate onSubmit={submit}>
        <Field data-invalid={Boolean(handleError)}>
          <FieldLabel htmlFor={handleId}>{m.auth_signup_handle()}</FieldLabel>
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
            aria-describedby={handleError ? handleErrorId : undefined}
            readOnly={pending}
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
