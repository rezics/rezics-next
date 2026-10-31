import { createFileRoute, useLocation } from '@tanstack/react-router';
import { AuthButton as Button } from '../button';
import { useEffect, useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';
import { authPost, failureMessage } from '../api';
import { approvedScopes, readConsent, type Consent } from '../consent';
import { ErrorAlert } from '../alert';
import { PermissionLimits, RequestedPermission } from '../permission-view';

export const Route = createFileRoute('/consent')({
  head: () => ({ meta: [{ title: `${m.auth_consent_heading()} · REZICS` }] }),
  component: ConsentPage,
});

function ConsentPage() {
  const query = useLocation({ select: (location) => location.searchStr });
  const parameters = new URLSearchParams(query);
  const client_id = parameters.get('client_id') ?? '';
  const scope = parameters.get('scope') ?? '';
  return <ConsentRequest key={JSON.stringify([client_id, scope])} clientId={client_id} scope={scope} />;
}

type State = 'loading' | 'ready' | 'signed-out' | 'not-found' | 'failed' | 'approved' | 'declined';

function ConsentRequest({ clientId, scope }: { clientId: string; scope: string }) {
  const [state, setState] = useState<State>(clientId ? 'loading' : 'not-found');
  const [consent, setConsent] = useState<Consent | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const submitting = useRef(false);
  const alert = useRef<HTMLDivElement>(null);
  const requested = [...new Set(scope.split(/\s+/).filter(Boolean))];

  useEffect(() => {
    if (!clientId) return;
    let active = true;
    void readConsent(clientId).then((result) => {
      if (!active) return;
      if (result.ok) {
        setConsent(result.body);
        setState('ready');
      } else if (result.status === 401) setState('signed-out');
      else if (result.status === 404) setState('not-found');
      else {
        setMessage(failureMessage(result.status, result.code, result.retryAfter));
        setState('failed');
      }
    });
    return () => {
      active = false;
    };
  }, [clientId]);

  useEffect(() => {
    if (message) alert.current?.focus();
  }, [message]);

  async function approve() {
    if (!consent || state !== 'ready' || submitting.current) return;
    submitting.current = true;
    setPending(true);
    setMessage('');
    const result = await authPost('/consent', {
      client_id: consent.client_id,
      scope: approvedScopes(consent, requested),
    });
    submitting.current = false;
    setPending(false);
    if (result.ok) setState('approved');
    else if (result.status === 401) setState('signed-out');
    else if (result.status === 404) setState('not-found');
    else setMessage(failureMessage(result.status, result.code, result.retryAfter));
  }

  return (
    <AuthPage heading={m.auth_consent_heading()}>
      <div className="auth-login-form">
        {state === 'loading' ? <p role="status">{m.auth_consent_loading()}</p> : null}
        {state === 'signed-out' ? (
          <>
            <p>{m.auth_consent_sign_in_required()}</p>
            <a href="/login">{m.auth_login_heading()}</a>
          </>
        ) : null}
        {state === 'not-found' ? <p>{m.auth_consent_not_found()}</p> : null}
        {state === 'approved' ? <p role="status">{m.auth_consent_approved()}</p> : null}
        {state === 'declined' ? <p role="status">{m.auth_consent_declined()}</p> : null}
        {state === 'ready' && consent ? (
          <>
            <div>
              <p>{m.auth_consent_request()}</p>
              <p className="font-semibold wrap-anywhere">{consent.display_name ?? consent.client_id}</p>
            </div>
            {requested.length ? (
              <>
                <PermissionLimits />
                <ul className="m-0 grid min-w-0 list-none gap-4 p-0">
                  {requested.map((id) => (
                    <li key={id} className="grid min-w-0 gap-1 wrap-anywhere">
                      <RequestedPermission scope={id} consent={consent} />
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>{m.auth_consent_empty()}</p>
            )}
            <Button type="button" onClick={approve} disabled={pending} aria-busy={pending}>
              {m.auth_consent_approve()}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                if (!submitting.current) {
                  setMessage('');
                  setState('declined');
                }
              }}
            >
              {m.auth_consent_decline()}
            </Button>
          </>
        ) : null}
        {message ? (
          <ErrorAlert tabIndex={-1} ref={alert}>
            {message}
          </ErrorAlert>
        ) : null}
      </div>
    </AuthPage>
  );
}
