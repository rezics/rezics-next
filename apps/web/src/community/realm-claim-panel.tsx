import { useMemo, useRef } from 'react';
import { useSession } from '../session/query';
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
  const session = useSession();
  const latest = useRef(session);
  latest.current = session;
  const native = useMemo<RealmClaimAdapter>(
    () => ({
      read: (realmId) =>
        readRealmClaimState({
          data: {
            realmId,
            credentialMode: latest.current.state === 'signed-in' ? 'session' : 'anonymous',
          },
        }),
      request: (data) =>
        latest.current.state === 'signed-in' && latest.current.csrfToken
          ? submitRealmClaim({ data, headers: { 'X-CSRF-Token': latest.current.csrfToken } })
          : Promise.resolve({ kind: 'signed-out' }),
      mine: (realmId) =>
        latest.current.state === 'signed-in'
          ? readOwnRealmClaimStatus({ data: { realmId } })
          : Promise.resolve({ kind: 'signed-out' }),
    }),
    [],
  );
  const first: RealmClaimRead = initial
    ? { kind: 'ready', snapshot: initial, admission: session.state === 'signed-out' ? 'signed-out' : 'unavailable' }
    : { kind: 'unavailable' };
  return (
    <RealmClaimControls
      key={`${realmId}:${session.subject ?? session.state}`}
      realmId={realmId}
      initial={first}
      returnTo={returnTo}
      adapter={adapter ?? native}
      ready={!!session.csrfToken || !!adapter}
      load={session.state !== 'unknown'}
      onRead={onRead}
    />
  );
}
