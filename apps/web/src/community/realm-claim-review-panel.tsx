import { useMemo, useRef } from 'react';
import { useSession } from '../session/query';
import { RealmClaimReviewView } from './realm-claim-review-page';
import { readRealmClaimReviewPage, submitRealmClaimApproval } from './realm-claim-review-actions';
import type { RealmClaimReviewAdapter, RealmClaimReviewRead } from './realm-claim-review';

export function RealmClaimReviewPanel({ realmId, initial }: { realmId: string; initial: RealmClaimReviewRead }) {
  const session = useSession();
  const current = useRef(session);
  current.current = session;
  const adapter = useMemo<RealmClaimReviewAdapter>(
    () => ({
      read: (data) => readRealmClaimReviewPage({ data }),
      approve: (data) =>
        current.current.state === 'signed-in' && current.current.csrfToken
          ? submitRealmClaimApproval({ data, headers: { 'X-CSRF-Token': current.current.csrfToken } })
          : Promise.resolve({ kind: 'signed-out' }),
    }),
    [],
  );
  return (
    <RealmClaimReviewView
      key={`${realmId}:${session.subject ?? session.state}`}
      realmId={realmId}
      initial={initial}
      adapter={adapter}
      ready={session.state === 'signed-in' && !!session.csrfToken}
    />
  );
}
