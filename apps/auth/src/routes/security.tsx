import { createFileRoute } from '@tanstack/react-router';
import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';
import { failureMessage } from '../api';
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
  const [showPassword, setShowPassword] = useState(false);
  const [passwordPending, setPasswordPending] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState('');
  const [passwordError, setPasswordError] = useState('');
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
    if (passwordError) passwordAlert.current?.focus();
  }, [passwordError]);

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingPassword.current || passwordPending) return;
    if (Array.from(password).length < 8 || Array.from(password).length > 128) {
      setPasswordNotice('');
      setPasswordError(failureMessage(400, 'invalid_password', null));
      return;
    }
    submittingPassword.current = true;
    setPasswordPending(true);
    setPasswordNotice('');
    setPasswordError('');
    const result = await changePassword(accountId, password);
    submittingPassword.current = false;
    setPasswordPending(false);
    if (result.ok) {
      setPassword('');
      setShowPassword(false);
      setPasswordNotice(m.auth_security_password_changed());
      return;
    }
    if (result.reason === 'step-up') {
      setPassword('');
      if (passwordInput.current) passwordInput.current.value = '';
      setShowPassword(false);
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
        <div className="auth-login-alert" role="alert">
          {loadMessage}
        </div>
      </AuthPage>
    );

  const locale = typeof document === 'undefined' ? 'en' : document.documentElement.lang || 'en';
  const orderedSessions = [...sessions].sort((left, right) => Number(right.current) - Number(left.current));

  return (
    <AuthPage heading={m.auth_security_heading()}>
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
              <Field required>
                <FieldLabel>{m.auth_security_new_password()}</FieldLabel>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Input
                    ref={passwordInput}
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    readOnly={passwordPending}
                    required
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setShowPassword((shown) => !shown)}
                    disabled={passwordPending}
                    aria-pressed={showPassword}
                  >
                    {showPassword ? m.auth_security_hide_password() : m.auth_security_show_password()}
                  </Button>
                </div>
              </Field>
              {passwordNotice ? (
                <div className="auth-login-alert" role="status">
                  {passwordNotice}
                </div>
              ) : null}
              {passwordError ? (
                <div className="auth-login-alert" role="alert" tabIndex={-1} ref={passwordAlert}>
                  {passwordError}
                </div>
              ) : null}
              <Button
                type="submit"
                disabled={passwordPending || !password}
                isLoading={passwordPending}
                className="w-full"
              >
                {m.auth_security_password_submit()}
              </Button>
            </form>
          </section>

          <section className="auth-login-form" aria-labelledby="security-sessions-heading">
            <h2 id="security-sessions-heading">{m.auth_security_sessions_heading()}</h2>
            {sessionNotice ? (
              <div className="auth-login-alert" role="status">
                {sessionNotice}
              </div>
            ) : null}
            {sessionError ? (
              <div className="auth-login-alert" role="alert">
                {sessionError}
              </div>
            ) : null}
            <ul aria-label={m.auth_security_sessions_heading()}>
              {orderedSessions.map((session) => {
                const device = securityDevice(session.user_agent);
                return (
                  <li key={session.id}>
                    <article>
                      <h3>{device ? m.auth_security_device(device) : m.auth_security_unknown_device()}</h3>
                      {session.current ? <p>{m.auth_security_current_session()}</p> : null}
                      <p>{session.client_id}</p>
                      <p>
                        {m.auth_security_created_at()}{' '}
                        <time dateTime={session.created_at}>{formatSecurityDate(session.created_at, locale)}</time>
                      </p>
                      <p>
                        {m.auth_security_expires_at()}{' '}
                        <time dateTime={session.expires_at}>{formatSecurityDate(session.expires_at, locale)}</time>
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void revoke(session)}
                        disabled={Boolean(sessionPending)}
                        isLoading={sessionPending === session.id}
                      >
                        {m.auth_security_revoke_session()}
                      </Button>
                    </article>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}
    </AuthPage>
  );
}
