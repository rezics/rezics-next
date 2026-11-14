import { useEffect, useId, useRef } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { MyRealmsCurrentController } from './contract';

/** Deliberate review of one frozen Account/Realm membership episode. */
export function MyRealmsLeaveReview({
  controller,
  onDismiss,
}: {
  controller: MyRealmsCurrentController;
  onDismiss?: (() => void) | undefined;
}) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const selected = controller.review?.row;
  useEffect(() => {
    if (selected) heading.current?.focus();
  }, [selected]);
  const dismiss = (action: () => void) => {
    action();
    onDismiss?.();
  };
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
      aria-labelledby={headingId}
      aria-busy={review.phase === 'submitting' || review.standing === 'loading'}
      className="min-w-0 space-y-4 rounded-xl border border-border bg-muted/40 p-4 [overflow-wrap:anywhere] sm:p-6 [&_button]:h-auto [&_button]:min-h-11 [&_button]:max-w-full [&_button]:whitespace-normal"
      data-slot="my-realms-leave-review"
      data-phase={review.phase}
      data-workflow-id={review.workflowId}
    >
      <h2
        id={headingId}
        ref={heading}
        tabIndex={-1}
        className="text-xl font-semibold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      >
        {m.my_realms_leave_review()}
      </h2>
      <p className="max-w-prose leading-relaxed">{m.my_realms_leave_confirm({ realm: review.row.name })}</p>
      <p role="status">{status}</p>
      {review.phase === 'pending' || review.phase === 'submitting' ? (
        <p className="text-sm text-muted-foreground">
          {m.my_realms_standing_label()}: {standing}
        </p>
      ) : null}
      {review.phase === 'review' ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="destructive" disabled={!controller.ready} onClick={controller.confirm}>
            {m.my_realms_leave_confirm_button()}
          </Button>
          <Button type="button" variant="outline" onClick={() => dismiss(controller.cancel)}>
            {m.action_cancel()}
          </Button>
        </div>
      ) : null}
      {review.phase === 'uncertain' && review.retryAllowed ? (
        <div className="flex flex-wrap gap-2">
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
