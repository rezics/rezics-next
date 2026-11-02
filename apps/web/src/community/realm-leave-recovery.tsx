import { useId, useState } from 'react';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { ListRowControl } from '@rezics/ui/list-row';
import { Button } from '@rezics/ui/shadcn/button';
import { ResourceAccessLink } from '../accounts/resource-access/link';
import { m } from '../paraglide/messages.js';
import type { RealmLeaveRecoveryState } from './realm-leave-recovery.ts';
export * from './realm-leave-recovery.ts';

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
  const headingId = useId();
  const [reviewAccess, setReviewAccess] = useState(false);
  const refused = recovery.kind === 'refused';
  return (
    <section aria-labelledby={headingId} className="min-w-0">
      <ContentItemFrame as="div" className="min-w-0 space-y-4 p-4 text-start [overflow-wrap:anywhere]">
        <ContentItemHeading id={headingId} className="text-lg leading-snug font-semibold sm:text-xl">
          {m.realm_leave_recovery_label()}
        </ContentItemHeading>
        <div data-content-item-slot="state" className="max-w-prose space-y-2 text-sm leading-relaxed">
          <p role="status">{refused ? m.realm_leave_refused() : m.realm_leave_uncertain()}</p>
          {refused ? (
            <p>
              {recovery.ownerReason === 'last-owner' ? m.realm_leave_owner_required() : m.realm_leave_owner_policy()}
            </p>
          ) : null}
          {refused ? <p>{m.realm_leave_check_before_retry()}</p> : null}
          {check ? (
            <p role="status">
              {check === 'checking'
                ? m.realm_leave_checking()
                : check === 'unavailable'
                  ? m.realm_leave_check_unavailable()
                  : m.realm_leave_not_settled()}
            </p>
          ) : null}
        </div>
        <ListRowControl
          data-content-item-slot="actions"
          className="flex min-w-0 flex-wrap items-center gap-3 [&_a]:h-auto [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:max-w-full [&_a]:whitespace-normal [&_a]:focus-visible:outline-2 [&_a]:focus-visible:outline-offset-2 [&_a]:focus-visible:outline-ring"
        >
          {refused && !reviewAccess ? (
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-11 min-w-11 max-w-full py-2 text-start whitespace-normal"
              onClick={() => setReviewAccess(true)}
            >
              {m.realm_leave_review_access()}
            </Button>
          ) : null}
          {refused && reviewAccess ? <ResourceAccessLink resourceId={realmId} /> : null}
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-11 min-w-11 max-w-full py-2 text-start whitespace-normal"
            disabled={busy}
            onClick={onCheck}
          >
            {m.realm_membership_retry()}
          </Button>
          {!refused ? (
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-11 min-w-11 max-w-full py-2 text-start whitespace-normal"
              disabled={busy || !ready}
              onClick={onRetry}
            >
              {m.realm_leave_retry_same()}
            </Button>
          ) : null}
        </ListRowControl>
        {refused && reviewAccess ? (
          <p className="max-w-prose text-sm leading-relaxed">{m.realm_leave_access_note()}</p>
        ) : null}
      </ContentItemFrame>
    </section>
  );
}
