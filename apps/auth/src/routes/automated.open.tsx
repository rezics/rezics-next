import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { AuthButton as Button } from '../button';
import { AuthPage } from '../frame';
import { ErrorAlert } from '../alert';
import { m } from '../paraglide/messages.js';
import { loadManagementSession, managementSessionMatches } from '../management-operations';
import {
  managementOperationStepUpUrl,
  pendingManagementOperationStepUpState,
  storePendingManagementOperationStepUp,
} from '../management-operation-step-up';
import {
  isOpeningInput,
  loadOpeningMetadata,
  readOpenedSession,
  submitOperatorOpening,
  type OpeningInput,
  type OpeningMetadata,
  type OpeningOutcome,
} from '../operator-session-opening';

export const Route = createFileRoute('/automated/open')({
  head: () => ({ meta: [{ title: `${m.auth_opening_heading()} · REZICS` }] }),
  component: OperatorSessionOpeningPage,
});
function message(kind: string) {
  if (kind === 'step-up') return m.auth_opening_step_up();
  if (kind === 'refused') return m.auth_opening_refused();
  if (kind === 'unknown') return m.auth_opening_unknown();
  if (kind === 'signed-out') return m.auth_account_operation_sign_in_required();
  return m.auth_opening_unavailable();
}
export function OperatorSessionOpeningPage() {
  const { history } = useRouter();
  const [page, setPage] = useState<{ key: number; isCurrent: () => boolean } | null>(null);
  useLayoutEffect(() => {
    let generation = 0;
    let active = false;
    const leave = () => {
      active = false;
      generation++;
      setPage(null);
    };
    const enter = () => {
      const key = ++generation;
      active = true;
      setPage({ key, isCurrent: () => active && generation === key });
    };
    const unsubscribe = history.subscribe(({ location }) => {
      if (location.pathname === '/automated/open') enter();
      else leave();
    });
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted && window.location.pathname === '/automated/open') enter();
    };
    window.addEventListener('pagehide', leave);
    window.addEventListener('pageshow', restore);
    enter();
    return () => {
      active = false;
      generation++;
      unsubscribe();
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('pageshow', restore);
    };
  }, [history]);
  return page ? <OpeningReview key={page.key} isCurrent={page.isCurrent} /> : null;
}

