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
import type { SecurityPageEnvelope, SecurityAdvice, ConsentReviewOperation } from '../security-inventory';
import { privateAuthRead } from '../private-auth-read';
import { waitForSecurityAction } from '../security-target-operation';
import {
  SecurityTargetReview,
  SecurityTargetRecovery,
  securityTargetRow,
  targetAdvice,
  type TargetRecoveryPhase,
} from '../security-target-review';
import { addPasskey, passkeysSupported } from '../passkeys';
import {
  readSecurityTarget,
  performSecurityAction,
  type SecurityTarget,
  type SecurityActionResult,
  type SecuritySource,
} from '../security-reconciliation';
import {
  changePassword,
  formatSecurityDate,
  loadSecurity,
  reviewPasskeyRegistration,
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
  | { kind: 'review'; target: SecurityTarget; generation: number; advice: number; retry: boolean }
  | { kind: 'target'; target: SecurityTarget }
  | { kind: 'recovery'; target: SecurityTarget; phase: TargetRecoveryPhase; reading: boolean };

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
function canAct(advice: SecurityAdvice | undefined) {
  return advice === 'allowed' || advice === 'step-up-required';
}
function AdviceHint({ advice }: { advice: SecurityAdvice | undefined }) {
  if (advice === 'allowed') return null;
  return (
    <p className="auth-security-hint">
      {advice === 'step-up-required'
        ? m.auth_security_step_up_advice()
        : advice === 'last-credential'
          ? m.auth_security_passkey_last_credential()
          : advice === 'capacity'
            ? m.auth_security_passkey_capacity()
            : m.auth_inventory_unavailable()}
    </p>
  );
}

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
  const [page, setPage] = useState<SecurityPageEnvelope | null>(null);
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
  const targetReview = operation?.kind === 'review' ? operation : null;
  const recovery = operation?.kind === 'recovery' ? operation : null;
  const registrationRecovery = operation?.kind === 'registration-review' ? operation : null;
  const reading = recovery?.reading ?? false;
  const operationBlocked = operation !== null;
  const departureProtected = Boolean(password || passkeyName.trim() || operation);
  if (departure) departure.current.protected = departureProtected;
  const [signedOutNotice, setSignedOutNotice] = useState('');
  const activeAccount = useRef('');
  const authorityGeneration = useRef(0);
  const renderGeneration = authorityGeneration.current;
  const adviceGeneration = useRef(0);
  const renderAdviceGeneration = adviceGeneration.current;
  const lifetime = useRef(new AbortController());
  const retryLoad = useRef<(() => void) | null>(null);
  const targetOrigin = useRef<HTMLElement | null>(null);
  const returnTargetFocus = useRef<'session' | 'passkey' | null>(null);
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
        setPage(result.page ?? null);
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
    if (returnTargetFocus.current && !operation) {
      const kind = returnTargetFocus.current;
      returnTargetFocus.current = null;
      const origin = targetOrigin.current;
      targetOrigin.current = null;
      if (origin?.isConnected && !origin.hasAttribute('disabled')) origin.focus();
      else
        document
          .getElementById(kind === 'session' ? 'security-sessions-heading' : 'security-passkeys-heading')
          ?.focus();
    } else if (recovery || registrationRecovery) recoveryStatus.current?.focus();
    else if (sessionNotice) sessionStatus.current?.focus();
  }, [operation, recovery, registrationRecovery, sessionNotice]);

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
    adviceGeneration.current++;
    lifetime.current.abort();
    lifetime.current = new AbortController();
    activeAccount.current = '';
    targetOrigin.current = null;
    returnTargetFocus.current = null;
    updateOperation(null);
    setAccountId('');
    setPage(null);
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
    adviceGeneration.current++;
    const attempt: SecurityOperation = { ...held, reading: true };
    updateOperation(attempt);
    const { target } = held;
    const generation = authorityGeneration.current;
    const result = await privateAuthRead(
      (signal) => (securitySource?.read ?? readSecurityTarget)(target, signal),
      lifetime.current.signal,
    ).catch(() => ({ kind: 'unavailable' as const }));
    if (authorityGeneration.current !== generation || activeOperation.current !== attempt) return;
    if (activeAccount.current !== target.accountId) return;
    if (result.kind === 'signed-out' || result.kind === 'denied') {
      clearPrivateData(result.kind === 'signed-out' ? 'signed-out' : 'failure', m.auth_security_action_unverified());
      return;
    }
    if (result.kind === 'unavailable') {
      updateOperation({ kind: 'recovery', target, phase: 'unavailable', reading: false });
      setSessionError('');
      return;
    }
    setSessionError('');
    if (result.page) setPage(result.page);
    setSessions(result.sessions);
    if (result.passkeys) setPasskeys(result.passkeys);
    if (result.presence === 'absent') {
      returnTargetFocus.current = target.kind;
      updateOperation(null);
      setSessionNotice(target.kind === 'session' ? m.auth_security_session_absent() : m.auth_security_passkey_absent());
    } else {
      updateOperation({
        kind: 'recovery',
        target,
        phase: result.presence === 'present' ? 'present' : 'truncated',
        reading: false,
      });
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
        if (result.kind === 'accepted' && current && target.kind === 'session') window.location.assign('/login');
        return;
      }
      updateOperation({ kind: 'recovery', target, phase: result.kind, reading: false });
      if (result.kind === 'accepted') void recoverTarget();
      return;
    }
    returnTargetFocus.current = target.kind;
    updateOperation(null);
    if (target.kind === 'passkey')
      setPasskeyError(
        result.kind === 'last-credential'
          ? m.auth_security_passkey_last_credential()
          : m.auth_security_passkey_remove_failed(),
      );
    else setSessionError(m.auth_security_sessions_failed());
  }

  function reviewTarget(target: SecurityTarget, retry = false) {
    if (renderGeneration !== authorityGeneration.current || renderAdviceGeneration !== adviceGeneration.current) return;
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
    const selected = securityTargetRow(target, sessions, passkeys);
    if (!selected || !canAct(targetAdvice(selected))) return;
    targetOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    updateOperation({
      kind: 'review',
      target,
      generation: authorityGeneration.current,
      advice: adviceGeneration.current,
      retry,
    });
  }

  function cancelTargetReview(expected: Extract<SecurityOperation, { kind: 'review' }>) {
    const held = activeOperation.current;
    if (held !== expected || held.kind !== 'review') return;
    if (held.retry) updateOperation({ kind: 'recovery', target: held.target, phase: 'present', reading: false });
    else {
      returnTargetFocus.current = held.target.kind;
      updateOperation(null);
    }
  }

  async function confirmTarget(expected: Extract<SecurityOperation, { kind: 'review' }>) {
    const held = activeOperation.current;
    if (held !== expected || held.kind !== 'review') return;
    const { target, generation } = held;
    if (
      generation !== authorityGeneration.current ||
      held.advice !== adviceGeneration.current ||
      renderGeneration !== generation ||
      renderAdviceGeneration !== held.advice ||
      activeAccount.current !== target.accountId
    )
      return;
    const selected = securityTargetRow(target, sessions, passkeys);
    const advice = targetAdvice(selected);
    if (!selected || !canAct(advice)) {
      cancelTargetReview(held);
      return;
    }
    if (advice === 'step-up-required') {
      clearPrivateData('signed-out');
      window.location.assign(STEP_UP_URL);
      return;
    }
    const current = selected.kind === 'session' && selected.row.current;
    const dispatch: SecurityOperation = { kind: 'target', target };
    updateOperation(dispatch);
    setSessionNotice('');
    setSessionError('');
    setPasskeyNotice('');
    setPasskeyError('');
    const result = await waitForSecurityAction(
      (signal) => (securitySource ? securitySource.act(target, signal) : performSecurityAction(target, signal)),
      lifetime.current.signal,
    );
    if (
      authorityGeneration.current !== generation ||
      activeOperation.current !== dispatch ||
      activeAccount.current !== target.accountId
    )
      return;
    finishAction(target, result, current);
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (renderGeneration !== authorityGeneration.current || renderAdviceGeneration !== adviceGeneration.current) return;
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
    if (renderGeneration !== authorityGeneration.current || renderAdviceGeneration !== adviceGeneration.current) return;
    if (
      activeOperation.current ||
      !activeAccount.current ||
      !passkeysSupported() ||
      !canAct(page?.actions.register_passkey)
    )
      return;
    if (page?.actions.register_passkey === 'step-up-required') {
      clearPrivateData('signed-out');
      window.location.assign(STEP_UP_URL);
      return;
    }
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
      // Retire earlier target advice until the native composition has caught up.
      setPasskeys((current) => [...current.map((row) => ({ ...row, remove: 'unavailable' as const })), result.passkey]);
      setPage(null);
      void refreshRegistrationInventory(owner, generation);
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

  async function refreshRegistrationInventory(owner: string, generation: number) {
    adviceGeneration.current++;
    updateOperation({ kind: 'passkey-add' });
    setSessions((current) => current.map((row) => ({ ...row, revoke: 'unavailable' as const })));
    const result = await (securitySource?.load ?? loadSecurity)(passkeysSupported()).catch((): SecurityLoadResult => ({
      kind: 'failure',
      message: m.auth_security_passkeys_failed(),
    }));
    if (authorityGeneration.current !== generation || activeAccount.current !== owner) return;
    updateOperation(null);
    if (result.kind === 'signed-out' || (result.kind === 'ready' && result.accountId !== owner)) {
      clearPrivateData(result.kind === 'signed-out' ? 'signed-out' : 'failure');
      return;
    }
    setPage(result.kind === 'ready' ? (result.page ?? null) : null);
    if (result.kind === 'ready') {
      setSessions(result.sessions);
      setPasskeysLoad(result.passkeys);
      setPasskeys(result.passkeys.kind === 'ready' ? result.passkeys.passkeys : []);
    } else {
      setPasskeysLoad({ kind: 'failure', message: m.auth_security_passkeys_failed() });
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
    setPage(null);
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
    void refreshRegistrationInventory(held.accountId, authorityGeneration.current);
  }

  async function removeOnePasskey(passkey: SecurityPasskey) {
    reviewTarget({ kind: 'passkey', id: passkey.id, accountId });
  }

  async function revoke(session: SecuritySession) {
    reviewTarget({ kind: 'session', id: session.id, accountId });
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
  const historicalTarget = (kind: SecurityTarget['kind'], id: string) =>
    (operation?.kind === 'target' ||
      (operation?.kind === 'recovery' && (operation.reading || operation.phase !== 'present'))) &&
    operation.target.kind === kind &&
    operation.target.id === id;
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
        <div
          className="auth-security-page"
          aria-busy={loadState === 'loading' || (operationBlocked && operation?.kind !== 'review')}
        >
          {loadState === 'loading' ? (
            <p role="status">{m.auth_inventory_loading()}</p>
          ) : (
            <>
              {targetReview && securityTargetRow(targetReview.target, sessions, passkeys) ? (
                <SecurityTargetReview
                  selected={securityTargetRow(targetReview.target, sessions, passkeys)!}
                  locale={locale}
                  retry={targetReview.retry}
                  confirm={() => void confirmTarget(targetReview)}
                  cancel={() => cancelTargetReview(targetReview)}
                />
              ) : null}
              {operation?.kind === 'target' ? <p role="status">{m.auth_inventory_loading()}</p> : null}
              {recovery ? (
                <SecurityTargetRecovery
                  target={recovery.target}
                  phase={recovery.phase}
                  reading={reading}
                  selected={securityTargetRow(recovery.target, sessions, passkeys)}
                  locale={locale}
                  retryAllowed={canAct(targetAdvice(securityTargetRow(recovery.target, sessions, passkeys)))}
                  statusRef={recoveryStatus}
                  check={() => void recoverTarget()}
                  review={() => reviewTarget(recovery.target, true)}
                />
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
                  <AdviceHint advice={page?.actions.change_password} />
                  <Button
                    type="submit"
                    disabled={operationBlocked || !canAct(page?.actions.change_password)}
                    aria-busy={passwordPending}
                    className="w-full"
                  >
                    {m.auth_security_password_submit()}
                  </Button>
                </form>
              </section>

              {passkeysLoad.kind === 'hidden' ? null : (
                <section aria-labelledby="security-passkeys-heading">
                  <h2 id="security-passkeys-heading" tabIndex={-1}>
                    {m.auth_security_passkeys_heading()}
                  </h2>
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
                                    <h3>{passkey.name.trim() || m.auth_security_passkey_unnamed()}</h3>
                                  </ItemTitle>
                                  <ItemDescription className="line-clamp-none wrap-anywhere">
                                    {historicalTarget('passkey', passkey.id) ? (
                                      <span className="block">{m.auth_security_target_historical()}</span>
                                    ) : null}
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
                                <ItemActions className="max-w-full flex-col items-start">
                                  <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => void removeOnePasskey(passkey)}
                                    disabled={operationBlocked || !canAct(passkey.remove)}
                                    aria-busy={passkeyRemoving === passkey.id}
                                    aria-label={m.auth_security_passkey_remove_named({
                                      name: passkey.name.trim() || m.auth_security_passkey_unnamed(),
                                    })}
                                  >
                                    {m.auth_security_passkey_remove()}
                                  </Button>
                                  <AdviceHint advice={passkey.remove} />
                                </ItemActions>
                              </article>
                            </Item>
                          ))}
                        </ItemGroup>
                      ) : (
                        <p>{m.auth_security_passkeys_empty()}</p>
                      )}
                      {page?.passkeys.kind === 'ready' && page.passkeys.truncated ? (
                        <p>{m.auth_security_inventory_truncated()}</p>
                      ) : null}
                      {!passkeysSupported() ? (
                        <p>{m.auth_security_passkeys_browser_unavailable()}</p>
                      ) : (
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
                          <Button
                            type="submit"
                            disabled={operationBlocked || !canAct(page?.actions.register_passkey)}
                            aria-busy={passkeyAdding}
                            className="w-full"
                          >
                            {m.auth_security_passkey_add()}
                          </Button>
                        </form>
                      )}
                      <AdviceHint advice={page?.actions.register_passkey} />
                    </>
                  )}
                </section>
              )}

              <section aria-labelledby="security-sessions-heading">
                <h2 id="security-sessions-heading" tabIndex={-1}>
                  {m.auth_security_sessions_heading()}
                </h2>
                {sessionNotice ? (
                  <div className="auth-login-alert" role="status" tabIndex={-1} ref={sessionStatus}>
                    {sessionNotice}
                  </div>
                ) : null}
                {sessionError ? <ErrorAlert>{sessionError}</ErrorAlert> : null}
                {page?.sessions.kind === 'unavailable' || !page ? (
                  <ErrorAlert>{m.auth_security_sessions_failed()}</ErrorAlert>
                ) : null}
                {page?.sessions.kind === 'ready' && page.sessions.truncated ? (
                  <p>{m.auth_security_inventory_truncated()}</p>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  disabled={operationBlocked}
                  onClick={() => retryLoad.current?.()}
                >
                  {m.auth_inventory_reload()}
                </Button>
                {page?.sessions.kind === 'ready' && !orderedSessions.length ? (
                  <p>{m.auth_security_sessions_empty()}</p>
                ) : null}
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
                              {historicalTarget('session', session.id) ? (
                                <span className="block">{m.auth_security_target_historical()}</span>
                              ) : null}
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
                              disabled={operationBlocked || !canAct(session.revoke)}
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
