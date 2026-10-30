import { useMemo, useRef } from 'react';
import { useSession } from '../session/query';
import { readOwnRealmClaimStatus } from './space-actions';
import { RealmClaimStatusView } from './realm-claim-status-page';
import type { RealmClaimStatusAdapter, RealmClaimStatusRead } from './realm-claim-status';

const unavailable: RealmClaimStatusRead = { kind: 'unavailable' };
const signedOut: RealmClaimStatusRead = { kind: 'signed-out' };

/** Private data starts only after hydration of the real current session, including after account changes. */
export function RealmClaimStatusPanel({ realmId, requestId }: { realmId: string; requestId: string }) {
  const session = useSession();
  const latest = useRef(session);
  latest.current = session;
  const adapter = useMemo<RealmClaimStatusAdapter>(
    () => ({
      read: (data) =>
        latest.current.state === 'signed-in' ? readOwnRealmClaimStatus({ data }) : Promise.resolve(signedOut),
    }),
    [],
  );
  return (
    <RealmClaimStatusView
      key={`${realmId}:${requestId}:${session.subject ?? session.state}`}
      realmId={realmId}
      requestId={requestId}
      adapter={adapter}
      initial={session.state === 'signed-out' ? signedOut : unavailable}
      load={session.state === 'signed-in'}
    />
  );
}
