import { useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { ResourceAccessLink } from '../accounts/resource-access/link';
import { m } from '../paraglide/messages.js';
import type { RealmLeaveRecoveryState } from './realm-leave-recovery';

export type RealmLeaveCheck = 'checking' | 'unavailable' | 'unchanged' | null;

export function RealmLeaveRecovery({
  realmId,
  recovery,
  check,
  busy,
  ready,
  onCheck,
  onRetry,
}: {
  realmId: string;
  recovery: RealmLeaveRecoveryState;
  check: RealmLeaveCheck;
  busy: boolean;
  ready: boolean;
  onCheck: () => void;
  onRetry: () => void;
}) {
  const [reviewAccess, setReviewAccess] = useState(false);
  const refused = recovery.kind === 'refused';
  return (
    <section
      aria-label={m.realm_leave_recovery_label()}
      className="max-w-prose space-y-3 rounded-xl border bg-background p-4 text-foreground"
    >
      <p role="status" className="text-sm">
        {refused ? m.realm_leave_refused() : m.realm_leave_uncertain()}
      </p>
      {refused ? (
        <p className="text-sm">
          {recovery.ownerReason === 'last-owner' ? m.realm_leave_owner_required() : m.realm_leave_owner_policy()}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {refused && !reviewAccess ? (
          <Button type="button" variant="outline" onClick={() => setReviewAccess(true)}>
            {m.realm_leave_review_access()}
          </Button>
        ) : null}
        {refused && reviewAccess ? <ResourceAccessLink resourceId={realmId} /> : null}
        <Button type="button" variant="outline" disabled={busy} onClick={onCheck}>
          {m.realm_membership_retry()}
        </Button>
        {!refused ? (
          <Button type="button" variant="outline" disabled={busy || !ready} onClick={onRetry}>
            {m.realm_leave_retry_same()}
          </Button>
        ) : null}
      </div>
      {refused && reviewAccess ? <p className="text-sm">{m.realm_leave_access_note()}</p> : null}
      {refused ? <p className="text-sm">{m.realm_leave_check_before_retry()}</p> : null}
      {check ? (
        <p role="status" className="text-sm">
          {check === 'checking'
            ? m.realm_leave_checking()
            : check === 'unavailable'
              ? m.realm_leave_check_unavailable()
              : m.realm_leave_not_settled()}
        </p>
      ) : null}
    </section>
  );
}
