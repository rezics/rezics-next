import { buttonVariants } from '@rezics/ui/shadcn/button';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import type { SubjectLabelReview } from './choice';
import { LabelRelationship } from './relationship';

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
  const effectId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const existing = review.choice.kind === 'existing';
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
      aria-describedby={effectId}
      className="mt-3 grid min-w-0 gap-4 rounded-xl border bg-muted/20 p-4 sm:p-5"
    >
      <h3
        id={titleId}
        ref={heading}
        tabIndex={-1}
        className="rounded-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {m.library_subject_label_review_heading()}
      </h3>
      <LabelRelationship
        subjectName={subjectName}
        labelName={choiceName}
        labelDescription={
          existing
            ? m.library_subject_label_review_existing({ name: choiceName })
            : m.library_subject_label_review_proposed({ name: choiceName })
        }
      />
      <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div id={effectId} className="min-w-0 space-y-2 text-sm text-muted-foreground">
          <p>{m.library_labels_assignment_effect()}</p>
          {!existing ? <p>{m.library_subject_label_review_proposal_note()}</p> : null}
          {alreadyAssigned ? <p role="status">{m.library_subject_label_review_already_assigned()}</p> : null}
        </div>
        <div className="flex min-w-0 flex-wrap gap-2 sm:justify-end">
          {!alreadyAssigned ? applyAction : null}
          <button type="button" className={actionClass} onClick={onEdit} data-subject-label-review-edit>
            {m.library_subject_label_review_edit()}
          </button>
          <button type="button" className={actionClass} onClick={onDiscard} data-subject-label-review-discard>
            {m.library_subject_label_review_discard()}
          </button>
        </div>
      </div>
    </section>
  );
}
