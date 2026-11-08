import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { MyRealmsCurrentController } from './contract';

/** Deliberate review of one frozen Account/Realm membership episode. */
export function MyRealmsLeaveReview({ controller }: { controller: MyRealmsCurrentController }) {
  const review = controller.review;
  if (!review) return null;

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
      aria-label={m.my_realms_leave_review()}
      aria-busy={review.phase === 'submitting' || review.standing === 'loading'}
      className="mt-3 space-y-3 rounded-xl border border-border bg-muted/40 p-4"
      data-slot="my-realms-leave-review"
      data-phase={review.phase}
      data-workflow-id={review.workflowId}
    >
      <h3 className="font-semibold">{m.my_realms_leave_review()}</h3>
      <p>{m.my_realms_leave_confirm({ realm: review.row.name })}</p>
      <p role="status">{status}</p>
      {review.phase === 'pending' || review.phase === 'submitting' ? (
        <p className="text-sm text-muted-foreground">
          {m.my_realms_standing_label()}: {standing}
        </p>
      ) : null}
      {review.phase === 'review' ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={!controller.ready} onClick={controller.confirm}>
            {m.my_realms_leave_confirm_button()}
          </Button>
          <Button type="button" variant="outline" onClick={controller.cancel}>
            {m.action_cancel()}
          </Button>
        </div>
      ) : null}
      {review.phase === 'uncertain' && review.retryAllowed ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={!controller.ready} onClick={controller.retry}>
            {m.realm_leave_retry_same()}
          </Button>
          <Button type="button" variant="outline" onClick={controller.discard}>
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
        <Button type="button" variant="outline" onClick={controller.discard}>
          {m.realm_membership_command_discard()}
        </Button>
      ) : null}
    </section>
  );
}