function OpeningReview({ isCurrent }: { isCurrent: () => boolean }) {
  const [accountId, setAccountId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [operatorId, setOperatorId] = useState('');
  const [attempt, setAttempt] = useState<OpeningInput | null>(null);
  const [metadata, setMetadata] = useState<OpeningMetadata | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [terminal, setTerminal] = useState(false);
  const [outcome, setOutcome] = useState<OpeningOutcome | null>(null);
  const lock = useRef(false);
  const feedback = useRef<HTMLDivElement>(null);
  const confirmation = useRef<HTMLHeadingElement>(null);

  async function reconcile(saved: OpeningInput) {
    const result = await readOpenedSession(saved);
    if (!isCurrent()) return;
    setOutcome(result);
    setStatus(result.kind === 'opened' ? '' : 'unknown');
  }

  // Recovery repeats only reads. A local review keeps its original tuple/key;
  // a submitted continuation always goes through native session readback.
  async function restore(local: OpeningInput | null = null) {
    if (!isCurrent() || lock.current) return;
    lock.current = true;
    setBusy(true);
    setStatus('');
    setMetadata(null);
    setConfirmed(false);
    try {
      const state = pendingManagementOperationStepUpState();
      if (
        state.kind === 'invalid' ||
        (state.kind === 'pending' &&
          !isOpeningInput({
            accountId: state.value.accountId,
            operationKey: state.value.operationKey,
            operation: state.value.operation,
          }))
      ) {
        setStatus('refused');
        return;
      }
      const saved =
        state.kind === 'pending'
          ? ({
              accountId: state.value.accountId,
              operationKey: state.value.operationKey,
              operation: state.value.operation,
            } as OpeningInput)
          : local;
      if (saved) {
        setAttempt(saved);
        if (state.kind === 'pending' && state.value.phase === 'submitted') {
          setTerminal(true);
          await reconcile(saved);
          return;
        }
        const human = await loadManagementSession();
        if (!isCurrent()) return;
        if (human.kind === 'unavailable') {
          setStatus('unavailable');
          return;
        }
        if (human.kind !== 'ready' || human.accountId !== saved.accountId) {
          setStatus('refused');
          return;
        }
        setAccountId(human.accountId);
        if ((state.kind === 'pending' && state.value.phase !== 'returned') || !managementSessionMatches(human, saved)) {
          setStatus('step-up');
          return;
        }
        const read = await loadOpeningMetadata(saved);
        if (!isCurrent()) return;
        if (read.kind === 'ready') setMetadata(read.metadata);
        else setStatus('unavailable');
        return;
      }
      const human = await loadManagementSession();
      if (!isCurrent()) return;
      if (human.kind === 'ready') setAccountId(human.accountId);
      else setStatus(human.kind);
    } finally {
      if (isCurrent()) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    void restore();
  }, []);
  useEffect(() => {
    if (status) feedback.current?.focus();
  }, [status]);
  useEffect(() => {
    if (metadata) confirmation.current?.focus();
  }, [metadata]);

  async function review(event: FormEvent) {
    event.preventDefault();
    if (!isCurrent() || lock.current || attempt || !accountId) return;
    const next: OpeningInput = {
      accountId,
      operationKey: crypto.randomUUID(),
      operation: {
        kind: 'opening',
        operatorAccountId: operatorId,
        subjectAccountId: subjectId,
      },
    };
    if (!isOpeningInput(next)) {
      setStatus('refused');
      return;
    }
    setAttempt(next);
    await restore(next);
  }
  function stepUp(restart = false) {
    if (!isCurrent() || !attempt || lock.current) return;
    // Recovery is a deliberate new opening and always requires a native fresh
    // human login. No consumed approval, cached human proof or metadata survives.
    const next = restart ? { ...attempt, operationKey: crypto.randomUUID() } : attempt;
    if (!storePendingManagementOperationStepUp(next)) {
      setStatus('unavailable');
      return;
    }
    window.location.assign(managementOperationStepUpUrl('opening'));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!isCurrent() || lock.current || !attempt || !metadata || !confirmed || terminal) return;
    lock.current = true;
    setBusy(true);
    setConfirmed(false);
    setStatus('');
    try {
      const result = await submitOperatorOpening(attempt, isCurrent);
      if (!isCurrent()) return;
      const state = pendingManagementOperationStepUpState();
      setTerminal(state.kind === 'pending' && state.value.phase === 'submitted');
      setOutcome(result);
      setStatus(result.kind === 'opened' ? '' : result.kind);
    } finally {
      if (isCurrent()) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <AuthPage heading={m.auth_opening_heading()}>
      <div className="space-y-5" aria-busy={busy}>
        <p>{m.auth_opening_intro()}</p>
        {status ? (
          <ErrorAlert ref={feedback} tabIndex={-1}>
            {message(status)}
          </ErrorAlert>
        ) : null}
        {status === 'unavailable' && !metadata && !terminal ? (
          <Button variant="outline" disabled={busy} onClick={() => void restore(attempt)}>
            {m.auth_account_identity_retry()}
          </Button>
        ) : null}
        {!attempt ? (
          <form className="auth-login-form" method="post" action="/automated/open" onSubmit={review}>
            <Field>
              <FieldLabel htmlFor="opening-subject">{m.auth_opening_subject()}</FieldLabel>
              <Input
                id="opening-subject"
                value={subjectId}
                onChange={(event) => setSubjectId(event.target.value)}
                required
                readOnly={busy}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="opening-operator">{m.auth_opening_operator()}</FieldLabel>
              <Input
                id="opening-operator"
                value={operatorId}
                onChange={(event) => setOperatorId(event.target.value)}
                required
                readOnly={busy}
              />
            </Field>
            <Button type="submit" disabled={busy || !accountId}>
              {m.auth_opening_review()}
            </Button>
          </form>
        ) : null}
        {metadata && !terminal ? (
          <form className="auth-login-form" method="post" action="/operator-sessions/open" onSubmit={submit}>
            <h2 ref={confirmation} tabIndex={-1}>
              {m.auth_opening_confirmation()}
            </h2>
            <dl>
              <dt>{m.auth_opening_subject()}</dt>
              <dd>
                {metadata.subject.displayName} {metadata.subject.handle} ({metadata.subject.id})
              </dd>
              <dt>{m.auth_opening_operator()}</dt>
              <dd>
                {metadata.operator.displayName} {metadata.operator.handle} ({metadata.operator.id})
              </dd>
            </dl>
            <Field>
              <FieldLabel htmlFor="opening-confirm">
                <input
                  id="opening-confirm"
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  required
                  disabled={busy}
                />
                {m.auth_opening_confirm()}
              </FieldLabel>
            </Field>
            <Button type="submit" disabled={busy || !confirmed}>
              {m.auth_opening_submit()}
            </Button>
          </form>
        ) : null}
        {attempt && status === 'step-up' && !terminal ? (
          <Button disabled={busy} onClick={() => stepUp()}>
            {m.auth_opening_authenticate()}
          </Button>
        ) : null}
        {terminal && attempt ? (
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                if (!isCurrent() || lock.current) return;
                lock.current = true;
                setBusy(true);
                try {
                  await reconcile(attempt);
                } finally {
                  if (isCurrent()) {
                    lock.current = false;
                    setBusy(false);
                  }
                }
              }}
            >
              {m.auth_opening_readback()}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => stepUp(true)}>
              {m.auth_opening_restart()}
            </Button>
          </>
        ) : null}
        {outcome?.kind === 'opened' ? (
          <div role="status">
            <h2>{m.auth_opening_current()}</h2>
            <dl>
              <dt>{m.auth_opening_subject()}</dt>
              <dd>{outcome.session.account_id}</dd>
              <dt>{m.auth_opening_method()}</dt>
              <dd>{outcome.session.amr.join(', ')}</dd>
              <dt>{m.auth_opening_scopes()}</dt>
              <dd>{outcome.session.scope.join(', ') || m.auth_opening_no_scopes()}</dd>
            </dl>
          </div>
        ) : null}
      </div>
    </AuthPage>
  );
}
