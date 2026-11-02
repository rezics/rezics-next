import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { sessionQuery } from '../../session/query';
import { AuthoringDepartureBoundary, useAuthoringDeparture } from '../../threads/authoring-departure';
import { parseIntent, type Action, type Intent, type Outcome, type Page } from './data';
import { commandRequest, reviewRequest } from './request';

type DisplayIdentity = Readonly<{ displayName: string | null; handle: string | null }>;
type Confirmation = Readonly<{ intent: Intent; identity: DisplayIdentity }>;

const identityLabel = (identity: DisplayIdentity) =>
  identity.displayName || (identity.handle ? `@${identity.handle}` : m.lifecycle_unnamed_account());

function AccountDetails({ accountId }: { accountId: string }) {
  return (
    <details>
      <summary className="min-h-11 cursor-pointer py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
        {m.lifecycle_identity_details()}
      </summary>
      <dl className="mt-2 flex flex-col gap-1">
        <dt className="text-sm text-muted-foreground">{m.lifecycle_account_id()}</dt>
        <dd className="select-all break-all font-mono text-sm">{accountId}</dd>
      </dl>
    </details>
  );
}

type IO = { read(signal: AbortSignal): Promise<Page>; change(intent: Intent, signal: AbortSignal): Promise<Outcome> };
const actionLabel = (action: Action) => (action === 'suspend' ? m.lifecycle_suspend() : m.lifecycle_reinstate());
function statusText(status: Page['status'] | Outcome['status']) {
  switch (status) {
    case 'denied':
      return m.lifecycle_denied();
    case 'signed-out':
      return m.lifecycle_signed_out();
    case 'missing':
      return m.lifecycle_missing();
    case 'pending':
      return m.lifecycle_pending();
    case 'conflict':
      return m.lifecycle_conflict();
    case 'refused':
      return m.lifecycle_refused();
    case 'recorded':
      return m.lifecycle_recorded();
    case 'uncertain':
      return m.lifecycle_uncertain();
    default:
      return m.lifecycle_unavailable();
  }
}

export function AccountLifecyclePage({ initial, io }: { initial: Page; io: IO }) {
  const resource = useRef(initial.status === 'ready' ? initial.account.id : 'unavailable');
  if (initial.status === 'ready') resource.current = initial.account.id;
  // A replacement resource starts a fresh review and retires the previous resource's callbacks.
  // A failed selection refresh does not discard a command whose result is still uncertain.
  return (
    <AuthoringDepartureBoundary sessionBound={false}>
      <LifecycleReview key={resource.current} initial={initial} io={io} />
    </AuthoringDepartureBoundary>
  );
}

/** Bind even when a containing departure owner does not bind its own children to a session. */
function useReviewCaller() {
  const client = useContext(QueryClientContext);
  const read = useCallback(() => {
    const session = client?.getQueryData(sessionQuery.queryKey);
    return JSON.stringify([session?.state, session?.subject, session?.csrfToken]);
  }, [client]);
  const [owner] = useState(() => ({ client, session: read() }));
  const retired = useRef(false);
  const current = useCallback(() => {
    if (owner.client !== client || owner.session !== read()) retired.current = true;
    return !retired.current;
  }, [client, owner, read]);
  const subscribe = useCallback(
    (listener: () => void) =>
      client?.getQueryCache().subscribe(() => {
        current();
        listener();
      }) ?? (() => {}),
    [client, current],
  );
  const snapshot = useCallback(() => JSON.stringify([current(), read()]), [current, read]);
  const session = useSyncExternalStore(subscribe, snapshot, snapshot);
  return { current, session };
}

const authorityLost = (page: Page) => ['denied', 'signed-out', 'missing'].includes(page.status);

