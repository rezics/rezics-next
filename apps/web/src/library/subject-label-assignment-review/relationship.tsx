import { TagIcon } from 'lucide-react';
import { m } from '../../paraglide/messages.js';

/** Presentation only: command identity and currentness stay with the originating review. */
export function LabelRelationship({
  subjectName,
  labelName,
  labelDescription,
}: {
  subjectName: string;
  labelName: string;
  labelDescription?: string;
}) {
  return (
    <dl className="min-w-0 divide-y rounded-lg border bg-background px-3" data-label-relationship>
      <div className="grid min-w-0 gap-1 py-3 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-3">
        <dt className="text-sm text-muted-foreground">{m.library_labels_review_subject()}</dt>
        <dd
          className="min-w-0 whitespace-pre-wrap break-words font-medium [overflow-wrap:anywhere]"
          dir="auto"
          data-label-review-subject
        >
          {subjectName}
        </dd>
      </div>
      <div className="grid min-w-0 gap-1 py-3 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-3">
        <dt className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <TagIcon aria-hidden="true" className="size-3.5 shrink-0" />
          {m.library_labels_review_label()}
        </dt>
        <dd className="min-w-0 space-y-1">
          <p
            className="whitespace-pre-wrap break-words font-medium [overflow-wrap:anywhere]"
            dir="auto"
            data-subject-label-review-name
          >
            {labelName}
          </p>
          {labelDescription ? <p className="text-sm text-muted-foreground">{labelDescription}</p> : null}
        </dd>
      </div>
    </dl>
  );
}
