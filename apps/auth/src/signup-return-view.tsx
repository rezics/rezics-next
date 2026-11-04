import { useLayoutEffect, useRef, type MouseEvent } from 'react';
import { AuthButton as Button } from './button';
import { ErrorAlert } from './alert';
import { AuthPage } from './frame';
import { m } from './paraglide/messages.js';
import { signInTarget } from './sign-in';
import type { RegistrationPage } from './registration-page';
import type { SignupReturnState } from './signup-return';

export function SignupReturnView({
  state,
  page,
  query,
  follow,
  retry,
  acknowledge,
}: {
  state: SignupReturnState;
  page: RegistrationPage;
  query: string;
  follow: (event: MouseEvent<HTMLAnchorElement>) => void;
  retry: () => void;
  acknowledge: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => heading.current?.focus(), [page.kind, state.status]);

  const summary = state.summary;
  const outcome = summary?.kind === 'created' ? m.auth_signup_return_created_body() : m.auth_signup_return_unknown_body();
  const checking = state.status === 'restoring';
  const unavailable = state.status === 'unavailable' || page.kind === 'unavailable';

  return (
    <AuthPage heading={m.auth_signup_heading()}>
      <section className="auth-login-form" aria-busy={checking}>
        {checking ? (
          <>
            <h2 ref={heading} tabIndex={-1}>{m.auth_signup_return_checking_heading()}</h2>
            <p role="status">{m.auth_signup_return_checking()}</p>
            {summary ? <p>{outcome}</p> : null}
            <SignupReturnLinks query={query} follow={follow} />
          </>
        ) : unavailable ? (
          <ErrorAlert>
            <h2 ref={heading} tabIndex={-1}>{m.auth_signup_return_unavailable_heading()}</h2>
            <p>{m.auth_signup_return_unavailable_body()}</p>
            {summary ? <p>{outcome}</p> : null}
            <Button type="button" onClick={retry}>{m.auth_signup_return_retry_read()}</Button>
            <SignupReturnLinks query={query} follow={follow} />
          </ErrorAlert>
        ) : page.kind === 'already-signed-in' ? (
          <>
            <h2 ref={heading} tabIndex={-1}>{m.auth_signup_return_current_session_heading()}</h2>
            <p role="status">
              {state.currentViewerChanged
                ? m.auth_signup_return_viewer_changed()
                : m.auth_signup_return_current_session()}
            </p>
            {summary ? <p>{outcome}</p> : null}
            <nav className="auth-login-links" aria-label={m.auth_signup_continue()}>
              <a href={signInTarget(query, window.location.origin)}>{m.auth_signup_return_continue_current()}</a>
            </nav>
            <SignupReturnLinks query={query} follow={follow} />
            <Button type="button" onClick={acknowledge}>{m.auth_signup_return_acknowledge()}</Button>
          </>
        ) : (
          <>
            <h2 ref={heading} tabIndex={-1}>
              {summary?.kind === 'created'
                ? m.auth_signup_return_created_heading()
                : m.auth_signup_return_unknown_heading()}
            </h2>
            {summary ? <p role="status">{outcome}</p> : null}
            <SignupReturnLinks query={query} follow={follow} />
            {page.kind === 'registration' && page.actions.register ? (
              <Button type="button" onClick={acknowledge}>{m.auth_signup_return_acknowledge()}</Button>
            ) : null}
          </>
        )}
      </section>
    </AuthPage>
  );
}

function SignupReturnLinks({ query, follow }: { query: string; follow: (event: MouseEvent<HTMLAnchorElement>) => void }) {
  return (
    <nav className="auth-signup-links" aria-label={m.auth_signup_sign_in()}>
      <a href={`/login${query}`} onClick={follow}>{m.auth_signup_sign_in()}</a>
      <a href={`/recovery${query}`} onClick={follow}>{m.auth_signup_recovery()}</a>
    </nav>
  );
}
