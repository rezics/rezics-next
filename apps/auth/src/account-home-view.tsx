import { useLayoutEffect, useRef } from 'react';
import type { AccountIdentitySource, AccountIdentityState } from './account-identity';
import { useAccountHomeIdentity } from './account-home';
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
        <p className="auth-account-home-intro">{m.auth_home_intro()}</p>

        <section className="auth-account-identity" aria-labelledby="auth-home-identity-heading">
          <h2 id="auth-home-identity-heading">{m.auth_home_identity_heading()}</h2>
          <p ref={status} className="auth-account-home-status" role="status" tabIndex={-1}>
            {identityMessage}
          </p>
          {state.kind === 'ready' ? (
            <dl className="auth-account-home-email">
              <div>
                <dt>{m.auth_home_email()}</dt>
                <dd>{state.email ? <bdi dir="auto">{state.email}</bdi> : m.auth_home_identity_missing_email()}</dd>
              </div>
            </dl>
          ) : null}
          {state.kind === 'ready' ? (
            <details>
              <summary>{m.auth_home_account_id()}</summary>
              <p>
                <code dir="ltr">{state.accountId}</code>
              </p>
            </details>
          ) : null}
          {state.kind === 'unavailable' ? (
            <AuthButton type="button" variant="outline" onClick={retry}>
              {m.auth_home_identity_retry()}
            </AuthButton>
          ) : null}
        </section>

        {state.kind === 'signed-out' ? (
          <section className="auth-home-entries" aria-labelledby="auth-home-signed-out-heading">
            <h2 id="auth-home-signed-out-heading">{m.auth_home_signed_out_heading()}</h2>
            <p>{m.auth_home_signed_out_description()}</p>
            <nav aria-label={m.auth_home_signed_out_heading()}>
              <a href="/login">{m.auth_home_sign_in()}</a>
              <a href="/signup">{m.auth_home_sign_up()}</a>
              <a href="/recovery">{m.auth_home_recovery()}</a>
            </nav>
          </section>
        ) : null}

        <section className="auth-home-settings" aria-labelledby="auth-home-settings-heading">
          <h2 id="auth-home-settings-heading">{m.auth_home_settings_heading()}</h2>
          <p>{m.auth_home_settings_description()}</p>
          <nav aria-label={m.auth_home_navigation_label()}>
            <a className="auth-home-link" href="/" aria-current="page">
              <span>
                <strong>{m.auth_home_heading()}</strong>
                <small>{m.auth_home_intro()}</small>
              </span>
              <span className="auth-home-current">{m.auth_home_current()}</span>
            </a>
            <a className="auth-home-link" href="/security">
              <span>
                <strong>{m.auth_home_security()}</strong>
                <small>{m.auth_home_security_description()}</small>
              </span>
            </a>
            <a className="auth-home-link" href="/account/rename">
              <span>
                <strong>{m.auth_home_rename()}</strong>
                <small>{m.auth_home_rename_description()}</small>
              </span>
            </a>
            <a className="auth-home-link" href="/account/delete">
              <span>
                <strong>{m.auth_home_delete()}</strong>
                <small>{m.auth_home_delete_description()}</small>
              </span>
            </a>
          </nav>
        </section>
      </div>
    </AuthPage>
  );
}
