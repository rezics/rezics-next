import { useMemo } from 'react';
import { useRealmClaimCaller } from './realm-claim-caller-lifetime';
import { readOwnRealmClaimStatus } from './space-actions';
import { RealmClaimStatusView } from './realm-claim-status-page';
import type { RealmClaimStatusAdapter, RealmClaimStatusRead } from './realm-claim-status';

const unavailable: RealmClaimStatusRead = { kind: 'unavailable' };
const signedOut: RealmClaimStatusRead = { kind: 'signed-out' };

/** The historical own-request read stays bound to the session and target that admitted it. */
export function RealmClaimStatusPanel({ realmId, requestId }: { realmId: string; requestId: string }) {
  const caller = useRealmClaimCaller(realmId, requestId);
  const { lifetime, ready, session, connectionRevision } = caller;
  const adapter = useMemo<RealmClaimStatusAdapter>(
    () => ({
      read: async (data) => {
        if (!lifetime.current() || data.realmId !== realmId || data.requestId !== requestId)
          return { kind: 'signed-out' };
        const ticket = lifetime.ticket();
        const result = await readOwnRealmClaimStatus({ data });
        return lifetime.owns(ticket) ? result : { kind: 'signed-out' };
      },
    }),
    [realmId, requestId, lifetime, session.subject, session.csrfToken],
  );
  return (
    <RealmClaimStatusView
      key={lifetime.id}
      realmId={realmId}
      requestId={requestId}
      adapter={adapter}
      initial={ready ? unavailable : session.state === 'signed-out' ? signedOut : unavailable}
      load={ready}
      ready={ready}
      lifetime={lifetime}
      connectionRevision={connectionRevision}
    />
  );
}
