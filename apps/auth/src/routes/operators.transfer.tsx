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
  managementSession,
  parseTransferRequest,
  prepareTransfer,
  readOperatorRelation,
  reauthenticateTransfer,
  sameRelation,
  restoreTransferAttempt,
  storeTransferAttempt,
  submitTransferAttempt,
  type OperatorRelation,
  type TransferAttempt,
  type TransferFailure,
  type TransferResult,
} from '../operator-transfer';

export const Route = createFileRoute('/operators/transfer')({
  head: () => ({ meta: [{ title: `${m.auth_transfer_heading()} · REZICS` }] }),
  component: OperatorTransferPage,
});

// The transfer page alone owns this guard; standalone fixtures need no router.
function TransferDeparture({ work, validate, retire }: {
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
      previous?.focus();
    };
  }, [blocker.status, work]);
  return blocker.status === 'blocked' ? (
    <dialog ref={dialog} aria-labelledby="transfer-departure-title" onCancel={(event) => {
      event.preventDefault();
      blocker.reset();
    }}>
      <h2 id="transfer-departure-title">{m.auth_transfer_departure_heading()}</h2>
      <p>{m.auth_transfer_departure_description()}</p>
      <p>{m.auth_account_operation_leave_notice()}</p>
      <div className="flex gap-3">
        <Button ref={stay} type="button" onClick={() => blocker.reset()}>{m.auth_organization_departure_stay()}</Button>
        <Button type="button" onClick={() => { retire(); blocker.proceed(); }}>{m.auth_organization_departure_leave()}</Button>
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
  const [reconfirmed, setReconfirmed] = useState(false);
  const [invalidContinuation, setInvalidContinuation] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fileFeedback, setFileFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [readRecovery, setReadRecovery] = useState(false);
  const retryRead = useRef<(() => Promise<TransferFailure | void>) | null>(null);
  const view = useRef(0);
  const fileRead = useRef(0);
  const liveAttempt = useRef<TransferAttempt | null>(null);
  const busy = useRef(false);
  const notice = useRef<HTMLDivElement>(null);

  const retired = useRef(false);
  // Only a review created here is known to be unsent. Restored commands may be unresolved.
  const unsent = useRef<TransferAttempt | null>(null);
  const state = useRef({ session, result, attempt, subject, destination, requestText, acceptance, invalidContinuation });
  state.current = { session, result, attempt, subject, destination, requestText, acceptance, invalidContinuation };
  const protectedWork = () => {
    const value = state.current;
    return !retired.current && !value.invalidContinuation && value.session?.kind === 'ready' &&
      value.result?.kind !== 'current' && Boolean(value.attempt || value.subject.trim() ||
        value.destination.trim() || value.requestText.trim() || value.acceptance.trim());
  };
  function retire() {
    if (retired.current) return;
    retired.current = true;
    view.current++;
    fileRead.current++;
    // Never remove a command that may have reached native, or another view's saved work.
    if (unsent.current && JSON.stringify(restoreTransferAttempt()) === JSON.stringify(unsent.current)) {
      try { window.sessionStorage.removeItem('rezics.operator-transfer.attempt'); } catch { /* Recovery remains saved. */ }
    }
    unsent.current = null;
    liveAttempt.current = null;
    busy.current = false;
    retryRead.current = null;
    setAttempt(null);
    setConfirmed(false);
    setPending(false);
    setSubject('');
    setDestination('');
    setRequestText('');
    setAcceptance('');
    setPassword('');
    setEmail('');
    setFileFeedback(null);
  }
  async function validateCaller() {
    const started = view.current;
    const owner = state.current.session;
    if (retired.current || owner?.kind !== 'ready') return;
    const caller = await loadAccountSession();
    if (started !== view.current) return;
    if (caller.kind === 'signed-out' || (caller.kind === 'ready' &&
      (caller.accountId !== owner.accountId || !caller.scopes?.includes('account:manage')))) {
      retire();
      setSession(caller);
      setInvalidContinuation(true);
      setResult({ kind: 'failure', reason: 'account-changed' });
    }
  }
  useEffect(() => {
    const restore = (event: PageTransitionEvent) => { if (event.persisted) setReload((value) => value + 1); };
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
    setReconfirmed(false);
    setInvalidContinuation(false);
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
    if (result || reconfirmed || fileFeedback || readRecovery) notice.current?.focus();
  }, [result, reconfirmed, fileFeedback, readRecovery]);

  async function loadPageSession(supplied?: AccountSessionResult) {
    const started = view.current;
    const value = supplied ?? (await loadAccountSession());
    if (started !== view.current) return;
    setSession(value);
    setNeedsProof(value.kind === 'ready' && !managementSession(value));
    // An unavailable read says nothing about the saved attempt's owner.
    if (value.kind === 'failure') {
      offerReadRetry(() => loadPageSession());
      return;
    }
    const saved = restoreTransferAttempt();
    if (saved === 'invalid' || (saved && (value.kind !== 'ready' || saved.accountId !== value.accountId))) {
      setInvalidContinuation(true);
      setResult({ kind: 'failure', reason: 'account-changed' });
    } else if (saved) {
      liveAttempt.current = saved;
      setAttempt(saved);
      setAcceptance(saved.acceptance ?? '');
      setReconfirmed(true);
      // A previous submit may have reached native even if its response was lost.
      if (saved.phase === 'execute') {
        setUncertain(true);
        setResult({ kind: 'failure', reason: 'uncertain' });
      }
      if (saved.phase === 'accepted') setResult({ kind: 'accepted', reference: saved.reference! });
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
      setResult((value) => (value?.kind === 'failure' && value.reason === 'unavailable' ? null : value));
      const failure = await action();
      if (started !== view.current || !failure) return;
      showFailure(failure);
      if (failure.reason === 'unavailable') offerReadRetry(action);
    });
  }
  async function readCurrent(value: TransferAttempt) {
    const started = view.current;
    const relation = await readOperatorRelation(value.request.previous.subjectAccountId, value.accountId);
    if (started !== view.current) return;
    if (relation.kind !== 'ready') return relation;
    setCurrent(relation.relation);
  }

  async function perform(action: () => Promise<void>) {
    if (busy.current || retired.current) return;
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
    setResult(value);
    if (value.reason === 'uncertain') setUncertain(true);
    if (['account-changed', 'step-up', 'denied'].includes(value.reason)) clearImported();
    if (value.reason === 'step-up') {
      setNeedsProof(true);
      setConfirmed(false);
    }
    if (value.reason === 'account-changed' || value.reason === 'denied') {
      retire();
      setInvalidContinuation(true);
    }
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
    setResult(null);
    setCurrent(null);
    setConfirmed(false);
  }
  function prepare(event: FormEvent) {
    event.preventDefault();
    if (session?.kind !== 'ready' || needsProof || invalidContinuation || attempt || restoreTransferAttempt() !== null)
      return;
    const started = view.current;
    readPage(async () => {
      const value = await prepareTransfer(subject.trim(), destination.trim(), session.accountId);
      if (started !== view.current) return;
      if ('kind' in value) return value;
      else install({ accountId: session.accountId, request: value, side: 'source', phase: 'approve' });
    });
  }
  function review(event: FormEvent) {
    event.preventDefault();
    if (session?.kind !== 'ready' || needsProof || invalidContinuation || attempt || restoreTransferAttempt() !== null)
      return;
    const request = parseTransferRequest(requestText);
    if (!request) {
      showFailure({ kind: 'failure', reason: 'invalid' });
      return;
    }
    reviewRequest(request);
  }
  function reviewRequest(request: TransferAttempt['request']) {
    if (session?.kind !== 'ready' || needsProof || invalidContinuation || uncertain) return;
    const started = view.current;
    readPage(async () => {
      const relation = await readOperatorRelation(request.previous.subjectAccountId, session.accountId);
      if (started !== view.current) return;
      if (relation.kind !== 'ready') return relation;
      // Native approve repeats the exact tuple/version check after review.
      if (!sameRelation(relation.relation, request)) {
        showFailure({ kind: 'failure', reason: 'conflict' });
        return;
      }
      install({ accountId: session.accountId, request, side: 'destination', phase: 'approve' });
    });
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!attempt || !confirmed || needsProof || invalidContinuation) return;
    const started = view.current;
    void perform(async () => {
      const value = { ...attempt, ...(attempt.side === 'source' ? { acceptance } : {}) };
      unsent.current = null;
      const outcome = await submitTransferAttempt(value, (next) => {
        if (started !== view.current) return false;
        liveAttempt.current = { ...next };
        setAttempt(liveAttempt.current);
        return storeTransferAttempt(next);
      }, () => started === view.current && !retired.current);
      if (started !== view.current) return;
      setConfirmed(false);
      if (outcome.kind === 'failure') {
        showFailure(outcome);
        // Read recovery never repeats approve/execute, even after an uncertain write.
        if (outcome.reason === 'unavailable') offerReadRetry(() => readCurrent(liveAttempt.current ?? value));
      } else {
        setUncertain(false);
        setResult(outcome);
        if (outcome.kind === 'current') setCurrent(outcome.relation);
      }
    });
  }
  function authenticate(event: FormEvent) {
    event.preventDefault();
    if (session?.kind !== 'ready') return;
    const started = view.current;
    void perform(async () => {
      const outcome = await reauthenticateTransfer(session.accountId, email, password, () => started === view.current && !retired.current);
      if (started !== view.current) return;
      setPassword('');
      if (outcome) showFailure(outcome);
      else {
        setNeedsProof(false);
        setReconfirmed(true);
        setConfirmed(false);
        clearImported();
        if (attempt?.phase === 'accepted') setResult({ kind: 'accepted', reference: attempt.reference! });
        else if (!uncertain) setResult(null);
      }
    });
  }

  const locked = pending || needsProof || invalidContinuation;
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
          <p>
            <a href="/login">{m.auth_security_sign_in()}</a>
          </p>
        ) : null}
        {session?.kind === 'failure' ? <ErrorAlert>{m.auth_transfer_unavailable()}</ErrorAlert> : null}
        {session?.kind === 'ready' ? <p>{m.auth_transfer_acting_as({ account: session.accountId })}</p> : null}
        <div ref={notice} tabIndex={-1} aria-live="polite">
          <div id="transfer-file-feedback" role={fileFeedback?.error ? 'alert' : 'status'}>
            {fileFeedback ? <p>{fileFeedback.text}</p> : null}
          </div>
          {reconfirmed ? <p>{m.auth_transfer_reconfirm()}</p> : null}
          {readRecovery ? (
            <Button
              disabled={pending}
              aria-busy={pending}
              onClick={() => {
                const action = retryRead.current;
                if (action) readPage(action);
              }}
            >
              {m.auth_account_delete_retry()}
            </Button>
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
          {attempt?.side === 'destination' && attempt.phase === 'accepted' && attempt.reference ? (
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
          {result?.kind === 'current' ? <p>{m.auth_transfer_observed()}</p> : null}
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
        {session?.kind === 'ready' && !needsProof && !invalidContinuation && !attempt ? (
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
        {attempt ? (
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
            {attempt.side === 'source' && attempt.phase === 'approve' && !attempt.acceptance ? (
              <Button
                variant="outline"
                disabled={locked || uncertain || Boolean(attempt.reference)}
                onClick={() => reviewRequest(attempt.request)}
              >
                {m.auth_transfer_review_same_person()}
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
            {attempt.phase !== 'accepted' && result?.kind !== 'current' ? (
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
                      disabled={pending || needsProof || invalidContinuation}
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
                    !confirmed ||
                    needsProof ||
                    invalidContinuation ||
                    (attempt.side === 'source' && !acceptance)
                  }
                  aria-busy={pending}
                >
                  {attempt.side === 'destination'
                    ? m.auth_transfer_accept()
                    : attempt.phase === 'readback'
                      ? m.auth_transfer_readback()
                      : m.auth_transfer_submit()}
                </Button>
              </form>
            ) : null}
            <Button
              variant="outline"
              disabled={pending || needsProof || invalidContinuation}
              onClick={() => readPage(() => readCurrent(attempt))}
            >
              {m.auth_transfer_readback()}
            </Button>
          </>
        ) : null}
        {current ? (
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
