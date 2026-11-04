import { createFileRoute, useBlocker, useRouter } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { AuthButton as Button } from '../button';
import { AuthPage } from '../frame';
import { ErrorAlert } from '../alert';
import { PasswordInput } from '../password-input';
import { loadAccountSession, type AccountSessionResult } from '../account-operations';
import { m } from '../paraglide/messages.js';
import {
  downloadTransferHandoff,
  readTransferHandoff,
  type HandoffError,
  type HandoffKind,
} from '../operator-transfer-handoff';
import {
  parseTransferRequest,
  isTransferFailure,
  pageFailure,
  prepareTransfer,
  readOperatorRelation,
  readOperatorTransferPage,
  reauthenticateTransfer,
  refreshTransferAdvice,
  reviewDestinationTransfer,
  restoreTransferAttempt,
  sameRelation,
  storeTransferAttempt,
  submitTransferAttempt,
  type OperatorRelation,
  type TransferAttempt,
  type TransferFailure,
  type TransferResult,
} from '../operator-transfer';
import {
  confirmsTransferReadback,
  readTransferRecovery,
  retainsTransferWork,
  transferRecoveryKind,
  type TransferRecoveryKind,
} from '../operator-transfer-recovery';
import { OperatorTransferRecoveryView } from '../operator-transfer-recovery-view';

export const Route = createFileRoute('/operators/transfer')({
  head: () => ({ meta: [{ title: `${m.auth_transfer_heading()} · REZICS` }] }),
  component: OperatorTransferPage,
});

// The transfer page alone owns this guard; standalone fixtures need no router.
function TransferDeparture({
  work,
  validate,
  retire,
}: {
  work: () => boolean;
  validate: () => Promise<void>;
  retire: () => void;
}) {
  const blocker = useBlocker({
    shouldBlockFn: async () => {
      await validate();
      return work();
    },
    enableBeforeUnload: work,
    withResolver: true,
  });
  const dialog = useRef<HTMLDialogElement>(null);
  const stay = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (blocker.status !== 'blocked') return;
    if (!work()) {
      blocker.proceed();
      return;
    }
    const previous = document.activeElement as HTMLElement | null;
    const modal = dialog.current!;
    modal.showModal();
    stay.current?.focus();
    return () => {
      modal.close();
      if (previous?.isConnected) previous.focus();
      else document.getElementById('transfer-notice')?.focus();
    };
  }, [blocker.status, work]);
  return blocker.status === 'blocked' ? (
    <dialog
      ref={dialog}
      aria-labelledby="transfer-departure-title"
      onCancel={(event) => {
        event.preventDefault();
        blocker.reset();
      }}
    >
      <h2 id="transfer-departure-title">{m.auth_transfer_departure_heading()}</h2>
      <p>{m.auth_transfer_departure_description()}</p>
      <p>{m.auth_account_operation_leave_notice()}</p>
      <div className="flex gap-3">
        <Button ref={stay} type="button" onClick={() => blocker.reset()}>
          {m.auth_organization_departure_stay()}
        </Button>
        <Button
          type="button"
          onClick={() => {
            retire();
            blocker.proceed();
          }}
        >
          {m.auth_organization_departure_leave()}
        </Button>
      </div>
    </dialog>
  ) : null;
}

function errorMessage(result: TransferFailure): string {
  switch (result.reason) {
    case 'account-changed':
      return m.auth_transfer_account_changed();
    case 'conflict':
      return m.auth_transfer_conflict();
    case 'denied':
      return m.auth_transfer_denied();
    case 'uncertain':
      return m.auth_transfer_uncertain();
    case 'step-up':
      return m.auth_transfer_step_up();
    case 'invalid':
      return m.auth_transfer_invalid();
    default:
      return m.auth_transfer_unavailable();
  }
}

function fileError(reason: HandoffError): string {
  switch (reason) {
    case 'one-file':
      return m.auth_transfer_handoff_one_file();
    case 'too-large':
      return m.auth_transfer_handoff_too_large();
    case 'unreadable':
      return m.auth_transfer_handoff_unreadable();
    case 'invalid-request':
      return m.auth_transfer_handoff_invalid_request();
    case 'invalid-acceptance':
      return m.auth_transfer_handoff_invalid_acceptance();
  }
}

