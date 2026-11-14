import { useLayoutEffect, useRef } from 'react';
import type { AccountIdentitySource, AccountIdentityState } from './account-identity';
import { useAccountHomeIdentity } from './account-home';
import { AccountHomeGuide } from './account-home-guide';
import { useInterfaceLocale } from './locale-observation';
import { AuthButton } from './button';
import { AuthPage } from './frame';
import { m } from './paraglide/messages.js';

export function AccountHome({ source }: { source?: AccountIdentitySource }) {
  const identity = useAccountHomeIdentity(source);
  return <AccountHomeView {...identity} />;
}

export function AccountHomeView({
  state,
  retry,
  retryFocusVersion,
}: {
  state: AccountIdentityState;
  retry: () => void;
  retryFocusVersion: number;
}) {
  useInterfaceLocale();
  const status = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (retryFocusVersion > 0) status.current?.focus({ preventScroll: true });
  }, [retryFocusVersion]);

  const identityMessage =
    state.kind === 'loading'
      ? m.auth_home_identity_loading()
      : state.kind === 'ready'
        ? m.auth_home_identity_ready()
        : state.kind === 'signed-out'
          ? m.auth_home_identity_signed_out()
          : state.kind === 'denied'
            ? m.auth_home_identity_denied()
            : m.auth_home_identity_unavailable();

  return (
    <AuthPage heading={m.auth_home_heading()}>
      <div className="auth-account-home">
        <section
          className="auth-account-identity"
          data-state={state.kind}
          aria-labelledby="auth-home-identity-heading"
        >
          <div className="auth-home-identity-copy">
            <h2 id="auth-home-identity-heading">{m.auth_home_identity_heading()}</h2>
            <p ref={status} className="auth-account-home-status" role="status" tabIndex={-1}>
              {identityMessage}
            </p>
            <p className="auth-home-identity-note">{m.auth_home_identity_note()}</p>
            {state.kind === 'unavailable' ? (
              <AuthButton type="button" variant="outline" onClick={retry}>
                {m.auth_home_identity_retry()}
              </AuthButton>
            ) : null}
          </div>
          {state.kind === 'ready' ? (
            <div className="auth-home-identity-private">
              <dl className="auth-account-home-email">
                <div>
                  <dt>{m.auth_home_email()}</dt>
                  <dd>
                    {state.email ? <bdi dir="auto">{state.email}</bdi> : m.auth_home_identity_missing_email()}
                  </dd>
                </div>
              </dl>
              <details>
                <summary>{m.auth_home_account_id()}</summary>
                <p>
                  <code dir="ltr">{state.accountId}</code>
                </p>
              </details>
            </div>
          ) : null}
        </section>

        <section className="auth-home-next-actions" aria-label={m.auth_home_navigation_label()}>
          <p className="auth-home-next-actions-intro">{m.auth_home_intro()}</p>
          {state.kind === 'signed-out' || state.kind === 'unavailable' ? (
            <section className="auth-home-entries" aria-labelledby="auth-home-signed-out-heading">
              <h2 id="auth-home-signed-out-heading">{m.auth_home_signed_out_heading()}</h2>
              <p>{m.auth_home_signed_out_description()}</p>
              <nav aria-label={m.auth_home_signed_out_heading()}>
                <a className="auth-home-entry-link" href="/login">
                  {m.auth_home_sign_in()}
                </a>
                <a className="auth-home-entry-link" href="/signup">
                  {m.auth_home_sign_up()}
                </a>
                <a className="auth-home-entry-link" href="/recovery">
                  {m.auth_home_recovery()}
                </a>
              </nav>
            </section>
          ) : null}

          <AccountHomeGuide />
        </section>

        <nav className="auth-home-location" aria-label={m.auth_home_heading()}>
          <a href="/" aria-current="page">
            {m.auth_home_heading()} · {m.auth_home_current()}
          </a>
        </nav>
      </div>
    </AuthPage>
  );
}
