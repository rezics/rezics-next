import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale, localizeHref } from '../paraglide/runtime.js';
import {
  createRealmClaim,
  mayRequestRealmClaim,
  mayRetryRealmClaim,
  type RealmClaimAdapter,
  type RealmClaimRead,
} from './realm-claim';
import {
  createRealmClaimCallerLifetime,
  useRealmClaimDeparture,
  type RealmClaimCallerLifetime,
} from './realm-claim-caller-lifetime';
import { AuthoringDepartureBoundary } from '../threads/authoring-departure';

function OriginalDate({ value }: { value: string }) {
  return (
    <time dateTime={value} className="block min-w-0 [overflow-wrap:anywhere]">
      <span className="block">
        {new Intl.DateTimeFormat(getLocale(), { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }).format(
          new Date(value),
        )}{' '}
        UTC
      </span>
      <span dir="ltr" className="mt-1 block select-all font-mono text-xs text-muted-foreground">
        {value}
      </span>
    </time>
  );
}

/** The same management region is mounted in Space/Realm home and Pattern stories. */
export function RealmClaimControls(props: RealmClaimControlsProps) {
  return (
    <AuthoringDepartureBoundary sessionBound={false}>
      <RealmClaimControlsContent {...props} />
    </AuthoringDepartureBoundary>
  );
}

type RealmClaimControlsProps = {
  realmId: string;
  initial: RealmClaimRead;
  adapter: RealmClaimAdapter;
  returnTo: string;
  ready?: boolean;
  load?: boolean;
  onRead?: (read: RealmClaimRead) => void;
  recoveryOnly?: boolean;
  lifetime?: RealmClaimCallerLifetime;
  connectionRevision?: number;
};