export function OperatorTransferPage({ initial }: { initial?: AccountSessionResult } = {}) {
  const router = useRouter({ warn: false });
  const [reload, setReload] = useState(0);
  const [session, setSession] = useState<AccountSessionResult | null>(null);
  const [attempt, setAttempt] = useState<TransferAttempt | null>(null);
  const [subject, setSubject] = useState('');
  const [destination, setDestination] = useState('');
  const [requestText, setRequestText] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<TransferResult | null>(null);
  const [current, setCurrent] = useState<OperatorRelation | null>(null);
  const [needsProof, setNeedsProof] = useState(false);
  const [nativeAdvice, setNativeAdvice] = useState<'source' | 'destination' | null>(null);
  const [reconfirmed, setReconfirmed] = useState(false);
  const [invalidContinuation, setInvalidContinuation] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fileFeedback, setFileFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [nativeReady, setNativeReady] = useState(false);
  const [attemptReviewed, setAttemptReviewed] = useState(false);
  const [recovery, setRecovery] = useState<TransferRecoveryKind>('none');
  const [recoveryReviewed, setRecoveryReviewed] = useState(false);
  const [readRecovery, setReadRecovery] = useState(false);
  const retryRead = useRef<(() => Promise<TransferFailure | void>) | null>(null);
  const view = useRef(0);
  const fileRead = useRef(0);
  const liveAttempt = useRef<TransferAttempt | null>(null);
  const busy = useRef(false);
  const notice = useRef<HTMLDivElement>(null);

  const retired = useRef(false);
  const recoveryKind = useRef<TransferRecoveryKind>('none');
  // Only a review created here is known to be unsent. Restored commands may be unresolved.
  const unsent = useRef<TransferAttempt | null>(null);
  const state = useRef({
    session,
    result,
    attempt,
    subject,
    destination,
    requestText,
    acceptance,
    invalidContinuation,
    needsProof,
    nativeReady,
    recovery,
  });
  state.current = {
    session,
    result,
    attempt,
    subject,
    destination,
    requestText,
    acceptance,
    invalidContinuation,
    needsProof,
    nativeReady,
    recovery,
  };
  function updateRecovery(value: TransferRecoveryKind) {
    recoveryKind.current = value;
    setRecovery(value);
  }
  const protectedWork = () => {
    const value = state.current;
    if (retainsTransferWork(recoveryKind.current)) return true;
    if (retired.current || value.invalidContinuation || value.needsProof || value.session?.kind !== 'ready')
      return false;
    if (
      value.result?.kind === 'current' ||
      (value.result?.kind === 'acknowledged' && value.result.readback.kind === 'current')
    )
      return false;
    return Boolean(
      value.attempt ||
      value.subject.trim() ||
      value.destination.trim() ||
      value.requestText.trim() ||
      value.acceptance.trim(),
    );
  };
  function retire() {
    if (retired.current) return;
    retired.current = true;
    view.current++;
    fileRead.current++;
    const discardUnsent = unsent.current && JSON.stringify(restoreTransferAttempt()) === JSON.stringify(unsent.current);
    const currentAttempt = state.current.attempt ?? liveAttempt.current;
    const inferred = transferRecoveryKind(currentAttempt, state.current.result);
    updateRecovery(
      discardUnsent
        ? 'none'
        : inferred !== 'none' || currentAttempt || state.current.result
          ? inferred
          : recoveryKind.current,
    );
    // Never remove a command that may have reached native, or another view's saved work.
    if (unsent.current && JSON.stringify(restoreTransferAttempt()) === JSON.stringify(unsent.current)) {
      try {
        window.sessionStorage.removeItem('rezics.operator-transfer.attempt');
      } catch {
        /* Recovery remains saved. */
      }
    }
    unsent.current = null;
    liveAttempt.current = null;
    busy.current = false;
    retryRead.current = null;
    setAttempt(null);
    setResult(null);
    setCurrent(null);
    setNativeReady(false);
    setAttemptReviewed(false);
    setRecoveryReviewed(false);
    setConfirmed(false);
    setPending(false);
    setSubject('');
    setDestination('');
    setRequestText('');
    setAcceptance('');
    setPassword('');
    setEmail('');
    setFileFeedback(null);
    setNativeAdvice(null);
    setUncertain(false);
  }
  async function validateCaller() {
    const started = view.current;
    const owner = state.current.session;
    if (retired.current || busy.current || owner?.kind !== 'ready') return;
    setConfirmed(false);
    setRecoveryReviewed(false);
    setNativeAdvice(null);
    const caller = await loadAccountSession();
    if (started !== view.current) return;
    if (caller.kind === 'failure') {
      offerReadRetry(() => validateCaller());
      return;
    }
    if (caller.kind === 'signed-out' || (caller.kind === 'ready' && caller.accountId !== owner.accountId)) {
      retire();
      setSession(caller);
      setNativeReady(false);
      setNeedsProof(false);
      setInvalidContinuation(true);
      setResult({ kind: 'failure', reason: 'account-changed' });
      return;
    }
    if (caller.kind !== 'ready') return;
    const readiness = await readOperatorTransferPage({ kind: 'readiness' }, owner.accountId);
    if (started !== view.current) return;
    if (isTransferFailure(readiness)) {
      if (readiness.reason === 'unavailable') offerReadRetry(() => validateCaller());
      else showFailure(readiness);
      return;
    }
    if (readiness.viewer.kind !== 'ready') {
      retire();
      setSession(caller);
      setNativeReady(false);
      setNeedsProof(readiness.viewer.kind === 'authentication-required');
      setInvalidContinuation(readiness.viewer.kind === 'signed-out' || readiness.viewer.kind === 'refused');
      setResult({
        kind: 'failure',
        reason: readiness.viewer.kind === 'authentication-required' ? 'step-up' : 'denied',
      });
      return;
    }
    setSession(caller);
    setNativeReady(true);
  }
  useEffect(() => {
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) setReload((value) => value + 1);
    };
    window.addEventListener('pagehide', retire);
    window.addEventListener('pageshow', restore);
    window.addEventListener('focus', validateCaller);
    return () => {
      window.removeEventListener('pagehide', retire);
      window.removeEventListener('pageshow', restore);
      window.removeEventListener('focus', validateCaller);
    };
  }, []);

  function clearImported() {
    fileRead.current++;
    setRequestText('');
    setAcceptance(liveAttempt.current?.acceptance ?? '');
    setFileFeedback(null);
    setConfirmed(false);
  }
  // Invalidate pending local reads before another session view can be installed.
  useLayoutEffect(() => {
    view.current++;
    retired.current = false;
    unsent.current = null;
    busy.current = false;
    liveAttempt.current = null;
    clearImported();
    setSession(null);
    setAttempt(null);
    setResult(null);
    setCurrent(null);
    setNativeReady(false);
    setAttemptReviewed(false);
    updateRecovery('none');
    setRecoveryReviewed(false);
    setNativeAdvice(null);
    setReconfirmed(false);
    setInvalidContinuation(false);
    setNeedsProof(false);
    setUncertain(false);
    retryRead.current = null;
    setReadRecovery(false);
    setPending(false);
    setPassword('');
    setEmail('');
    setSubject('');
    setDestination('');
    return () => {
      retire();
    };
  }, [initial, reload]);
  useEffect(() => {
    readPage(() => loadPageSession(reload === 0 ? initial : undefined));
  }, [initial, reload]);
  useLayoutEffect(() => {
    if (result || reconfirmed || fileFeedback || readRecovery || (recovery !== 'none' && !nativeReady))
      notice.current?.focus();
  }, [result, reconfirmed, fileFeedback, readRecovery, recovery, nativeReady]);

  async function loadPageSession(supplied?: AccountSessionResult): Promise<TransferFailure | void> {
    const started = view.current;
    const value = supplied ?? (await loadAccountSession());
    if (started !== view.current) return;
    setSession(value);
    setNativeReady(false);
    const saved = restoreTransferAttempt();
    if (saved === 'invalid') updateRecovery('unreadable');
    else if (saved) updateRecovery(transferRecoveryKind(saved));
    // An unavailable read says nothing about the saved attempt's owner.
    if (value.kind === 'failure') {
      offerReadRetry(() => loadPageSession());
      return { kind: 'failure', reason: 'unavailable' };
    }
    if (saved === 'invalid') {
      setInvalidContinuation(true);
      setResult({ kind: 'failure', reason: 'invalid' });
      return { kind: 'failure', reason: 'invalid' };
    }
    if (saved && (value.kind !== 'ready' || saved.accountId !== value.accountId)) {
      retire();
      setSession(value);
      setInvalidContinuation(true);
      setResult({ kind: 'failure', reason: 'account-changed' });
      return { kind: 'failure', reason: 'account-changed' };
    }
    const readiness = await readOperatorTransferPage(
      { kind: 'readiness' },
      value.kind === 'ready' ? value.accountId : undefined,
    );
    if (started !== view.current) return;
    if (isTransferFailure(readiness)) {
      offerReadRetry(() => loadPageSession());
      return readiness;
    }
    if (value.kind !== 'ready' || readiness.viewer.kind !== 'ready') {
      retire();
      setSession(value.kind === 'ready' && readiness.viewer.kind === 'signed-out' ? { kind: 'signed-out' } : value);
      setNativeReady(false);
      setNeedsProof(readiness.viewer.kind === 'authentication-required');
      setInvalidContinuation(readiness.viewer.kind === 'signed-out' || readiness.viewer.kind === 'refused');
      const reason = readiness.viewer.kind === 'authentication-required' ? 'step-up' : 'denied';
      setResult({ kind: 'failure', reason });
      return { kind: 'failure', reason };
    }
    setNativeReady(true);
    setNeedsProof(false);
    setInvalidContinuation(false);
    if (saved) {
      setRecoveryReviewed(false);
      if (saved.phase === 'approve') {
        const advice = await refreshTransferAdvice(saved);
        if (
          started !== view.current ||
          retired.current ||
          JSON.stringify(restoreTransferAttempt()) !== JSON.stringify(saved)
        )
          return;
        if (advice) {
          showFailure(advice);
          if (advice.reason === 'unavailable') offerReadRetry(() => retryAttemptRead(saved));
        } else {
          exposeAttempt(saved);
          setNativeAdvice(saved.side);
        }
      }
    }
  }

  function offerReadRetry(action: () => Promise<TransferFailure | void>) {
    retryRead.current = action;
    setReadRecovery(true);
  }
  function readPage(action: () => Promise<TransferFailure | void>) {
    const started = view.current;
    void perform(async () => {
      setConfirmed(false);
      setRecoveryReviewed(false);
      setNativeAdvice(null);
      setCurrent(null);
      setResult((value) => (value?.kind === 'failure' && value.reason === 'unavailable' ? null : value));
      const failure = await action();
      if (started !== view.current || !failure) return;
      showFailure(failure);
      if (failure.reason === 'unavailable' && !retryRead.current) offerReadRetry(action);
    });
  }
  function storedAttemptMatches(value: TransferAttempt): boolean {
    return JSON.stringify(restoreTransferAttempt()) === JSON.stringify(value);
  }
  function replacedAttemptFeedback() {
    setFileFeedback({ error: true, text: m.auth_transfer_handoff_preserved() });
  }
  function exposeAttempt(value: TransferAttempt) {
    liveAttempt.current = value;
    setAttempt(value);
    setAcceptance(value.acceptance ?? '');
    setAttemptReviewed(true);
    setReconfirmed(true);
  }
  async function readCurrent(value: TransferAttempt) {
    const started = view.current;
    const stored = JSON.stringify(restoreTransferAttempt());
    if (stored !== JSON.stringify(value)) {
      replacedAttemptFeedback();
      return;
    }
    const relation = await readOperatorRelation(value.request.previous.subjectAccountId, value.accountId);
    if (started !== view.current || retired.current) return;
    if (stored !== JSON.stringify(restoreTransferAttempt())) {
      replacedAttemptFeedback();
      return;
    }
    const acknowledged = value.side === 'source' && value.phase === 'readback';
    if (relation.kind !== 'ready') {
      if (acknowledged && ['account-changed', 'denied', 'step-up'].includes(relation.reason)) return relation;
      if (acknowledged) {
        const result: TransferResult = { kind: 'acknowledged', reference: value.reference!, readback: relation };
        setResult(result);
        updateRecovery(transferRecoveryKind(value, result));
        if (relation.reason === 'unavailable') offerReadRetry(() => readCurrent(value));
        return;
      }
      return relation;
    }
    setCurrent(relation.relation);
    if (value.side === 'source' && value.phase === 'execute') {
      const exact = sameRelation(relation.relation, value.request);
      setRecoveryReviewed(exact);
      setNativeAdvice(exact ? 'source' : null);
      setUncertain(true);
      setResult({ kind: 'failure', reason: 'uncertain' });
      updateRecovery('source-unknown');
    }
    if (acknowledged) {
      const confirmed = confirmsTransferReadback(value, relation.relation);
      const result: TransferResult = {
        kind: 'acknowledged',
        reference: value.reference!,
        readback: confirmed
          ? { kind: 'current', relation: relation.relation }
          : { kind: 'failure', reason: 'conflict' },
      };
      setResult(result);
      updateRecovery(transferRecoveryKind(value, result));
    }
  }
  async function reviewRecovery(value: TransferAttempt): Promise<TransferFailure | void> {
    const started = view.current;
    const stored = JSON.stringify(restoreTransferAttempt());
    if (stored !== JSON.stringify(value)) {
      replacedAttemptFeedback();
      return;
    }
    const outcome = await readTransferRecovery(value);
    if (started !== view.current || retired.current) return;
    if (stored !== JSON.stringify(restoreTransferAttempt())) {
      replacedAttemptFeedback();
      return;
    }
    if (outcome.kind === 'failure') {
      if (value.side === 'source' && value.phase === 'readback' && outcome.reason === 'conflict')
        updateRecovery('source-acknowledged-conflict');
      return outcome;
    }
    if (outcome.kind === 'relation') {
      setCurrent(outcome.relation);
      if (!state.current.attempt && !liveAttempt.current) exposeAttempt(value);
      if (value.side === 'source' && value.phase === 'execute') {
        const exact = sameRelation(outcome.relation, value.request);
        setRecoveryReviewed(exact);
        setNativeAdvice(exact ? 'source' : null);
        setUncertain(true);
        setResult({ kind: 'failure', reason: 'uncertain' });
        updateRecovery('source-unknown');
      } else if (value.side === 'source' && value.phase === 'readback') {
        const confirmed = confirmsTransferReadback(value, outcome.relation);
        const result: TransferResult = {
          kind: 'acknowledged',
          reference: value.reference!,
          readback: confirmed
            ? { kind: 'current', relation: outcome.relation }
            : { kind: 'failure', reason: 'conflict' },
        };
        setResult(result);
        updateRecovery(transferRecoveryKind(value, result));
      }
      return;
    }
    if (value.side === 'destination' && value.phase === 'accepted') {
      setResult({ kind: 'accepted', reference: value.reference! });
      updateRecovery('destination-accepted');
    } else setNativeAdvice(value.side);
    if (!state.current.attempt && !liveAttempt.current) exposeAttempt(value);
  }
  async function reviewStoredRecovery(): Promise<TransferFailure | void> {
    const owner = state.current.session;
    if (owner?.kind !== 'ready' || !nativeReady || retired.current) return;
    const saved = restoreTransferAttempt();
    if (saved === 'invalid' || saved === null) {
      updateRecovery('unreadable');
      return { kind: 'failure', reason: 'invalid' };
    }
    if (saved.accountId !== owner.accountId) {
      updateRecovery(transferRecoveryKind(saved));
      return { kind: 'failure', reason: 'account-changed' };
    }
    const expected = recoveryKind.current;
    const actual = transferRecoveryKind(saved);
    const compatible =
      expected === actual ||
      (['source-acknowledged', 'source-acknowledged-conflict'].includes(expected) &&
        ['source-acknowledged', 'source-acknowledged-conflict'].includes(actual));
    if (!compatible) {
      updateRecovery('unreadable');
      return { kind: 'failure', reason: 'invalid' };
    }
    return reviewRecovery(saved);
  }

  async function perform(action: () => Promise<void>, allowRetired = false) {
    if (busy.current || (retired.current && !allowRetired)) return;
    busy.current = true;
    retryRead.current = null;
    const started = view.current;
    fileRead.current++;
    setPending(true);
    try {
      await action();
    } finally {
      if (started === view.current) {
        busy.current = false;
        setPending(false);
        if (!retryRead.current) setReadRecovery(false);
      }
    }
  }
  function showFailure(value: TransferFailure) {
    const currentAttempt = state.current.attempt ?? liveAttempt.current;
    const retained = transferRecoveryKind(currentAttempt, state.current.result);
    if (retained !== 'none') updateRecovery(retained);
    setNativeAdvice(null);
    if (value.reason === 'uncertain') setUncertain(true);
    if (['account-changed', 'step-up', 'denied'].includes(value.reason)) clearImported();
    if (value.reason === 'step-up') {
      setNeedsProof(true);
      setConfirmed(false);
    }
    if (value.reason === 'account-changed' || value.reason === 'denied' || value.reason === 'step-up') {
      retire();
      setNativeReady(false);
      if (value.reason !== 'step-up') setInvalidContinuation(true);
    }
    setResult(value);
  }
  function install(value: TransferAttempt) {
    if (JSON.stringify(restoreTransferAttempt()) !== JSON.stringify(liveAttempt.current)) {
      setFileFeedback({ error: true, text: m.auth_transfer_handoff_preserved() });
      return;
    }
    if (!storeTransferAttempt(value)) {
      showFailure({ kind: 'failure', reason: 'unavailable' });
      return;
    }
    const locallyUnsent = !liveAttempt.current || unsent.current === liveAttempt.current;
    liveAttempt.current = value;
    unsent.current = locallyUnsent && value.phase === 'approve' && !value.reference ? value : null;
    clearImported();
    setAttempt(value);
    setAttemptReviewed(true);
    setResult(null);
    setCurrent(null);
    updateRecovery(transferRecoveryKind(value));
    setRecoveryReviewed(false);
    setNativeAdvice(null);
    setConfirmed(false);
  }
  function prepare(event: FormEvent) {
    event.preventDefault();
    if (
      session?.kind !== 'ready' ||
      !nativeReady ||
      needsProof ||
      invalidContinuation ||
      retired.current ||
      retainsTransferWork(recoveryKind.current) ||
      attempt ||
      restoreTransferAttempt() !== null
    )
      return;
    const started = view.current;
    readPage(async () => {
      const value = await prepareTransfer(subject.trim(), destination.trim(), session.accountId);
      if (started !== view.current) return;
      if ('kind' in value) return value;
      else {
        install({ accountId: session.accountId, request: value, side: 'source', phase: 'approve' });
        setNativeAdvice('source');
      }
    });
  }
  function review(event: FormEvent) {
    event.preventDefault();
    if (
      session?.kind !== 'ready' ||
      !nativeReady ||
      needsProof ||
      invalidContinuation ||
      retired.current ||
      retainsTransferWork(recoveryKind.current) ||
      attempt ||
      restoreTransferAttempt() !== null
    )
      return;
    const request = parseTransferRequest(requestText);
    if (!request) {
      showFailure({ kind: 'failure', reason: 'invalid' });
      return;
    }
    reviewRequest(request);
  }
  function reviewRequest(request: TransferAttempt['request']) {
    if (
      session?.kind !== 'ready' ||
      !nativeReady ||
      needsProof ||
      invalidContinuation ||
      retired.current ||
      uncertain ||
      retainsTransferWork(recoveryKind.current)
    )
      return;
    const started = view.current;
    readPage(async () => {
      const failure = await reviewDestinationTransfer(request, session.accountId);
      if (started !== view.current) return;
      if (failure) return failure;
      install({ accountId: session.accountId, request, side: 'destination', phase: 'approve' });
      setNativeAdvice('destination');
    });
  }
  function reviewAttempt() {
    if (!attempt || session?.kind !== 'ready' || !nativeReady || needsProof || invalidContinuation || retired.current)
      return;
    const selected = attempt;
    readPage(async () => {
      const failure = await refreshTransferAdvice(selected);
      if (!failure) setNativeAdvice(selected.side);
      return failure ?? undefined;
    });
  }
  async function retryAttemptRead(value: TransferAttempt): Promise<TransferFailure | void> {
    if (value.phase === 'execute' || value.phase === 'readback') return readCurrent(value);
    if (value.phase === 'accepted') return reviewRecovery(value);
    const started = view.current;
    const failure = await refreshTransferAdvice(value);
    if (started !== view.current || retired.current) return;
    if (!failure && storedAttemptMatches(value)) {
      setNativeAdvice(value.side);
      if (!liveAttempt.current) exposeAttempt(value);
    } else if (!failure) replacedAttemptFeedback();
    return failure ?? undefined;
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !attempt ||
      !confirmed ||
      !nativeReady ||
      needsProof ||
      invalidContinuation ||
      retired.current ||
      attempt.phase === 'readback' ||
      (attempt.phase === 'approve' && nativeAdvice !== attempt.side) ||
      (attempt.phase === 'execute' && (!recoveryReviewed || nativeAdvice !== 'source'))
    )
      return;
    const started = view.current;
    void perform(async () => {
      const value = { ...attempt, ...(attempt.side === 'source' ? { acceptance } : {}) };
      unsent.current = null;
      const outcome = await submitTransferAttempt(
        value,
        (next) => {
          if (started !== view.current) return false;
          liveAttempt.current = { ...next };
          setAttempt(liveAttempt.current);
          return storeTransferAttempt(next);
        },
        () => started === view.current && !retired.current,
      );
      if (started !== view.current) return;
      setConfirmed(false);
      if (outcome.kind === 'failure') {
        showFailure(outcome);
        // Read recovery never repeats approve/execute, even after an uncertain write.
        if (outcome.reason === 'unavailable') offerReadRetry(() => retryAttemptRead(liveAttempt.current ?? value));
      } else {
        setUncertain(false);
        setResult(outcome);
        setNativeAdvice(null);
        if (outcome.kind === 'current') setCurrent(outcome.relation);
        if (outcome.kind === 'acknowledged') {
          if (outcome.readback.kind === 'current') setCurrent(outcome.readback.relation);
          else offerReadRetry(() => readCurrent(liveAttempt.current ?? value));
        }
        updateRecovery(transferRecoveryKind(liveAttempt.current ?? value, outcome));
      }
    });
  }
  function authenticate(event: FormEvent) {
    event.preventDefault();
    if (session?.kind !== 'ready') return;
    const started = view.current;
    void perform(async () => {
      const outcome = await reauthenticateTransfer(session.accountId, email, password, () => started === view.current);
      if (started !== view.current) return;
      setPassword('');
      if (outcome) showFailure(outcome);
      else {
        const readiness = await readOperatorTransferPage({ kind: 'readiness' }, session.accountId);
        if (started !== view.current) return;
        if (isTransferFailure(readiness)) {
          showFailure(readiness);
          return;
        }
        const authentication = pageFailure(readiness);
        if (authentication || readiness.viewer.kind !== 'ready') {
          showFailure(authentication ?? { kind: 'failure', reason: 'denied' });
          return;
        }
        const saved = restoreTransferAttempt();
        if (saved === 'invalid') {
          updateRecovery('unreadable');
          setInvalidContinuation(true);
          setNeedsProof(false);
          return;
        }
        if (saved && saved.accountId !== session.accountId) {
          updateRecovery(transferRecoveryKind(saved));
          showFailure({ kind: 'failure', reason: 'account-changed' });
          return;
        }
        retired.current = false;
        setNativeReady(true);
        setNeedsProof(false);
        setInvalidContinuation(false);
        setReconfirmed(true);
        setConfirmed(false);
        setCurrent(null);
        setNativeAdvice(null);
        setResult(null);
        setUncertain(false);
        setAttemptReviewed(false);
        setRecoveryReviewed(false);
        if (saved) {
          if (!retainsTransferWork(recoveryKind.current)) updateRecovery(transferRecoveryKind(saved));
          setAttempt(null);
          setNativeAdvice(null);
          setRecoveryReviewed(false);
        } else if (!retainsTransferWork(recoveryKind.current)) {
          setResult(null);
        }
      }
    }, true);
  }

  const locked = pending || needsProof || invalidContinuation || !nativeReady || retired.current;
  const canDisclose =
    session?.kind === 'ready' && nativeReady && !needsProof && !invalidContinuation && !retired.current;
  const canDiscloseAttempt = canDisclose && attemptReviewed;
  const recoveryVisible =
    recovery !== 'none' && (!canDisclose || recovery !== 'saved-step' || !attemptReviewed || !attempt);
  const recoveryReadUnavailable =
    readRecovery ||
    (result?.kind === 'failure' && result.reason === 'unavailable') ||
    (result?.kind === 'acknowledged' && result.readback.kind === 'failure' && result.readback.reason === 'unavailable');
  const recoveryCanReview =
    recoveryVisible &&
    !retired.current &&
    !needsProof &&
    !invalidContinuation &&
    ((canDisclose && recovery !== 'unreadable') || Boolean(readRecovery && retryRead.current));
  function reviewCurrentRecovery() {
    if (canDisclose && attempt) readPage(() => reviewRecovery(attempt));
    else if (canDisclose) readPage(() => reviewStoredRecovery());
    else if (retryRead.current) readPage(retryRead.current);
  }
  const acceptanceEditable =
    attempt?.side === 'source' &&
    attempt.phase === 'approve' &&
    !attempt.acceptance &&
    !attempt.reference &&
    !uncertain;
  async function importFile(files: File[], kind: HandoffKind) {
    if (locked || busy.current || session?.kind !== 'ready') return;
    if ((kind === 'request' && attempt) || (kind === 'acceptance' && !acceptanceEditable)) {
      setFileFeedback({ error: true, text: m.auth_transfer_handoff_preserved() });
      return;
    }
    const started = view.current;
    const reading = ++fileRead.current;
    const saved = JSON.stringify(restoreTransferAttempt());
    if (saved !== JSON.stringify(liveAttempt.current)) {
      setFileFeedback({ error: true, text: m.auth_transfer_handoff_preserved() });
      return;
    }
    const imported = await readTransferHandoff(files, kind);
    if (started !== view.current || reading !== fileRead.current) return;
    if (saved !== JSON.stringify(restoreTransferAttempt()) || (kind === 'request' && saved !== 'null')) {
      setFileFeedback({ error: true, text: m.auth_transfer_handoff_preserved() });
      return;
    }
    if (imported.kind === 'failure') {
      setFileFeedback({ error: true, text: fileError(imported.reason) });
      return;
    }
    setConfirmed(false);
    setNativeAdvice(null);
    if (imported.kind === 'request') setRequestText(imported.text);
    else setAcceptance(imported.text);
    setFileFeedback({
      error: false,
      text: kind === 'request' ? m.auth_transfer_handoff_request_loaded() : m.auth_transfer_handoff_acceptance_loaded(),
    });
  }
  function download(kind: HandoffKind) {
    if (locked || !attempt) return;
    const text = kind === 'request' ? JSON.stringify(attempt.request) : attempt.reference;
    if (!text || (kind === 'acceptance' && attempt.phase !== 'accepted')) return;
    const ok = downloadTransferHandoff(kind, text);
    setFileFeedback({
      error: !ok,
      text: ok ? m.auth_transfer_handoff_downloaded() : m.auth_transfer_handoff_download_failed(),
    });
  }
  function fileField(kind: HandoffKind) {
    const id = `transfer-${kind}-file`;
    return (
      <Field>
        <FieldLabel htmlFor={id}>
          {kind === 'request' ? m.auth_transfer_handoff_select_request() : m.auth_transfer_handoff_select_acceptance()}
        </FieldLabel>
        <p id="transfer-file-help">
          {m.auth_transfer_guide_file_formats()} {m.auth_transfer_handoff_file_help()}
        </p>
        <Input
          id={id}
          type="file"
          className="h-auto min-h-11 w-full file:min-h-11"
          disabled={locked || (kind === 'acceptance' && !acceptanceEditable)}
          aria-describedby="transfer-file-help transfer-file-feedback"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            void importFile(files, kind);
          }}
        />
      </Field>
    );
  }

  return (
    <AuthPage returnToSecurity heading={m.auth_transfer_heading()}>
      {router ? <TransferDeparture work={protectedWork} validate={validateCaller} retire={retire} /> : null}
      <div className="auth-login-form min-w-0 text-start wrap-anywhere">
        <p>{m.auth_transfer_guide_orientation()}</p>
        {!session ? <p role="status">{m.auth_inventory_loading()}</p> : null}
        {session?.kind === 'signed-out' ? (
          <p role="status">
            {m.auth_transfer_signed_out()} <a href="/login">{m.auth_security_sign_in()}</a>
          </p>
        ) : null}
        {session?.kind === 'failure' ? <ErrorAlert>{m.auth_transfer_unavailable()}</ErrorAlert> : null}
        {canDisclose ? <p>{m.auth_transfer_acting_as({ account: session.accountId })}</p> : null}
        <div id="transfer-notice" ref={notice} tabIndex={-1} aria-live="polite">
          <div id="transfer-file-feedback" role={fileFeedback?.error ? 'alert' : 'status'}>
            {fileFeedback ? <p>{fileFeedback.text}</p> : null}
          </div>
          {reconfirmed ? <p>{m.auth_transfer_reconfirm()}</p> : null}
          {readRecovery && !recoveryVisible ? (
            <Button
              disabled={pending}
              aria-busy={pending}
              onClick={() => {
                readPage(retryRead.current ?? (() => loadPageSession()));
              }}
            >
              {recovery === 'none' ? m.auth_account_delete_retry() : m.auth_transfer_recovery_retry()}
            </Button>
          ) : null}
          {pending && !recoveryVisible ? <p role="status">{m.auth_transfer_pending()}</p> : null}
          {recoveryVisible ? (
            <OperatorTransferRecoveryView
              kind={recovery}
              pending={pending}
              authorityRetired={retired.current}
              readUnavailable={recoveryReadUnavailable}
              observed={canDisclose && current !== null}
              canReview={recoveryCanReview}
              onReview={reviewCurrentRecovery}
            />
          ) : null}
          {result?.kind === 'failure' ? (
            <ErrorAlert>
              {errorMessage(result)}
              {result.status ? (
                <details>
                  <summary className="min-h-11 cursor-pointer py-3">{m.auth_transfer_handoff_diagnostics()}</summary>
                  {result.status}
                  {result.code && /^[a-z][a-z0-9_]{0,79}$/.test(result.code) ? ` · ${result.code}` : ''}
                </details>
              ) : null}
            </ErrorAlert>
          ) : null}
          {canDiscloseAttempt &&
          attempt?.side === 'destination' &&
          attempt.phase === 'accepted' &&
          attempt.reference ? (
            <>
              <p>{m.auth_transfer_accepted()}</p>
              <Button disabled={locked} onClick={() => download('acceptance')}>
                {m.auth_transfer_handoff_download_acceptance()}
              </Button>
              <details>
                <summary className="min-h-11 cursor-pointer py-3">{m.auth_transfer_handoff_technical()}</summary>
                <Field>
                  <FieldLabel htmlFor="transfer-accepted">{m.auth_transfer_acceptance()}</FieldLabel>
                  <Textarea id="transfer-accepted" value={attempt.reference} readOnly />
                </Field>
              </details>
            </>
          ) : null}
          {canDisclose && result?.kind === 'current' ? <p>{m.auth_transfer_observed()}</p> : null}
          {canDiscloseAttempt && result?.kind === 'acknowledged' ? (
            <div role="status">
              <h2>{m.auth_transfer_acknowledged()}</h2>
              <details>
                <summary className="min-h-11 cursor-pointer py-3">{m.auth_transfer_handoff_technical()}</summary>
                <Field>
                  <FieldLabel htmlFor="transfer-acknowledgment">{m.auth_transfer_acceptance()}</FieldLabel>
                  <Textarea id="transfer-acknowledgment" value={result.reference} readOnly />
                </Field>
              </details>
              {result.readback.kind === 'current' ? <p>{m.auth_transfer_observed()}</p> : null}
            </div>
          ) : null}
        </div>
        {needsProof && !invalidContinuation ? (
          <form className="auth-login-form" onSubmit={authenticate} method="post" action="/signin">
            <p>{m.auth_transfer_step_up()}</p>
            <Field>
              <FieldLabel htmlFor="transfer-email">{m.auth_login_email()}</FieldLabel>
              <Input
                id="transfer-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                readOnly={pending}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="transfer-password">{m.auth_login_password()}</FieldLabel>
              <PasswordInput
                id="transfer-password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                readOnly={pending}
              />
            </Field>
            <Button type="submit" disabled={pending} aria-busy={pending}>
              {m.auth_step_up_heading()}
            </Button>
          </form>
        ) : null}
        {canDisclose && !attempt && !retainsTransferWork(recoveryKind.current) ? (
          <>
            <form
              className="auth-login-form"
              method="post"
              action="/account-management/operators/relation"
              onSubmit={prepare}
            >
              <h2>{m.auth_transfer_handoff_prepare_heading()}</h2>
              <Field>
                <FieldLabel htmlFor="transfer-subject">{m.auth_transfer_handoff_subject()}</FieldLabel>
                <Input
                  id="transfer-subject"
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                  required
                  readOnly={pending}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="transfer-destination">{m.auth_transfer_handoff_destination()}</FieldLabel>
                <Input
                  id="transfer-destination"
                  value={destination}
                  onChange={(event) => setDestination(event.target.value)}
                  required
                  readOnly={pending}
                />
              </Field>
              <Button type="submit" disabled={pending} aria-busy={pending}>
                {m.auth_transfer_prepare()}
              </Button>
            </form>
            <form
              className="auth-login-form"
              method="post"
              action="/account-management/operators/relation"
              onSubmit={review}
            >
              <h2>{m.auth_transfer_handoff_review_heading()}</h2>
              {fileField('request')}
              <details>
                <summary className="min-h-11 cursor-pointer py-3">{m.auth_transfer_handoff_manual_request()}</summary>
                <Field>
                  <FieldLabel htmlFor="transfer-request-input">{m.auth_transfer_request()}</FieldLabel>
                  <Textarea
                    id="transfer-request-input"
                    value={requestText}
                    onChange={(event) => {
                      fileRead.current++;
                      setFileFeedback(null);
                      setRequestText(event.target.value);
                      setConfirmed(false);
                    }}
                    maxLength={4096}
                    readOnly={pending}
                  />
                </Field>
              </details>
              <Button type="submit" disabled={pending || !requestText} aria-busy={pending}>
                {m.auth_transfer_review()}
              </Button>
            </form>
          </>
        ) : null}
        {canDiscloseAttempt && attempt ? (
          <>
            <h2>
              {attempt.side === 'source'
                ? m.auth_transfer_handoff_send_heading()
                : m.auth_transfer_handoff_accept_heading()}
            </h2>
            <dl>
              <dt>{m.auth_transfer_handoff_subject()}</dt>
              <dd>{attempt.request.previous.subjectAccountId}</dd>
              <dt>{m.auth_transfer_source()}</dt>
              <dd>{attempt.request.previous.operatorAccountId}</dd>
              <dt>{m.auth_transfer_handoff_destination()}</dt>
              <dd>{attempt.request.operatorAccountId}</dd>
            </dl>
            <p>{m.auth_transfer_handoff_consequences()}</p>
            {attempt.side === 'destination' ? <p>{m.auth_transfer_imported_request_provenance()}</p> : null}
            {attempt.side === 'source' ? (
              <p>{m.auth_transfer_native_advice_source()}</p>
            ) : (
              <p>{m.auth_transfer_native_advice_destination()}</p>
            )}
            {attempt.side === 'source' ? (
              <>
                <p>
                  {uncertain || attempt.phase !== 'approve'
                    ? m.auth_transfer_handoff_preserved()
                    : m.auth_transfer_handoff_send_request()}
                </p>
                <Button disabled={locked} onClick={() => download('request')}>
                  {m.auth_transfer_handoff_download_request()}
                </Button>
              </>
            ) : null}
            <details>
              <summary className="min-h-11 cursor-pointer py-3">{m.auth_transfer_handoff_technical()}</summary>
              <dl>
                <dt>{m.auth_transfer_version()}</dt>
                <dd>{attempt.request.expectedVersion}</dd>
                <dt>{m.auth_transfer_handoff_reservation()}</dt>
                <dd>{attempt.request.previous.reservationId}</dd>
                <dt>{m.auth_transfer_handoff_key()}</dt>
                <dd>{attempt.request.sourceOperationKey}</dd>
              </dl>
              <Field>
                <FieldLabel htmlFor="transfer-request">{m.auth_transfer_request()}</FieldLabel>
                <Textarea id="transfer-request" value={JSON.stringify(attempt.request)} readOnly />
              </Field>
            </details>
            {attempt.phase === 'approve' && nativeAdvice !== attempt.side ? (
              <Button variant="outline" disabled={locked || Boolean(attempt.reference)} onClick={reviewAttempt}>
                {attempt.side === 'source' ? m.auth_transfer_review_same_person() : m.auth_transfer_native_review()}
              </Button>
            ) : null}
            {attempt.side === 'destination' ? (
              <Button
                variant="outline"
                disabled={locked || uncertain}
                onClick={() => {
                  const reference = attempt.phase === 'accepted' ? attempt.reference : undefined;
                  install({
                    accountId: attempt.accountId,
                    request: attempt.request,
                    side: 'source',
                    ...(reference ? { acceptance: reference } : {}),
                    phase: 'approve',
                  });
                }}
              >
                {m.auth_transfer_continue_source()}
              </Button>
            ) : null}
            {attempt.phase !== 'accepted' &&
            attempt.phase !== 'readback' &&
            (attempt.phase !== 'execute' || recoveryReviewed) &&
            result?.kind !== 'current' &&
            result?.kind !== 'acknowledged' ? (
              <form className="auth-login-form" method="post" action="/account-operations/approve" onSubmit={submit}>
                {attempt.side === 'source' ? (
                  <>
                    <p>
                      {acceptanceEditable
                        ? m.auth_transfer_handoff_import_response()
                        : m.auth_transfer_handoff_preserved()}
                    </p>
                    {fileField('acceptance')}
                    <details>
                      <summary className="min-h-11 cursor-pointer py-3">
                        {m.auth_transfer_handoff_manual_acceptance()}
                      </summary>
                      <Field>
                        <FieldLabel htmlFor="transfer-acceptance">{m.auth_transfer_acceptance()}</FieldLabel>
                        <Textarea
                          id="transfer-acceptance"
                          value={acceptance}
                          onChange={(event) => {
                            fileRead.current++;
                            setFileFeedback(null);
                            setAcceptance(event.target.value);
                            setConfirmed(false);
                            setNativeAdvice(null);
                          }}
                          maxLength={4096}
                          readOnly={locked || !acceptanceEditable}
                        />
                      </Field>
                    </details>
                  </>
                ) : null}
                <Field>
                  <FieldLabel htmlFor="transfer-confirm">
                    <input
                      id="transfer-confirm"
                      type="checkbox"
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                      disabled={
                        pending ||
                        !nativeReady ||
                        needsProof ||
                        invalidContinuation ||
                        (attempt.phase === 'approve' && nativeAdvice !== attempt.side) ||
                        (attempt.phase === 'execute' && (!recoveryReviewed || nativeAdvice !== 'source'))
                      }
                      required
                    />
                    {attempt.side === 'source'
                      ? m.auth_transfer_confirm_source()
                      : m.auth_transfer_confirm_destination()}
                  </FieldLabel>
                </Field>
                <Button
                  type="submit"
                  disabled={
                    pending ||
                    !nativeReady ||
                    !confirmed ||
                    needsProof ||
                    invalidContinuation ||
                    retired.current ||
                    (attempt.phase === 'approve' && nativeAdvice !== attempt.side) ||
                    (attempt.phase === 'execute' && (!recoveryReviewed || nativeAdvice !== 'source')) ||
                    (attempt.side === 'source' && !acceptance)
                  }
                  aria-busy={pending}
                >
                  {attempt.phase === 'execute'
                    ? m.auth_transfer_recovery_retry_exact()
                    : attempt.side === 'destination'
                      ? m.auth_transfer_accept()
                      : m.auth_transfer_submit()}
                </Button>
              </form>
            ) : null}
            {attempt.phase !== 'execute' && attempt.phase !== 'readback' ? (
              <Button variant="outline" disabled={locked} onClick={() => readPage(() => readCurrent(attempt))}>
                {m.auth_transfer_readback()}
              </Button>
            ) : null}
          </>
        ) : null}
        {canDisclose && current ? (
          <div role="status">
            <h2>{m.auth_transfer_current()}</h2>
            <dl>
              <dt>{m.auth_transfer_source()}</dt>
              <dd>{current.previous.operatorAccountId}</dd>
            </dl>
            <details>
              <summary className="min-h-11 cursor-pointer py-3">{m.auth_transfer_handoff_technical()}</summary>
              <dl>
                <dt>{m.auth_transfer_version()}</dt>
                <dd>{current.expectedVersion}</dd>
                <dt>{m.auth_transfer_handoff_reservation()}</dt>
                <dd>{current.previous.reservationId}</dd>
              </dl>
            </details>
          </div>
        ) : null}
        <details>
          <summary className="min-h-11 cursor-pointer py-3">{m.auth_transfer_guide_heading()}</summary>
          <div className="space-y-3">
            <p>{m.auth_transfer_handoff_explanation()}</p>
            <ol className="list-decimal space-y-3 ps-6">
              <li>{m.auth_transfer_handoff_step_request()}</li>
              <li>{m.auth_transfer_handoff_step_accept()}</li>
              <li>{m.auth_transfer_handoff_step_submit()}</li>
              <li>{m.auth_transfer_handoff_step_readback()}</li>
            </ol>
          </div>
        </details>
      </div>
    </AuthPage>
  );
}
