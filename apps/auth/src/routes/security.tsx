import { createFileRoute } from '@tanstack/react-router';
import { Badge } from '@rezics/ui/shadcn/badge';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { AuthButton as Button } from '../button';
import { Field, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@rezics/ui/shadcn/item';
import { PasswordInput } from '../password-input';
import { Trash2 } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';
import { useAccountIdentity, type AccountIdentitySource } from '../account-identity';
import { AccountIdentitySummary } from '../account-identity-view';
import { failureMessage } from '../api';
import { ErrorAlert } from '../alert';
import { SecurityInventory, type InventorySource } from '../security-inventory-view';
import { addPasskey, passkeysSupported, removePasskey } from '../passkeys';
import {
  readSecurityTarget,
  type SecurityTarget,
  type SecurityActionResult,
  type SecuritySource,
} from '../security-reconciliation';
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
  securitySource,
  identitySource,
}: {
  initial?: SecurityLoadResult;
  inventorySource?: InventorySource;
  securitySource?: SecuritySource;
  identitySource?: AccountIdentitySource;
} = {}) {
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
  const [recovery, setRecovery] = useState<{
    target: SecurityTarget;
    phase: 'unknown' | 'accepted' | 'present';
  } | null>(null);
  const [reading, setReading] = useState(false);
  const [signedOutNotice, setSignedOutNotice] = useState('');
  const actionPending = useRef(false);
  const activeAccount = useRef('');
  const authorityGeneration = useRef(0);
  const retryLoad = useRef<(() => void) | null>(null);
  const recoveryStatus = useRef<HTMLDivElement>(null);
  const sessionStatus = useRef<HTMLDivElement>(null);
  const submittingPassword = useRef(false);
  const passwordInput = useRef<HTMLInputElement>(null);
  const passwordAlert = useRef<HTMLDivElement>(null);
  const identity = useAccountIdentity(
    accountId,
    authorityGeneration.current,
    (kind) => {
      clearPrivateData(kind === 'signed-out' ? 'signed-out' : 'failure');
    },
    identitySource,
  );

  useLayoutEffect(() => {
    let active = true;
    let pending = false;
    async function load(provided?: SecurityLoadResult) {
      if (!active || pending) return;
      pending = true;
      clearPrivateData('loading');
      setConsentReduced(false);
      const generation = authorityGeneration.current;
      const result = provided ?? (await loadSecurity(passkeysSupported()));
      if (!active) return;
      pending = false;
      if (authorityGeneration.current !== generation) return;
      if (result.kind === 'ready') {
        activeAccount.current = result.accountId;
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
    }
    retryLoad.current = () => void load();
    void load(initial);
    return () => {
      active = false;
      retryLoad.current = null;
      authorityGeneration.current++;
      activeAccount.current = '';
    };
  }, [initial]);

  useLayoutEffect(() => {
    if (passwordFieldError) passwordInput.current?.focus();
    else if (passwordError) passwordAlert.current?.focus();
  }, [passwordFieldError, passwordError]);

  useLayoutEffect(() => {
    if (recovery) recoveryStatus.current?.focus();
    else if (sessionNotice) sessionStatus.current?.focus();
  }, [recovery, sessionNotice]);

  function clearPrivateData(state: Exclude<LoadState, 'ready'>, notice = '') {
    authorityGeneration.current++;
    activeAccount.current = '';
    actionPending.current = false;
    submittingPassword.current = false;
    setAccountId('');
    setSessions([]);
    setPasskeys([]);
    setPasskeysLoad({ kind: 'hidden' });
    setPassword('');
    setPasskeyName('');
    setPasswordNotice('');
    setPasswordError('');
    setPasswordFieldError('');
    setSessionNotice('');
    setSessionError('');
    setPasskeyNotice('');
    setPasskeyError('');
    setRecovery(null);
    setReading(false);
    setPasswordPending(false);
    setSessionPending('');
    setPasskeyAdding(false);
    setPasskeyRemoving('');
    setSignedOutNotice(notice);
    setLoadMessage(m.auth_security_authority_changed());
    setLoadState(state);
  }

  async function recoverTarget() {
    if (!recovery || actionPending.current || reading) return;
    actionPending.current = true;
    setReading(true);
    const { target } = recovery;
    const generation = authorityGeneration.current;
    const result = await (securitySource?.read(target) ?? readSecurityTarget(target));
    if (authorityGeneration.current !== generation) return;
    actionPending.current = false;
    setReading(false);
    if (activeAccount.current !== target.accountId) return;
    if (result.kind === 'signed-out' || result.kind === 'denied') {
      clearPrivateData(result.kind === 'signed-out' ? 'signed-out' : 'failure', m.auth_security_action_unverified());
      return;
    }
    if (result.kind === 'unavailable') {
      setRecovery({ target, phase: 'unknown' });
      setSessionError(m.auth_security_readback_unavailable());
      return;
    }
    setSessionError('');
    setSessions(result.sessions);
    if (result.passkeys) setPasskeys(result.passkeys);
    if (result.presence === 'absent') {
      setRecovery(null);
      setSessionNotice(m.auth_security_target_absent());
    } else {
      setRecovery({ target, phase: result.presence === 'present' ? 'present' : 'unknown' });
      if (result.presence === 'unknown') setSessionError(m.auth_security_readback_unavailable());
    }
  }

  function finishAction(target: SecurityTarget, result: SecurityActionResult, current: boolean) {
    if (result.kind === 'signed-out' || result.kind === 'denied' || result.kind === 'step-up') {
      clearPrivateData(result.kind === 'denied' ? 'failure' : 'signed-out', m.auth_security_action_unverified());
      if (result.kind === 'step-up') window.location.assign(STEP_UP_URL);
      return;
    }
    if (result.kind === 'accepted' || result.kind === 'unknown') {
      // Native passkey removal revokes all sessions. An acknowledgement is not a later inventory read.
      if (result.sessionEnded || (result.kind === 'accepted' && (current || target.kind === 'passkey'))) {
        clearPrivateData(
          'signed-out',
          result.kind === 'accepted' ? m.auth_security_action_accepted() : m.auth_security_action_unverified(),
        );
        return;
      }
      setRecovery({ target, phase: result.kind });
      return;
    }
    if (target.kind === 'passkey')
      setPasskeyError(
        result.kind === 'last-credential'
          ? m.auth_security_passkey_last_credential()
          : m.auth_security_passkey_remove_failed(),
      );
    else setSessionError(m.auth_security_sessions_failed());
  }

  async function runAction(target: SecurityTarget, current = false, retry = false) {
    if (
      actionPending.current ||
      sessionPending ||
      passkeyAdding ||
      passkeyRemoving ||
      (recovery && (!retry || recovery.phase !== 'present')) ||
      activeAccount.current !== target.accountId
    )
      return;
    if (
      !window.confirm(
        target.kind === 'session'
          ? m.auth_security_revoke_confirmation()
          : m.auth_security_passkey_remove_confirmation(),
      )
    )
      return;
    actionPending.current = true;
    if (target.kind === 'session') setSessionPending(target.id);
    else setPasskeyRemoving(target.id);
    setSessionNotice('');
    setSessionError('');
    setPasskeyNotice('');
    setPasskeyError('');
    const generation = authorityGeneration.current;
    const result = securitySource
      ? await securitySource.act(target)
      : target.kind === 'session'
        ? await revokeSession(target.id, target.accountId)
        : await removePasskey(target.id, target.accountId);
    if (authorityGeneration.current !== generation) return;
    actionPending.current = false;
    setSessionPending('');
    setPasskeyRemoving('');
    if (activeAccount.current !== target.accountId) return;
    // A retry consumed the previous observation; another uncertain response needs another current read.
    setRecovery(null);
    finishAction(target, result, current);
  }

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
    const owner = accountId;
    const generation = authorityGeneration.current;
    const result = await changePassword(accountId, password);
    if (authorityGeneration.current !== generation) return;
    submittingPassword.current = false;
    setPasswordPending(false);
    if (activeAccount.current !== owner) return;
    if (result.ok) {
      clearPrivateData('signed-out', m.auth_security_password_changed());
      return;
    }
    if (result.reason === 'step-up') {
      clearPrivateData('signed-out');
      window.location.assign(STEP_UP_URL);
      return;
    }
    setPasswordError(result.message ?? failureMessage(503, 'unavailable', null));
  }

  async function submitPasskey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (actionPending.current || recovery || passkeyAdding || passkeyRemoving) return;
    setPasskeyAdding(true);
    setPasskeyNotice('');
    setPasskeyError('');
    const owner = accountId;
    const generation = authorityGeneration.current;
    const result = await addPasskey(passkeyName);
    if (authorityGeneration.current !== generation) return;
    setPasskeyAdding(false);
    if (activeAccount.current !== owner) return;
    if (result.ok) {
      setPasskeys((current) => [...current, result.passkey]);
      setPasskeyName('');
      setPasskeyNotice(m.auth_security_passkey_added());
    } else if (result.reason === 'step-up') {
      clearPrivateData('signed-out');
      window.location.assign(STEP_UP_URL);
    } else if (result.reason === 'failure') {
      setPasskeyError(result.message);
    }
  }

  async function removeOnePasskey(passkey: SecurityPasskey) {
    await runAction({ kind: 'passkey', id: passkey.id, accountId });
  }

  async function revoke(session: SecuritySession) {
    await runAction({ kind: 'session', id: session.id, accountId }, session.current);
  }

  if (loadState === 'signed-out')
    return (
      <AuthPage heading={m.auth_security_heading()}>
        <div className="auth-login-form">
          <p>{m.auth_security_sign_in_required()}</p>
          {signedOutNotice ? <p role="status">{signedOutNotice}</p> : null}
          {consentReduced ? <p role="status">{m.auth_inventory_reduced()}</p> : null}
          <a href="/login">{m.auth_security_sign_in()}</a>
        </div>
      </AuthPage>
    );

  if (loadState === 'failure')
    return (
      <AuthPage heading={m.auth_security_heading()}>
        <div className="auth-login-form">
          <ErrorAlert>{loadMessage}</ErrorAlert>
          <Button type="button" variant="outline" onClick={() => retryLoad.current?.()}>
            {m.auth_inventory_reload()}
          </Button>
          <a href="/login">{m.auth_security_sign_in()}</a>
        </div>
      </AuthPage>
    );

  const locale = typeof document === 'undefined' ? 'en' : document.documentElement.lang || 'en';
  const orderedSessions = [...sessions].sort((left, right) => Number(right.current) - Number(left.current));

  return (
    <AuthPage
      heading={m.auth_security_heading()}
      identity={
        <AccountIdentitySummary accountId={accountId} state={identity.state} action="security" retry={identity.retry} />
      }
    >
      <div className="auth-security-page" aria-busy={loadState === 'loading'}>
        {loadState === 'loading' ? (
          <p role="status">{m.auth_inventory_loading()}</p>
        ) : (
          <>
            {recovery ? (
              <div className="auth-login-form" aria-busy={reading}>
                <div ref={recoveryStatus} tabIndex={-1} role="status">
                  {recovery.phase === 'accepted'
                    ? m.auth_security_action_accepted()
                    : recovery.phase === 'present'
                      ? m.auth_security_target_present()
                      : m.auth_security_action_unknown()}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void recoverTarget()}
                  disabled={reading || Boolean(sessionPending) || Boolean(passkeyRemoving)}
                  aria-busy={reading}
                >
                  {m.auth_security_check_current()}
                </Button>
                {recovery.phase === 'present' ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={reading || Boolean(sessionPending) || Boolean(passkeyRemoving)}
                    onClick={() =>
                      void runAction(
                        recovery.target,
                        sessions.some((row) => row.id === recovery.target.id && row.current),
                        true,
                      )
                    }
                  >
                    {m.auth_security_retry_action()}
                  </Button>
                ) : null}
              </div>
            ) : null}
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
                  <p id="security-password-help" className="auth-security-hint">
                    {m.auth_security_password_invalid()}
                  </p>
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
                    aria-describedby={
                      passwordFieldError ? 'security-password-help security-password-error' : 'security-password-help'
                    }
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
                                  disabled={
                                    Boolean(recovery) ||
                                    reading ||
                                    Boolean(sessionPending) ||
                                    passkeyAdding ||
                                    Boolean(passkeyRemoving)
                                  }
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
                        disabled={
                          Boolean(recovery) ||
                          reading ||
                          Boolean(sessionPending) ||
                          passkeyAdding ||
                          Boolean(passkeyRemoving)
                        }
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
                <div className="auth-login-alert" role="status" tabIndex={-1} ref={sessionStatus}>
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
                            disabled={
                              Boolean(recovery) ||
                              reading ||
                              passkeyAdding ||
                              Boolean(passkeyRemoving) ||
                              Boolean(sessionPending)
                            }
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
                clearPrivateData('signed-out');
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
