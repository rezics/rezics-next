import { createFileRoute } from '@tanstack/react-router';
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

export function OperatorTransferPage({ initial }: { initial?: AccountSessionResult } = {}) {
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
  const busy = useRef(false);
  const notice = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    void (initial ? Promise.resolve(initial) : loadAccountSession()).then((value) => {
      if (!active) return;
      setSession(value);
      setNeedsProof(value.kind === 'ready' && !managementSession(value));
      const saved = restoreTransferAttempt();
      if (saved === 'invalid' || (saved && (value.kind !== 'ready' || saved.accountId !== value.accountId))) {
        setInvalidContinuation(true);
        setResult({ kind: 'failure', reason: 'account-changed' });
      } else if (saved) {
        setAttempt(saved);
        setAcceptance(saved.acceptance ?? '');
        setReconfirmed(true);
        // A previous submit may have reached native even if its response was lost.
        if (saved.phase === 'execute') setResult({ kind: 'failure', reason: 'uncertain' });
        if (saved.phase === 'accepted') setResult({ kind: 'accepted', reference: saved.reference! });
      }
    });
    return () => {
      active = false;
    };
  }, [initial]);
  useLayoutEffect(() => {
    if (result || reconfirmed) notice.current?.focus();
  }, [result, reconfirmed]);

  async function perform(action: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      await action();
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  function showFailure(value: TransferFailure) {
    setResult(value);
    if (value.reason === 'step-up') {
      setNeedsProof(true);
      setConfirmed(false);
    }
    if (value.reason === 'account-changed') setInvalidContinuation(true);
  }
  function install(value: TransferAttempt) {
    if (!storeTransferAttempt(value)) {
      showFailure({ kind: 'failure', reason: 'unavailable' });
      return;
    }
    setAttempt(value);
    setResult(null);
    setCurrent(null);
    setConfirmed(false);
  }
  function prepare(event: FormEvent) {
    event.preventDefault();
    if (session?.kind !== 'ready') return;
    void perform(async () => {
      const value = await prepareTransfer(subject.trim(), destination.trim(), session.accountId);
      if ('kind' in value) showFailure(value);
      else install({ accountId: session.accountId, request: value, side: 'source', phase: 'approve' });
    });
  }
  function review(event: FormEvent) {
    event.preventDefault();
    if (session?.kind !== 'ready') return;
    const request = parseTransferRequest(requestText);
    if (!request) {
      showFailure({ kind: 'failure', reason: 'invalid' });
      return;
    }
    void perform(async () => {
      const relation = await readOperatorRelation(request.previous.subjectAccountId, session.accountId);
      if (relation.kind !== 'ready') {
        showFailure(relation);
        return;
      }
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
    void perform(async () => {
      const value = { ...attempt, ...(attempt.side === 'source' ? { acceptance } : {}) };
      const outcome = await submitTransferAttempt(value, (next) => {
        setAttempt({ ...next });
        return storeTransferAttempt(next);
      });
      setConfirmed(false);
      if (outcome.kind === 'failure') showFailure(outcome);
      else {
        setResult(outcome);
        if (outcome.kind === 'current') setCurrent(outcome.relation);
      }
    });
  }
  function authenticate(event: FormEvent) {
    event.preventDefault();
    if (session?.kind !== 'ready') return;
    void perform(async () => {
      const outcome = await reauthenticateTransfer(session.accountId, email, password);
      setPassword('');
      if (outcome) showFailure(outcome);
      else {
        setNeedsProof(false);
        setReconfirmed(true);
        setConfirmed(false);
        setResult(null);
      }
    });
  }

  return (
    <AuthPage returnToSecurity heading={m.auth_transfer_heading()}>
      <div className="auth-login-form">
        <p>{m.auth_transfer_explanation()}</p>
        {!session ? <p role="status">{m.auth_inventory_loading()}</p> : null}
        {session?.kind === 'signed-out' ? (
          <p>
            <a href="/login">{m.auth_security_sign_in()}</a>
          </p>
        ) : null}
        {session?.kind === 'failure' ? <ErrorAlert>{m.auth_transfer_unavailable()}</ErrorAlert> : null}
        {session?.kind === 'ready' ? <p>{m.auth_transfer_acting_as({ account: session.accountId })}</p> : null}
        <div ref={notice} tabIndex={-1} aria-live="polite">
          {reconfirmed ? <p>{m.auth_transfer_reconfirm()}</p> : null}
          {result?.kind === 'failure' ? (
            <ErrorAlert>
              {errorMessage(result)}
              {result.status ? (
                <p>
                  {result.status}
                  {result.code && /^[a-z][a-z0-9_]{0,79}$/.test(result.code) ? ` · ${result.code}` : ''}
                </p>
              ) : null}
            </ErrorAlert>
          ) : null}
          {result?.kind === 'accepted' ? (
            <>
              <p>{m.auth_transfer_accepted()}</p>
              <Field>
                <FieldLabel htmlFor="transfer-accepted">{m.auth_transfer_acceptance()}</FieldLabel>
                <Textarea id="transfer-accepted" value={result.reference} readOnly />
              </Field>
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
              <h2>{m.auth_transfer_source_heading()}</h2>
              <Field>
                <FieldLabel htmlFor="transfer-subject">{m.auth_transfer_subject()}</FieldLabel>
                <Input
                  id="transfer-subject"
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                  required
                  readOnly={pending}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="transfer-destination">{m.auth_transfer_destination()}</FieldLabel>
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
              <h2>{m.auth_transfer_destination_heading()}</h2>
              <Field>
                <FieldLabel htmlFor="transfer-request-input">{m.auth_transfer_request()}</FieldLabel>
                <Textarea
                  id="transfer-request-input"
                  value={requestText}
                  onChange={(event) => setRequestText(event.target.value)}
                  required
                  maxLength={4096}
                  readOnly={pending}
                />
              </Field>
              <Button type="submit" disabled={pending} aria-busy={pending}>
                {m.auth_transfer_review()}
              </Button>
            </form>
          </>
        ) : null}
        {attempt ? (
          <>
            <h2>
              {attempt.side === 'source' ? m.auth_transfer_source_heading() : m.auth_transfer_destination_heading()}
            </h2>
            <dl>
              <dt>{m.auth_transfer_subject()}</dt>
              <dd>{attempt.request.previous.subjectAccountId}</dd>
              <dt>{m.auth_transfer_source()}</dt>
              <dd>{attempt.request.previous.operatorAccountId}</dd>
              <dt>{m.auth_transfer_destination()}</dt>
              <dd>{attempt.request.operatorAccountId}</dd>
              <dt>{m.auth_transfer_version()}</dt>
              <dd>{attempt.request.expectedVersion}</dd>
            </dl>
            <Field>
              <FieldLabel htmlFor="transfer-request">{m.auth_transfer_request()}</FieldLabel>
              <Textarea id="transfer-request" value={JSON.stringify(attempt.request)} readOnly />
            </Field>
            {attempt.side === 'source' && attempt.phase === 'approve' && !attempt.acceptance ? (
              <Button
                variant="outline"
                disabled={pending || needsProof || invalidContinuation}
                onClick={() => {
                  install({
                    accountId: attempt.accountId,
                    request: attempt.request,
                    side: 'destination',
                    phase: 'approve',
                  });
                }}
              >
                {m.auth_transfer_review_same_person()}
              </Button>
            ) : null}
            {attempt.side === 'destination' ? (
              <Button
                variant="outline"
                disabled={pending || needsProof || invalidContinuation}
                onClick={() => {
                  const reference = result?.kind === 'accepted' ? result.reference : undefined;
                  setAcceptance(reference ?? '');
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
                  <Field>
                    <FieldLabel htmlFor="transfer-acceptance">{m.auth_transfer_acceptance()}</FieldLabel>
                    <Textarea
                      id="transfer-acceptance"
                      value={acceptance}
                      onChange={(event) => {
                        setAcceptance(event.target.value);
                        setConfirmed(false);
                      }}
                      required
                      maxLength={4096}
                      readOnly={pending || Boolean(attempt.acceptance)}
                    />
                  </Field>
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
              onClick={() =>
                void perform(async () => {
                  const value = await readOperatorRelation(
                    attempt.request.previous.subjectAccountId,
                    attempt.accountId,
                  );
                  if (value.kind === 'ready') setCurrent(value.relation);
                  else showFailure(value);
                })
              }
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
              <dt>{m.auth_transfer_version()}</dt>
              <dd>{current.expectedVersion}</dd>
            </dl>
          </div>
        ) : null}
      </div>
    </AuthPage>
  );
}
