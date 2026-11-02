import { createFileRoute, useLocation } from '@tanstack/react-router';
import { AuthButton as Button } from '../button';
import { useEffect, useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';
import { createConsentDecision, type ConsentDecision } from '../consent';
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

function ConsentRequest({ clientId, scope }: { clientId: string; scope: string }) {
  const [{ state, consent, pending, message, uncertain }, setDecision] = useState<ConsentDecision>({
    state: clientId ? 'loading' : 'not-found',
    pending: false,
    uncertain: false,
  });
  const decision = useRef<ReturnType<typeof createConsentDecision> | null>(null);
  const alert = useRef<HTMLDivElement>(null);
  const requested = [...new Set(scope.split(/\s+/).filter(Boolean))];

  useEffect(() => {
    const visit = createConsentDecision(clientId, scope, setDecision);
    decision.current = visit;
    visit.restore();
    window.addEventListener('pagehide', visit.suspend);
    window.addEventListener('pageshow', visit.restore);
    return () => {
      window.removeEventListener('pagehide', visit.suspend);
      window.removeEventListener('pageshow', visit.restore);
      visit.dispose();
      decision.current = null;
    };
  }, [clientId, scope]);

  useEffect(() => {
    if (message) alert.current?.focus();
  }, [message]);

  const returnTo = `/consent?${new URLSearchParams({ client_id: clientId, scope })}`;
  const signIn = `/login?${new URLSearchParams({ return_to: returnTo })}`;

  return (
    <AuthPage heading={m.auth_consent_heading()}>
      <div className="auth-login-form">
        {state === 'loading' ? <p role="status">{m.auth_consent_loading()}</p> : null}
        {state === 'failed' ? (
          <Button type="button" onClick={() => decision.current?.load()}>
            {m.auth_security_retry_action()}
          </Button>
        ) : null}
        {state === 'signed-out' ? (
          <>
            <p>{m.auth_consent_sign_in_required()}</p>
            <a href={signIn}>{m.auth_login_heading()}</a>
          </>
        ) : null}
        {state === 'not-found' ? <p>{m.auth_consent_not_found()}</p> : null}
        {state === 'approved' ? <p role="status">{m.auth_consent_approved()}</p> : null}
        {uncertain ? <p role="status">{m.auth_consent_submission_unknown()}</p> : null}
        {state === 'declined' ? (
          <p role="status">{uncertain ? m.auth_consent_declined_after_submission() : m.auth_consent_declined()}</p>
        ) : null}
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
            <Button
              type="button"
              onClick={() => void decision.current?.approve()}
              disabled={pending}
              aria-busy={pending}
            >
              {m.auth_consent_approve()}
            </Button>
            <Button type="button" variant="outline" disabled={pending} onClick={() => decision.current?.decline()}>
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
