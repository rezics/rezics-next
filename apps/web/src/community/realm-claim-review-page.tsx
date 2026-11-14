import { useEffect, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { ArrowRight, Check, CircleHelp, RefreshCw, ShieldCheck } from 'lucide-react';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { PageHeading } from '../shell/page-heading';
import { m } from '../paraglide/messages.js';
import {
  ManagementField,
  ManagementReference as Reference,
  ManagementReferences,
  ManagementReview,
  ManagementRow,
} from './members/management-ui';
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
    <time dateTime={value} className="block min-w-0 select-text [overflow-wrap:anywhere]">
      <span className="block">
        {new Intl.DateTimeFormat(getLocale(), {
          dateStyle: 'long',
          timeStyle: 'short',
          timeZone: 'UTC',
        }).format(new Date(value))}{' '}
        UTC
      </span>
      <span dir="ltr" className="mt-1 block select-all font-mono text-xs text-muted-foreground">
        {value}
      </span>
    </time>
  );
}
function ReferenceDetails({ realmId, requestId }: { realmId: string; requestId?: string }) {
  return (
    <ManagementReferences label={m.community_management_details_claim_summary()}>
      <ManagementField label={m.realm_review_realm()}>
        <Reference>{realmId}</Reference>
      </ManagementField>
      {requestId ? (
        <ManagementField label={m.realm_claim_reference()}>
          <Reference>{requestId}</Reference>
        </ManagementField>
      ) : null}
    </ManagementReferences>
  );
}
function ClaimantName({ request }: { request: RealmClaimReviewRequest }) {
  const label =
    request.claimant?.label.trim() && request.claimant.label !== 'Claimant'
      ? request.claimant.label
      : m.realm_review_claimant();
  return request.claimant?.href ? (
    <a
      href={request.claimant.href}
      className="inline-block min-h-11 max-w-full content-center rounded-md underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <bdi>{label}</bdi>
    </a>
  ) : (
    <bdi>{label}</bdi>
  );
}
function RequestDetails({ request, compact = false }: { request: RealmClaimReviewRequest; compact?: boolean }) {
  return (
    <div className="w-full min-w-0 space-y-3">
      {!compact ? (
        <p className="font-medium">
          <ClaimantName request={request} />
        </p>
      ) : null}
      <dl className="grid w-full min-w-0 gap-x-6 gap-y-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
        <ManagementField label={m.realm_review_claimant()} className="sm:col-span-2 xl:col-span-3">
          <Reference>{request.claimantAccountId}</Reference>
        </ManagementField>
        <ManagementField label={m.realm_claim_orphaned_at()}>
          <OriginalDate value={request.orphanedAt} />
        </ManagementField>
        <ManagementField label={m.realm_claim_eligible_at()}>
          <OriginalDate value={request.claimEligibleAt} />
        </ManagementField>
        <ManagementField label={m.realm_claim_requested_at()}>
          <OriginalDate value={request.requestedAt} />
        </ManagementField>
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
  const approvalActive =
    !!state.intent &&
    (state.outcome === 'confirming' ||
      state.outcome === 'sending' ||
      state.outcome === 'uncertain' ||
      state.outcome === 'conflict');
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
          {page?.realmPresentation?.state === 'available' ? (
            <div className="space-y-2">
              <p className="font-medium">{page.realmPresentation.name}</p>
              <p className="text-sm text-muted-foreground">{page.realmPresentation.description}</p>
            </div>
          ) : null}
          {page ? <ReferenceDetails realmId={realmId} /> : null}
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
      <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_15rem] xl:gap-10">
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
          </div>
          <div aria-live="polite" aria-atomic="true" className="space-y-4">
            {!page && !receipt && !approvalActive ? (
              <div
                ref={state.outcome === 'conflict' ? undefined : setRecoveryBoundary}
                tabIndex={-1}
                className="space-y-3 rounded-xl border bg-muted/20 p-4 text-sm leading-7 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
          {page ? (
            <>
              {page.claimRequests.length ? (
                <ul aria-labelledby={`${id}-queue`} className="min-w-0 rounded-xl border px-3 sm:px-1">
                  {page.claimRequests.map((request) => (
                    <ManagementRow
                      key={request.requestId}
                      title={<ClaimantName request={request} />}
                      metadata={<RequestDetails request={request} compact />}
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
                    >
                      <ReferenceDetails realmId={request.realmId} requestId={request.requestId} />
                    </ManagementRow>
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
        </section>
        <aside className="space-y-5 border-t pt-6 text-sm leading-7 text-muted-foreground xl:border-t-0 xl:border-s xl:ps-6 xl:pt-0">
          <h2 className="flex items-center gap-2 font-semibold text-foreground">
            <CircleHelp className="size-4" aria-hidden="true" />
            {m.realm_review_guidance_heading()}
          </h2>
          <p>{m.realm_review_guidance_dates()}</p>
          <p>{m.realm_review_guidance_authority()}</p>
          <p>{m.realm_review_guidance_privacy()}</p>
        </aside>
      </div>
      {confirming ||
      state.outcome === 'conflict' ||
      (state.outcome === 'uncertain' && !denied) ||
      (state.outcome === 'sending' && !!state.intent) ? (
        <section aria-label={m.realm_review_eyebrow()} className="space-y-5 border-t pt-6">
          {confirming ? (
            <section
              ref={confirmationBoundary}
              aria-labelledby={`${id}-confirm`}
              tabIndex={-1}
              className="min-w-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <ManagementReview title={m.realm_review_confirm_heading()} aria-labelledby={`${id}-confirm`}>
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
              </ManagementReview>
            </section>
          ) : null}
          {state.outcome === 'sending' ? (
            <p role="status" className="text-sm leading-6">
              {m.realm_review_working()}
            </p>
          ) : null}
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
              {state.busy ? <p role="status">{m.realm_review_working()}</p> : null}
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
              {state.inspection && state.intent ? (
                <section aria-label={m.realm_review_inspect_original()} className="space-y-3 border-t pt-3">
                  <p role="status">
                    {state.inspection.state === 'approved'
                      ? m.realm_review_inspected_approved()
                      : m.realm_review_inspected_pending()}
                  </p>
                  <RequestDetails request={state.intent.source} />
                  {state.inspection.state === 'approved' ? (
                    <ManagementField label={m.realm_claim_status_approved_at()}>
                      <OriginalDate value={state.inspection.approvedAt} />
                    </ManagementField>
                  ) : null}
                  <ReferenceDetails realmId={state.intent.realmId} requestId={state.intent.requestId} />
                </section>
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
        </section>
      ) : null}
      {receipt ? (
        <section aria-label={m.realm_review_success()} className="space-y-4 border-t pt-6">
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
            <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="text-muted-foreground">{m.realm_review_claimant()}</dt>
                <dd>
                  {state.intent ? <ClaimantName request={state.intent.source} /> : null}
                  <Reference>{receipt.claimantAccountId}</Reference>
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground">{m.realm_claim_orphaned_at()}</dt>
                <dd>
                  <OriginalDate value={receipt.orphanedAt} />
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground">{m.realm_claim_status_approved_at()}</dt>
                <dd>
                  <OriginalDate value={receipt.approvedAt} />
                </dd>
              </div>
            </dl>
            <p>{m.realm_review_success_help()}</p>
            <ReferenceDetails realmId={receipt.realmId} requestId={receipt.requestId} />
          </ContentItemFrame>
          {state.intent ? (
            <section aria-labelledby={`${id}-original-request`} className="space-y-3 rounded-xl border bg-muted/20 p-4">
              <ContentItemHeading level={3} id={`${id}-original-request`} className="text-base font-semibold">
                {m.realm_claim_request()}
              </ContentItemHeading>
              <dl className="grid min-w-0 gap-4 text-sm sm:grid-cols-2">
                <ManagementField label={m.realm_claim_eligible_at()}>
                  <OriginalDate value={state.intent.source.claimEligibleAt} />
                </ManagementField>
                <ManagementField label={m.realm_claim_requested_at()}>
                  <OriginalDate value={state.intent.source.requestedAt} />
                </ManagementField>
              </dl>
            </section>
          ) : null}
          {!page ? (
            <div
              ref={state.outcome === 'conflict' ? undefined : setRecoveryBoundary}
              tabIndex={-1}
              role="status"
              className="space-y-3 rounded-xl border bg-muted/20 p-4 text-sm leading-7 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
              {!state.busy ? <p>{m.realm_review_refresh_after_approval()}</p> : null}
            </div>
          ) : null}
        </section>
      ) : null}
      {page && ['approved', 'conflict', 'refused'].includes(state.outcome) ? (
        <div className="flex flex-wrap gap-2">
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
        </div>
      ) : null}
    </article>
  );
}
