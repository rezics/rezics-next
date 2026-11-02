import { useMemo } from 'react';
import { useRealmClaimCaller } from './realm-claim-caller-lifetime';
import { readRealmClaimState, readOwnRealmClaimStatus, submitRealmClaim } from './space-actions';
import { RealmClaimControls } from './realm-claim-controls';
import type { RealmClaimAdapter, RealmClaimRead, RealmClaimSnapshot } from './realm-claim';

/** Session identity never supplies authority; the participation endpoint decides admission. */
export function RealmClaimPanel({
  realmId,
  initial,
  returnTo,
  adapter,
  onRead,
}: {
  realmId: string;
  initial?: RealmClaimSnapshot | null;
  returnTo: string;
  adapter?: RealmClaimAdapter;
  onRead: (read: RealmClaimRead) => void;
}) {
  const { session, ready, lifetime, connectionRevision } = useRealmClaimCaller(realmId);
  const native = useMemo<RealmClaimAdapter>(
    () => ({
      read: (target) =>
        lifetime.current() && target === realmId
          ? readRealmClaimState({
              data: {
                realmId,
                credentialMode: 'session',
              },
            })
          : Promise.resolve({ kind: 'unavailable' }),
      request: (data) =>
        lifetime.current() && data.realmId === realmId && session.csrfToken
          ? submitRealmClaim({ data, headers: { 'X-CSRF-Token': session.csrfToken } })
          : Promise.resolve({ kind: 'signed-out' }),
      mine: (target) =>
        lifetime.current() && target === realmId
          ? readOwnRealmClaimStatus({ data: { realmId } })
          : Promise.resolve({ kind: 'signed-out' }),
    }),
    [realmId, lifetime, session.csrfToken],
  );
  const first: RealmClaimRead = initial
    ? { kind: 'ready', snapshot: initial, admission: session.state === 'signed-out' ? 'signed-out' : 'unavailable' }
    : { kind: 'unavailable' };
  return (
    <RealmClaimControls
      key={lifetime.id}
      realmId={realmId}
      initial={first}
      returnTo={returnTo}
      adapter={adapter ?? native}
      ready={ready}
      load={ready}
      lifetime={lifetime}
      connectionRevision={connectionRevision}
      onRead={onRead}
      recoveryOnly
    />
  );
}
