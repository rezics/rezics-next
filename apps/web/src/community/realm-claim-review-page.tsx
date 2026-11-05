import { useEffect, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { ArrowRight, Check, CircleHelp, RefreshCw, ShieldCheck } from 'lucide-react';
import { ContentItem, ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { PageHeading } from '../shell/page-heading';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import {
  createRealmClaimReview,
  type RealmClaimReviewAdapter,
  type RealmClaimReviewRead,
  type RealmClaimReviewRequest,
} from './realm-claim-review';
import {
  createRealmClaimCallerLifetime,
  useRealmClaimDeparture,
  type RealmClaimCallerLifetime,
} from './realm-claim-caller-lifetime';
import { AuthoringDepartureBoundary } from '../threads/authoring-departure';

type FocusIntent =
  | { kind: 'queue'; ticket: number }
  | { kind: 'review'; ticket: number; request: RealmClaimReviewRequest }
  | { kind: 'cancel'; ticket: number; request: RealmClaimReviewRequest; read: RealmClaimReviewRead }
  | { kind: 'approval'; ticket: number; request: RealmClaimReviewRequest; action: 'confirm' | 'retry' | 'inspect' };

function sameRequest(a: RealmClaimReviewRequest, b: RealmClaimReviewRequest) {
  return (
    a.realmId === b.realmId &&
    a.requestId === b.requestId &&
    a.claimantAccountId === b.claimantAccountId &&
    a.state === b.state &&
    a.orphanedAt === b.orphanedAt &&
    a.claimEligibleAt === b.claimEligibleAt &&
    a.requestedAt === b.requestedAt
  );
}

function OriginalDate({ value }: { value: string }) {
  return (
    <time dateTime={value}>
      {new Intl.DateTimeFormat(getLocale(), {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
      }).format(new Date(value))}{' '}
      UTC
    </time>
  );
}
function Reference({ children }: { children: string }) {
  return (
    <span
      dir="ltr"
      className="inline-block max-w-full select-all whitespace-normal break-all font-mono text-xs leading-6"
    >
      {children}
    </span>
  );
}
function ReferenceDetails({ realmId, requestId }: { realmId: string; requestId?: string }) {
  return (
    <details className="min-w-0 text-sm">
      <summary className="min-h-11 min-w-11 cursor-pointer content-center rounded-md py-2 text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {m.realm_review_details_heading()}
      </summary>
      <dl className="min-w-0 space-y-3 py-3">
        <div className="min-w-0">
          <dt className="text-muted-foreground">{m.realm_review_realm()}</dt>
          <dd>
            <Reference>{realmId}</Reference>
          </dd>
        </div>
        {requestId ? (
          <div className="min-w-0">
            <dt className="text-muted-foreground">{m.realm_review_request_reference()}</dt>
            <dd>
              <Reference>{requestId}</Reference>
            </dd>
          </div>
        ) : null}
      </dl>
    </details>
  );
}
function RequestDetails({ request }: { request: RealmClaimReviewRequest }) {
  return (
    <div className="w-full min-w-0 space-y-4">
      <p className="font-medium">
        {request.claimant?.href ? (
          <a
            href={request.claimant.href}
            className="inline-block min-h-11 max-w-full content-center rounded-md underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {request.claimant.label.trim() && request.claimant.label !== 'Claimant'
              ? request.claimant.label
              : m.realm_review_claimant()}
          </a>
        ) : (
          <span>
            {request.claimant?.label.trim() && request.claimant.label !== 'Claimant'
              ? request.claimant.label
              : m.realm_review_claimant()}
          </span>
        )}
      </p>
      <dl className="grid w-full min-w-0 gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-muted-foreground">{m.realm_review_claimant()}</dt>
          <dd>
            <Reference>{request.claimantAccountId}</Reference>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{m.realm_claim_requested_at()}</dt>
          <dd>
            <OriginalDate value={request.requestedAt} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{m.realm_claim_orphaned_at()}</dt>
          <dd>
            <OriginalDate value={request.orphanedAt} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{m.realm_claim_eligible_at()}</dt>
          <dd>
            <OriginalDate value={request.claimEligibleAt} />
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** A page region inside AppShell's single main, shared by the route and review stories. */
export function RealmClaimReviewView(props: RealmClaimReviewViewProps) {
  return (
    <AuthoringDepartureBoundary sessionBound={false}>
      <RealmClaimReviewContent {...props} />
    </AuthoringDepartureBoundary>
  );
}

type RealmClaimReviewViewProps = {
  realmId: string;
  initial: RealmClaimReviewRead;
  adapter: RealmClaimReviewAdapter;
  ready?: boolean;
  load?: boolean;
  lifetime?: RealmClaimCallerLifetime;
  connectionRevision?: number;
};

function RealmClaimReviewContent({
  realmId,
  initial,
  adapter,
  ready = true,
  load = false,
  lifetime: suppliedLifetime,
  connectionRevision = 0,
}: RealmClaimReviewViewProps) {
  const id = useId();
  const lifetime = useMemo(
    () => suppliedLifetime ?? createRealmClaimCallerLifetime(() => true),
    [suppliedLifetime, realmId, initial, adapter],
  );
  const control = useMemo(
    () => createRealmClaimReview(realmId, initial, adapter, undefined, lifetime),
    [realmId, initial, adapter, lifetime],
  );
  const snapshot = useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot);
  useSyncExternalStore(lifetime.subscribe, lifetime.snapshot, lifetime.snapshot);
  const queueBoundary = useRef<HTMLHeadingElement>(null);
  const retryPageButton = useRef<HTMLButtonElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<FocusIntent | null>(null);
  const selectedReviewButton = useRef<HTMLButtonElement>(null);
  const confirmationBoundary = useRef<HTMLElement>(null);
  const receiptBoundary = useRef<HTMLDivElement>(null);
  const recoveryBoundary = useRef<HTMLElement>(null);
  const inspectionButton = useRef<HTMLButtonElement>(null);
  const approvalRetryButton = useRef<HTMLButtonElement>(null);
  const setRecoveryBoundary = (node: HTMLElement | null) => {
    recoveryBoundary.current = node;
  };
  useEffect(() => {
    const cancel = () => {
      pendingFocus.current = null;
    };
    const cancelOnTab = (event: KeyboardEvent) => {
      if (event.key === 'Tab') cancel();
    };
    document.addEventListener('focusin', cancel, true);
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', cancelOnTab, true);
    window.addEventListener('blur', cancel);
    return () => {
      cancel();
      document.removeEventListener('focusin', cancel, true);
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', cancelOnTab, true);
      window.removeEventListener('blur', cancel);
    };
  }, []);
  useRealmClaimDeparture(lifetime, control, ready);
  useEffect(() => {
    pendingFocus.current = null;
    control.reconnect();
    if (load || (lifetime && connectionRevision > 0)) {
      const ticket = lifetime?.ticket();
      queueMicrotask(() => {
        if (lifetime && ticket !== undefined && !lifetime.owns(ticket)) return;
        void control.refresh();
      });
    }
    return () => {
      pendingFocus.current = null;
      control.disconnect();
    };
  }, [control, load, lifetime, connectionRevision]);
  const active = ready && (!lifetime || lifetime.current());
  const hidden: typeof snapshot = {
    read: { kind: 'unavailable' },
    cursor: undefined,
    intent: null,
    receipt: null,
    inspection: null,
    recoveryReady: false,
    outcome: 'refused',
    busy: false,
  };
  const state = active ? snapshot : hidden;
  useLayoutEffect(() => {
    const intent = pendingFocus.current;
    if (!intent) return;
    if (!active || !lifetime.owns(intent.ticket)) {
      pendingFocus.current = null;
      return;
    }
    if (state.busy) return;
    if (intent.kind === 'queue') {
      pendingFocus.current = null;
      if (state.read.kind === 'ready') queueBoundary.current?.focus();
      else (retryPageButton.current ?? refreshButton.current)?.focus();
      return;
    }
    if (intent.kind === 'review') {
      if (state.outcome === 'confirming' && state.intent && sameRequest(state.intent.source, intent.request)) {
        pendingFocus.current = null;
        confirmationBoundary.current?.focus();
      } else pendingFocus.current = null;
      return;
    }
    if (intent.kind === 'cancel') {
      pendingFocus.current = null;
      const requestIsCurrent =
        state.read.kind === 'ready' &&
        state.read.page.claimRequests.some((request) => sameRequest(request, intent.request));
      if (state.outcome === 'idle' && !state.intent && state.read === intent.read && requestIsCurrent)
        selectedReviewButton.current?.focus();
      else queueBoundary.current?.focus();
      return;
    }
    if (!state.intent || !sameRequest(state.intent.source, intent.request)) {
      pendingFocus.current = null;
      return;
    }
    if (
      intent.action === 'retry' &&
      state.outcome === 'uncertain' &&
      state.read.kind !== 'ready' &&
      approvalRetryButton.current
    ) {
      pendingFocus.current = null;
      return;
    }
    pendingFocus.current = null;
    if (state.outcome === 'approved' && receiptBoundary.current) receiptBoundary.current.focus();
    else if (state.outcome === 'uncertain')
      (
        approvalRetryButton.current ??
        inspectionButton.current ??
        recoveryBoundary.current ??
        retryPageButton.current ??
        refreshButton.current
      )?.focus();
    else if (state.outcome === 'approved') recoveryBoundary.current?.focus();
    else if (state.outcome === 'conflict' || state.outcome === 'refused') {
      (recoveryBoundary.current ?? retryPageButton.current ?? refreshButton.current)?.focus();
    }
  }, [active, lifetime, state]);
  function rememberQueueActivation(detail: number) {
    pendingFocus.current = detail === 0 ? { kind: 'queue', ticket: lifetime.ticket() } : null;
  }
  const page = state.read.kind === 'ready' ? state.read.page : null;
  const confirming = page && state.outcome === 'confirming' ? state.intent : null;
  const denied = state.read.kind === 'denied' || state.read.kind === 'signed-out' || state.read.kind === 'closed';
  const canRestart = ['unavailable', 'invalid-cursor', 'stale-cursor'].includes(state.read.kind);
  const receipt = !denied && state.outcome === 'approved' ? state.receipt : null;
  const editable = active && !state.busy && state.outcome === 'idle';
  return (
    <article className="min-w-0 space-y-8 text-foreground [overflow-wrap:anywhere]" aria-busy={state.busy}>
      <header className="flex flex-wrap items-start justify-between gap-5 border-b pb-6">
        <div className="max-w-2xl space-y-3">
          <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <ShieldCheck className="size-4" aria-hidden="true" />
            {m.realm_review_eyebrow()}
          </p>
          <PageHeading>{m.realm_review_heading()}</PageHeading>
          <p className="text-pretty leading-7 text-muted-foreground">{m.realm_review_intro()}</p>
        </div>
        {canRestart && !state.busy && state.outcome !== 'uncertain' ? (
          <div className="flex flex-wrap gap-3">
            {state.read.kind === 'unavailable' ? (
              <Button
                ref={retryPageButton}
                variant="outline"
                className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal text-start"
                disabled={!active}
                onClick={(event) => {
                  rememberQueueActivation(event.detail);
                  void control.retryPage();
                }}
              >
                {m.realm_review_retry_page()}
              </Button>
            ) : null}
            <Button
              variant="outline"
              className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal text-start"
              disabled={!active}
              onClick={(event) => {
                rememberQueueActivation(event.detail);
                void control.restart();
              }}
            >
              {m.realm_review_restart()}
            </Button>
          </div>
        ) : (
          <Button
            ref={refreshButton}
            variant="outline"
            className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal text-start"
            disabled={!active || state.busy || state.outcome === 'uncertain'}
            onClick={(event) => {
              rememberQueueActivation(event.detail);
              void control.refresh();
            }}
          >
            <RefreshCw className={state.busy ? 'animate-spin' : ''} aria-hidden="true" />
            {state.busy ? m.realm_review_working() : m.realm_review_refresh()}
          </Button>
        )}
      </header>
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_16rem] lg:gap-10">
        <section aria-labelledby={`${id}-queue`} className="min-w-0 space-y-5">
          <div className="space-y-1">
            <h2
              ref={queueBoundary}
              id={`${id}-queue`}
              tabIndex={-1}
              className="text-lg font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {m.realm_review_queue()}
            </h2>
            {page?.realmPresentation?.state === 'available' ? (
              <div className="space-y-2">
                <p className="font-medium">{page.realmPresentation.name}</p>
                <p className="text-sm text-muted-foreground">{page.realmPresentation.description}</p>
              </div>
            ) : null}
            {page ? <ReferenceDetails realmId={realmId} /> : null}
          </div>
          <div aria-live="polite" aria-atomic="true" className="space-y-4">
            {state.outcome === 'conflict' ? (
              <p
                ref={setRecoveryBoundary}
                tabIndex={-1}
                role="alert"
                className="rounded-xl border p-4 text-sm leading-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {m.realm_review_conflict()}
              </p>
            ) : null}
            {state.outcome === 'uncertain' && !denied ? (
              <div ref={setRecoveryBoundary} role="alert" className="space-y-3 rounded-xl border p-4 text-sm leading-6">
                <p>{m.realm_review_uncertain()}</p>
                <Button
                  ref={inspectionButton}
                  variant="outline"
                  className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal text-start"
                  disabled={!active || state.busy}
                  onClick={(event) => {
                    pendingFocus.current =
                      event.detail === 0 && state.intent
                        ? {
                            kind: 'approval',
                            ticket: lifetime.ticket(),
                            request: state.intent.source,
                            action: 'inspect',
                          }
                        : null;
                    void control.inspectOriginal();
                  }}
                >
                  {m.realm_review_inspect_original()}
                </Button>
                {state.inspection ? (
                  <p role="status">
                    {state.inspection.state === 'approved'
                      ? m.realm_review_inspected_approved()
                      : m.realm_review_inspected_pending()}
                  </p>
                ) : state.recoveryReady ? (
                  <p role="status">{m.realm_review_inspected_missing()}</p>
                ) : null}
                {state.recoveryReady ? (
                  <Button
                    ref={approvalRetryButton}
                    variant="outline"
                    className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal text-start"
                    disabled={!active || state.busy}
                    onClick={(event) => {
                      pendingFocus.current =
                        event.detail === 0 && state.intent
                          ? {
                              kind: 'approval',
                              ticket: lifetime.ticket(),
                              request: state.intent.source,
                              action: 'retry',
                            }
                          : null;
                      void control.retry();
                    }}
                  >
                    {m.realm_review_retry()}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {receipt ? (
              <ContentItemFrame
                as="article"
                role="status"
                aria-labelledby={`${id}-receipt`}
                className="space-y-3 p-5 text-sm leading-6"
              >
                <div
                  ref={receiptBoundary}
                  tabIndex={-1}
                  className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <ContentItemHeading level={3} id={`${id}-receipt`} className="flex items-center gap-2 font-semibold">
                    <Check className="size-4" aria-hidden="true" />
                    {m.realm_review_success()}
                  </ContentItemHeading>
                </div>
                <dl className="space-y-2">
                  <div>
                    <dt className="text-muted-foreground">{m.realm_review_claimant()}</dt>
                    <dd>
                      <Reference>{receipt.claimantAccountId}</Reference>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{m.realm_claim_orphaned_at()}</dt>
                    <dd>
                      <OriginalDate value={receipt.orphanedAt} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{m.realm_review_approved_at()}</dt>
                    <dd>
                      <OriginalDate value={receipt.approvedAt} />
                    </dd>
                  </div>
                </dl>
                <p>{m.realm_review_success_help()}</p>
                <ReferenceDetails realmId={receipt.realmId} requestId={receipt.requestId} />
              </ContentItemFrame>
            ) : null}
            {!page ? (
              <div
                ref={state.outcome === 'conflict' ? undefined : setRecoveryBoundary}
                tabIndex={-1}
                className="space-y-3 p-2 text-sm leading-7 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <p>
                  {state.busy
                    ? m.realm_review_working()
                    : state.read.kind === 'signed-out'
                      ? m.realm_review_signed_out()
                      : state.read.kind === 'closed'
                        ? m.realm_review_closed()
                        : denied
                          ? m.realm_review_denied()
                          : m.realm_review_unavailable()}
                </p>
                {!state.busy && state.outcome === 'approved' ? <p>{m.realm_review_refresh_after_approval()}</p> : null}
              </div>
            ) : null}
          </div>
          {confirming ? (
            <section
              ref={confirmationBoundary}
              aria-labelledby={`${id}-confirm`}
              tabIndex={-1}
              className="min-w-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <ContentItemFrame as="div" className="space-y-5 p-5 sm:p-6">
                <div className="space-y-2">
                  <ContentItemHeading level={3} id={`${id}-confirm`} className="text-lg font-semibold">
                    {m.realm_review_confirm_heading()}
                  </ContentItemHeading>
                  <p className="text-sm leading-6">{m.realm_review_confirm_help()}</p>
                </div>
                <RequestDetails request={confirming.source} />
                <ReferenceDetails realmId={confirming.source.realmId} requestId={confirming.source.requestId} />
                <div className="flex flex-wrap gap-3">
                  <Button
                    className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal text-start"
                    disabled={!active || state.busy}
                    onClick={(event) => {
                      pendingFocus.current =
                        event.detail === 0
                          ? {
                              kind: 'approval',
                              ticket: lifetime.ticket(),
                              request: confirming.source,
                              action: 'confirm',
                            }
                          : null;
                      void control.confirm();
                    }}
                  >
                    {m.realm_review_confirm()}
                  </Button>
                  <Button
                    variant="outline"
                    className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal text-start"
                    disabled={state.busy}
                    onClick={(event) => {
                      pendingFocus.current =
                        event.detail === 0
                          ? { kind: 'cancel', ticket: lifetime.ticket(), request: confirming.source, read: state.read }
                          : null;
                      control.cancel();
                    }}
                  >
                    {m.realm_review_cancel()}
                  </Button>
                </div>
              </ContentItemFrame>
            </section>
          ) : null}
          {page && !confirming ? (
            <>
              {page.claimRequests.length ? (
                <ul aria-labelledby={`${id}-queue`} className="min-w-0 space-y-4">
                  {page.claimRequests.map((request) => (
                    <ContentItem
                      key={request.requestId}
                      title={m.realm_review_details_request_heading()}
                      headingLevel={3}
                      className="[&_h3]:line-clamp-none [&_h3]:whitespace-normal [&_h3]:[overflow-wrap:anywhere]"
                      metadata={<RequestDetails request={request} />}
                      preview={<ReferenceDetails realmId={request.realmId} requestId={request.requestId} />}
                      state={
                        <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium">
                          {m.realm_review_pending()}
                        </span>
                      }
                      actions={
                        <Button
                          variant="outline"
                          className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal text-start"
                          disabled={!editable || !request.approvalAdvice}
                          ref={
                            pendingFocus.current?.kind === 'cancel' &&
                            sameRequest(pendingFocus.current.request, request)
                              ? selectedReviewButton
                              : undefined
                          }
                          onClick={(event) => {
                            pendingFocus.current =
                              event.detail === 0 ? { kind: 'review', ticket: lifetime.ticket(), request } : null;
                            void control.prepare(request.requestId);
                          }}
                        >
                          {m.realm_review_review()}
                          <ArrowRight aria-hidden="true" />
                        </Button>
                      }
                    />
                  ))}
                </ul>
              ) : (
                <div className="space-y-2 p-2 leading-7">
                  <p className="font-medium">{page.next ? m.realm_review_sparse() : m.realm_review_empty()}</p>
                  <p className="text-sm text-muted-foreground">
                    {page.next ? m.realm_review_sparse_help() : m.realm_review_empty_help()}
                  </p>
                </div>
              )}
              {page.next && state.outcome === 'idle' ? (
                <Button
                  variant="outline"
                  className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal text-start"
                  disabled={!editable}
                  onClick={(event) => {
                    rememberQueueActivation(event.detail);
                    void control.next();
                  }}
                >
                  {m.realm_review_next()}
                  <ArrowRight aria-hidden="true" />
                </Button>
              ) : null}
            </>
          ) : null}
          {page && ['approved', 'conflict', 'refused'].includes(state.outcome) ? (
            <Button
              variant="outline"
              className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal text-start"
              disabled={state.busy}
              onClick={() => {
                pendingFocus.current = null;
                control.reviewCurrent();
              }}
            >
              {m.realm_review_review_current()}
            </Button>
          ) : null}
        </section>
        <aside className="space-y-5 border-t pt-6 text-sm leading-7 text-muted-foreground lg:border-t-0 lg:border-s lg:ps-6 lg:pt-0">
          <h2 className="flex items-center gap-2 font-semibold text-foreground">
            <CircleHelp className="size-4" aria-hidden="true" />
            {m.realm_review_guidance_heading()}
          </h2>
          <p>{m.realm_review_guidance_dates()}</p>
          <p>{m.realm_review_guidance_authority()}</p>
          <p>{m.realm_review_guidance_privacy()}</p>
        </aside>
      </div>
    </article>
  );
}