function RealmClaimControlsContent({
  realmId,
  initial,
  adapter,
  returnTo,
  ready = true,
  load = false,
  onRead,
  recoveryOnly = false,
  lifetime: suppliedLifetime,
  connectionRevision = 0,
}: RealmClaimControlsProps) {
  const id = useId();
  const lifetime = useMemo(
    () => suppliedLifetime ?? createRealmClaimCallerLifetime(() => true),
    [suppliedLifetime, realmId, adapter],
  );
  const control = useMemo(
    () => createRealmClaim(realmId, initial, adapter, undefined, lifetime),
    [realmId, adapter, lifetime],
  );
  const state = useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot);
  const lifetimeRevision = useSyncExternalStore(lifetime.subscribe, lifetime.snapshot, lifetime.snapshot);
  useRealmClaimDeparture(lifetime, control, ready);
  const [copy, setCopy] = useState<{
    control: typeof control;
    request: object;
    read: RealmClaimRead;
    lifetime: RealmClaimCallerLifetime;
    state: 'copied' | 'failed';
  } | null>(null);
  const copyAttempt = useRef(0);
  const copyContext = useRef({ control, lifetime });
  copyContext.current = { control, lifetime };
  const copyButton = useRef<HTMLButtonElement>(null);
  const copyFallback = useRef<HTMLInputElement>(null);
  const pageSnapshot = initial.kind === 'ready' ? initial.snapshot : null;
  const pageKind = initial.kind;
  useEffect(() => {
    control.reconnect();
    return () => {
      copyAttempt.current++;
      control.disconnect();
    };
  }, [control]);
  useEffect(() => {
    if (pageSnapshot) control.observePage(pageSnapshot);
    else if (pageKind !== 'ready') control.observeUnavailable({ kind: pageKind });
  }, [control, pageSnapshot, pageKind]);
  useEffect(() => {
    if (load || (lifetime && connectionRevision > 0)) {
      const ticket = lifetime?.ticket();
      queueMicrotask(() => {
        if (lifetime && ticket !== undefined && !lifetime.owns(ticket)) return;
        void control.refresh();
      });
    }
  }, [control, load, lifetime, connectionRevision]);
  useEffect(() => {
    onRead?.(control.getSnapshot().read);
  }, [control, state.read, onRead, pageSnapshot]);
  const active = ready && (!lifetime || lifetime.current());
  const current = state.read.kind === 'ready' && state.read.snapshot.realmId === realmId ? state.read : null;
  const orphan = current?.snapshot.ownershipState === 'orphaned' ? current.snapshot : null;
  const suppliedReceipt = state.recovered ?? state.request;
  const receipt = active && suppliedReceipt?.realmId === realmId ? suppliedReceipt : null;
  const request =
    !state.busy &&
    orphan &&
    receipt?.realmId === realmId &&
    receipt.orphanedAt === orphan.orphanedAt &&
    current?.admission === 'allowed'
      ? receipt
      : null;
  const owned = current?.snapshot.ownershipState === 'owned';
  const copyState =
    copy?.control === control && copy.request === request && copy.read === state.read && copy.lifetime === lifetime
      ? copy.state
      : 'idle';
  useEffect(() => {
    if (copy && copyState === 'idle') setCopy(null);
  }, [copy, copyState, lifetimeRevision]);
  useEffect(() => {
    if (copyState === 'failed') {
      copyFallback.current?.focus();
      copyFallback.current?.select();
    }
  }, [copyState]);
  if (recoveryOnly && !orphan && !state.intent) return null;
  return (
    <section aria-labelledby={`${id}-heading`} aria-busy={state.busy}>
      <ContentItemFrame as="div" data-slot="content-item-frame" className="w-full min-w-0 space-y-4 p-5 sm:p-6">
        <header className="min-w-0 space-y-2">
          <ContentItemHeading level={2} id={`${id}-heading`} className="text-lg font-semibold">
            {m.realm_claim_heading()}
          </ContentItemHeading>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {owned ? m.realm_claim_owned() : orphan ? m.realm_claim_orphaned() : m.realm_claim_unavailable()}
          </p>
        </header>
        {orphan?.orphanedAt && orphan.claimEligibleAt ? (
          <dl className="grid gap-4 rounded-xl bg-muted/50 p-4 text-sm sm:grid-cols-2">
            <div className="space-y-1">
              <dt className="text-muted-foreground">{m.realm_claim_orphaned_at()}</dt>
              <dd>
                <OriginalDate value={orphan.orphanedAt} />
              </dd>
            </div>
            <div className="space-y-1">
              <dt className="text-muted-foreground">{m.realm_claim_eligible_at()}</dt>
              <dd>
                <OriginalDate value={orphan.claimEligibleAt} />
              </dd>
            </div>
          </dl>
        ) : null}
        {orphan ? <p className="text-sm text-muted-foreground">{m.realm_claim_eligibility()}</p> : null}
        {current?.admission === 'unavailable' ? (
          <p role="status" className="text-sm">
            {m.realm_claim_admission_unavailable()}
          </p>
        ) : null}
        {orphan && current?.admission === 'allowed' && ['unchecked', 'unavailable'].includes(state.recovery) ? (
          <p role="status" className="text-sm">
            {m.realm_claim_status_recovery_unknown()}
          </p>
        ) : null}
        {request ? (
          <div role="status" className="space-y-3 rounded-xl bg-muted p-4 text-sm">
            <p className="font-semibold">
              {request.state === 'approved' ? m.realm_claim_status_approved() : m.realm_claim_pending()}
            </p>
            <p>{request.state === 'approved' ? m.realm_claim_status_approved_help() : m.realm_claim_review_help()}</p>
            <dl className="space-y-2">
              <div>
                <dt className="text-muted-foreground">{m.realm_claim_requested_at()}</dt>
                <dd>
                  <OriginalDate value={request.requestedAt} />
                </dd>
              </div>
              {'approvedAt' in request && request.approvedAt ? (
                <div>
                  <dt className="text-muted-foreground">{m.realm_claim_status_approved_at()}</dt>
                  <dd>
                    <OriginalDate value={request.approvedAt} />
                  </dd>
                </div>
              ) : null}
            </dl>
            <details className="min-w-0">
              <summary className="min-h-11 cursor-pointer py-2 font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                {m.community_management_details_claim_summary()}
              </summary>
              <div className="space-y-3 pt-2">
                <dl className="space-y-1 text-sm">
                  <div>
                    <dt className="text-muted-foreground">{m.realm_claim_reference()}</dt>
                    <dd className="select-all break-all font-mono">{request.requestId}</dd>
                  </div>
                </dl>
                <Button
                  ref={copyButton}
                  variant="outline"
                  onClick={async () => {
                    const read = state.read;
                    const ticket = lifetime.ticket();
                    const attempt = ++copyAttempt.current;
                    const canPublish = () => {
                      const latest = control.getSnapshot();
                      const selected = latest.recovered ?? latest.request;
                      return (
                        copyAttempt.current === attempt &&
                        copyContext.current.control === control &&
                        copyContext.current.lifetime === lifetime &&
                        lifetime.owns(ticket) &&
                        latest.read === read &&
                        !latest.busy &&
                        latest.read.kind === 'ready' &&
                        latest.read.admission === 'allowed' &&
                        latest.read.snapshot.realmId === realmId &&
                        latest.read.snapshot.ownershipState === 'orphaned' &&
                        latest.read.snapshot.orphanedAt === request.orphanedAt &&
                        selected === request &&
                        request.realmId === realmId
                      );
                    };
                    setCopy(null);
                    if (!canPublish()) return;
                    try {
                      await navigator.clipboard.writeText(request.requestId);
                      if (canPublish()) setCopy({ control, request, read, lifetime, state: 'copied' });
                    } catch {
                      if (canPublish()) setCopy({ control, request, read, lifetime, state: 'failed' });
                    }
                  }}
                >
                  {m.realm_claim_copy()}
                </Button>
                {copyState !== 'idle' ? (
                  <p role="status">{copyState === 'copied' ? m.realm_claim_copied() : m.realm_claim_copy_failed()}</p>
                ) : null}
                {copyState === 'failed' ? (
                  <div className="space-y-2">
                    <label htmlFor={`${id}-claim-reference-copy`} className="block font-medium">
                      {m.realm_claim_copy_fallback_label()}
                    </label>
                    <input
                      ref={copyFallback}
                      id={`${id}-claim-reference-copy`}
                      aria-label={m.realm_claim_copy_fallback_label()}
                      className="min-h-11 w-full select-all rounded-md border bg-background px-3 font-mono text-sm"
                      readOnly
                      value={request.requestId}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <Button
                      variant="outline"
                      onClick={() => {
                        setCopy(null);
                        copyButton.current?.focus();
                      }}
                    >
                      {m.realm_claim_copy_close()}
                    </Button>
                  </div>
                ) : null}
              </div>
            </details>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                nativeButton={false}
                render={<a href={localizeHref(`/realms/${realmId}/claim-requests/${request.requestId}`)} />}
              >
                {m.realm_claim_status_open()}
              </Button>
            </div>
          </div>
        ) : null}
        {!state.busy && !request && receipt && current?.admission === 'allowed' ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              nativeButton={false}
              render={<a href={localizeHref(`/realms/${realmId}/claim-requests/${receipt.requestId}`)} />}
            >
              {m.realm_claim_status_open()}
            </Button>
          </div>
        ) : null}
        {active && state.outcome === 'uncertain' ? (
          <p role="alert" className="text-sm">
            {m.realm_claim_uncertain()}
          </p>
        ) : null}
        {active && state.outcome === 'conflict' ? (
          <p role="alert" className="text-sm">
            {m.realm_claim_conflict()}
          </p>
        ) : null}
        {(active && state.outcome === 'refused') || current?.admission === 'denied' ? (
          <p role="alert" className="text-sm">
            {m.realm_claim_refused()}
          </p>
        ) : null}
        {orphan && current?.admission === 'signed-out' ? (
          <Button nativeButton={false} render={<a href={`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`} />}>
            {m.realm_claim_sign_in()}
          </Button>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {current?.admission === 'allowed' && mayRequestRealmClaim(state) ? (
            <Button disabled={!ready} onClick={() => void control.submit()}>
              {m.realm_claim_request()}
            </Button>
          ) : null}
          {current?.admission === 'allowed' && mayRetryRealmClaim(state) ? (
            <Button disabled={!ready} onClick={() => void control.retry()}>
              {m.realm_claim_retry()}
            </Button>
          ) : null}
          {state.reviewed && (state.outcome === 'conflict' || state.outcome === 'refused') ? (
            <Button variant="outline" disabled={state.busy} onClick={() => control.review()}>
              {m.realm_claim_review_current()}
            </Button>
          ) : null}
          <Button variant="outline" disabled={!ready || state.busy} onClick={() => void control.refresh()}>
            {state.busy ? m.realm_claim_working() : m.realm_claim_refresh()}
          </Button>
        </div>
      </ContentItemFrame>
    </section>
  );
}
