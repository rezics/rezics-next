import { createFileRoute, useLocation } from '@tanstack/react-router';
import { AuthButton as Button } from '../button';
import { useEffect, useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';
import { createConsentDecision, type ConsentDecision } from '../consent';
import { ErrorAlert } from '../alert';
import { Permission, PermissionLimits, RequestedPermission } from '../permission-view';

export const Route = createFileRoute('/consent')({
  head: () => ({ meta: [{ title: `${m.auth_consent_heading()} · REZICS` }] }),
  component: ConsentPage,
});

function ConsentPage() {
  const query = useLocation({ select: (location) => location.searchStr });
  const parameters = new URLSearchParams(query);
  const clients = parameters.getAll('client_id');
  const scopes = parameters.getAll('scope');
  const invalid = clients.length !== 1 || scopes.length > 1;
  const clientId = invalid ? '' : (clients[0] ?? '');
  const scope = invalid ? '' : (scopes[0] ?? '');
  return (
    <ConsentRequest
      key={JSON.stringify([clientId, scope, invalid])}
      clientId={clientId}
      scope={scope}
      invalid={invalid}
    />
  );
}

function ConsentRequest({ clientId, scope, invalid }: { clientId: string; scope: string; invalid: boolean }) {
  const [{ state, consent, approved, pending, message, uncertain, unattributedUncertain }, setDecision] =
    useState<ConsentDecision>({
      state: clientId && !invalid ? 'loading' : 'not-found',
      pending: false,
      uncertain: false,
      unattributedUncertain: false,
    });
  const decision = useRef<ReturnType<typeof createConsentDecision> | null>(null);
  const alert = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const visit = createConsentDecision(clientId, scope, setDecision);
    decision.current = visit;
    if (!invalid) visit.restore();
    let inactive = false;
    const refresh = () => visit.refresh();
    const restore = () => visit.restore();
    const onBlur = () => {
      inactive = true;
    };
    const onFocus = () => {
      if (inactive && document.visibilityState === 'visible') {
        inactive = false;
        refresh();
      }
    };
    window.addEventListener('pagehide', visit.suspend);
    window.addEventListener('pageshow', restore);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('pagehide', visit.suspend);
      window.removeEventListener('pageshow', restore);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      visit.dispose();
      decision.current = null;
    };
  }, [clientId, scope, invalid]);

  useEffect(() => {
    if (message) alert.current?.focus();
  }, [message]);

  const returnTo = `/consent?${new URLSearchParams({ client_id: clientId, scope }).toString()}`;
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
        {state === 'approved' && consent ? (
          <div role="status">
            <p>{m.auth_consent_approved()}</p>
            {approved?.length ? (
              <>
                <p>{m.auth_consent_approved_permissions()}</p>
                <ul className="m-0 grid min-w-0 list-none gap-4 p-0">
                  {approved.map((id) => (
                    <li key={id} className="grid min-w-0 gap-1 wrap-anywhere">
                      <Permission scope={id} />
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>{m.auth_consent_approved_none()}</p>
            )}
          </div>
        ) : null}
        {uncertain && ['ready', 'approved', 'declined'].includes(state) ? (
          <p role="status">{m.auth_consent_submission_unknown()}</p>
        ) : null}
        {unattributedUncertain ? <p role="status">{m.auth_consent_unattributed_submission()}</p> : null}
        {state === 'declined' ? (
          <p role="status">{uncertain ? m.auth_consent_declined_after_submission() : m.auth_consent_declined()}</p>
        ) : null}
        {(state === 'ready' || state === 'approved' || state === 'declined') && consent ? (
          <>
            <div>
              <p>{m.auth_consent_request()}</p>
              <p className="font-semibold wrap-anywhere">{consent.display_name ?? consent.client_id}</p>
            </div>
            <p>
              {m.auth_login_current_account({
                account: consent.acting_account.email ?? m.auth_security_rezics_account(),
              })}
            </p>
            {consent.pending_reduction ? <p role="status">{m.auth_inventory_consent_pending()}</p> : null}
            {consent.requested.length ? (
              <>
                <PermissionLimits />
                <ul className="m-0 grid min-w-0 list-none gap-4 p-0">
                  {consent.requested.map((id) => (
                    <li key={id} className="grid min-w-0 gap-1 wrap-anywhere">
                      <RequestedPermission scope={id} consent={consent} />
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>{m.auth_consent_empty()}</p>
            )}
            {state === 'ready' ? (
              <>
                {consent.decisions.allow ? (
                  <Button
                    type="button"
                    onClick={() => void decision.current?.approve()}
                    disabled={pending}
                    aria-busy={pending}
                  >
                    {m.auth_consent_approve()}
                  </Button>
                ) : null}
                {consent.decisions.decline ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending}
                    onClick={() => decision.current?.decline()}
                  >
                    {m.auth_consent_decline()}
                  </Button>
                ) : null}
                {consent.decisions.switch_account ? <a href={signIn}>{m.auth_login_switch_account()}</a> : null}
              </>
            ) : null}
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
