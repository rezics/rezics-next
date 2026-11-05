import { buttonVariants } from '@rezics/ui/shadcn/button';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import type { SubjectLabelReview } from './choice';

const actionClass = `${buttonVariants({ variant: 'outline' })} h-auto min-h-[44px] min-w-0 max-w-full whitespace-normal py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`;

export function SubjectLabelAssignmentReview({
  review,
  subjectName,
  alreadyAssigned,
  applyAction,
  onEdit,
  onDiscard,
}: {
  review: SubjectLabelReview;
  subjectName: string;
  alreadyAssigned: boolean;
  applyAction: ReactNode;
  onEdit: () => void;
  onDiscard: () => void;
}) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const choiceName = review.choice.kind === 'existing' ? review.choice.label.name : review.choice.name;

  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <section
      data-subject-label-review
      data-choice-kind={review.choice.kind}
      role="region"
      aria-labelledby={titleId}
      className="mt-2 grid min-w-0 gap-3 rounded-lg border bg-background p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
    >
      <div className="min-w-0 space-y-2">
        <h3 id={titleId} ref={heading} tabIndex={-1} className="text-sm font-semibold focus:outline-none">
          {m.library_subject_label_review_heading()}
        </h3>
        <p className="text-sm text-muted-foreground">{m.library_subject_label_review_subject({ name: subjectName })}</p>
        <p className="min-w-0 break-words text-sm font-medium" data-subject-label-review-name>
          {review.choice.kind === 'existing'
            ? m.library_subject_label_review_existing({ name: choiceName })
            : m.library_subject_label_review_proposed({ name: choiceName })}
        </p>
        {review.choice.kind === 'proposed' ? (
          <p className="text-sm text-muted-foreground">{m.library_subject_label_review_proposal_note()}</p>
        ) : (
          <p className="text-sm text-muted-foreground">{m.library_subject_label_review_existing_note()}</p>
        )}
        {alreadyAssigned ? (
          <p role="status" className="text-sm text-muted-foreground">
            {m.library_subject_label_review_already_assigned()}
          </p>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap gap-2 sm:justify-end">
        {!alreadyAssigned ? (
          applyAction
        ) : null}
        <button type="button" className={actionClass} onClick={onEdit} data-subject-label-review-edit>
          {m.library_subject_label_review_edit()}
        </button>
        <button type="button" className={actionClass} onClick={onDiscard} data-subject-label-review-discard>
          {m.library_subject_label_review_discard()}
        </button>
      </div>
    </section>
  );
}
