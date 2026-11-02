import { createFileRoute, useBlocker, useRouter } from '@tanstack/react-router';
import { Badge } from '@rezics/ui/shadcn/badge';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { AuthButton as Button } from '../button';
import { Field, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@rezics/ui/shadcn/item';
import { PasswordInput } from '../password-input';
import { Trash2 } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type FormEvent, type MutableRefObject } from 'react';
import { flushSync } from 'react-dom';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';
import { useAccountIdentity, type AccountIdentitySource } from '../account-identity';
import { AccountIdentitySummary } from '../account-identity-view';
import { failureMessage } from '../api';
import { ErrorAlert } from '../alert';
import { SecurityInventory, type InventorySource } from '../security-inventory-view';
import type { ConsentReviewOperation } from '../security-inventory';
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
  reviewPasskeyRegistration,
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
type SecurityOperation =
  | { kind: 'password' | 'passkey-add' | 'consent' }
  | { kind: 'registration-review'; accountId: string; phase: 'unknown' | 'reviewed'; reading: boolean }
  | { kind: 'target'; target: SecurityTarget }
  | { kind: 'recovery'; target: SecurityTarget; phase: 'unknown' | 'accepted' | 'present'; reading: boolean };

type DepartureState = { protected: boolean; allow: boolean };
type DepartureBlocker =
  | { status: 'idle'; proceed: undefined; reset: undefined }
  | { status: 'blocked'; proceed: () => void; reset: () => void };
type SecurityPageProps = {
  initial?: SecurityLoadResult;
  inventorySource?: InventorySource;
  securitySource?: SecuritySource & { reviewRegistration?: typeof reviewPasskeyRegistration };
  identitySource?: AccountIdentitySource;
};

export function SecurityPage(props: SecurityPageProps = {}) {
  const router = useRouter({ warn: false });
  return router ? <RoutedSecurityPage {...props} /> : <SecurityPageView {...props} />;
}

function RoutedSecurityPage(props: SecurityPageProps) {
  const departure = useRef<DepartureState>({ protected: false, allow: false });
  const blocker = useBlocker({
    shouldBlockFn: () => departure.current.protected && !departure.current.allow,
    enableBeforeUnload: () => departure.current.protected && !departure.current.allow,
    withResolver: true,
  }) as DepartureBlocker;
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;
  useLayoutEffect(
    () => () => {
      if (blockerRef.current.status === 'blocked') blockerRef.current.proceed();
    },
    [],
  );
  return <SecurityPageView {...props} departure={departure} blocker={blocker} />;
}

const STEP_UP_URL = '/step-up?return_to=%2Fsecurity';

