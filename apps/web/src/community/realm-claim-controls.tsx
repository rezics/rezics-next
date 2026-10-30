import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
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

function OriginalDate({ value }: { value: string }) {
  return (
    <time dateTime={value}>
      {new Intl.DateTimeFormat(getLocale(), { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }).format(
        new Date(value),
      )}{' '}
      UTC
    </time>
  );
}

/** The same management region is mounted in Space/Realm home and Pattern stories. */
export function RealmClaimControls({
  realmId,
  initial,
  adapter,
  returnTo,
  ready = true,
  load = false,
  onRead,
}: {
  realmId: string;
  initial: RealmClaimRead;
  adapter: RealmClaimAdapter;
  returnTo: string;
  ready?: boolean;
  load?: boolean;
  onRead?: (read: RealmClaimRead) => void;
}) {
  const id = useId();
  const control = useMemo(() => createRealmClaim(realmId, initial, adapter), [realmId, adapter]);
  const state = useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const pageSnapshot = initial.kind === 'ready' ? initial.snapshot : null;
  const pageKind = initial.kind;
  useEffect(() => {
    if (pageSnapshot) control.observePage(pageSnapshot);
    else if (pageKind !== 'ready') control.observeUnavailable({ kind: pageKind });
  }, [control, pageSnapshot, pageKind]);
  useEffect(() => {
    if (load) void control.refresh();
  }, [control, load]);
  useEffect(() => {
    onRead?.(control.getSnapshot().read);
  }, [control, state.read, onRead, pageSnapshot]);
  const current = state.read.kind === 'ready' ? state.read : null;
  const orphan = current?.snapshot.ownershipState === 'orphaned' ? current.snapshot : null;
  const receipt = state.recovered ?? state.request;
  const request =
    !state.busy && orphan && receipt?.orphanedAt === orphan.orphanedAt && current?.admission === 'allowed'
      ? receipt
      : null;
  const owned = current?.snapshot.ownershipState === 'owned';
  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-4 rounded-2xl border bg-card p-5 sm:p-6">
      <div className="space-y-2">
        <h2 id={`${id}-heading`} className="text-lg font-semibold">
          {m.realm_claim_heading()}
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {owned ? m.realm_claim_owned() : orphan ? m.realm_claim_orphaned() : m.realm_claim_unavailable()}
        </p>
      </div>
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
              <dt className="text-muted-foreground">{m.realm_claim_reference()}</dt>
              <dd className="select-all break-all font-mono">{request.requestId}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{m.realm_claim_requested_at()}</dt>
              <dd>
                <OriginalDate value={request.requestedAt} />
              </dd>
            </div>
          </dl>
          <Button
            variant="outline"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(request.requestId);
                setCopyState('copied');
              } catch {
                setCopyState('failed');
              }
            }}
          >
            {m.realm_claim_copy()}
          </Button>
          <Button
            variant="outline"
            render={<a href={localizeHref(`/realms/${realmId}/claim-requests/${request.requestId}`)} />}
          >
            {m.realm_claim_status_open()}
          </Button>
          {copyState !== 'idle' ? (
            <p>{copyState === 'copied' ? m.realm_claim_copied() : m.realm_claim_copy_failed()}</p>
          ) : null}
        </div>
      ) : null}
      {!state.busy && !request && receipt && current?.admission === 'allowed' ? (
        <Button
          variant="outline"
          render={<a href={localizeHref(`/realms/${realmId}/claim-requests/${receipt.requestId}`)} />}
        >
          {m.realm_claim_status_open()}
        </Button>
      ) : null}
      {state.outcome === 'uncertain' ? (
        <p role="alert" className="text-sm">
          {m.realm_claim_uncertain()}
        </p>
      ) : null}
      {state.outcome === 'conflict' ? (
        <p role="alert" className="text-sm">
          {m.realm_claim_conflict()}
        </p>
      ) : null}
      {state.outcome === 'refused' || current?.admission === 'denied' ? (
        <p role="alert" className="text-sm">
          {m.realm_claim_refused()}
        </p>
      ) : null}
      {orphan && current?.admission === 'signed-out' ? (
        <Button render={<a href={`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`} />}>
          {m.realm_claim_sign_in()}
        </Button>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {mayRequestRealmClaim(state) ? (
          <Button disabled={!ready} onClick={() => void control.submit()}>
            {m.realm_claim_request()}
          </Button>
        ) : null}
        {mayRetryRealmClaim(state) ? (
          <Button disabled={!ready} onClick={() => void control.retry()}>
            {m.realm_claim_retry()}
          </Button>
        ) : null}
        {state.reviewed && (state.outcome === 'conflict' || state.outcome === 'refused') ? (
          <Button variant="outline" disabled={state.busy} onClick={() => control.review()}>
            {m.realm_claim_review_current()}
          </Button>
        ) : null}
        <Button variant="outline" disabled={state.busy} onClick={() => void control.refresh()}>
          {state.busy ? m.realm_claim_working() : m.realm_claim_refresh()}
        </Button>
      </div>
    </section>
  );
}
