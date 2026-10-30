import { createFileRoute } from '@tanstack/react-router';
import { Badge } from '@rezics/ui/shadcn/badge';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { AuthButton as Button } from '../button';
import { Field, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@rezics/ui/shadcn/item';
import { PasswordInput } from '../password-input';
import { Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';
import { failureMessage } from '../api';
import { ErrorAlert } from '../alert';
import { SecurityInventory, type InventorySource } from '../security-inventory-view';
import { addPasskey, passkeysSupported, removePasskey } from '../passkeys';
import {
  changePassword,
  formatSecurityDate,
  loadSecurity,
  revokeSession,
  securityDevice,
  type PasskeysLoad,
  type SecurityPasskey,
  type SecuritySession,
  type SecurityLoadResult,
} from '../security';

export const Route = createFileRoute('/security')({
  head: () => ({ meta: [{ title: `${m.auth_security_heading()} · REZICS` }] }),
  component: SecurityPage,
});

type LoadState = 'loading' | 'ready' | 'signed-out' | 'failure';

const STEP_UP_URL = '/step-up?return_to=%2Fsecurity';

export function SecurityPage({
  initial,
  inventorySource,
}: { initial?: SecurityLoadResult; inventorySource?: InventorySource } = {}) {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [accountId, setAccountId] = useState('');
  const [sessions, setSessions] = useState<SecuritySession[]>([]);
  const [loadMessage, setLoadMessage] = useState('');
  const [consentReduced, setConsentReduced] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordPending, setPasswordPending] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordFieldError, setPasswordFieldError] = useState('');
  const [sessionPending, setSessionPending] = useState('');
  const [sessionNotice, setSessionNotice] = useState('');
  const [sessionError, setSessionError] = useState('');
  const [passkeysLoad, setPasskeysLoad] = useState<PasskeysLoad>({ kind: 'hidden' });
  const [passkeys, setPasskeys] = useState<SecurityPasskey[]>([]);
  const [passkeyName, setPasskeyName] = useState('');
  const [passkeyAdding, setPasskeyAdding] = useState(false);
  const [passkeyRemoving, setPasskeyRemoving] = useState('');
  const [passkeyNotice, setPasskeyNotice] = useState('');
  const [passkeyError, setPasskeyError] = useState('');
  const submittingPassword = useRef(false);
  const passwordInput = useRef<HTMLInputElement>(null);
  const passwordAlert = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    void (initial ? Promise.resolve(initial) : loadSecurity(passkeysSupported())).then((result) => {
      if (!active) return;
      if (result.kind === 'ready') {
        setAccountId(result.accountId);
        setSessions(result.sessions);
        setPasskeysLoad(result.passkeys);
        if (result.passkeys.kind === 'ready') setPasskeys(result.passkeys.passkeys);
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
  }, [initial]);

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
      window.location.assign(STEP_UP_URL);
      return;
    }
    setPasswordError(result.message ?? failureMessage(503, 'unavailable', null));
  }

  async function submitPasskey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (passkeyAdding || passkeyRemoving) return;
    setPasskeyAdding(true);
    setPasskeyNotice('');
    setPasskeyError('');
    const result = await addPasskey(passkeyName);
    setPasskeyAdding(false);
    if (result.ok) {
      setPasskeys((current) => [...current, result.passkey]);
      setPasskeyName('');
      setPasskeyNotice(m.auth_security_passkey_added());
    } else if (result.reason === 'step-up') {
      window.location.assign(STEP_UP_URL);
    } else if (result.reason === 'failure') {
      setPasskeyError(result.message);
    }
  }

  async function removeOnePasskey(passkey: SecurityPasskey) {
    if (passkeyAdding || passkeyRemoving || !window.confirm(m.auth_security_passkey_remove_confirmation())) return;
    setPasskeyRemoving(passkey.id);
    setPasskeyNotice('');
    setPasskeyError('');
    const result = await removePasskey(passkey.id);
    setPasskeyRemoving('');
    if (result.ok) {
      setPasskeys((current) => current.filter((item) => item.id !== passkey.id));
      setPasskeyNotice(m.auth_security_passkey_removed());
    } else if (result.reason === 'step-up') {
      window.location.assign(STEP_UP_URL);
    } else {
      setPasskeyError(result.message);
    }
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
          {consentReduced ? <p role="status">{m.auth_inventory_reduced()}</p> : null}
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
        {loadState === 'loading' ? (
          <p role="status">{m.auth_inventory_loading()}</p>
        ) : (
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
                <Field data-invalid={Boolean(passwordFieldError)}>
                  <FieldLabel htmlFor="security-new-password">{m.auth_security_new_password()}</FieldLabel>
                  <PasswordInput
                    name="password"
                    autoComplete="new-password"
                    required
                    readOnly={passwordPending}
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
                <Button type="submit" disabled={passwordPending} aria-busy={passwordPending} className="w-full">
                  {m.auth_security_password_submit()}
                </Button>
              </form>
            </section>

            {passkeysLoad.kind === 'hidden' ? null : (
              <section aria-labelledby="security-passkeys-heading">
                <h2 id="security-passkeys-heading">{m.auth_security_passkeys_heading()}</h2>
                {passkeysLoad.kind === 'failure' ? (
                  <ErrorAlert>{passkeysLoad.message}</ErrorAlert>
                ) : (
                  <>
                    <p className="auth-security-hint">{m.auth_security_passkeys_description()}</p>
                    {passkeyNotice ? (
                      <div className="auth-login-alert" role="status">
                        {passkeyNotice}
                      </div>
                    ) : null}
                    {passkeyError ? <ErrorAlert>{passkeyError}</ErrorAlert> : null}
                    {passkeys.length ? (
                      <ItemGroup aria-label={m.auth_security_passkeys_heading()}>
                        {passkeys.map((passkey) => (
                          <Item key={passkey.id} render={<li />} variant="outline">
                            <article className="flex w-full flex-col items-start gap-3.5 sm:flex-row sm:items-center">
                              <ItemContent className="min-w-0 w-full sm:w-auto">
                                <ItemTitle className="line-clamp-none wrap-anywhere">
                                  <h3>{passkey.name}</h3>
                                </ItemTitle>
                                <ItemDescription className="line-clamp-none wrap-anywhere">
                                  {m.auth_security_created_at()}{' '}
                                  <time dateTime={passkey.created_at}>
                                    {formatSecurityDate(passkey.created_at, locale)}
                                  </time>
                                  {' · '}
                                  {passkey.last_used_at ? (
                                    <>
                                      {m.auth_security_passkey_last_used()}{' '}
                                      <time dateTime={passkey.last_used_at}>
                                        {formatSecurityDate(passkey.last_used_at, locale)}
                                      </time>
                                    </>
                                  ) : (
                                    m.auth_security_passkey_never_used()
                                  )}
                                </ItemDescription>
                              </ItemContent>
                              <ItemActions>
                                <Button
                                  type="button"
                                  variant="outline"
                                  onClick={() => void removeOnePasskey(passkey)}
                                  disabled={passkeyAdding || Boolean(passkeyRemoving)}
                                  aria-busy={passkeyRemoving === passkey.id}
                                  aria-label={m.auth_security_passkey_remove_named({ name: passkey.name })}
                                >
                                  {m.auth_security_passkey_remove()}
                                </Button>
                              </ItemActions>
                            </article>
                          </Item>
                        ))}
                      </ItemGroup>
                    ) : (
                      <p>{m.auth_security_passkeys_empty()}</p>
                    )}
                    <form className="auth-login-form" noValidate onSubmit={submitPasskey}>
                      <Field>
                        <FieldLabel htmlFor="security-passkey-name">{m.auth_security_passkey_name()}</FieldLabel>
                        <Input
                          id="security-passkey-name"
                          name="passkey-name"
                          autoComplete="off"
                          maxLength={64}
                          value={passkeyName}
                          onChange={(event) => setPasskeyName(event.target.value)}
                          readOnly={passkeyAdding}
                        />
                      </Field>
                      <Button
                        type="submit"
                        disabled={passkeyAdding || Boolean(passkeyRemoving)}
                        aria-busy={passkeyAdding}
                        className="w-full"
                      >
                        {m.auth_security_passkey_add()}
                      </Button>
                    </form>
                  </>
                )}
              </section>
            )}

            <section aria-labelledby="security-sessions-heading">
              <h2 id="security-sessions-heading">{m.auth_security_sessions_heading()}</h2>
              {sessionNotice ? (
                <div className="auth-login-alert" role="status">
                  {sessionNotice}
                </div>
              ) : null}
              {sessionError ? <ErrorAlert>{sessionError}</ErrorAlert> : null}
              {!orderedSessions.length ? <p>{m.auth_security_sessions_empty()}</p> : null}
              <ItemGroup aria-label={m.auth_security_sessions_heading()}>
                {orderedSessions.map((session) => {
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
                    <Item key={session.id} render={<li />} variant="outline">
                      <article className="flex w-full flex-col items-start gap-3.5 sm:flex-row sm:items-center">
                        <ItemContent className="min-w-0 w-full sm:w-auto">
                          <ItemTitle className="line-clamp-none wrap-anywhere">
                            <h3>
                              {device}
                              {session.current ? (
                                <Badge variant="secondary">{m.auth_security_this_device()}</Badge>
                              ) : null}
                            </h3>
                          </ItemTitle>
                          <ItemDescription className="line-clamp-none wrap-anywhere">
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
                            aria-busy={sessionPending === session.id}
                            aria-label={m.auth_security_sign_out_session({ device })}
                          >
                            {m.auth_security_sign_out()}
                          </Button>
                        </ItemActions>
                      </article>
                    </Item>
                  );
                })}
              </ItemGroup>
            </section>

            <SecurityInventory
              {...(inventorySource ? { source: inventorySource } : {})}
              onSessionEnded={(reduced) => {
                setConsentReduced(reduced);
                setAccountId('');
                setSessions([]);
                setPasskeys([]);
                setPassword('');
                setLoadState('signed-out');
              }}
            />

            <section aria-labelledby="security-organizations-heading">
              <h2 id="security-organizations-heading">{m.auth_organization_security_heading()}</h2>
              <nav aria-labelledby="security-organizations-heading">
                <a className={buttonVariants({ variant: 'outline' })} href="/organizations/new">
                  {m.auth_organization_security_create()}
                </a>
              </nav>
            </section>

            <section aria-labelledby="security-delete-account-heading">
              <h2 id="security-delete-account-heading">{m.auth_account_delete_submit()}</h2>
              <p>{m.auth_account_delete_security_description()}</p>
              <nav aria-labelledby="security-delete-account-heading">
                <a
                  className={`${buttonVariants({ variant: 'outline' })} border-destructive/50 hover:border-destructive/70`}
                  href="/account/delete"
                >
                  <Trash2 aria-hidden="true" className="text-destructive" />
                  {m.auth_account_delete_submit()}
                </a>
              </nav>
            </section>
          </>
        )}
      </div>
    </AuthPage>
  );
}