function SecurityPageView({
  initial,
  inventorySource,
  securitySource,
  identitySource,
  departure,
  blocker,
}: SecurityPageProps & { departure?: MutableRefObject<DepartureState>; blocker?: DepartureBlocker }) {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [accountId, setAccountId] = useState('');
  const [sessions, setSessions] = useState<SecuritySession[]>([]);
  const [loadMessage, setLoadMessage] = useState('');
  const [consentReduced, setConsentReduced] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordNotice, setPasswordNotice] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordFieldError, setPasswordFieldError] = useState('');
  const [sessionNotice, setSessionNotice] = useState('');
  const [sessionError, setSessionError] = useState('');
  const [passkeysLoad, setPasskeysLoad] = useState<PasskeysLoad>({ kind: 'hidden' });
  const [passkeys, setPasskeys] = useState<SecurityPasskey[]>([]);
  const [passkeyName, setPasskeyName] = useState('');
  const [passkeyNotice, setPasskeyNotice] = useState('');
  const [passkeyError, setPasskeyError] = useState('');
  const [operation, setOperation] = useState<SecurityOperation | null>(null);
  // The ref closes the boundary synchronously, including two submissions before React renders.
  const activeOperation = useRef<SecurityOperation | null>(null);
  const passwordPending = operation?.kind === 'password';
  const passkeyAdding = operation?.kind === 'passkey-add';
  const sessionPending = operation?.kind === 'target' && operation.target.kind === 'session' ? operation.target.id : '';
  const passkeyRemoving =
    operation?.kind === 'target' && operation.target.kind === 'passkey' ? operation.target.id : '';
  const recovery = operation?.kind === 'recovery' ? operation : null;
  const registrationRecovery = operation?.kind === 'registration-review' ? operation : null;
  const reading = recovery?.reading ?? false;
  const operationBlocked = operation !== null;
  const departureProtected = Boolean(password || passkeyName.trim() || operation);
  if (departure) departure.current.protected = departureProtected;
  const [signedOutNotice, setSignedOutNotice] = useState('');
  const activeAccount = useRef('');
  const authorityGeneration = useRef(0);
  const lifetime = useRef(new AbortController());
  const retryLoad = useRef<(() => void) | null>(null);
  const recoveryStatus = useRef<HTMLDivElement>(null);
  const sessionStatus = useRef<HTMLDivElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const passwordAlert = useRef<HTMLDivElement>(null);
  const departureDialog = useRef<HTMLDivElement>(null);
  const departureFocus = useRef<HTMLElement | null>(null);
  const focusAfterStay = useRef(false);
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
    let departed = false;
    let unresolved: SecurityTarget | null = null;
    async function load(provided?: SecurityLoadResult) {
      if (!active || departed || pending) return;
      pending = true;
      clearPrivateData('loading');
      setConsentReduced(false);
      const generation = authorityGeneration.current;
      const result =
        provided ??
        (await (securitySource?.load ?? loadSecurity)(passkeysSupported()).catch((): SecurityLoadResult => ({
          kind: 'failure',
          message: failureMessage(503, 'unavailable', null),
        })));
      if (!active || departed || authorityGeneration.current !== generation) return;
      pending = false;
      if (result.kind === 'ready') {
        activeAccount.current = result.accountId;
        setAccountId(result.accountId);
        setSessions(result.sessions);
        setPasskeysLoad(result.passkeys);
        if (result.passkeys.kind === 'ready') setPasskeys(result.passkeys.passkeys);
        if (unresolved?.accountId === result.accountId)
          updateOperation({ kind: 'recovery', target: unresolved, phase: 'unknown', reading: false });
        unresolved = null;
        setLoadState('ready');
      } else if (result.kind === 'signed-out') {
        unresolved = null;
        setLoadState('signed-out');
      } else {
        setLoadMessage(result.message);
        setLoadState('failure');
      }
    }
    function depart() {
      if (departed) return;
      departed = true;
      const held = activeOperation.current;
      if (held?.kind === 'target' || held?.kind === 'recovery') unresolved = held.target;
      pending = false;
      // Commit the cleared DOM before the browser freezes this document.
      flushSync(() => {
        clearPrivateData('loading');
        setConsentReduced(false);
      });
    }
    function restore(event: PageTransitionEvent) {
      if (!departed && !event.persisted) return;
      // Never reuse the initial render snapshot or an old read's pending flag.
      if (!departed) depart();
      departed = false;
      void load();
    }
    window.addEventListener('pagehide', depart);
    window.addEventListener('pageshow', restore);
    retryLoad.current = () => void load();
    void load(initial);
    return () => {
      active = false;
      window.removeEventListener('pagehide', depart);
      window.removeEventListener('pageshow', restore);
      lifetime.current.abort();
      retryLoad.current = null;
      authorityGeneration.current++;
      activeAccount.current = '';
    };
  }, [initial, securitySource]);

  useLayoutEffect(() => {
    if (passwordFieldError) passwordInput.current?.focus();
    else if (passwordError) passwordAlert.current?.focus();
  }, [passwordFieldError, passwordError]);

  useLayoutEffect(() => {
    if (recovery || registrationRecovery) recoveryStatus.current?.focus();
    else if (sessionNotice) sessionStatus.current?.focus();
  }, [recovery, registrationRecovery, sessionNotice]);

  useLayoutEffect(() => {
    if (!blocker || !departure) return;
    if (blocker.status === 'blocked') {
      if (!departureProtected) {
        departure.current.allow = true;
        blocker.proceed();
        return;
      }
      if (!departureFocus.current) {
        const active = document.activeElement;
        departureFocus.current = active instanceof HTMLElement && active !== document.body ? active : null;
      }
      departureDialog.current?.querySelector<HTMLButtonElement>('[data-stay]')?.focus();
    } else if (focusAfterStay.current) {
      focusAfterStay.current = false;
      const target = departureFocus.current;
      departureFocus.current = null;
      if (target?.isConnected && !target.hasAttribute('disabled')) target.focus();
      else if (recovery || registrationRecovery) recoveryStatus.current?.focus();
      else if (passwordInput.current?.value) passwordInput.current.focus();
      else document.querySelector<HTMLInputElement>('#security-passkey-name')?.focus();
    } else if (departure.current.allow) departure.current.allow = false;
  }, [blocker?.status, departureProtected, recovery, registrationRecovery]);

  function updateOperation(next: SecurityOperation | null) {
    activeOperation.current = next;
    setOperation(next);
  }

  function beginConsentReview(): ConsentReviewOperation | null {
    if (activeOperation.current || !activeAccount.current) return null;
    const held: SecurityOperation = { kind: 'consent' };
    const generation = authorityGeneration.current;
    updateOperation(held);
    const isCurrent = () => authorityGeneration.current === generation && activeOperation.current === held;
    return {
      isCurrent,
      finish: () => {
        // A disposed review cannot release a later page authority's operation.
        if (isCurrent()) updateOperation(null);
      },
    };
  }

  function clearPrivateData(state: Exclude<LoadState, 'ready'>, notice = '') {
    if (departure) departure.current.protected = false;
    authorityGeneration.current++;
    lifetime.current.abort();
    lifetime.current = new AbortController();
    activeAccount.current = '';
    updateOperation(null);
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
    setSignedOutNotice(notice);
    setLoadMessage(m.auth_security_authority_changed());
    setLoadState(state);
  }

  function stay() {
    if (blocker?.status !== 'blocked') return;
    focusAfterStay.current = true;
    blocker.reset();
  }

  function leave() {
    if (blocker?.status !== 'blocked' || !departure) return;
    departure.current.protected = false;
    departure.current.allow = true;
    clearPrivateData('loading');
    blocker.proceed();
  }

  async function recoverTarget() {
    const held = activeOperation.current;
    if (held?.kind !== 'recovery' || held.reading) return;
    updateOperation({ ...held, reading: true });
    const { target } = held;
    const generation = authorityGeneration.current;
    const result = await (securitySource?.read(target) ?? readSecurityTarget(target));
    if (authorityGeneration.current !== generation) return;
    if (activeAccount.current !== target.accountId) return;
    if (result.kind === 'signed-out' || result.kind === 'denied') {
      clearPrivateData(result.kind === 'signed-out' ? 'signed-out' : 'failure', m.auth_security_action_unverified());
      return;
    }
    if (result.kind === 'unavailable') {
      updateOperation({ kind: 'recovery', target, phase: 'unknown', reading: false });
      setSessionError(m.auth_security_readback_unavailable());
      return;
    }
    setSessionError('');
    setSessions(result.sessions);
    if (result.passkeys) setPasskeys(result.passkeys);
    if (result.presence === 'absent') {
      updateOperation(null);
      setSessionNotice(m.auth_security_target_absent());
    } else {
      updateOperation({
        kind: 'recovery',
        target,
        phase: result.presence === 'present' ? 'present' : 'unknown',
        reading: false,
      });
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
      updateOperation({ kind: 'recovery', target, phase: result.kind, reading: false });
      return;
    }
    updateOperation(null);
    if (target.kind === 'passkey')
      setPasskeyError(
        result.kind === 'last-credential'
          ? m.auth_security_passkey_last_credential()
          : m.auth_security_passkey_remove_failed(),
      );
    else setSessionError(m.auth_security_sessions_failed());
  }

  async function runAction(target: SecurityTarget, current = false, retry = false) {
    const held = activeOperation.current;
    const retryAllowed =
      retry &&
      held?.kind === 'recovery' &&
      !held.reading &&
      held.phase === 'present' &&
      held.target.accountId === target.accountId &&
      held.target.kind === target.kind &&
      held.target.id === target.id;
    if ((held && !retryAllowed) || activeAccount.current !== target.accountId || !target.accountId) return;
    const generation = authorityGeneration.current;
    if (
      !window.confirm(
        target.kind === 'session'
          ? m.auth_security_revoke_confirmation()
          : m.auth_security_passkey_remove_confirmation(),
      )
    )
      return;
    // A browser confirmation may have outlived the document's authority.
    if (authorityGeneration.current !== generation || activeAccount.current !== target.accountId) return;
    updateOperation({ kind: 'target', target });
    setSessionNotice('');
    setSessionError('');
    setPasskeyNotice('');
    setPasskeyError('');
    const result = securitySource
      ? await securitySource.act(target)
      : target.kind === 'session'
        ? await revokeSession(target.id, target.accountId)
        : await removePasskey(target.id, target.accountId);
    if (authorityGeneration.current !== generation) return;
    if (activeAccount.current !== target.accountId) return;
    // A retry consumes the observation; finishAction keeps any new uncertainty inside the boundary.
    finishAction(target, result, current);
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (activeOperation.current || !activeAccount.current) return;
    const passwordLength = Array.from(password).length;
    if (passwordLength < 8 || passwordLength > 128) {
      setPasswordNotice('');
      setPasswordFieldError(password ? m.auth_security_password_invalid() : m.auth_form_required());
      return;
    }
    setPasswordFieldError('');
    updateOperation({ kind: 'password' });
    setPasswordNotice('');
    setPasswordError('');
    const owner = accountId;
    const generation = authorityGeneration.current;
    const result = await changePassword(accountId, password, lifetime.current.signal);
    if (authorityGeneration.current !== generation) return;
    updateOperation(null);
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
    if (activeOperation.current || !activeAccount.current) return;
    updateOperation({ kind: 'passkey-add' });
    setPasskeyNotice('');
    setPasskeyError('');
    const owner = accountId;
    const generation = authorityGeneration.current;
    const result = await addPasskey(passkeyName, lifetime.current.signal);
    if (authorityGeneration.current !== generation) return;
    updateOperation(null);
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
    } else if (result.reason === 'unknown') {
      updateOperation({ kind: 'registration-review', accountId: owner, phase: 'unknown', reading: false });
    }
  }

  async function reviewRegistration() {
    const held = activeOperation.current;
    if (held?.kind !== 'registration-review' || held.reading) return;
    updateOperation({ ...held, reading: true });
    const generation = authorityGeneration.current;
    const result = await (securitySource?.reviewRegistration ?? reviewPasskeyRegistration)(
      held.accountId,
      lifetime.current.signal,
    );
    if (authorityGeneration.current !== generation || activeAccount.current !== held.accountId) return;
    if (result.kind === 'signed-out' || result.kind === 'denied') {
      clearPrivateData(result.kind === 'signed-out' ? 'signed-out' : 'failure', m.auth_security_action_unverified());
      return;
    }
    if (result.kind === 'unavailable') {
      updateOperation({ ...held, phase: 'unknown', reading: false });
      setPasskeyError(m.auth_security_readback_unavailable());
      return;
    }
    setPasskeys(result.passkeys);
    setPasskeysLoad(result);
    setPasskeyError('');
    // Native row IDs are authoritative. Neither a name nor a WebAuthn credential ID identifies a saved row.
    updateOperation({ ...held, phase: 'reviewed', reading: false });
  }

  function finishRegistrationReview() {
    const held = activeOperation.current;
    if (held?.kind !== 'registration-review' || held.reading || held.phase !== 'reviewed') return;
    updateOperation(null);
    setPasskeyName('');
    setPasskeyNotice(m.auth_security_passkey_registration_reviewed());
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
    <>
      <AuthPage
        heading={m.auth_security_heading()}
        identity={
          <AccountIdentitySummary
            accountId={accountId}
            state={identity.state}
            action="security"
            retry={identity.retry}
          />
        }
      >
        <div className="auth-security-page" aria-busy={loadState === 'loading' || operationBlocked}>
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
                    disabled={reading}
                    aria-busy={reading}
                  >
                    {m.auth_security_check_current()}
                  </Button>
                  {recovery.phase === 'present' ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={reading}
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
              {registrationRecovery ? (
                <div className="auth-login-form" aria-busy={registrationRecovery.reading}>
                  <div ref={recoveryStatus} tabIndex={-1} role="status">
                    {registrationRecovery.phase === 'reviewed'
                      ? m.auth_security_passkey_registration_reviewed()
                      : m.auth_security_passkey_registration_unknown()}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void reviewRegistration()}
                    disabled={registrationRecovery.reading}
                    aria-busy={registrationRecovery.reading}
                  >
                    {m.auth_security_check_current()}
                  </Button>
                  {registrationRecovery.phase === 'reviewed' ? (
                    <Button type="button" variant="outline" onClick={finishRegistrationReview}>
                      {m.auth_security_passkey_registration_continue()}
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
                      readOnly={operationBlocked}
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
                  <Button type="submit" disabled={operationBlocked} aria-busy={passwordPending} className="w-full">
                    {m.auth_security_password_submit()}
                  </Button>
                </form>
              </section>

              {passkeysLoad.kind === 'hidden' ? null : (
                <section aria-labelledby="security-passkeys-heading">
                  <h2 id="security-passkeys-heading">{m.auth_security_passkeys_heading()}</h2>
                  {passkeysLoad.kind === 'failure' ? (
                    <>
                      <ErrorAlert>{passkeysLoad.message}</ErrorAlert>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={operationBlocked}
                        onClick={() => retryLoad.current?.()}
                      >
                        {m.auth_inventory_reload()}
                      </Button>
                    </>
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
                                    disabled={operationBlocked}
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
                            readOnly={operationBlocked}
                          />
                        </Field>
                        <Button type="submit" disabled={operationBlocked} aria-busy={passkeyAdding} className="w-full">
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
                    const device = parsedDevice
                      ? m.auth_security_device(parsedDevice)
                      : m.auth_security_unknown_device();
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
                              disabled={operationBlocked}
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
                lifetime={lifetime.current.signal}
                {...(inventorySource ? { source: inventorySource } : {})}
                operation={{ blocked: operationBlocked, begin: beginConsentReview }}
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
      {blocker?.status === 'blocked' && departureProtected ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div
            ref={departureDialog}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="security-departure-heading"
            aria-describedby="security-departure-description"
            className="w-full max-w-md rounded-lg border bg-background p-6 text-foreground shadow-xl"
          >
            <h2 id="security-departure-heading" className="text-lg font-semibold">
              {m.auth_security_departure_heading()}
            </h2>
            <p id="security-departure-description" className="mt-2 text-sm">
              {m.auth_security_departure_description()}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button type="button" variant="outline" data-stay onClick={stay}>
                {m.auth_security_departure_stay()}
              </Button>
              <Button type="button" data-leave onClick={leave}>
                {m.auth_security_departure_leave()}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
