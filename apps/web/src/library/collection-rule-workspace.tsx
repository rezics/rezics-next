import type { ReactNode } from 'react';

/** Arrange rule editing, its command, and the read-only meaning review as one workspace. */
export function CollectionRuleWorkspace({
  context,
  editing,
  meaningReview,
  commandActions,
  references,
}: {
  context: ReactNode;
  editing: ReactNode;
  meaningReview: ReactNode;
  commandActions: ReactNode;
  references: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-4">
      {context}
      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(18rem,0.9fr)]">
        <div className="min-w-0 space-y-4 lg:col-start-1 lg:row-start-1">{editing}</div>
        <div className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">{meaningReview}</div>
        <div className="min-w-0 space-y-4 lg:col-start-1 lg:row-start-2">{commandActions}</div>
      </div>
      {references}
    </div>
  );
}
