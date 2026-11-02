import { useEffect, useId, useMemo, useSyncExternalStore } from 'react';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale, localizeHref } from '../paraglide/runtime.js';
import { createRealmClaimStatus, type RealmClaimStatusAdapter, type RealmClaimStatusRead } from './realm-claim-status';
import type { RealmClaimCallerLifetime } from './realm-claim-caller-lifetime';

function NativeDate({ value }: { value: string }) {
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

export function RealmClaimStatusView({
  realmId,
  requestId,
  initial,
  adapter,
  load = false,
  ready = true,
  lifetime,
  connectionRevision = 0,
}: {
  realmId: string;
  requestId: string;
  initial: RealmClaimStatusRead;
  adapter: RealmClaimStatusAdapter;
  load?: boolean;
  ready?: boolean;
  lifetime?: RealmClaimCallerLifetime;
  connectionRevision?: number;
}) {
  const id = useId();
  const control = useMemo(
    () => createRealmClaimStatus({ realmId, requestId }, initial, adapter, lifetime),
    [realmId, requestId, adapter, lifetime],
  );
  const snapshot = useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot);
  useEffect(() => {
    control.reconnect();
    control.observe(initial);
    return () => control.disconnect();
  }, [control, initial]);
  useEffect(() => {
    if (load || (lifetime && connectionRevision > 0)) {
      const ticket = lifetime?.ticket();
      queueMicrotask(() => {
        if (lifetime && ticket !== undefined && !lifetime.owns(ticket)) return;
        void control.refresh();
      });
    }
  }, [control, load, lifetime, connectionRevision]);
  const active = ready && (!lifetime || lifetime.current());
  const state = active
    ? snapshot
    : { read: initial.kind === 'signed-out' ? initial : { kind: 'unavailable' as const }, busy: false };
  const receipt = state.read.kind === 'ready' ? state.read.claimRequest : null;
  return (
    <article
      className="mx-auto min-w-0 w-full max-w-3xl space-y-7 px-4 py-8 [overflow-wrap:anywhere] sm:px-6"
      aria-labelledby={`${id}-heading`}
    >
      <a
        className="inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm py-2 text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        href={localizeHref(`/realms/${realmId}`)}
      >
        {m.realm_claim_status_back()}
      </a>
      <header className="space-y-3">
        <p className="text-sm text-muted-foreground">{m.realm_claim_heading()}</p>
        <h1 id={`${id}-heading`} className="text-3xl font-semibold tracking-tight">
          {m.realm_claim_status_heading()}
        </h1>
        <p className="text-sm leading-7 text-muted-foreground">{m.realm_claim_status_authority()}</p>
      </header>
      <section className="space-y-5" aria-busy={state.busy}>
        {receipt ? (
          <ContentItemFrame as="article" aria-labelledby={`${id}-case`} className="min-w-0 space-y-5 p-5 sm:p-6">
            <ContentItemHeading level={2} id={`${id}-case`} className="text-xl font-semibold">
              {receipt.state === 'approved' ? m.realm_claim_status_approved() : m.realm_claim_pending()}
            </ContentItemHeading>
            <p className="text-sm leading-7">
              {receipt.state === 'approved'
                ? m.realm_claim_status_approved_help()
                : receipt.currentEpisode
                  ? m.realm_claim_review_help()
                  : m.realm_claim_status_old_pending()}
            </p>
            {!receipt.currentEpisode ? (
              <p className="text-sm text-muted-foreground">{m.realm_claim_status_old_episode()}</p>
            ) : null}
            <dl className="space-y-4 border-t pt-5 text-sm">
              <div className="space-y-1">
                <dt className="text-muted-foreground">{m.realm_claim_orphaned_at()}</dt>
                <dd>
                  <NativeDate value={receipt.orphanedAt} />
                </dd>
              </div>
              <div className="space-y-1">
                <dt className="text-muted-foreground">{m.realm_claim_requested_at()}</dt>
                <dd>
                  <NativeDate value={receipt.requestedAt} />
                </dd>
              </div>
              {receipt.approvedAt ? (
                <div className="space-y-1">
                  <dt className="text-muted-foreground">{m.realm_claim_status_approved_at()}</dt>
                  <dd>
                    <NativeDate value={receipt.approvedAt} />
                  </dd>
                </div>
              ) : null}
            </dl>
            <details className="min-w-0 border-t pt-2 text-sm">
              <summary className="min-h-11 cursor-pointer rounded-sm py-3 font-medium focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
                {m.realm_status_details_reference()}
              </summary>
              <dl className="min-w-0 space-y-1 pb-2 pt-3">
                <dt className="text-muted-foreground">{m.realm_claim_reference()}</dt>
                <dd dir="ltr" className="select-all break-all font-mono">
                  {receipt.requestId}
                </dd>
              </dl>
            </details>
          </ContentItemFrame>
        ) : (
          <p role="status" className="text-sm leading-7">
            {state.busy
              ? m.realm_claim_status_checking()
              : state.read.kind === 'signed-out'
                ? m.realm_claim_status_signed_out()
                : state.read.kind === 'denied'
                  ? m.realm_claim_status_denied()
                  : state.read.kind === 'closed'
                    ? m.realm_claim_status_closed()
                    : m.realm_claim_status_unavailable()}
          </p>
        )}
        <Button
          variant="outline"
          className="min-h-11 min-w-11 max-w-full whitespace-normal text-start"
          disabled={!active || state.busy}
          onClick={() => void control.refresh()}
        >
          {state.busy ? m.realm_claim_status_checking() : m.realm_claim_status_check_again()}
        </Button>
      </section>
    </article>
  );
}
