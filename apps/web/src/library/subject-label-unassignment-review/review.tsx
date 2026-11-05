import { buttonVariants } from '@rezics/ui/shadcn/button';
import { useId, type Ref } from 'react';
import { m } from '../../paraglide/messages.js';
import type { SlotLifetime } from '../subject-library-current-origin';
import type { SubjectReference } from '../subject-ref';
import type { SubjectLabel } from '../subject-labels.ts';

const primaryClass = buttonVariants({ variant: 'default' });
const secondaryClass = buttonVariants({ variant: 'outline' });
const focusClass = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export type SubjectLabelReviewBasis = {
  subjectId: string;
  assignmentId: string;
  labelId: string;
  revision: number;
};

/** Private, one-assignment display evidence. The Label name is presentation, never identity. */
export type ReviewedSubjectLabel = SubjectLabelReviewBasis & {
  subjectLabel: string;
  labelName: string;
  locale: string;
  originKey: string;
  lifetime: SlotLifetime;
};

export function captureSubjectLabelReview(
  subject: SubjectReference,
  locale: string,
  assignment: SubjectLabel,
  originKey: string,
  lifetime: SlotLifetime,
): ReviewedSubjectLabel {
  return {
    subjectId: subject.id,
    assignmentId: assignment.id,
    labelId: assignment.labelId,
    revision: assignment.revision,
    subjectLabel: subject.label,
    labelName: assignment.name,
    locale,
    originKey,
    lifetime,
  };
}

/** A confirmation is valid only for the same received relationship and exact private read lifetime. */
export function subjectLabelReviewIsCurrent(
  review: ReviewedSubjectLabel,
  input: {
    subject: SubjectReference;
    locale: string;
    assignments: readonly SubjectLabel[] | null;
    originKey: string;
    lifetime: SlotLifetime;
  },
): boolean {
  return (
    review.subjectId === input.subject.id &&
    review.locale === input.locale &&
    review.originKey === input.originKey &&
    review.lifetime === input.lifetime &&
    input.lifetime.current('library_label.assignment_list', 'library_label.unassign') &&
    !!input.assignments?.some(
      (assignment) =>
        assignment.id === review.assignmentId &&
        assignment.labelId === review.labelId &&
        assignment.revision === review.revision,
    )
  );
}

export function SubjectLabelUnassignmentReview({
  review,
  canConfirm,
  actionRef,
  onConfirm,
  onCancel,
}: {
  review: ReviewedSubjectLabel | null;
  canConfirm: boolean;
  actionRef?: Ref<HTMLButtonElement>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const headingId = useId();
  if (!review) return null;
  return (
    <section
      aria-labelledby={headingId}
      data-subject-label-review-card
      className="min-w-0 max-w-2xl basis-full rounded-md border border-border p-3 [overflow-wrap:anywhere]"
    >
      <h3 id={headingId} className="m-0 text-sm font-semibold">
        {m.library_subject_label_review_heading()}
      </h3>
      <p className="mt-2 mb-0 min-w-0 break-words text-sm [overflow-wrap:anywhere]">
        {m.library_subject_label_review_relationship({ name: review.labelName, subject: review.subjectLabel })}
      </p>
      <p className="mt-2 mb-0 text-sm text-muted-foreground">{m.library_subject_label_review_effect()}</p>
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
        <button
          type="button"
          data-subject-label-review-confirm
          ref={actionRef}
          disabled={!canConfirm}
          className={`${primaryClass} min-h-[44px] max-w-full whitespace-normal ${focusClass}`}
          onClick={() => {
            if (canConfirm) onConfirm();
          }}
        >
          {m.library_subject_label_review_remove()}
        </button>
        <button
          type="button"
          data-subject-label-review-cancel
          className={`${secondaryClass} min-h-[44px] max-w-full whitespace-normal ${focusClass}`}
          onClick={onCancel}
        >
          {m.library_subject_label_review_keep()}
        </button>
      </div>
    </section>
  );
}
