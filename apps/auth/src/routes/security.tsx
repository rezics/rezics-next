import { createFileRoute } from '@tanstack/react-router';
import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { Field, FieldError, FieldLabel } from '@rezics/ui/field';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemSeparator, ItemTitle } from '@rezics/ui/item';
import { PasswordInput, PasswordInputGroup, PasswordInputInput, PasswordInputTrigger } from '@rezics/ui/password-input';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';
import { failureMessage } from '../api';
import { ErrorAlert } from '../alert';
import {
  changePassword,
  formatSecurityDate,
  loadSecurity,
  revokeSession,
  securityDevice,
  type SecuritySession,
} from '../security';

export const Route = createFileRoute('/security')({
  component: SecurityPage,
});

type LoadState = 'loading' | 'ready' | 'signed-out' | 'failure';

function SecurityPage() {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [accountId, setAccountId] = useState('');
  const [sessions, setSessions] = useState<SecuritySession[]>([]);
  const [loadMessage, setLoadMessage] = useState('');
  const [password, setPassword] = useState('');
  const [passwordPending, setPasswordPending] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordFieldError, setPasswordFieldError] = useState('');
  const [sessionPending, setSessionPending] = useState('');
  const [sessionNotice, setSessionNotice] = useState('');
  const [sessionError, setSessionError] = useState('');
  const submittingPassword = useRef(false);
  const passwordInput = useRef<HTMLInputElement>(null);
  const passwordAlert = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    void loadSecurity().then((result) => {
      if (!active) return;
      if (result.kind === 'ready') {
        setAccountId(result.accountId);
        setSessions(result.sessions);
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
    if (passwordFieldError) passwordInput.current?.focus();
    else if (passwordError) passwordAlert.current?.focus();
  }, [passwordFieldError, passwordError]);

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingPassword.current || passwordPending) return;
    const passwordLength = Array.from(password).length;
    if (passwordLength < 8 || passwordLength > 128) {
      setPasswordNotice('');
      setPasswordFieldError(password ? m.auth_security_password_invalid() : m.auth_form_required());
      return;
    }
    setPasswordFieldError('');
    submittingPassword.current = true;
    setPasswordPending(true);
    setPasswordNotice('');
    setPasswordError('');
    const result = await changePassword(accountId, password);
    submittingPassword.current = false;
    setPasswordPending(false);
    if (result.ok) {
      setPassword('');
      setPasswordNotice(m.auth_security_password_changed());
      return;
    }
    if (result.reason === 'step-up') {
      setPassword('');
      window.location.assign('/step-up?return_to=%2Fsecurity');
      return;
    }
    setPasswordError(result.message ?? failureMessage(503, 'unavailable', null));
  }

  async function revoke(session: SecuritySession) {
    if (sessionPending || !window.confirm(m.auth_security_revoke_confirmation())) return;
    setSessionPending(session.id);
    setSessionNotice('');
    setSessionError('');
    const result = await revokeSession(session.id);
    setSessionPending('');
    if (!result.ok) {
      setSessionError(result.message);
      return;
    }
    if (session.current) {
      window.location.assign('/login');
      return;
    }
    setSessions((current) => current.filter((item) => item.id !== session.id));
    setSessionNotice(m.auth_security_session_revoked());
  }

  if (loadState === 'signed-out')
    return (
      <AuthPage heading={m.auth_security_heading()}>
        <div className="auth-login-form">
          <p>{m.auth_security_sign_in_required()}</p>
          <a href="/login">{m.auth_security_sign_in()}</a>
        </div>
      </AuthPage>
    );

  if (loadState === 'failure')
    return (
      <AuthPage heading={m.auth_security_heading()}>
        <ErrorAlert>{loadMessage}</ErrorAlert>
      </AuthPage>
    );

  const locale = typeof document === 'undefined' ? 'en' : document.documentElement.lang || 'en';
  const orderedSessions = [...sessions].sort((left, right) => Number(right.current) - Number(left.current));

  return (
    <AuthPage heading={m.auth_security_heading()}>
      <div className="auth-security-page">
        {loadState === 'loading' ? null : (
          <>
            <section aria-labelledby="security-password-heading">
              <h2 id="security-password-heading">{m.auth_security_change_password()}</h2>
              <form
                className="auth-login-form"
                method="post"
                action="/credential-effects/stage"
                noValidate
                onSubmit={submitPassword}
              >
                <Field required invalid={Boolean(passwordFieldError)}>
                  <FieldLabel htmlFor="security-new-password">{m.auth_security_new_password()}</FieldLabel>
                  <PasswordInput
                    name="password"
                    autoComplete="new-password"
                    required
                    readOnly={passwordPending}
                    invalid={Boolean(passwordFieldError)}
                    translations={{
                      visibilityTrigger: (visible) =>
                        visible ? m.auth_security_hide_password() : m.auth_security_show_password(),
                    }}
                  >
                    <PasswordInputGroup>
                      <PasswordInputInput
                        ref={passwordInput}
                        id="security-new-password"
                        value={password}
                        onChange={(event) => {
                          setPassword(event.target.value);
                          setPasswordFieldError('');
                        }}
                        aria-invalid={passwordFieldError ? true : undefined}
                        aria-describedby={passwordFieldError ? 'security-password-error' : undefined}
                      />
                      <PasswordInputTrigger />
                    </PasswordInputGroup>
                  </PasswordInput>
                  {passwordFieldError ? (
                    <FieldError id="security-password-error">{passwordFieldError}</FieldError>
                  ) : null}
                </Field>
                {passwordNotice ? (
                  <div className="auth-login-alert" role="status">
                    {passwordNotice}
                  </div>
                ) : null}
                {passwordError ? (
                  <ErrorAlert tabIndex={-1} ref={passwordAlert}>
                    {passwordError}
                  </ErrorAlert>
                ) : null}
                <Button type="submit" disabled={passwordPending} isLoading={passwordPending} className="w-full">
                  {m.auth_security_password_submit()}
                </Button>
              </form>
            </section>

            <section aria-labelledby="security-sessions-heading">
              <h2 id="security-sessions-heading">{m.auth_security_sessions_heading()}</h2>
              {sessionNotice ? (
                <div className="auth-login-alert" role="status">
                  {sessionNotice}
                </div>
              ) : null}
              {sessionError ? <ErrorAlert>{sessionError}</ErrorAlert> : null}
              <ItemGroup aria-label={m.auth_security_sessions_heading()}>
                {orderedSessions.map((session, index) => {
                  const parsedDevice = securityDevice(session.user_agent);
                  const device = parsedDevice ? m.auth_security_device(parsedDevice) : m.auth_security_unknown_device();
                  const clientName =
                    session.client_display_name?.trim() ||
                    (session.client_id === 'login'
                      ? m.auth_security_rezics_account()
                      : session.client_id === 'rezics-website'
                        ? m.auth_security_rezics()
                        : session.client_id);
                  const rawClientId =
                    !session.client_display_name?.trim() && !['login', 'rezics-website'].includes(session.client_id);
                  return (
                    <div className="contents" key={session.id}>
                      {index > 0 ? <ItemSeparator /> : null}
                      <Item asChild variant="outline">
                        <li>
                          <article className="contents">
                            <ItemContent>
                              <ItemTitle asChild>
                                <h3>
                                  {device}
                                  {session.current ? (
                                    <Badge variant="soft" size="sm">
                                      {m.auth_security_this_device()}
                                    </Badge>
                                  ) : null}
                                </h3>
                              </ItemTitle>
                              <ItemDescription>
                                <span className={rawClientId ? 'font-mono text-xs' : undefined}>{clientName}</span>
                                {' · '}
                                <span>
                                  {m.auth_security_created_at()}{' '}
                                  <time dateTime={session.created_at}>
                                    {formatSecurityDate(session.created_at, locale)}
                                  </time>
                                  {' · '}
                                  {m.auth_security_expires_at()}{' '}
                                  <time dateTime={session.expires_at}>
                                    {formatSecurityDate(session.expires_at, locale)}
                                  </time>
                                </span>
                              </ItemDescription>
                            </ItemContent>
                            <ItemActions>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => void revoke(session)}
                                disabled={Boolean(sessionPending)}
                                isLoading={sessionPending === session.id}
                                aria-label={m.auth_security_sign_out_session({ device })}
                              >
                                {m.auth_security_sign_out()}
                              </Button>
                            </ItemActions>
                          </article>
                        </li>
                      </Item>
                    </div>
                  );
                })}
              </ItemGroup>
            </section>
          </>
        )}
      </div>
    </AuthPage>
  );
}
