import type { ReactNode } from 'react';

/** Presentation frame for the existing Collection draft, form, review and save controls. */
export function CollectionAuthoringWorkspace({
  editing,
  heading,
  memberCanvas,
  metadata,
  review,
  saveActions,
}: {
  editing: boolean;
  heading?: ReactNode;
  memberCanvas: ReactNode;
  metadata?: ReactNode;
  review?: ReactNode;
  saveActions?: ReactNode;
}) {
  if (!editing) return memberCanvas;

  return (
    <div
      className="min-w-0 space-y-5"
      data-collection-authoring-workspace
      data-collection-workbench
    >
      {heading}
      <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
        <div className="min-w-0 xl:pb-32" data-collection-member-canvas-slot>
          {memberCanvas}
        </div>
        {metadata ? (
          <div className="min-w-0 xl:pb-32" data-collection-metadata-slot>
            {metadata}
          </div>
        ) : null}
      </div>
      {review ? (
        <div className="min-w-0" data-collection-recovery-review-slot>
          {review}
        </div>
      ) : null}
      {saveActions ? <div data-collection-save-actions-slot>{saveActions}</div> : null}
    </div>
  );
}
