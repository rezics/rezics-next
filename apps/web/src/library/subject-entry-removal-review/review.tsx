import { useId, useLayoutEffect, useRef } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { SlotLifetime } from '../subject-library-current-origin';
import type { SubjectReference } from '../subject-ref';
import type { SubjectSlotEntry } from '../subject-slot';
import {
  captureEntryStateBasis,
  entryStateBasisMatches,
  type EntryStateBasis,
} from '../subject-entry-state-review/review';

export type ReviewedEntryRemoval = {
  subjectId: string;
  subjectLabel: string;
  basis: Exclude<EntryStateBasis, null>;
  stateLabel: string;
  originKey: string;
  lifetime: SlotLifetime;
};

export function captureEntryRemovalReview(input: {
  subject: SubjectReference;
  entry: SubjectSlotEntry | null;
  stateLabel: string;
  originKey: string;
  lifetime: SlotLifetime;
}): ReviewedEntryRemoval | null {
  const basis = captureEntryStateBasis(input.entry);
  if (!basis || basis.subjectId !== input.subject.id) return null;
  return {
    subjectId: input.subject.id,
    subjectLabel: input.subject.label,
    basis,
    stateLabel: input.stateLabel,
    originKey: input.originKey,
    lifetime: input.lifetime,
  };
}

export function entryRemovalReviewMatches(
  review: ReviewedEntryRemoval,
  input: {
    subject: SubjectReference;
    entry: SubjectSlotEntry | null;
    originKey: string;
    lifetime: SlotLifetime;
  },
): boolean {
  return (
    review.subjectId === input.subject.id &&
    review.subjectLabel === input.subject.label &&
    review.originKey === input.originKey &&
    review.lifetime === input.lifetime &&
    review.lifetime.current('library_entry.get', 'library_entry.delete') &&
    entryStateBasisMatches(review.basis, input.entry)
  );
}

const primaryClass = buttonVariants({ variant: 'default' });
const secondaryClass = buttonVariants({ variant: 'outline' });
const focusClass = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export function SubjectEntryRemovalReview({
  review,
  valid,
  busy,
  onConfirm,
  onKeep,
}: {
  review: ReviewedEntryRemoval;
  valid: boolean;
  busy: boolean;
  onConfirm: (review: ReviewedEntryRemoval) => void;
  onKeep: () => void;
}) {
  const headingId = useId();
  const descriptionId = useId();
  const heading = useRef<HTMLHeadingElement | null>(null);

  useLayoutEffect(() => {
    heading.current?.focus();
  }, [review]);

  return (
    <section
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      data-entry-removal-review
      className="min-w-0 max-w-2xl basis-full rounded-md border border-border p-3 [overflow-wrap:anywhere]"
    >
      <h3 ref={heading} id={headingId} tabIndex={-1} className="m-0 text-sm font-semibold">
        {m.library_entry_removal_heading()}
      </h3>
      <p id={descriptionId} className="mt-2 mb-0 text-sm text-muted-foreground">
        {m.library_entry_removal_scope()}
      </p>
      <dl className="mt-3 grid min-w-0 gap-x-4 gap-y-2 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
        <dt className="font-medium text-muted-foreground">{m.library_entry_review_subject()}</dt>
        <dd className="m-0 min-w-0 whitespace-normal break-words [overflow-wrap:anywhere]">
          {review.subjectLabel || m.library_subject_unavailable()}
        </dd>
        <dt className="font-medium text-muted-foreground">{m.library_entry_review_received()}</dt>
        <dd className="m-0 min-w-0 whitespace-normal break-words [overflow-wrap:anywhere]">{review.stateLabel}</dd>
      </dl>
      {!valid ? (
        <p role="status" aria-live="polite" className="mt-3 mb-0 text-sm">
          {m.library_entry_removal_changed()}
        </p>
      ) : null}
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
        <button
          type="button"
          className={`${primaryClass} min-h-[44px] max-w-full whitespace-normal ${focusClass}`}
          disabled={!valid || busy}
          onClick={() => onConfirm(review)}
        >
          {m.library_subject_remove()}
        </button>
        <button
          type="button"
          className={`${secondaryClass} min-h-[44px] max-w-full whitespace-normal ${focusClass}`}
          onClick={onKeep}
        >
          {m.library_entry_removal_keep()}
        </button>
      </div>
    </section>
  );
}
