import { useId } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { MyRealmsCurrentController } from './contract';

/** Deliberate review of one frozen Account/Realm membership episode. */
export function MyRealmsLeaveReview({
  controller,
  onDismiss,
  id,
}: {
  controller: MyRealmsCurrentController;
  id?: string | undefined;
  onDismiss?: (() => void) | undefined;
}) {
  const headingId = useId();
  const promptId = useId();
  const standingId = useId();
  const dismiss = (action: () => void) => {
    action();
    onDismiss?.();
  };
  const review = controller.review;
  if (!review) return null;
  const showStanding = review.phase === 'pending' || review.phase === 'submitting';

  const status =
    review.phase === 'uncertain'
      ? m.realm_leave_uncertain()
      : review.phase === 'refused'
        ? review.ownerReason === 'last-owner'
          ? m.realm_leave_owner_required()
          : m.realm_leave_refused()
        : review.phase === 'blocked'
          ? m.my_realms_leave_blocked()
          : review.phase === 'pending' || review.phase === 'submitting'
            ? m.realm_membership_checking()
            : m.my_realms_leave_review();

  const standing =
    review.standing === 'member'
      ? m.realm_members_current()
      : review.standing === 'none'
        ? m.my_realms_standing_none()
        : review.standing === 'pending'
          ? m.realm_members_pending()
          : review.standing === 'banned'
            ? m.my_realms_standing_unavailable()
            : review.standing === 'unavailable'
              ? m.realm_membership_unavailable()
              : m.realm_membership_loading();

  return (
    <section
      id={id}
      aria-labelledby={headingId}
      aria-describedby={showStanding ? `${promptId} ${standingId}` : promptId}
      aria-busy={review.phase === 'submitting' || review.standing === 'loading'}
      className="min-w-0 space-y-3 ps-3 [overflow-wrap:anywhere] [&_button]:h-auto [&_button]:max-w-full [&_button]:text-start [&_button]:whitespace-normal"
      data-slot="my-realms-leave-review"
      data-phase={review.phase}
      data-workflow-id={review.workflowId}
    >
      <h3 id={headingId} className="text-base font-semibold leading-snug">
        {m.my_realms_leave_review()}
      </h3>
      <p id={promptId} className="max-w-prose leading-relaxed">
        {m.my_realms_leave_confirm({ realm: review.row.name })}
      </p>
      <p role="status">{status}</p>
      {showStanding ? (
        <p id={standingId} className="text-sm text-muted-foreground">
          {m.my_realms_standing_label()}: {standing}
        </p>
      ) : null}
      {review.phase === 'review' ? (
        <div className="flex min-w-0 flex-wrap gap-2">
          <Button type="button" variant="destructive" disabled={!controller.ready} onClick={controller.confirm}>
            {m.my_realms_leave_confirm_button()}
          </Button>
          <Button type="button" variant="outline" onClick={() => dismiss(controller.cancel)}>
            {m.action_cancel()}
          </Button>
        </div>
      ) : null}
      {review.phase === 'uncertain' && review.retryAllowed ? (
        <div className="flex min-w-0 flex-wrap gap-2">
          <Button type="button" disabled={!controller.ready} onClick={controller.retry}>
            {m.realm_leave_retry_same()}
          </Button>
          <Button type="button" variant="outline" onClick={() => dismiss(controller.discard)}>
            {m.realm_membership_command_discard()}
          </Button>
        </div>
      ) : null}
      {review.phase === 'pending' ? (
        <Button type="button" variant="outline" disabled={!controller.ready} onClick={controller.refresh}>
          {m.realm_membership_retry()}
        </Button>
      ) : null}
      {review.phase === 'blocked' || review.phase === 'refused' ? (
        <Button type="button" variant="outline" onClick={() => dismiss(controller.discard)}>
          {m.realm_membership_command_discard()}
        </Button>
      ) : null}
    </section>
  );
}
