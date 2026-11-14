import { useLayoutEffect, useRef, type MouseEvent } from 'react';
import { AuthButton as Button } from './button';
import { ErrorAlert } from './alert';
import { AuthPage } from './frame';
import { AuthActions, AuthHelp, AuthNotice, AuthTask, AuthTaskSection } from './auth-task-view';
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
  const checking = state.status === 'restoring';
  const unavailable = state.status === 'unavailable' || page.kind === 'unavailable';
  const currentSession = page.kind === 'already-signed-in';
  const title = checking
    ? m.auth_signup_return_checking_heading()
    : unavailable
      ? m.auth_signup_return_unavailable_heading()
      : currentSession
        ? m.auth_signup_return_current_session_heading()
        : summary?.kind === 'created'
          ? m.auth_signup_return_created_heading()
          : m.auth_signup_return_unknown_heading();

  return (
    <AuthPage heading={m.auth_signup_heading()}>
      <AuthTask>
        <AuthTaskSection aria-busy={checking}>
          <h2 ref={heading} tabIndex={-1}>
            {title}
          </h2>
          {checking ? (
            <p role="status">{m.auth_signup_return_checking()}</p>
          ) : unavailable ? (
            <ErrorAlert>{m.auth_signup_return_unavailable_body()}</ErrorAlert>
          ) : currentSession ? (
            <p role="status">
              {state.currentViewerChanged
                ? m.auth_signup_return_viewer_changed()
                : m.auth_signup_return_current_session()}
            </p>
          ) : null}
          {summary ? (
            <AuthNotice role="status">
              {summary.kind === 'created' ? m.auth_signup_return_created_body() : m.auth_signup_return_unknown_body()}
            </AuthNotice>
          ) : null}
          {!checking ? (
            unavailable ? (
              <AuthActions>
                <Button type="button" onClick={retry}>
                  {m.auth_signup_return_retry_read()}
                </Button>
              </AuthActions>
            ) : (
              <>
                {currentSession ? (
                  <AuthHelp aria-label={m.auth_signup_continue()}>
                    <a href={signInTarget(query, window.location.origin)}>{m.auth_signup_return_continue_current()}</a>
                  </AuthHelp>
                ) : null}
                {currentSession || (page.kind === 'registration' && page.actions.register) ? (
                  <AuthActions>
                    <Button type="button" onClick={acknowledge}>
                      {m.auth_signup_return_acknowledge()}
                    </Button>
                  </AuthActions>
                ) : null}
              </>
            )
          ) : null}
          <AuthHelp aria-label={m.auth_signup_sign_in()}>
            <a href={`/login${query}`} onClick={follow}>
              {m.auth_signup_sign_in()}
            </a>
            <a href={`/recovery${query}`} onClick={follow}>
              {m.auth_signup_recovery()}
            </a>
          </AuthHelp>
        </AuthTaskSection>
      </AuthTask>
    </AuthPage>
  );
}
