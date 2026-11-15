import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
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
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import {
  ContentSection,
  ContentSectionBody,
  ContentSectionHeader,
  ContentSectionTitle,
} from '@rezics/ui/content-section';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@rezics/ui/shadcn/field';
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
      <summary className="cursor-pointer py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
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

const authorityLost = (page: { status: string }): page is { status: 'denied' | 'signed-out' | 'missing' } =>
  ['denied', 'signed-out', 'missing'].includes(page.status);

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
    if (authorityLost(result)) {
      // Revoking local authority makes no claim about an earlier native effect.
      updatePage({ status: result.status });
      return;
    }
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

  const contextIdentity =
    page.status === 'ready'
      ? page.account
      : confirmation?.identity ?? (initial.status === 'ready' ? initial.account : null);

  if (retired || !authorized) {
    const revoked = authorityLost(initial) ? initial : page;
    return (
      <article className="mx-auto flex w-full max-w-2xl flex-col gap-8 pb-8 sm:gap-10">
        <header className="flex flex-col gap-3">
          <PageHeading>{m.lifecycle_title()}</PageHeading>
          <p className="text-muted-foreground">{m.lifecycle_intro()}</p>
        </header>
        <ContentSection>
          <ContentSectionHeader>
            <ContentSectionTitle className="break-words [overflow-wrap:anywhere]">
              {contextIdentity ? identityLabel(contextIdentity) : m.lifecycle_target()}
            </ContentSectionTitle>
          </ContentSectionHeader>
          <ContentSectionBody className="flex flex-col gap-4 sm:gap-5">
            {contextIdentity?.displayName && contextIdentity.handle && (
              <p className="break-words [overflow-wrap:anywhere]">@{contextIdentity.handle}</p>
            )}
            {accountId.current !== null && <AccountDetails accountId={accountId.current} />}
            <p role="status">
              {authorityLost(revoked) ? statusText(revoked.status) : m.thread_authoring_session_changed()}
            </p>
            <Button className="w-full sm:w-fit" variant="outline" onClick={() => window.location.reload()}>
              {m.settings_reload()}
            </Button>
          </ContentSectionBody>
        </ContentSection>
      </article>
    );
  }

  return (
    <article className="mx-auto flex w-full max-w-2xl flex-col gap-8 pb-8 sm:gap-10">
      <header className="flex flex-col gap-3">
        <PageHeading>{m.lifecycle_title()}</PageHeading>
        <p className="text-muted-foreground">{m.lifecycle_intro()}</p>
      </header>
      <ContentSection>
        <ContentSectionHeader>
          <ContentSectionTitle className="break-words [overflow-wrap:anywhere]">
            {contextIdentity ? identityLabel(contextIdentity) : m.lifecycle_target()}
          </ContentSectionTitle>
        </ContentSectionHeader>
        <ContentSectionBody className="flex flex-col gap-4 sm:gap-5">
          {contextIdentity?.displayName && contextIdentity.handle && (
            <p className="break-words [overflow-wrap:anywhere]">@{contextIdentity.handle}</p>
          )}
          {accountId.current !== null && <AccountDetails accountId={accountId.current} />}
          {page.status === 'ready' ? (
            <>
              <p>{m.lifecycle_state_unavailable()}</p>
              <div className="flex flex-col gap-2 rounded-md bg-muted/40 p-3 sm:p-4">
                <p className="text-sm font-semibold">{m.lifecycle_action()}</p>
                {offered.length > 0 ? (
                  <ul className="flex flex-wrap gap-2">
                    {offered.map((item) => (
                      <li key={item}>
                        <Badge variant="outline" className="h-auto min-h-5 max-w-full whitespace-normal wrap-anywhere">
                          {actionLabel(item)}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>{m.lifecycle_capability_unavailable()}</p>
                )}
              </div>
            </>
          ) : (
            <p role="status">{statusText(page.status)}</p>
          )}
        </ContentSectionBody>
      </ContentSection>
      {page.status === 'ready' && (
        <form
          className="flex flex-col gap-4 rounded-lg border p-4 sm:gap-5 sm:p-6"
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
          <fieldset disabled={!canChoose || confirmation !== null} className="flex flex-col gap-4 sm:gap-5">
            <legend className="mb-3 font-semibold">{m.lifecycle_action()}</legend>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={actionId}>{m.lifecycle_action()}</FieldLabel>
                <Select
                  disabled={!canChoose || confirmation !== null}
                  items={
                    offered.length
                      ? offered.map((value) => ({ value, label: actionLabel(value) }))
                      : [{ value: '', label: m.lifecycle_capability_unavailable() }]
                  }
                  value={selected ?? ''}
                  onValueChange={(value) => setAction(value! as Action)}
                >
                  <SelectTrigger id={actionId} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {offered.length === 0 && <SelectItem value="">{m.lifecycle_capability_unavailable()}</SelectItem>}
                      {offered.map((item) => (
                        <SelectItem key={item} value={item}>
                          {actionLabel(item)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
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
            <Button className="w-full self-start sm:w-fit" type="submit">
              {m.lifecycle_review()}
            </Button>
          </fieldset>
        </form>
      )}
      {confirmation && (
        <section
          aria-labelledby={titleId}
          className="flex max-w-full flex-col gap-5 rounded-lg border bg-card p-4 sm:p-6"
        >
          <h2 id={titleId} className="text-lg font-semibold sm:text-xl">
            {m.lifecycle_confirmation()}
          </h2>
          <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] sm:gap-y-3">
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
            <dd className="break-words [overflow-wrap:anywhere]">{actionLabel(confirmation.intent.action)}</dd>
            <dt className="font-semibold">{m.lifecycle_reason()}</dt>
            <dd className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
              {confirmation.intent.reason ?? m.lifecycle_no_reason()}
            </dd>
          </dl>
          <p className="rounded-md bg-muted/40 p-3 text-sm leading-relaxed sm:p-4 sm:text-base">
            {confirmation.intent.action === 'suspend' ? m.lifecycle_suspend_effect() : m.lifecycle_reinstate_effect()}
          </p>
          {!locked && (
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button
                className="w-full sm:w-fit"
                disabled={busy || !offered.includes(confirmation.intent.action)}
                onClick={() => void send(confirmation)}
              >
                {m.lifecycle_confirm()}
              </Button>
              <Button
                className="w-full sm:w-fit"
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
            <summary className="cursor-pointer py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
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
        </section>
      )}
      <div className="flex flex-col gap-4 rounded-lg border p-4 sm:gap-5 sm:p-5">
        {outcome && (
          <div role="status" aria-live="polite" className="flex flex-col gap-2">
            {!['recorded', 'uncertain', 'pending'].includes(outcome.status) && (
              <h2 className="font-semibold">{m.lifecycle_not_applied()}</h2>
            )}
            <p>{statusText(outcome.status)}</p>
          </div>
        )}
        <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:flex-wrap">
          <Button className="w-full sm:w-fit" variant="outline" disabled={busy} onClick={() => void read()}>
            {m.lifecycle_read_current()}
          </Button>
          {confirmation && outcome?.status === 'uncertain' && (
            <Button
              className="w-full sm:w-fit"
              variant="outline"
              disabled={busy || !lastRead.current || !offered.includes(confirmation.intent.action)}
              onClick={() => void send(confirmation)}
            >
              {m.lifecycle_retry_same()}
            </Button>
          )}
        </div>
      </div>
      <details>
        <summary className="cursor-pointer py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
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
