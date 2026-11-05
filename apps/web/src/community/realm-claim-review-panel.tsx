import { useEffect, useMemo, useRef } from 'react';
import { useRealmClaimCaller } from './realm-claim-caller-lifetime';
import { RealmClaimReviewView } from './realm-claim-review-page';
import { readRealmClaimReviewPage, submitRealmClaimApproval } from './realm-claim-review-actions';
import { realmClaimReviewPage, type RealmClaimReviewAdapter, type RealmClaimReviewRead } from './realm-claim-review';

const unavailable: RealmClaimReviewRead = { kind: 'unavailable' };

type Visit = {
  lifetime: ReturnType<typeof useRealmClaimCaller>['lifetime'];
  sourceInitial: RealmClaimReviewRead;
  initial: RealmClaimReviewRead;
  seeded: boolean;
};

const consumedInitials = new WeakSet<object>();

/** Loader pages are one-use data, tied to the session cache generation that read them. */
function initialForCurrentCaller(
  initial: RealmClaimReviewRead,
  realmId: string,
  sessionSourceId: number | undefined,
  sessionSubject: string | undefined,
  sessionDataUpdateCount: number | undefined,
  sessionDataUpdatedAt: number | undefined,
  ready: boolean,
  hydrated: boolean,
) {
  if (!ready) return undefined;
  if (consumedInitials.has(initial)) return undefined;
  const exactSourceMatches =
    initial.callerRealmId === realmId &&
    sessionSourceId !== undefined &&
    initial.callerSessionSourceId === sessionSourceId &&
    sessionDataUpdateCount !== undefined &&
    initial.callerSessionDataUpdateCount === sessionDataUpdateCount &&
    initial.callerSessionSubject === sessionSubject &&
    initial.callerSessionDataUpdatedAt === sessionDataUpdatedAt;
  const hydrationTransferMatches =
    !hydrated &&
    initial.callerRealmId === realmId &&
    initial.callerSessionSourceId === undefined &&
    typeof sessionSubject === 'string' &&
    initial.callerSessionSubject === sessionSubject &&
    sessionDataUpdateCount !== undefined &&
    initial.callerSessionDataUpdateCount === sessionDataUpdateCount &&
    sessionDataUpdatedAt !== undefined &&
    initial.callerSessionDataUpdatedAt === sessionDataUpdatedAt;
  if (!exactSourceMatches && !hydrationTransferMatches) return undefined;
  if (initial.kind !== 'ready') return { kind: initial.kind } satisfies RealmClaimReviewRead;
  if (!realmClaimReviewPage(initial.page, realmId)) return { kind: 'unavailable' } satisfies RealmClaimReviewRead;
  return { kind: 'ready', page: initial.page } satisfies RealmClaimReviewRead;
}

/** The loader read is display data only; the original current session admits every later caller action. */
export function RealmClaimReviewPanel({ realmId, initial }: { realmId: string; initial: RealmClaimReviewRead }) {
  const caller = useRealmClaimCaller(realmId, undefined, initial);
  const visitRef = useRef<Visit | null>(null);
  let visit = visitRef.current;
  if (!visit || visit.lifetime !== caller.lifetime || visit.sourceInitial !== initial) {
    const seeded = initialForCurrentCaller(
      initial,
      realmId,
      caller.source?.id,
      caller.session.subject ?? undefined,
      caller.source?.dataUpdateCount(),
      caller.source?.dataUpdatedAt(),
      caller.ready,
      caller.hydrated,
    );
    visit = {
      lifetime: caller.lifetime,
      sourceInitial: initial,
      initial: seeded ?? unavailable,
      seeded: !!seeded,
    };
    visitRef.current = visit;
  }

  const { lifetime, initial: page, seeded } = visit;
  const { session, ready, connectionRevision } = caller;
  useEffect(() => {
    if (ready) consumedInitials.add(initial);
  }, [initial, ready]);
  const adapter = useMemo<RealmClaimReviewAdapter>(() => {
    const originalCsrfToken = session.csrfToken;
    return {
      read: async (data) => {
        if (!lifetime.current() || data.realmId !== realmId) return { kind: 'signed-out' };
        const ticket = lifetime.ticket();
        const result = await readRealmClaimReviewPage({ data });
        return lifetime.owns(ticket) ? result : { kind: 'signed-out' };
      },
      approve: async (data) => {
        if (!lifetime.current() || !originalCsrfToken || data.realmId !== realmId) return { kind: 'signed-out' };
        const ticket = lifetime.ticket();
        const result = await submitRealmClaimApproval({
          data,
          headers: { 'X-CSRF-Token': originalCsrfToken },
        });
        return lifetime.owns(ticket) ? result : { kind: 'signed-out' };
      },
    };
  }, [realmId, lifetime, session.csrfToken]);

  return (
    <RealmClaimReviewView
      key={lifetime.id}
      realmId={realmId}
      initial={page}
      adapter={adapter}
      ready={ready}
      load={ready && !seeded}
      lifetime={lifetime}
      connectionRevision={connectionRevision}
    />
  );
}
