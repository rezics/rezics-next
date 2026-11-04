import { createFileRoute, useBlocker, useLocation, useRouter } from '@tanstack/react-router';
import { AuthButton as Button } from '../button';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';
import { createConsentDecision, type ConsentDecision } from '../consent';
import { ConsentDepartureView, ConsentRecoveryView } from '../consent-recovery-view';
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
  const [{ state, consent, approved, pending, message, uncertain, unattributedUncertain, history }, setDecision] =
    useState<ConsentDecision>({
      state: clientId && !invalid ? 'loading' : 'not-found',
      pending: false,
      uncertain: false,
      unattributedUncertain: false,
      history: 'none',
    });
  const decision = useRef<ReturnType<typeof createConsentDecision> | null>(null);
  const alert = useRef<HTMLDivElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const focusAfterRead = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const router = useRouter();
  const shouldWarn = useCallback(() => decision.current?.shouldWarn() ?? false, []);
  const blocker = useBlocker({
    shouldBlockFn: () => {
      if (!shouldWarn()) return false;
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return true;
    },
    enableBeforeUnload: shouldWarn,
    withResolver: true,
  });
  const resolver = useRef(blocker);
  resolver.current = blocker;
  useLayoutEffect(
    () => () => {
      if (resolver.current.status === 'blocked') resolver.current.reset();
    },
    [],
  );
  const focusSummary = () => summary.current?.focus();
  const stay = () => {
    if (blocker.status === 'blocked') blocker.reset();
  };
  const navigate = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void router.navigate({ to: event.currentTarget.getAttribute('href')! });
  };
  const retry = () => {
    focusAfterRead.current = true;
    decision.current?.load();
  };

  useEffect(() => {
    const visit = createConsentDecision(clientId, scope, setDecision);
    decision.current = visit;
    if (!invalid) visit.restore();
    let inactive = false;
    // Clear cached private DOM before the browser can freeze this document.
    const suspend = () => flushSync(() => visit.suspend());
    const refresh = () => {
      suspend();
      visit.restore();
    };
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
    window.addEventListener('pagehide', suspend);
    window.addEventListener('pageshow', restore);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('pagehide', suspend);
      window.removeEventListener('pageshow', restore);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      visit.dispose();
      decision.current = null;
    };
  }, [clientId, scope, invalid]);

  useLayoutEffect(() => {
    if (state === 'loading' || focusAfterRead.current) {
      focusSummary();
      if (state !== 'loading') focusAfterRead.current = false;
    } else if (document.activeElement === document.body) focusSummary();
  }, [state, consent]);

  useEffect(() => {
    if (message) alert.current?.focus();
  }, [message]);

  const returnTo = `/consent?${new URLSearchParams({ client_id: clientId, scope }).toString()}`;
  const signIn = `/login?${new URLSearchParams({ return_to: returnTo })}`;

  return (
    <AuthPage heading={m.auth_consent_heading()}>
      <div className="auth-login-form" ref={summary} tabIndex={-1} aria-label={m.auth_consent_heading()}>
        <ConsentRecoveryView
          state={state}
          history={history}
          uncertain={uncertain}
          unattributedUncertain={unattributedUncertain}
          pending={pending}
          retry={retry}
        />
        {state === 'loading' ? <p role="status">{m.auth_consent_loading()}</p> : null}
        {state === 'signed-out' ? (
          <>
            <p>{m.auth_consent_sign_in_required()}</p>
            <a href={signIn} onClick={navigate}>
              {m.auth_login_heading()}
            </a>
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
        {state === 'declined' ? (
          <p role="status">
            {uncertain || history === 'unknown' || unattributedUncertain
              ? m.auth_consent_declined_after_submission()
              : m.auth_consent_declined()}
          </p>
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
                {consent.decisions.switch_account ? (
                  <a href={signIn} onClick={navigate}>
                    {m.auth_login_switch_account()}
                  </a>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}
        {message ? (
          <ErrorAlert tabIndex={-1} ref={alert}>
            {message}
          </ErrorAlert>
        ) : null}
        <a href="/security" onClick={navigate}>
          {m.auth_security_heading()}
        </a>
      </div>
      <ConsentDepartureView
        open={blocker.status === 'blocked'}
        stay={stay}
        focus={() => {
          const target = returnFocus.current;
          if (target?.isConnected && !target.matches(':disabled')) target.focus();
          else focusSummary();
        }}
        leave={() => {
          if (blocker.status !== 'blocked') return;
          decision.current?.suspend();
          blocker.proceed();
        }}
      />
    </AuthPage>
  );
}