function LifecycleReview({ initial, io }: { initial: Page; io: IO }) {
  const id = useId();
  const actionId = `${id}-action`;
  const reasonId = `${id}-reason`;
  const reasonHelpId = `${id}-reason-help`;
  const titleId = `${id}-confirm-title`;
  const [page, setPage] = useState(initial);
  const currentPage = useRef(initial);
  const accountId = useRef(initial.status === 'ready' ? initial.account.id : null);
  const [defaultAction] = useState(() =>
    initial.status === 'ready' && !initial.offered.includes('suspend') ? (initial.offered[0] ?? 'suspend') : 'suspend',
  );
  const [action, setAction] = useState<Action>(defaultAction);
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  // Synchronous exclusion prevents two clicks from starting two effects before React re-renders.
  const inFlight = useRef(false);
  const unresolved = useRef<Intent | null>(null);
  const lastRead = useRef(false);
  const ambiguous = useRef(false);
  const retryable = useRef(false);
  const active = useRef(true);
  const request = useRef<AbortController | null>(null);
  const currentConfirmation = useRef<Confirmation | null>(null);
  const caller = useReviewCaller();
  const incoming = useRef(initial);
  incoming.current = initial;
  const [retired, setRetired] = useState(false);
  const current = () =>
    active.current && caller.current() && !authorityLost(incoming.current) && !authorityLost(currentPage.current);
  function retire() {
    active.current = false;
    request.current?.abort();
    currentConfirmation.current = null;
    unresolved.current = null;
  }
  useEffect(() => {
    active.current = true;
    return () => {
      retire();
    };
  }, []);

  const reconciled = outcome?.status === 'recorded' && outcome.effects?.state === 'complete';
  const needsDecision = () =>
    current() &&
    !reconciled &&
    (unresolved.current !== null || confirmation !== null || reason !== '' || action !== defaultAction);
  const departure = useAuthoringDeparture(
    needsDecision,
    () => current() && !reconciled && unresolved.current !== null,
    JSON.stringify([action, reason, confirmation?.intent.key, outcome?.status, busy, reconciled, caller.session]),
    undefined,
    () => {
      retire();
      setRetired(true);
    },
    undefined,
    {
      title: m.lifecycle_leave_title(),
      unsaved: m.lifecycle_leave_unsaved(),
      pending: m.container_lifecycle_leave_pending(),
    },
  );
  const authorized = current();
  useLayoutEffect(() => {
    if (!authorized) {
      retire();
      departure.release();
    }
  }, [authorized, departure.release]);

  function replaceConfirmation(value: Confirmation | null) {
    currentConfirmation.current = value;
    setConfirmation(value);
  }
  function updatePage(value: Page) {
    currentPage.current = value;
    if (value.status === 'ready' && accountId.current !== null && value.account.id !== accountId.current) {
      retire();
      setRetired(true);
    }
    if (authorityLost(value)) retire();
    setPage(value);
  }
  const offered = page.status === 'ready' ? page.offered : [];
  const selected = offered.includes(action) ? action : offered[0];
  const canChoose = !busy && !locked && selected !== undefined;

  async function read() {
    if (!current() || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      request.current = new AbortController();
      const next = await reviewRequest((signal) => io.read(signal), request.current.signal);
      if (current()) updatePage(next);
    } catch {
      if (current()) updatePage({ status: 'unavailable' });
    } finally {
      // Replaying an uncertain command requires a bounded read attempt first, even if unavailable.
      if (current()) {
        lastRead.current = true;
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  async function send(review: Confirmation) {
    const intent = review.intent;
    const available = currentPage.current;
    if (
      !current() ||
      currentConfirmation.current !== review ||
      inFlight.current ||
      available.status !== 'ready' ||
      available.account.id !== intent.accountId ||
      !available.offered.includes(intent.action) ||
      (unresolved.current !== null && (unresolved.current !== intent || !retryable.current || !lastRead.current))
    )
      return;
    inFlight.current = true;
    unresolved.current = intent;
    lastRead.current = false;
    setLocked(true);
    setBusy(true);
    let result: Outcome;
    try {
      request.current = new AbortController();
      result = await commandRequest((signal) => io.change(intent, signal), request.current.signal);
    } catch {
      // A BFF response can be lost after the native commit. Preserve exactly this intent.
      result = { status: 'uncertain', current: { status: 'unavailable' } };
    }
    if (!current()) return;
    if (['recorded', 'uncertain', 'pending'].includes(result.status)) ambiguous.current = true;
    // A later denial before receipt access cannot settle an earlier lost response.
    if (ambiguous.current && !['recorded', 'uncertain', 'pending'].includes(result.status))
      result = { status: 'uncertain', current: result.current ?? { status: 'unavailable' } };
    setOutcome(result);
    retryable.current = result.status === 'uncertain';
    if (result.current) updatePage(result.current);
    if (!ambiguous.current) {
      // An explicit native not_applied result or a pre-command refusal permits editing again.
      unresolved.current = null;
      setLocked(false);
      replaceConfirmation(null);
    }
    inFlight.current = false;
    setBusy(false);
  }

  if (retired || !authorized) {
    const revoked = authorityLost(initial) ? initial : page;
    return (
      <article className="mx-auto flex w-full max-w-2xl flex-col gap-6 pb-8">
        <PageHeading>{m.lifecycle_title()}</PageHeading>
        <p role="status">
          {authorityLost(revoked) ? statusText(revoked.status) : m.thread_authoring_session_changed()}
        </p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          {m.settings_reload()}
        </Button>
      </article>
    );
  }

  return (
    <article className="mx-auto flex w-full max-w-2xl flex-col gap-6 pb-8">
      <header className="flex flex-col gap-3">
        <PageHeading>{m.lifecycle_title()}</PageHeading>
        <p className="text-muted-foreground">{m.lifecycle_intro()}</p>
      </header>
      {page.status === 'ready' ? (
        <Card>
          <CardHeader>
            <CardTitle className="break-words [overflow-wrap:anywhere]">{identityLabel(page.account)}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {page.account.displayName && page.account.handle && (
              <p className="break-words [overflow-wrap:anywhere]">@{page.account.handle}</p>
            )}
            <AccountDetails accountId={page.account.id} />
            <p>{m.lifecycle_state_unavailable()}</p>
            {offered.length === 0 && <p>{m.lifecycle_capability_unavailable()}</p>}
          </CardContent>
        </Card>
      ) : (
        <p role="status">{statusText(page.status)}</p>
      )}
      {outcome && (
        <div role="status" aria-live="polite" className="flex flex-col gap-2">
          {!['recorded', 'uncertain', 'pending'].includes(outcome.status) && (
            <h2 className="font-semibold">{m.lifecycle_not_applied()}</h2>
          )}
          <p>{statusText(outcome.status)}</p>
        </div>
      )}
      <Button variant="outline" disabled={busy} onClick={() => void read()}>
        {m.lifecycle_read_current()}
      </Button>
      {page.status === 'ready' && (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (
              !current() ||
              page !== currentPage.current ||
              inFlight.current ||
              unresolved.current ||
              currentConfirmation.current ||
              !canChoose ||
              !selected ||
              reason.length > 2000
            )
              return;
            replaceConfirmation({
              intent: parseIntent({
                accountId: page.account.id,
                action: selected,
                key: crypto.randomUUID(),
                ...(reason === '' ? {} : { reason }),
              }),
              // Display only: later availability reads must not relabel the confirmed request.
              identity: Object.freeze({ displayName: page.account.displayName, handle: page.account.handle }),
            });
          }}
        >
          <fieldset disabled={!canChoose || confirmation !== null} className="flex flex-col gap-4">
            <legend className="mb-3 font-semibold">{m.lifecycle_action()}</legend>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={actionId}>{m.lifecycle_action()}</FieldLabel>
                <NativeSelect
                  id={actionId}
                  className="w-full"
                  value={selected ?? ''}
                  onChange={(event) => setAction(event.target.value as Action)}
                >
                  {offered.length === 0 && (
                    <NativeSelectOption value="">{m.lifecycle_capability_unavailable()}</NativeSelectOption>
                  )}
                  {offered.map((item) => (
                    <NativeSelectOption key={item} value={item}>
                      {actionLabel(item)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor={reasonId}>{m.lifecycle_reason()}</FieldLabel>
                <Textarea
                  id={reasonId}
                  className="min-h-28"
                  maxLength={2000}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  aria-describedby={reasonHelpId}
                />
                <FieldDescription id={reasonHelpId}>{m.lifecycle_reason_help()}</FieldDescription>
              </Field>
            </FieldGroup>
            <Button type="submit">{m.lifecycle_review()}</Button>
          </fieldset>
        </form>
      )}
      {confirmation && (
        <section aria-labelledby={titleId} className="flex flex-col gap-4 rounded-lg border p-5">
          <h2 id={titleId} className="text-lg font-semibold">
            {m.lifecycle_confirmation()}
          </h2>
          <dl className="flex flex-col gap-2">
            <dt className="font-semibold">{m.lifecycle_target()}</dt>
            <dd className="flex min-w-0 flex-col gap-1">
              <p className="break-words font-semibold [overflow-wrap:anywhere]">
                {identityLabel(confirmation.identity)}
              </p>
              {confirmation.identity.displayName && confirmation.identity.handle && (
                <p className="break-words [overflow-wrap:anywhere]">@{confirmation.identity.handle}</p>
              )}
              <AccountDetails accountId={confirmation.intent.accountId} />
            </dd>
            <dt className="font-semibold">{m.lifecycle_action()}</dt>
            <dd>{actionLabel(confirmation.intent.action)}</dd>
            <dt className="font-semibold">{m.lifecycle_reason()}</dt>
            <dd className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
              {confirmation.intent.reason ?? m.lifecycle_no_reason()}
            </dd>
          </dl>
          <p>
            {confirmation.intent.action === 'suspend' ? m.lifecycle_suspend_effect() : m.lifecycle_reinstate_effect()}
          </p>
          {!locked && (
            <div className="flex flex-wrap gap-3">
              <Button
                disabled={busy || !offered.includes(confirmation.intent.action)}
                onClick={() => void send(confirmation)}
              >
                {m.lifecycle_confirm()}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (!inFlight.current && currentConfirmation.current === confirmation) replaceConfirmation(null);
                }}
              >
                {m.lifecycle_cancel()}
              </Button>
            </div>
          )}
          {locked && <p>{m.lifecycle_locked()}</p>}
          <details>
            <summary className="min-h-11 cursor-pointer py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
              {m.lifecycle_operation_details()}
            </summary>
            <div className="mt-2 flex flex-col gap-3 text-sm">
              <p>{m.lifecycle_operation_help()}</p>
              <dl className="flex flex-col gap-1">
                <dt>{m.lifecycle_request_key()}</dt>
                <dd className="select-all break-all font-mono">{confirmation.intent.key}</dd>
                {outcome?.status === 'recorded' && (
                  <>
                    <dt>{m.lifecycle_receipt_id()}</dt>
                    <dd className="select-all break-all font-mono">{outcome.receiptId}</dd>
                  </>
                )}
              </dl>
            </div>
          </details>
          {outcome?.status === 'uncertain' && (
            <Button
              variant="outline"
              disabled={busy || !lastRead.current || !offered.includes(confirmation.intent.action)}
              onClick={() => void send(confirmation)}
            >
              {m.lifecycle_retry_same()}
            </Button>
          )}
        </section>
      )}
      <details>
        <summary className="min-h-11 cursor-pointer py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
          {m.lifecycle_technical_details()}
        </summary>
        <div className="mt-2 flex flex-col gap-3 text-sm text-muted-foreground">
          <p>{m.lifecycle_protocol_help()}</p>
          <p>{m.lifecycle_availability_help()}</p>
        </div>
      </details>
    </article>
  );
}
